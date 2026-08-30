import type { SessionDataApi } from "./api";

import {
  compareMessageSnapshots,
  snapshotMessages,
  uniquePricingPairs,
  type MessageSnapshot,
} from "./message-snapshot";
import { Metrics } from "./metrics";
import { MetricsLoader, type SessionMetricsSource } from "./metrics-loader";
import { getPricingResolver, type Catalog, type PricingResolver } from "./pricing";
import { RefreshSchedulerRegistry } from "./refresh";
import { DESCENDANT_CONCURRENCY, getSessionDescendants, SessionIndex } from "./session";
import { abortable, mapWithConcurrency } from "./utils";

export type SessionMetricsStoreOptions = {
  catalog?: Catalog;
  includeSubagents?: boolean;
};

type StoreListener = (sessionID: string) => void;

export type MetricsStore = Pick<
  SessionMetricsStore,
  | "get"
  | "prime"
  | "hasUsableSnapshot"
  | "subscribe"
  | "retainRefresh"
  | "retain"
  | "setCatalog"
  | "setIncludeSubagents"
>;

type SessionRecord = {
  sessionID: string;
  own: Metrics;
  aggregate: Metrics;
  messageSnapshot?: MessageSnapshot;
  source?: SessionMetricsSource;
  descendants: string[];
  hasPublishedSnapshot: boolean;
  dirty: boolean;
  ownStale: boolean;
  version: number;
  pricingGeneration: number;
  lastAccess: number;
  ownInFlight?: Promise<Metrics>;
  ownInFlightVersion?: number;
  ownSuccessor?: Promise<Metrics>;
  refreshInFlight?: Promise<Metrics>;
  refreshVersion?: number;
  refreshSuccessor?: Promise<Metrics>;
};

type LeaseState = {
  record: SessionRecord;
  count: number;
};

type RefreshOptions = {
  signal?: AbortSignal;
};

