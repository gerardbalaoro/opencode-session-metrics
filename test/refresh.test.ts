import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldShowLoading } from "../src/components/sidebar.tsx";
import { SessionMetricsStore } from "../src/metrics-store.ts";
import {
  RefreshScheduler,
  IDLE_POLL_MS,
  BUSY_POLL_MS,
  PART_DELTA_DEBOUNCE_MS,
} from "../src/refresh.ts";

class FakeTimers {
  private nextID = 1;
  readonly tasks = new Map<number, { delay: number; callback: () => void }>();
  readonly cleared: number[] = [];

  readonly timers = {
    setTimeout: (callback: () => void, delay: number) => {
      const id = this.nextID++;
      this.tasks.set(id, { delay, callback });
      return id as any;
    },
    clearTimeout: (id: any) => {
      this.cleared.push(id);
      this.tasks.delete(id);
    },
  };

  run(delay: number) {
    const entries = [...this.tasks.entries()].filter(([, task]) => task.delay === delay);
    for (const [id, task] of entries) {
      this.tasks.delete(id);
      task.callback();
    }
  }
}

function eventApi(client?: unknown) {
  const handlers = new Map<string, Set<(event: unknown) => void>>();
  let unsubscribed = 0;
  const api = {
    event: {
      on: (type: string, handler: (event: unknown) => void) => {
        const set = handlers.get(type) ?? new Set<(event: unknown) => void>();
        set.add(handler);
        handlers.set(type, set);
        return () => {
          unsubscribed += 1;
          set.delete(handler);
        };
      },
    },
    state: { session: { status: () => ({ type: "idle" }) } },
    ...(client ? { client } : {}),
  };
  return {
    api: api as never,
    emit: (event: { type: string; properties?: Record<string, unknown> }) => {
      for (const handler of handlers.get(event.type) ?? []) handler(event);
    },
    subscriptions: () => [...handlers.values()].reduce((count, set) => count + set.size, 0),
    unsubscribed: () => unsubscribed,
  };
}

function metricsEventApi() {
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events = eventApi({
    session: {
      messages: async () => {
        requests += 1;
        if (requests === 3) await pending;
        return {
          data: [
            {
              info: {
                id: "message-1",
                role: "assistant",
                providerID: "provider",
                modelID: "model",
                cost: 1.23,
                tokens: {
                  input: 7,
                  output: 0,
                  reasoning: 0,
                  total: 7,
                  cache: { read: 0, write: 0 },
                },
              },
            },
          ],
        };
      },
      children: async () => ({ data: [] }),
      get: async () => ({ data: undefined }),
    },
  });
  return { ...events, release };
}

function partialRefreshEventApi() {
  let childRequests = 0;
  let releaseRetry!: () => void;
  let markRetryChildStarted!: () => void;
  const retryPending = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const retryChildStarted = new Promise<void>((resolve) => {
    markRetryChildStarted = resolve;
  });
  const message = (sessionID: string, total: number, cost: number) => ({
    id: `${sessionID}-message`,
    role: "assistant" as const,
    providerID: "provider",
    modelID: "model",
    cost,
    tokens: {
      input: total,
      output: 0,
      reasoning: 0,
      total,
      cache: { read: 0, write: 0 },
    },
  });
  const events = eventApi({
    session: {
      messages: async ({ sessionID }: { sessionID: string }) => {
        if (sessionID === "child") {
          childRequests += 1;
          if (childRequests === 1) throw new Error("offline");
          markRetryChildStarted();
          await retryPending;
          return { data: [{ info: message("child", 2, 0.5) }] };
        }
        return { data: [{ info: message("root", 7, 1.23) }] };
      },
      children: async ({ sessionID }: { sessionID: string }) => ({
        data: sessionID === "root" ? [{ id: "child" }] : [],
      }),
      get: async () => ({ data: undefined }),
    },
  });
  return { ...events, childRequests: () => childRequests, releaseRetry, retryChildStarted };
}

