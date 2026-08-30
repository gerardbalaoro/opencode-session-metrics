import type { Event } from "@opencode-ai/sdk/v2";

import type { RefreshApi } from "./api";
import type { SessionMetricsStore } from "./metrics-store";

const BUSY_POLL_MS = 2_000;
const IDLE_POLL_MS = 30_000;
const MAX_FAILURE_BACKOFF_MS = 30_000;
const PART_DELTA_DEBOUNCE_MS = 100;

type TimerHandle = ReturnType<typeof setTimeout>;

type RefreshTimers = {
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

type RefreshSchedulerOptions = {
  api: RefreshApi;
  store?: Pick<SessionMetricsStore, "descendants" | "invalidate" | "isDirty" | "refresh">;
  sessionID: string;
  includeSubagents?: boolean;
  timers?: RefreshTimers;
  partDebounceMs?: number;
  onRefresh?: (signal: AbortSignal) => Promise<boolean | void>;
  isBusy?: () => boolean;
  logger?: { warn: (message: string) => void };
};

type RefreshSchedulerStore = NonNullable<RefreshSchedulerOptions["store"]>;

type RefreshSchedulerRegistryOptions = {
  api: RefreshApi;
  store: RefreshSchedulerStore;
  timers?: RefreshTimers;
  logger?: { warn: (message: string) => void };
};

type EventLike = {
  type?: unknown;
  properties?: unknown;
};

type RefreshSignal =
  | { kind: "session-change"; sessionID: string; immediate: boolean }
  | { kind: "part-delta"; sessionID: string }
  | { kind: "child-created"; childID: string; parentID: string };

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
] as const satisfies readonly Event["type"][];

const defaultTimers: RefreshTimers = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle),
};

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isCompactionEvent(type: string | undefined) {
  return type === "session.compacted" || type?.startsWith("session.next.compaction.") === true;
}

function pollingDelay(failureCount: number, isBusy: boolean) {
  if (failureCount > 0) {
    return Math.min(MAX_FAILURE_BACKOFF_MS, BUSY_POLL_MS * 2 ** (failureCount - 1));
  }
  if (isBusy) return BUSY_POLL_MS;
  return IDLE_POLL_MS;
}

const recognizedEventTypes = new Set<string>(eventTypes);

function normalizeRefreshEvent(
  event: EventLike,
  warn: (message: string) => void,
): RefreshSignal | undefined {
  const type = typeof event.type === "string" ? event.type : undefined;
  if (!type) {
    warn('session-metrics: ignoring malformed refresh event type "<missing>": missing event type');
    return;
  }
  if (!recognizedEventTypes.has(type)) return;

  const properties = objectOf(event.properties);
  const info = objectOf(properties?.info);
  const sessionID = nonEmptyString(properties?.sessionID) ?? nonEmptyString(info?.id);
  const malformed = (reason: string) => {
    warn(`session-metrics: ignoring malformed refresh event type "${type}": ${reason}`);
  };

  if (type === "session.created") {
    if (!sessionID) {
      malformed("missing session identifier");
      return;
    }
    if (properties?.info !== undefined && !info) {
      malformed("invalid session information");
      return;
    }
    if (info && "parentID" in info) {
      const parentID = nonEmptyString(info.parentID);
      if (!parentID) {
        malformed("invalid parent identifier");
        return;
      }
      return { kind: "child-created", childID: sessionID, parentID };
    }
    return { kind: "session-change", sessionID, immediate: false };
  }

  if (!properties || !sessionID) {
    malformed("missing session identifier");
    return;
  }

  if (type === "session.status") {
    const status = objectOf(properties.status);
    if (!status || typeof status.type !== "string" || status.type.length === 0) {
      malformed("invalid status");
      return;
    }
    return { kind: "session-change", sessionID, immediate: status.type === "idle" };
  }

  if (type === "message.part.delta") return { kind: "part-delta", sessionID };
  return {
    kind: "session-change",
    sessionID,
    immediate: type === "session.idle" || type === "session.deleted" || isCompactionEvent(type),
  };
}