function emptyMetrics() {
  return new Metrics();
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

  readonly api: SessionDataApi;
  readonly resolver: PricingResolver;
  readonly loader: MetricsLoader;
  private readonly refreshRegistry: RefreshSchedulerRegistry;
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

  constructor(api: SessionDataApi, options: SessionMetricsStoreOptions = {}) {
    this.api = api;
    this.catalog = options.catalog;
    this.includeSubagents = options.includeSubagents ?? true;
    this.resolver = getPricingResolver(this.api, this.catalog);
    this.loader = new MetricsLoader(this.api);
    this.refreshRegistry = new RefreshSchedulerRegistry({
      api: this.api,
      store: this,
    });
  }

  private get pricingGeneration() {
    return this.resolver.pricingGeneration;
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
      record.messageSnapshot = snapshotMessages(messages);
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
    return this.records.get(sessionID)?.hasPublishedSnapshot ?? false;
  }

  isDirty(sessionID: string) {
    return this.accessRecord(sessionID)?.dirty ?? true;
  }

  descendants(sessionID: string) {
    return [...(this.accessRecord(sessionID)?.descendants ?? [])];
  }

  subscribe(sessionID: string, listener: StoreListener) {
    if (this.disposed) return () => {};
    const listeners = this.listeners.get(sessionID) ?? new Set<StoreListener>();
    this.listeners.set(sessionID, listeners);
    listeners.add(listener);
    return () => {
      if (this.disposed) return;
      listeners?.delete(listener);
      if (listeners?.size === 0) this.listeners.delete(sessionID);
    };
  }

  retainRefresh(sessionID: string, includeSubagents: boolean) {
    return this.refreshRegistry.retain(sessionID, includeSubagents);
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
    this.refreshRegistry.dispose();
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
    const record = this.records.get(sessionID) ?? {
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
    if (includeSubagents) record.dirty = true;
    const own = await this.refreshOwn(record, version);

    if (!this.isCurrentRecord(record) || signal.aborted) {
      return this.finishAggregate(record);
    }

    if (!this.isCurrentAggregateMode(includeSubagents, includeSubagentsGeneration)) {
      if (this.isCurrentRecord(record)) record.dirty = true;
      return this.finishAggregate(record);
    }

    if (!includeSubagents) {
      if (this.isCurrentRecord(record) && record.version === version) {
        record.aggregate = own.clone();
        record.descendants = [];
        record.hasPublishedSnapshot ||= !record.ownStale;
        record.dirty = record.ownStale || record.version !== version;
        this.touch(record);
        this.notify(record.sessionID, record);
      } else if (this.isCurrentRecord(record)) {
        record.dirty = true;
      }
      return this.finishAggregate(record);
    }

    const pinnedDescendantIDs = new Set<string>();
    try {
      const { descendants, isStale } = await (async () => {
        try {
          const descendants = await getSessionDescendants(this.api, record.sessionID, {
            signal,
            index: this.sessionIndex,
          });
          return { descendants, isStale: this.sessionIndex.isStale(record.sessionID) };
        } catch {
          if (signal.aborted || !this.isCurrentRecord(record)) {
            return { descendants: [], isStale: true };
          }
          return { descendants: this.sessionIndex.lastKnown(record.sessionID), isStale: true };
        }
      })();

      if (signal.aborted || !this.isCurrentRecord(record)) {
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
      if (
        !descendantRecords.every(
          (descendantRecord): descendantRecord is SessionRecord => !!descendantRecord,
        )
      ) {
        return this.finishAggregate(record);
      }

      const total = own.clone();
      const childMetrics = await mapWithConcurrency(
        descendantRecords,
        DESCENDANT_CONCURRENCY,
        (descendantRecord) => this.refreshOwn(descendantRecord),
        signal,
      );
      for (const metrics of childMetrics) total.add(metrics);

      const descendantsStale =
        isStale ||
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
        record.version === version &&
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
    if (record.refreshSuccessor) return record.refreshSuccessor;
    if (
      record.refreshInFlight &&
      record.refreshVersion !== undefined &&
      record.refreshVersion !== record.version
    ) {
      const inFlight = record.refreshInFlight;
      const completedVersion = record.refreshVersion;
      const successor = this.runRefreshSuccessor(record, inFlight, completedVersion);
      record.refreshSuccessor = successor;
      const clearRefreshSuccessor = () => {
        if (this.isCurrentRecord(record) && record.refreshSuccessor === successor) {
          record.refreshSuccessor = undefined;
          this.trim();
        }
      };
      void successor.then(clearRefreshSuccessor, clearRefreshSuccessor);
      return successor;
    }
    if (record.refreshInFlight) return record.refreshInFlight;
    return this.startRefresh(record, record.version);
  }

  private runRefreshSuccessor(
    record: SessionRecord,
    request: Promise<Metrics>,
    completedVersion: number,
  ): Promise<Metrics> {
    return request
      .then(
        (metrics) => this.continueRefreshSuccessor(record, metrics, completedVersion),
        () => this.continueRefreshSuccessor(record, copyRecordMetrics(record), completedVersion),
      )
      .then((metrics) => metrics.clone());
  }

  private continueRefreshSuccessor(
    record: SessionRecord,
    metrics: Metrics,
    completedVersion: number,
  ): Metrics | Promise<Metrics> {
    if (!this.isCurrentRecord(record)) return metrics;
    if (record.version === completedVersion) return metrics;

    const nextVersion = record.version;
    return this.runRefreshSuccessor(record, this.startRefresh(record, nextVersion), nextVersion);
  }

  private startRefresh(record: SessionRecord, version: number) {
    const promise = this.refreshAggregate(record)
      .catch(() => copyRecordMetrics(record))
      .then((metrics) => metrics.clone());
    record.refreshInFlight = promise;
    record.refreshVersion = version;
    const clearRefreshInFlight = () => {
      if (this.isCurrentRecord(record) && record.refreshInFlight === promise) {
        record.refreshInFlight = undefined;
        record.refreshVersion = undefined;
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

  private refreshOwn(record: SessionRecord, loadVersion = record.version): Promise<Metrics> {
    const signal = this.disposeController.signal;
    if (!this.isCurrentRecord(record) || signal.aborted) return Promise.resolve(record.own.clone());
    if (record.ownSuccessor) return record.ownSuccessor.then((metrics) => metrics.clone());
    if (record.ownInFlight) {
      if (record.ownInFlightVersion === loadVersion) {
        return record.ownInFlight.then((metrics) => metrics.clone());
      }

      const successor = this.runOwnSuccessor(
        record,
        record.ownInFlight,
        record.ownInFlightVersion ?? loadVersion,
      );
      record.ownSuccessor = successor;
      const clearOwnSuccessor = () => {
        if (this.isCurrentRecord(record) && record.ownSuccessor === successor) {
          record.ownSuccessor = undefined;
          this.trim();
        }
      };
      void successor.then(clearOwnSuccessor, clearOwnSuccessor);
      return successor.then((metrics) => metrics.clone());
    }

    return this.startOwn(record, loadVersion);
  }

  private runOwnSuccessor(
    record: SessionRecord,
    request: Promise<Metrics>,
    completedVersion: number,
  ): Promise<Metrics> {
    return request
      .then(
        (metrics) => this.continueOwnSuccessor(record, metrics, completedVersion),
        () => this.continueOwnSuccessor(record, record.own.clone(), completedVersion),
      )
      .then((metrics) => metrics.clone());
  }

  private continueOwnSuccessor(
    record: SessionRecord,
    metrics: Metrics,
    completedVersion: number,
  ): Metrics | Promise<Metrics> {
    if (!this.isCurrentRecord(record)) return metrics;
    if (record.version === completedVersion) return metrics;

    const nextVersion = record.version;
    return this.runOwnSuccessor(record, this.startOwn(record, nextVersion), nextVersion);
  }

  private startOwn(record: SessionRecord, loadVersion: number) {
    const signal = this.disposeController.signal;

    const promise = this.loadOwn(record, loadVersion)
      .catch(() => {
        if (this.isCurrentRecord(record) && !signal.aborted && record.version === loadVersion) {
          record.ownStale = true;
          record.dirty = true;
        }
        return record.own.clone();
      })
      .then((metrics) => metrics.clone());
    record.ownInFlight = promise;
    record.ownInFlightVersion = loadVersion;
    const clearOwnInFlight = () => {
      if (this.isCurrentRecord(record) && record.ownInFlight === promise) {
        record.ownInFlight = undefined;
        record.ownInFlightVersion = undefined;
        this.trim();
      }
    };
    void promise.then(clearOwnInFlight, clearOwnInFlight);
    return promise;
  }

  private async loadOwn(record: SessionRecord, loadVersion: number) {
    const signal = this.disposeController.signal;
    const result = await this.loader.load(record.sessionID, {
      catalog: this.catalog,
      resolver: this.resolver,
      signal,
    });
    if (!this.isCurrentRecord(record) || signal.aborted || record.version !== loadVersion)
      return record.own.clone();

    const previous = record.own;
    const previousSnapshot = record.messageSnapshot;
    const nextSnapshot = result.messages ? snapshotMessages(result.messages) : undefined;
    if (nextSnapshot) {
      this.resolver.validate(
        this.api,
        uniquePricingPairs(record.messageSnapshot, nextSnapshot),
        this.catalog,
      );
    }
    const generation = this.pricingGeneration;
    const canReuse =
      result.source === "http" &&
      record.source === "http" &&
      record.pricingGeneration === generation &&
      !!previousSnapshot &&
      !!nextSnapshot;
    const comparison =
      canReuse && previousSnapshot && nextSnapshot
        ? compareMessageSnapshots(previousSnapshot, nextSnapshot)
        : { kind: "rebuild" as const };
    const next = (() => {
      if (!result.successful) return undefined;
      if (!result.messages) return result.metrics.clone();

      switch (comparison.kind) {
        case "unchanged":
          return previous.clone();
        case "append-only": {
          const delta = result.messages.slice(comparison.deltaStart);
          return Metrics.merge(
            previous,
            Metrics.fromMessages(delta, this.api, this.catalog, this.resolver),
          );
        }
        case "rebuild":
          return Metrics.fromMessages(result.messages, this.api, this.catalog, this.resolver);
      }
    })();

    const successful = result.successful && !!next;
    if (successful && next && this.isCurrentRecord(record) && record.version === loadVersion) {
      record.own = next.clone();
      record.messageSnapshot = nextSnapshot;
      record.source = result.source;
      record.pricingGeneration = generation;
      record.ownStale = false;
      if (!record.hasPublishedSnapshot) record.aggregate = record.own.clone();
      record.hasPublishedSnapshot = true;
      record.dirty = false;
      if (!this.includeSubagents) record.aggregate = record.own.clone();
      this.notify(record.sessionID, record);
    } else if (!successful && this.isCurrentRecord(record) && record.version === loadVersion) {
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
        if (
          record.ownInFlight ||
          record.ownSuccessor ||
          record.refreshInFlight ||
          record.refreshSuccessor
        )
          continue;
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
      if (
        record.ownInFlight ||
        record.ownSuccessor ||
        record.refreshInFlight ||
        record.refreshSuccessor
      )
        continue;
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
    record.messageSnapshot = undefined;
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
