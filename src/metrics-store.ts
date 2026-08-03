import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  loadSessionMetrics,
  Metrics,
  type SessionMetricsLoadResult,
  type SessionMetricsSource,
} from "./metrics";
import {
  DESCENDANT_CONCURRENCY,
  getSessionDescendants,
  SessionIndex,
  type Message,
  type Session,
} from "./session";
import {
  getPricingResolver,
  type Catalog,
  type PricingPair,
  type PricingResolver,
} from "./pricing";
import { abortable, mapWithConcurrency } from "./utils";

export type SessionMetricsStoreOptions = {
  catalog?: Catalog;
  includeSubagents?: boolean;
};

type StoreListener = (sessionID: string) => void;

type SessionRecord = {
  sessionID: string;
  own: Metrics;
  aggregate: Metrics;
  messageKeys?: string[];
  source?: SessionMetricsSource;
  pricingPairs?: PricingPair[];
  descendants: string[];
  hasPublishedSnapshot: boolean;
  dirty: boolean;
  ownStale: boolean;
  version: number;
  pricingGeneration: number;
  lastAccess: number;
  ownInFlight?: Promise<Metrics>;
  refreshInFlight?: Promise<Metrics>;
};

type LeaseState = {
  record: SessionRecord;
  count: number;
};

export type RefreshOptions = {
  signal?: AbortSignal;
};

function emptyMetrics() {
  return new Metrics();
}