/** Coordinates event-driven refreshes and adaptive fallback polling. */
class RefreshScheduler {
  private readonly api: RefreshApi;
  private readonly store?: RefreshSchedulerOptions["store"];
  private readonly sessionID: string;
  private readonly includeSubagents: boolean;
  private readonly timers: RefreshTimers;
  private readonly partDebounceMs: number;
  private readonly customRefresh?: RefreshSchedulerOptions["onRefresh"];
  private readonly busyCheck?: () => boolean;
  private readonly logger: { warn: (message: string) => void };
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
    this.logger = options.logger ?? console;
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;

    for (const type of eventTypes) {
      const unsubscribe = this.api.event.on(type, (event) => this.handleEvent(event));
      if (typeof unsubscribe === "function") this.unsubscribers.push(unsubscribe);
    }

    void this.requestRefresh();
  }

  private handleEvent(event: unknown) {
    if (this.disposed) return;
    const signal = normalizeRefreshEvent(objectOf(event) ?? {}, (message) =>
      this.logger.warn(message),
    );
    if (!signal) return;

    if (signal.kind === "child-created") {
      if (!this.includeSubagents || !this.isRelevant(signal.parentID)) return;
      this.invalidate(signal.childID);
      this.invalidate(this.sessionID);
      void this.requestRefresh();
      return;
    }

    if (!this.isRelevant(signal.sessionID)) return;

    this.invalidate(signal.sessionID);
    if (signal.sessionID !== this.sessionID && this.includeSubagents)
      this.invalidate(this.sessionID);

    if (signal.kind === "part-delta") {
      this.schedulePartDeltaRefresh();
      return;
    }

    void this.requestRefresh(signal.immediate);
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
    try {
      if (this.customRefresh) {
        const result = await this.customRefresh(controller.signal);
        this.completeRefresh(result !== false && !controller.signal.aborted, onScopeAbort);
        return;
      }
      if (this.store) {
        await this.store.refresh(this.sessionID, { signal: controller.signal });
        this.completeRefresh(
          !this.store.isDirty(this.sessionID) && !controller.signal.aborted,
          onScopeAbort,
        );
        return;
      }
      this.completeRefresh(!controller.signal.aborted, onScopeAbort);
    } catch {
      this.completeRefresh(false, onScopeAbort);
    }
  }

  private completeRefresh(successful: boolean, onScopeAbort: () => void) {
    this.scope.signal.removeEventListener("abort", onScopeAbort);
    this.active = false;

    if (this.disposed) return;
    if (successful) this.failureCount = 0;
    else this.failureCount += 1;

    if (this.followUp) {
      this.followUp = false;
      void this.requestRefresh(true);
      return;
    }
    this.schedulePoll();
  }

  private schedulePoll() {
    if (this.disposed) return;
    this.clearTimer("poll");
    const delay = pollingDelay(this.failureCount, this.isBusy());
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

type RefreshLease = {
  scheduler: RefreshScheduler;
  consumers: number;
};

function refreshLeaseKey(sessionID: string, includeSubagents: boolean) {
  return JSON.stringify([sessionID, includeSubagents]);
}

/** Shares one event and polling scheduler for each store/session/options pair. */
export class RefreshSchedulerRegistry {
  private readonly leases = new Map<string, RefreshLease>();
  private disposed = false;

  constructor(private readonly options: RefreshSchedulerRegistryOptions) {}

  retain(sessionID: string, includeSubagents = true) {
    if (this.disposed) return () => {};

    const key = refreshLeaseKey(sessionID, includeSubagents);
    const lease =
      this.leases.get(key) ??
      (() => {
        const created = {
          scheduler: new RefreshScheduler({
            api: this.options.api,
            store: this.options.store,
            sessionID,
            includeSubagents,
            timers: this.options.timers,
            logger: this.options.logger,
          }),
          consumers: 0,
        };
        this.leases.set(key, created);
        created.scheduler.start();
        return created;
      })();

    lease.consumers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.disposed) return;

      const current = this.leases.get(key);
      if (current !== lease) return;
      if (current.consumers > 1) {
        current.consumers -= 1;
        return;
      }

      this.leases.delete(key);
      current.scheduler.dispose();
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const lease of this.leases.values()) lease.scheduler.dispose();
    this.leases.clear();
  }
}
