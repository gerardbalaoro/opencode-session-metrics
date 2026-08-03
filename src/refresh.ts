import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { SessionMetricsStore } from "./metrics-store";

export const BUSY_POLL_MS = 2_000;
export const IDLE_POLL_MS = 30_000;
const MAX_FAILURE_BACKOFF_MS = 30_000;
export const PART_DELTA_DEBOUNCE_MS = 100;

type TimerHandle = ReturnType<typeof setTimeout>;

export type RefreshTimers = {
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type RefreshSchedulerOptions = {
  api: TuiPluginApi;
  store?: Pick<SessionMetricsStore, "descendants" | "invalidate" | "isDirty" | "refresh">;
  sessionID: string;
  includeSubagents?: boolean;
  timers?: RefreshTimers;
  partDebounceMs?: number;
  onRefresh?: (signal: AbortSignal) => Promise<boolean | void>;
  isBusy?: () => boolean;
};

type EventLike = {
  type?: string;
  properties?: Record<string, any>;
};

const eventTypes = [
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
  "message.part.delta",
  "session.created",
  "session.updated",
  "session.deleted",
  "session.status",
  "session.idle",
  "session.compacted",
  "session.next.compaction.started",
  "session.next.compaction.delta",
  "session.next.compaction.ended",
] as const;

const defaultTimers: RefreshTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

function sessionIDOf(event: EventLike) {
  const properties = event.properties;
  if (typeof properties?.sessionID === "string") return properties.sessionID;
  const info = properties?.info;
  return typeof info?.id === "string" ? info.id : undefined;
}

function sessionInfoOf(event: EventLike) {
  const info = event.properties?.info;
  return info && typeof info === "object"
    ? (info as { id?: string; parentID?: string })
    : undefined;
}

function isCompactionEvent(type: string | undefined) {
  return type === "session.compacted" || type?.startsWith("session.next.compaction.") === true;
}

/** Coordinates event-driven refreshes and adaptive fallback polling. */
export class RefreshScheduler {
  private readonly api: TuiPluginApi;
  private readonly store?: RefreshSchedulerOptions["store"];
  private readonly sessionID: string;
  private readonly includeSubagents: boolean;
  private readonly timers: RefreshTimers;
  private readonly partDebounceMs: number;
  private readonly customRefresh?: RefreshSchedulerOptions["onRefresh"];
  private readonly busyCheck?: () => boolean;
  private readonly scope = new AbortController();
  private readonly unsubscribers: Array<() => void> = [];

  private started = false;
  private disposed = false;
  private active = false;
  private activePromise?: Promise<void>;
  private followUp = false;
  private pollTimer?: TimerHandle;
  private partTimer?: TimerHandle;
  private failureCount = 0;

  constructor(options: RefreshSchedulerOptions) {
    this.api = options.api;
    this.store = options.store;
    this.sessionID = options.sessionID;
    this.includeSubagents = options.includeSubagents ?? true;
    this.timers = options.timers ?? defaultTimers;
    this.partDebounceMs = options.partDebounceMs ?? PART_DELTA_DEBOUNCE_MS;
    this.customRefresh = options.onRefresh;
    this.busyCheck = options.isBusy;
  }

  get isActive() {
    return this.active;
  }

  get pendingFollowUp() {
    return this.followUp;
  }

  get failureAttempts() {
    return this.failureCount;
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;

    for (const type of eventTypes) {
      const unsubscribe = (this.api.event.on as any)(type, (event: EventLike) =>
        this.handleEvent(event),
      );
      if (typeof unsubscribe === "function") this.unsubscribers.push(unsubscribe);
    }

    void this.requestRefresh();
  }

  handleEvent(event: EventLike) {
    if (this.disposed) return;
    const type = event.type;
    const sessionID = sessionIDOf(event);
    const info = sessionInfoOf(event);
    const isChildCreation = type === "session.created" && info?.parentID !== undefined;

    if (isChildCreation) {
      if (!this.includeSubagents || !this.isRelevant(info?.parentID)) return;
      this.invalidate(info?.id);
      this.invalidate(this.sessionID);
      void this.requestRefresh();
      return;
    }

    if (!this.isRelevant(sessionID)) return;

    this.invalidate(sessionID);
    if (sessionID !== this.sessionID && this.includeSubagents) this.invalidate(this.sessionID);

    if (type === "message.part.delta") {
      this.schedulePartDeltaRefresh();
      return;
    }

    const immediate =
      type === "session.idle" ||
      type === "session.deleted" ||
      isCompactionEvent(type) ||
      (type === "session.status" && event.properties?.status?.type === "idle");
    void this.requestRefresh(immediate);
  }

  refreshNow() {
    if (this.disposed) return Promise.resolve();
    this.clearTimer("poll");
    this.clearTimer("part");
    return this.requestRefresh(true);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.scope.abort();
    this.clearTimer("poll");
    this.clearTimer("part");
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.followUp = false;
  }

  private invalidate(sessionID: string | undefined) {
    if (sessionID) this.store?.invalidate(sessionID);
  }

  private isRelevant(sessionID: string | undefined) {
    if (!sessionID) return false;
    if (sessionID === this.sessionID) return true;
    return (
      this.includeSubagents &&
      (this.store?.descendants(this.sessionID).includes(sessionID) ?? false)
    );
  }

  private schedulePartDeltaRefresh() {
    this.clearTimer("part");
    this.partTimer = this.timers.setTimeout(() => {
      this.partTimer = undefined;
      void this.requestRefresh();
    }, this.partDebounceMs);
  }

  private requestRefresh(immediate = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pollTimer) this.clearTimer("poll");
    if (immediate && this.partTimer) this.clearTimer("part");
    if (this.active) {
      this.followUp = true;
      return this.activePromise ?? Promise.resolve();
    }

    const promise = this.runRefresh();
    this.activePromise = promise;
    return promise;
  }

  private async runRefresh() {
    if (this.disposed) return;
    this.active = true;
    const controller = new AbortController();
    const onScopeAbort = () => controller.abort();
    this.scope.signal.addEventListener("abort", onScopeAbort, { once: true });
    let successful = false;

    try {
      let result: boolean | void;
      if (this.customRefresh) {
        result = await this.customRefresh(controller.signal);
      } else if (this.store) {
        await this.store.refresh(this.sessionID, {
          signal: controller.signal,
        });
        result = !this.store.isDirty(this.sessionID);
      } else {
        result = true;
      }
      successful = result !== false && !controller.signal.aborted;
    } catch {
      successful = false;
    } finally {
      this.scope.signal.removeEventListener("abort", onScopeAbort);
      this.active = false;

      if (!this.disposed) {
        if (successful) this.failureCount = 0;
        else this.failureCount += 1;

        if (this.followUp) {
          this.followUp = false;
          void this.requestRefresh(true);
        } else {
          this.schedulePoll();
        }
      }
    }
  }

  private schedulePoll() {
    if (this.disposed) return;
    this.clearTimer("poll");
    const delay = this.failureCount
      ? Math.min(MAX_FAILURE_BACKOFF_MS, BUSY_POLL_MS * 2 ** (this.failureCount - 1))
      : this.isBusy()
        ? BUSY_POLL_MS
        : IDLE_POLL_MS;
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      void this.requestRefresh(true);
    }, delay);
  }

  private isBusy() {
    return this.busyCheck?.() ?? this.api.state.session.status?.(this.sessionID)?.type === "busy";
  }

  private clearTimer(kind: "poll" | "part") {
    const timer = kind === "poll" ? this.pollTimer : this.partTimer;
    if (timer !== undefined) this.timers.clearTimeout(timer);
    if (kind === "poll") this.pollTimer = undefined;
    else this.partTimer = undefined;
  }
}