function messageID(message: Message) {
  const id = (message as Message & { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function messageSignature(message: Message) {
  const candidate = message as Message & {
    cost?: unknown;
    providerID?: unknown;
    modelID?: unknown;
    tokens?: {
      total?: unknown;
      input?: unknown;
      output?: unknown;
      reasoning?: unknown;
      cache?: { read?: unknown; write?: unknown };
    };
  };
  const tokens = candidate.tokens;
  return JSON.stringify([
    message.role,
    candidate.cost,
    candidate.providerID,
    candidate.modelID,
    tokens?.total,
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache?.read,
    tokens?.cache?.write,
  ]);
}

function messageKeys(messages: ReadonlyArray<Message>) {
  const keys: string[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    const id = messageID(message);
    if (!id || seen.has(id)) return undefined;
    seen.add(id);
    keys.push(`${id}:${messageSignature(message)}`);
  }

  return keys;
}

function messagePricingPairs(messages: ReadonlyArray<Message>) {
  const pairs = new Map<string, PricingPair>();

  for (const message of messages) {
    const candidate = message as Message & {
      cost?: unknown;
      providerID?: unknown;
      modelID?: unknown;
      tokens?: unknown;
    };
    if (
      message.role !== "assistant" ||
      !candidate.tokens ||
      (candidate.cost !== undefined && candidate.cost !== null && candidate.cost !== 0) ||
      typeof candidate.providerID !== "string" ||
      typeof candidate.modelID !== "string"
    ) {
      continue;
    }

    const pair = { providerID: candidate.providerID, modelID: candidate.modelID };
    pairs.set(`${pair.providerID}\u0000${pair.modelID}`, pair);
  }

  return [...pairs.values()];
}

function uniquePricingPairs(...groups: Array<ReadonlyArray<PricingPair> | undefined>) {
  const pairs = new Map<string, PricingPair>();
  for (const group of groups) {
    for (const pair of group ?? []) pairs.set(`${pair.providerID}\u0000${pair.modelID}`, pair);
  }
  return [...pairs.values()];
}

function canReuseAppendOnly(
  previous: SessionRecord,
  result: SessionMetricsLoadResult,
  pricingGeneration: number,
  nextKeys: string[] | undefined,
) {
  if (
    result.source !== "http" ||
    previous.source !== "http" ||
    previous.pricingGeneration !== pricingGeneration ||
    !previous.messageKeys ||
    !result.messages
  ) {
    return false;
  }

  if (!nextKeys || nextKeys.length < previous.messageKeys.length) return false;
  if (!previous.messageKeys.every((key, index) => nextKeys[index] === key)) return false;
  return nextKeys.length > previous.messageKeys.length;
}

function unchangedMessages(
  previous: SessionRecord,
  result: SessionMetricsLoadResult,
  pricingGeneration: number,
  nextKeys: string[] | undefined,
) {
  if (
    result.source !== "http" ||
    previous.source !== "http" ||
    previous.pricingGeneration !== pricingGeneration ||
    !previous.messageKeys ||
    !result.messages
  ) {
    return false;
  }
  return (
    !!nextKeys &&
    nextKeys.length === previous.messageKeys.length &&
    nextKeys.every((key, index) => key === previous.messageKeys?.[index])
  );
}

function copyRecordMetrics(record: SessionRecord | undefined) {
  return record?.aggregate.clone() ?? emptyMetrics();
}

/**
 * Owns the cached metric snapshots for all sessions displayed by the plugin.
 * Network work is coalesced per session, while stale snapshots remain usable
 * until a later refresh succeeds.
 */
export class SessionMetricsStore {
  private static readonly MAX_IDLE_RECORDS = 32;

  readonly api: TuiPluginApi;
  readonly resolver: PricingResolver;
  private readonly records = new Map<string, SessionRecord>();

  private catalog?: Catalog;
  private includeSubagents: boolean;
  private includeSubagentsGeneration = 0;
  private disposed = false;
  private accessOrder = 0;
  private readonly leases = new Map<string, LeaseState>();
  private readonly temporaryPins = new Map<string, number>();
  private readonly listeners = new Map<string, Set<StoreListener>>();
  private readonly disposeController = new AbortController();
  private readonly sessionIndex = new SessionIndex();

  constructor(api: TuiPluginApi, options: SessionMetricsStoreOptions = {}) {
    this.api = api;
    this.catalog = options.catalog;
    this.includeSubagents = options.includeSubagents ?? true;
    this.resolver = getPricingResolver(this.api, this.catalog);
  }

  get pricingGeneration() {
    return this.resolver.pricingGeneration;
  }

  get isDisposed() {
    return this.disposed;
  }

  get(sessionID: string) {
    return copyRecordMetrics(this.accessRecord(sessionID));
  }

  /** Seed a snapshot from already-loaded TUI state without skipping refresh. */
  prime(sessionID: string) {
    const record = this.ensureRecord(sessionID);
    if (!record) return emptyMetrics();
    if (record.source) return record.aggregate.clone();

    const messages = this.api.state.session.messages(sessionID);
    const session = this.api.state.session.get?.(sessionID);
    if (messages.length > 0) {
      record.own = Metrics.fromMessages(messages, this.api, this.catalog, this.resolver);
      record.aggregate = record.own.clone();
      record.messageKeys = messageKeys(messages);
      record.pricingPairs = messagePricingPairs(messages);
      record.source = "tui";
      record.hasPublishedSnapshot = true;
      record.ownStale = false;
      record.dirty = true;
    } else if (session) {
      const rollup = Metrics.fromSessionRollup(session);
      if (rollup) {
        record.own = rollup;
        record.aggregate = record.own.clone();
        record.source = "rollup";
        record.hasPublishedSnapshot = true;
        record.ownStale = false;
        record.dirty = true;
      }
    }
    return record.aggregate.clone();
  }

  snapshot(sessionID: string) {
    const record = this.accessRecord(sessionID);
    return record ? record.aggregate.clone() : undefined;
  }

  hasUsableSnapshot(sessionID: string) {
    return this.accessRecord(sessionID)?.hasPublishedSnapshot ?? false;
  }

  isDirty(sessionID: string) {
    return this.accessRecord(sessionID)?.dirty ?? true;
  }

  descendants(sessionID: string) {
    return [...(this.accessRecord(sessionID)?.descendants ?? [])];
  }

  subscribe(sessionID: string, listener: StoreListener) {
    if (this.disposed) return () => {};
    let listeners = this.listeners.get(sessionID);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(sessionID, listeners);
    }
    listeners.add(listener);
    return () => {
      if (this.disposed) return;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionID);
    };
  }

  retain(sessionID: string) {
    if (this.disposed) return () => {};

    const record = this.ensureRecord(sessionID);
    if (!record) return () => {};

    const current = this.leases.get(sessionID);
    if (current?.record === record) {
      current.count += 1;
    } else {
      this.leases.set(sessionID, { record, count: 1 });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      if (this.disposed) return;
      if (this.records.get(sessionID) !== record) return;

      const lease = this.leases.get(sessionID);
      if (!lease || lease.record !== record) return;
      if (lease.count <= 1) this.leases.delete(sessionID);
      else lease.count -= 1;
      this.trim();
    };
  }

  setCatalog(catalog?: Catalog) {
    if (this.disposed) return false;
    const unchanged = catalog === this.catalog;
    if (unchanged) {
      this.resolver.invalidate();
    } else {
      this.catalog = catalog;
      this.resolver.setCatalog(catalog);
    }

    for (const record of this.records.values()) {
      record.dirty = true;
      record.version += 1;
      record.pricingGeneration = -1;
      this.notify(record.sessionID, record);
    }
    return !unchanged;
  }

  setIncludeSubagents(includeSubagents: boolean) {
    if (this.disposed) return false;
    if (this.includeSubagents === includeSubagents) return false;
    this.includeSubagents = includeSubagents;
    this.includeSubagentsGeneration += 1;
    this.invalidate();
    return true;
  }

  invalidate(sessionID?: string) {
    if (this.disposed) return;
    if (sessionID) {
      const record = this.ensureRecord(sessionID);
      if (!record) return;
      record.dirty = true;
      record.version += 1;
      this.notify(sessionID);
      return;
    }

    for (const record of this.records.values()) {
      record.dirty = true;
      record.version += 1;
      this.notify(record.sessionID);
    }
  }

  refresh(sessionID: string, options: RefreshOptions = {}): Promise<Metrics> {
    if (this.disposed) return Promise.resolve(this.get(sessionID));
    if (options.signal?.aborted) return Promise.resolve(this.get(sessionID));

    const record = this.ensureRecord(sessionID);
    if (!record) return Promise.resolve(this.get(sessionID));
    const promise = this.refreshShared(record);
    return this.waitForRefresh(sessionID, promise, options.signal);
  }

  async refreshAll(options: RefreshOptions = {}) {
    const metrics = new Map<string, Metrics>();
    for (const sessionID of Array.from(this.records.keys())) {
      const record = this.records.get(sessionID);
      const wasInFlight = !!record?.refreshInFlight;
      metrics.set(sessionID, await this.refresh(sessionID, options));
      if (wasInFlight && this.isDirty(sessionID)) {
        metrics.set(sessionID, await this.refresh(sessionID, options));
      }
    }
    return metrics;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeController.abort();
    for (const record of this.records.values()) this.clearRecordCaches(record);
    this.records.clear();
    this.leases.clear();
    this.temporaryPins.clear();
    this.listeners.clear();
    this.sessionIndex.dispose();
  }

  private ensureRecord(sessionID: string) {
    if (this.disposed) return undefined;
    let record = this.records.get(sessionID);
    if (!record) {
      record = {
        sessionID,
        own: emptyMetrics(),
        aggregate: emptyMetrics(),
        descendants: [],
        hasPublishedSnapshot: false,
        dirty: true,
        ownStale: true,
        version: 0,
        pricingGeneration: this.pricingGeneration,
        lastAccess: 0,
      };
      this.records.set(sessionID, record);
    }
    this.touch(record);
    this.trim();
    return record;
  }

  private async refreshAggregate(record: SessionRecord) {
    if (!this.isCurrentRecord(record)) return record.aggregate.clone();
    const version = record.version;
    const signal = this.disposeController.signal;
    const includeSubagents = this.includeSubagents;
    const includeSubagentsGeneration = this.includeSubagentsGeneration;
    const own = await this.refreshOwn(record);

    if (!this.isCurrentRecord(record) || signal.aborted) {
      return this.finishAggregate(record);
    }

    if (!this.isCurrentAggregateMode(includeSubagents, includeSubagentsGeneration)) {
      if (this.isCurrentRecord(record)) record.dirty = true;
      return this.finishAggregate(record);
    }

    if (!includeSubagents) {
      if (this.isCurrentRecord(record)) {
        record.aggregate = own.clone();
        record.descendants = [];
        record.hasPublishedSnapshot ||= !record.ownStale;
        record.dirty = record.ownStale || record.version !== version;
        this.touch(record);
        this.notify(record.sessionID, record);
      }
      return this.finishAggregate(record);
    }

    const pinnedDescendantIDs = new Set<string>();
    try {
      let descendants: Session[] = [];
      let descendantsStale = false;
      try {
        descendants = await getSessionDescendants(this.api, record.sessionID, {
          signal,
          index: this.sessionIndex,
        });
        descendantsStale = this.sessionIndex.isStale(record.sessionID);
      } catch {
        if (signal.aborted || !this.isCurrentRecord(record)) {
          return this.finishAggregate(record);
        }
        descendants = this.sessionIndex.lastKnown(record.sessionID);
        descendantsStale = true;
      }

      if (!this.isCurrentRecord(record) || signal.aborted) {
        return this.finishAggregate(record);
      }

      // Pin every ID before creating any record so synchronous trimming cannot
      // evict an earlier descendant while the remaining records are created.
      for (const { id } of descendants) {
        if (pinnedDescendantIDs.has(id)) continue;
        this.pinTemporaryRecord(id);
        pinnedDescendantIDs.add(id);
      }
      const descendantRecords = descendants.map(({ id }) => this.ensureRecord(id));
      if (descendantRecords.some((descendantRecord) => !descendantRecord)) {
        return this.finishAggregate(record);
      }

      const total = own.clone();
      const childMetrics = await mapWithConcurrency(
        descendantRecords as SessionRecord[],
        DESCENDANT_CONCURRENCY,
        (descendantRecord) => this.refreshOwn(descendantRecord),
        signal,
      );
      for (const metrics of childMetrics) total.add(metrics);

      descendantsStale =
        descendantsStale ||
        descendants.some(({ id }) => {
          const descendantRecord = this.records.get(id);
          return (
            descendantRecord !== undefined &&
            this.isCurrentRecord(descendantRecord) &&
            (descendantRecord.ownStale || descendantRecord.dirty)
          );
        });

      if (
        this.isCurrentRecord(record) &&
        !signal.aborted &&
        this.isCurrentAggregateMode(includeSubagents, includeSubagentsGeneration)
      ) {
        record.aggregate = total;
        record.descendants = descendants.map(({ id }) => id);
        record.hasPublishedSnapshot ||=
          !record.ownStale ||
          descendantRecords.some(
            (descendantRecord) => descendantRecord?.hasPublishedSnapshot ?? false,
          );
        record.dirty = record.ownStale || descendantsStale || record.version !== version;
        this.touch(record);
        this.notify(record.sessionID, record);
      } else if (this.isCurrentRecord(record)) {
        record.dirty = true;
      }
      return this.finishAggregate(record);
    } finally {
      for (const sessionID of pinnedDescendantIDs) this.releaseTemporaryRecord(sessionID);
      this.trim();
    }
  }

  private refreshShared(record: SessionRecord) {
    if (record.refreshInFlight) return record.refreshInFlight;

    const promise = this.refreshAggregate(record)
      .catch(() => copyRecordMetrics(record))
      .then((metrics) => metrics.clone());
    record.refreshInFlight = promise;
    const clearRefreshInFlight = () => {
      if (this.isCurrentRecord(record) && record.refreshInFlight === promise) {
        record.refreshInFlight = undefined;
        this.trim();
      }
    };
    void promise.then(clearRefreshInFlight, clearRefreshInFlight);
    return promise;
  }

  private waitForRefresh(sessionID: string, promise: Promise<Metrics>, signal?: AbortSignal) {
    if (!signal) {
      return promise.then(
        (metrics) => metrics.clone(),
        () => this.get(sessionID),
      );
    }

    try {
      return abortable(promise, signal).then(
        (metrics) => metrics.clone(),
        () => this.get(sessionID),
      );
    } catch {
      return Promise.resolve(this.get(sessionID));
    }
  }

  private isCurrentAggregateMode(includeSubagents: boolean, generation: number) {
    return (
      this.includeSubagents === includeSubagents && this.includeSubagentsGeneration === generation
    );
  }

  private finishAggregate(record: SessionRecord) {
    if (this.isCurrentRecord(record)) this.touch(record);
    return record.aggregate.clone();
  }

  private refreshOwn(record: SessionRecord): Promise<Metrics> {
    const signal = this.disposeController.signal;
    if (!this.isCurrentRecord(record) || signal.aborted) return Promise.resolve(record.own.clone());
    if (record.ownInFlight) return record.ownInFlight.then((metrics) => metrics.clone());

    const promise = this.loadOwn(record)
      .catch(() => {
        if (this.isCurrentRecord(record) && !signal.aborted) {
          record.ownStale = true;
          record.dirty = true;
        }
        return record.own.clone();
      })
      .then((metrics) => metrics.clone());
    record.ownInFlight = promise;
    const clearOwnInFlight = () => {
      if (this.isCurrentRecord(record) && record.ownInFlight === promise) {
        record.ownInFlight = undefined;
      }
    };
    void promise.then(clearOwnInFlight, clearOwnInFlight);
    return promise;
  }

  private async loadOwn(record: SessionRecord) {
    const signal = this.disposeController.signal;
    const result = await loadSessionMetrics(this.api, record.sessionID, {
      catalog: this.catalog,
      resolver: this.resolver,
      signal,
    });
    if (!this.isCurrentRecord(record) || signal.aborted) return record.own.clone();

    const previous = record.own;
    const nextKeys = result.messages ? messageKeys(result.messages) : undefined;
    const nextPricingPairs = result.messages ? messagePricingPairs(result.messages) : undefined;
    if (nextPricingPairs) {
      this.resolver.validate(
        this.api,
        uniquePricingPairs(record.pricingPairs, nextPricingPairs),
        this.catalog,
      );
    }
    const generation = this.pricingGeneration;
    let next: Metrics | undefined;

    if (result.successful && result.messages) {
      if (unchangedMessages(record, result, generation, nextKeys)) {
        next = previous.clone();
      } else if (canReuseAppendOnly(record, result, generation, nextKeys)) {
        const delta = result.messages.slice(record.messageKeys!.length);
        next = Metrics.merge(
          previous,
          Metrics.fromMessages(delta, this.api, this.catalog, this.resolver),
        );
      } else {
        next = Metrics.fromMessages(result.messages, this.api, this.catalog, this.resolver);
      }
    } else if (result.successful) {
      next = result.metrics.clone();
    }

    const successful = result.successful && !!next;
    if (successful && this.isCurrentRecord(record)) {
      record.own = next!.clone();
      record.messageKeys = nextKeys;
      record.pricingPairs = nextPricingPairs;
      record.source = result.source;
      record.pricingGeneration = generation;
      record.dirty = false;
      record.ownStale = false;
      record.hasPublishedSnapshot = true;
      this.notify(record.sessionID, record);
    } else if (!successful && this.isCurrentRecord(record)) {
      record.ownStale = true;
      record.dirty = true;
    }

    return successful ? record.own.clone() : previous.clone();
  }

  private accessRecord(sessionID: string) {
    const record = this.records.get(sessionID);
    if (record) this.touch(record);
    return record;
  }

  private touch(record: SessionRecord) {
    record.lastAccess = ++this.accessOrder;
  }

  private isCurrentRecord(record: SessionRecord) {
    return !this.disposed && this.records.get(record.sessionID) === record;
  }

  private pinTemporaryRecord(sessionID: string) {
    this.temporaryPins.set(sessionID, (this.temporaryPins.get(sessionID) ?? 0) + 1);
  }

  private releaseTemporaryRecord(sessionID: string) {
    const count = this.temporaryPins.get(sessionID);
    if (!count || count <= 1) this.temporaryPins.delete(sessionID);
    else this.temporaryPins.set(sessionID, count - 1);
  }

  private trim() {
    if (this.disposed) return;

    while (this.idleRecordCount() > SessionMetricsStore.MAX_IDLE_RECORDS) {
      let oldest: SessionRecord | undefined;
      for (const record of this.records.values()) {
        if (record.ownInFlight || record.refreshInFlight) continue;
        const lease = this.leases.get(record.sessionID);
        if (lease?.record === record && lease.count > 0) continue;
        if (this.temporaryPins.has(record.sessionID)) continue;
        if (
          !oldest ||
          record.lastAccess < oldest.lastAccess ||
          (record.lastAccess === oldest.lastAccess && record.sessionID < oldest.sessionID)
        ) {
          oldest = record;
        }
      }

      if (!oldest) return;
      this.evict(oldest);
    }
  }

  private idleRecordCount() {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.ownInFlight || record.refreshInFlight) continue;
      const lease = this.leases.get(record.sessionID);
      if (lease?.record === record && lease.count > 0) continue;
      if (this.temporaryPins.has(record.sessionID)) continue;
      count += 1;
    }
    return count;
  }

  private evict(record: SessionRecord) {
    if (this.records.get(record.sessionID) !== record) return;
    this.records.delete(record.sessionID);
    const lease = this.leases.get(record.sessionID);
    if (lease?.record === record) this.leases.delete(record.sessionID);
    this.sessionIndex.clear(record.sessionID);
    this.clearRecordCaches(record);
  }

  private clearRecordCaches(record: SessionRecord) {
    record.messageKeys = undefined;
    record.pricingPairs = undefined;
    record.descendants = [];
  }

  private notify(sessionID: string, record?: SessionRecord) {
    if (this.disposed) return;
    if (record ? this.records.get(sessionID) !== record : !this.records.has(sessionID)) return;
    for (const listener of this.listeners.get(sessionID) ?? []) {
      if (
        this.disposed ||
        (record ? this.records.get(sessionID) !== record : !this.records.has(sessionID))
      )
        return;
      listener(sessionID);
    }
  }
}