describe("RefreshScheduler", () => {
  it("keeps loading after an initial all-source failure but clears it for usable snapshots", async () => {
    type Mode = "failure" | "zero" | "success" | "partial";
    let mode: Mode = "failure";
    const message = (sessionID: string) => ({
      id: `${sessionID}-message`,
      role: "assistant" as const,
      providerID: "provider",
      modelID: "model",
      cost: 1,
      tokens: { input: 1, output: 0, reasoning: 0, total: 1, cache: { read: 0, write: 0 } },
    });
    const events = eventApi({
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => {
          if (mode === "failure" || (mode === "partial" && sessionID === "root")) {
            throw new Error("offline");
          }
          return mode === "zero" ? { data: [] } : { data: [{ info: message(sessionID) }] };
        },
        children: async ({ sessionID }: { sessionID: string }) => ({
          data:
            sessionID === "root" && (mode === "failure" || mode === "partial")
              ? [{ id: "child" }]
              : [],
        }),
        get: async () => ({ data: undefined }),
      },
    });
    const refreshLoading = async (store: SessionMetricsStore) => {
      let hasUsableSnapshot = store.hasUsableSnapshot("root");
      await store.refresh("root");
      hasUsableSnapshot ||= store.hasUsableSnapshot("root");
      return shouldShowLoading(true, hasUsableSnapshot);
    };

    const store = new SessionMetricsStore(events.api, { includeSubagents: true });
    assert.equal(await refreshLoading(store), true);
    assert.equal(store.hasUsableSnapshot("root"), false);

    mode = "zero";
    store.invalidate("root");
    assert.equal(await refreshLoading(store), false);
    assert.equal(store.hasUsableSnapshot("root"), true);

    mode = "failure";
    store.invalidate("root");
    assert.equal(await refreshLoading(store), false);

    mode = "partial";
    const partialStore = new SessionMetricsStore(events.api, { includeSubagents: true });
    const partialLoading = await refreshLoading(partialStore);
    assert.equal(partialStore.get("root").tokens.total, 1);
    assert.equal(partialLoading, false);
    assert.equal(partialStore.hasUsableSnapshot("root"), true);

    mode = "success";
    const successfulStore = new SessionMetricsStore(events.api, { includeSubagents: true });
    assert.equal(await refreshLoading(successfulStore), false);
  });

  it("keeps a partial snapshot visible while a failed child retry is pending", async () => {
    const events = partialRefreshEventApi();
    const store = new SessionMetricsStore(events.api, { includeSubagents: true });
    const timers = new FakeTimers();
    let refreshes = 0;
    let hasUsableSnapshot = store.hasUsableSnapshot("root");
    let loading = false;
    let markInitialFinished!: () => void;
    const initialFinished = new Promise<void>((resolve) => {
      markInitialFinished = resolve;
    });
    const scheduler = new RefreshScheduler({
      api: events.api,
      store,
      sessionID: "root",
      includeSubagents: true,
      timers: timers.timers,
      onRefresh: async (signal) => {
        refreshes += 1;
        loading = shouldShowLoading(true, hasUsableSnapshot);
        await store.refresh("root", { signal });
        if (!signal.aborted) {
          hasUsableSnapshot ||= store.hasUsableSnapshot("root");
          loading = shouldShowLoading(true, hasUsableSnapshot);
        }
        if (refreshes === 1) markInitialFinished();
        return !store.isDirty("root");
      },
    });

    try {
      scheduler.start();
      await initialFinished;
      assert.equal(store.get("root").tokens.total, 7);
      assert.equal(store.get("root").cost, 1.23);
      assert.equal(store.isDirty("root"), true);

      events.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await events.retryChildStarted;

      assert.equal(events.childRequests(), 2);
      assert.equal(store.get("root").tokens.total, 7);
      assert.equal(store.get("root").cost, 1.23);
      assert.equal(loading, false);
    } finally {
      events.releaseRetry();
      scheduler.dispose();
      await Promise.resolve();
      await Promise.resolve();
    }
  });

  it("keeps cached metrics visible during a deferred background refresh", async () => {
    const events = metricsEventApi();
    const store = new SessionMetricsStore(events.api, { includeSubagents: true });
    await store.refresh("root");
    assert.equal(store.snapshot("root")?.tokens.total, 7);
    assert.equal(store.snapshot("root")?.cost, 1.23);

    const timers = new FakeTimers();
    let refreshes = 0;
    let markInitialFinished!: () => void;
    const initialFinished = new Promise<void>((resolve) => {
      markInitialFinished = resolve;
    });
    let markBackgroundStarted!: () => void;
    const backgroundStarted = new Promise<void>((resolve) => {
      markBackgroundStarted = resolve;
    });
    let loading = false;
    const scheduler = new RefreshScheduler({
      api: events.api,
      store,
      sessionID: "root",
      includeSubagents: true,
      timers: timers.timers,
      onRefresh: async (signal) => {
        refreshes += 1;
        loading = shouldShowLoading(true, store.hasUsableSnapshot("root"));
        if (refreshes === 2) markBackgroundStarted();
        await store.refresh("root", { signal });
        if (!signal.aborted) loading = shouldShowLoading(true, store.hasUsableSnapshot("root"));
        if (refreshes === 1) markInitialFinished();
        return !store.isDirty("root");
      },
    });

    try {
      scheduler.start();
      await initialFinished;

      events.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await backgroundStarted;

      assert.equal(scheduler.isActive, true);
      assert.equal(loading, false);
      const displayed = store.get("root");
      assert.equal(displayed.tokens.total, 7);
      assert.equal(displayed.cost, 1.23);
    } finally {
      events.release();
      scheduler.dispose();
    }
  });

  it("keeps valid primed metrics visible while network and descendant refreshes are pending", async () => {
    let releaseNetwork!: () => void;
    const networkPending = new Promise<void>((resolve) => {
      releaseNetwork = resolve;
    });
    let markNetworkStarted!: () => void;
    const networkStarted = new Promise<void>((resolve) => {
      markNetworkStarted = resolve;
    });
    let releaseDescendant!: () => void;
    const descendantPending = new Promise<void>((resolve) => {
      releaseDescendant = resolve;
    });
    let markDescendantStarted!: () => void;
    const descendantStarted = new Promise<void>((resolve) => {
      markDescendantStarted = resolve;
    });
    const rootMessage = {
      id: "root-message",
      role: "assistant" as const,
      providerID: "provider",
      modelID: "model",
      cost: 1.23,
      tokens: { input: 5, output: 0, reasoning: 0, total: 5, cache: { read: 0, write: 0 } },
    };
    const childMessage = {
      ...rootMessage,
      id: "child-message",
      cost: 0,
      tokens: { ...rootMessage.tokens, input: 2, total: 2 },
    };
    const events = eventApi({
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "root") {
            markNetworkStarted();
            await networkPending;
            return { data: [{ info: rootMessage }] };
          }
          markDescendantStarted();
          await descendantPending;
          return { data: [{ info: childMessage }] };
        },
        children: async ({ sessionID }: { sessionID: string }) => ({
          data: sessionID === "root" ? [{ id: "child" }] : [],
        }),
        get: async () => ({ data: undefined }),
      },
    });
    (events.api as any).state.session.messages = () => [rootMessage];

    const store = new SessionMetricsStore(events.api, { includeSubagents: true });
    const primed = store.prime("root");
    assert.equal(primed.tokens.total, 5);
    assert.equal(primed.cost, 1.23);
    assert.equal(store.hasUsableSnapshot("root"), true);

    let loading = shouldShowLoading(true, store.hasUsableSnapshot("root"));
    const scheduler = new RefreshScheduler({
      api: events.api,
      store,
      sessionID: "root",
      includeSubagents: true,
      onRefresh: async (signal) => {
        loading = shouldShowLoading(true, store.hasUsableSnapshot("root"));
        await store.refresh("root", { signal });
        if (!signal.aborted) loading = shouldShowLoading(true, store.hasUsableSnapshot("root"));
        return !store.isDirty("root");
      },
    });

    try {
      scheduler.start();
      await networkStarted;
      assert.equal(loading, false);
      assert.equal(store.get("root").tokens.total, 5);
      assert.equal(store.get("root").cost, 1.23);

      releaseNetwork();
      await descendantStarted;
      assert.equal(loading, false);
      assert.equal(store.get("root").tokens.total, 5);
      assert.equal(store.get("root").cost, 1.23);
    } finally {
      scheduler.dispose();
      releaseNetwork();
      releaseDescendant();
      await Promise.resolve();
      await Promise.resolve();
    }
  });

  it("debounces part deltas and queues at most one follow-up", async () => {
    const events = eventApi();
    const timers = new FakeTimers();
    const started: Array<() => void> = [];
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let markSecondFinished!: () => void;
    const secondFinished = new Promise<void>((resolve) => {
      markSecondFinished = resolve;
    });
    let calls = 0;
    const scheduler = new RefreshScheduler({
      api: events.api,
      sessionID: "root",
      timers: timers.timers,
      onRefresh: async () => {
        calls += 1;
        if (calls === 2) markSecondStarted();
        await new Promise<void>((resolve) => started.push(resolve));
        if (calls === 2) markSecondFinished();
      },
    });
    scheduler.start();
    assert.equal(calls, 1);

    events.emit({ type: "message.updated", properties: { sessionID: "root" } });
    events.emit({ type: "message.updated", properties: { sessionID: "root" } });
    assert.equal(scheduler.pendingFollowUp, true);
    assert.equal(calls, 1);
    started.shift()!();
    await secondStarted;
    assert.equal(calls, 2);
    assert.equal(scheduler.pendingFollowUp, false);
    started.shift()!();
    await secondFinished;
    await Promise.resolve();
    await Promise.resolve();

    events.emit({ type: "message.part.delta", properties: { sessionID: "root" } });
    events.emit({ type: "message.part.delta", properties: { sessionID: "root" } });
    assert.equal(calls, 2);
    timers.run(PART_DELTA_DEBOUNCE_MS);
    assert.equal(calls, 3);
    started.shift()!();
    await Promise.resolve();
    scheduler.dispose();
  });

  it("uses busy and idle poll intervals", async () => {
    const events = eventApi();
    const timers = new FakeTimers();
    let busy = false;
    let calls = 0;
    const scheduler = new RefreshScheduler({
      api: events.api,
      sessionID: "root",
      timers: timers.timers,
      isBusy: () => busy,
      onRefresh: async () => {
        calls += 1;
      },
    });
    scheduler.start();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal([...timers.tasks.values()][0]?.delay, IDLE_POLL_MS);

    busy = true;
    timers.run(IDLE_POLL_MS);
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal([...timers.tasks.values()][0]?.delay, BUSY_POLL_MS);
    scheduler.dispose();
  });

  it("backs off failed polls and cleans up late completion", async () => {
    const events = eventApi();
    const timers = new FakeTimers();
    let calls = 0;
    const scheduler = new RefreshScheduler({
      api: events.api,
      sessionID: "root",
      timers: timers.timers,
      onRefresh: async () => {
        calls += 1;
        return false;
      },
    });
    scheduler.start();
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal([...timers.tasks.values()][0]?.delay, BUSY_POLL_MS);
    timers.run(BUSY_POLL_MS);
    await Promise.resolve();
    assert.equal(calls, 2);
    assert.equal([...timers.tasks.values()][0]?.delay, BUSY_POLL_MS * 2);

    const cleanupEvents = eventApi();
    const cleanupTimers = new FakeTimers();
    const cleanupScheduler = new RefreshScheduler({
      api: cleanupEvents.api,
      sessionID: "root",
      timers: cleanupTimers.timers,
      onRefresh: async () => {},
    });
    cleanupScheduler.start();
    await Promise.resolve();
    cleanupEvents.emit({ type: "message.part.delta", properties: { sessionID: "root" } });
    assert.equal(cleanupTimers.tasks.size, 2);
    cleanupScheduler.dispose();
    assert.equal(cleanupEvents.subscriptions(), 0);
    assert.equal(cleanupEvents.unsubscribed(), 14);
    assert.equal(cleanupTimers.tasks.size, 0);
    assert.equal(cleanupTimers.cleared.length, 2);

    const lateEvents = eventApi();
    const lateTimers = new FakeTimers();
    let release!: () => void;
    let lateSignal!: AbortSignal;
    let lateCalls = 0;
    const lateScheduler = new RefreshScheduler({
      api: lateEvents.api,
      sessionID: "root",
      timers: lateTimers.timers,
      onRefresh: async (signal) => {
        lateCalls += 1;
        lateSignal = signal;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    lateScheduler.start();
    lateEvents.emit({ type: "message.updated", properties: { sessionID: "root" } });
    assert.equal(lateScheduler.pendingFollowUp, true);
    lateScheduler.dispose();
    assert.equal(lateEvents.subscriptions(), 0);
    assert.equal(lateSignal.aborted, true);
    assert.equal(lateTimers.tasks.size, 0);
    release();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(lateCalls, 1);
    assert.equal(lateScheduler.pendingFollowUp, false);
    assert.equal(lateTimers.tasks.size, 0);
    scheduler.dispose();
  });
});
