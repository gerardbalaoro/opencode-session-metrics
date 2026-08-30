import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { Event, Message, Session } from "@opencode-ai/sdk/v2";

import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { RefreshApi, SessionDataApi } from "#lib/api";

import { Metrics } from "#lib/metrics";
import { SessionMetricsStore } from "#lib/metrics-store";
import { RefreshSchedulerRegistry } from "#lib/refresh";

type FullApiIsRefreshApi = TuiPluginApi extends RefreshApi ? true : false;
const fullApiIsRefreshApi: FullApiIsRefreshApi = true;
void fullApiIsRefreshApi;

type RefreshStore = Pick<SessionMetricsStore, "descendants" | "invalidate" | "isDirty" | "refresh">;
type TimerHandle = ReturnType<typeof setTimeout>;
type TimerApi = {
  setTimeout: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};
type EventType = Event["type"];
type EventHandler<Type extends EventType> = (event: Extract<Event, { type: Type }>) => void;
type UnknownEventHandler = (event: unknown) => void;

function isEventOfType<Type extends EventType>(
  event: unknown,
  type: Type,
): event is Extract<Event, { type: Type }> {
  return event !== null && typeof event === "object" && "type" in event && event.type === type;
}

class FakeTimers {
  readonly tasks = new Map<TimerHandle, { delay: number; callback: () => void }>();
  readonly timers: TimerApi = {
    setTimeout: (callback, delay) => {
      const handle = setTimeout(() => {}, 0);
      clearTimeout(handle);
      this.tasks.set(handle, { delay, callback });
      return handle;
    },
    clearTimeout: (handle) => {
      this.tasks.delete(handle);
    },
  };

  run(delay: number) {
    for (const [handle, task] of this.tasks.entries()) {
      if (task.delay !== delay) continue;
      this.tasks.delete(handle);
      task.callback();
    }
  }
}

function createRefreshApi(options: { isBusy?: () => boolean } = {}) {
  const handlers = new Map<string, Set<UnknownEventHandler>>();
  const api: RefreshApi = {
    event: {
      on<Type extends EventType>(type: Type, handler: EventHandler<Type>) {
        const registered = handlers.get(type) ?? new Set<UnknownEventHandler>();
        const listener: UnknownEventHandler = (event) => {
          if (isEventOfType(event, type)) handler(event);
        };
        registered.add(listener);
        handlers.set(type, registered);
        return () => registered.delete(listener);
      },
    },
    state: { session: { status: () => ({ type: options.isBusy?.() ? "busy" : "idle" }) } },
  };
  function dispatch(event: unknown) {
    if (event === null || typeof event !== "object" || Array.isArray(event)) return;
    const type = "type" in event && typeof event.type === "string" ? event.type : undefined;
    if (!type) return;
    for (const handler of handlers.get(type) ?? []) handler(event);
  }
  return { api, emit: (event: Event) => dispatch(event), emitMalformed: dispatch };
}

function createFakeStore(
  options: {
    descendants?: (sessionID: string) => string[];
    refresh?: (sessionID: string, signal: AbortSignal) => Promise<boolean | void>;
  } = {},
) {
  const invalidated: string[] = [];
  let dirty = false;
  const store: RefreshStore = {
    descendants: options.descendants ?? (() => []),
    invalidate(sessionID) {
      if (sessionID) invalidated.push(sessionID);
      dirty = true;
    },
    isDirty: () => dirty,
    refresh: async (sessionID, refreshOptions) => {
      dirty = false;
      await options.refresh?.(sessionID, refreshOptions?.signal ?? new AbortController().signal);
      return new Metrics();
    },
  };
  return { store, invalidated };
}

function message(id: string, total: number): Message {
  return {
    id,
    sessionID: "root",
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: "parent",
    providerID: "provider",
    modelID: "model",
    mode: "default",
    agent: "default",
    path: { cwd: ".", root: "." },
    cost: total / 10,
    tokens: { input: total, output: 0, reasoning: 0, total, cache: { read: 0, write: 0 } },
  };
}

function createSessionDataApi(messages: () => Promise<ReturnType<typeof message>[]>) {
  type ClientSession = SessionDataApi["client"]["session"];
  const request = new Request("http://localhost");
  const response = new Response();
  const session: ClientSession = {
    messages: async (...args) => {
      void args;
      return {
        data: (await messages()).map((info) => ({ info, parts: [] })),
        error: undefined,
        request,
        response,
      };
    },
    children: async (...args) => {
      void args;
      return { data: [], error: undefined, request, response };
    },
    get: async (...args) => {
      void args;
      const data: Session = {
        id: "root",
        slug: "root",
        projectID: "project",
        directory: ".",
        title: "Root",
        version: "1",
        metadata: {},
        time: { created: 0, updated: 1 },
      };
      return { data, error: undefined, request, response };
    },
  };
  return {
    client: { session },
    event: { on: () => () => {} },
    state: {
      session: { messages: () => [], get: () => undefined, status: () => ({ type: "idle" }) },
      provider: [],
    },
  } satisfies SessionDataApi;
}

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("RefreshSchedulerRegistry", () => {
  it("publishes initial empty and successful snapshots", async () => {
    const api = createSessionDataApi(async () => []);
    const store = new SessionMetricsStore(api, { includeSubagents: false });
    const registry = new RefreshSchedulerRegistry({ api, store });
    const release = registry.retain("root", false);
    await settle();
    assert.equal(store.hasUsableSnapshot("root"), true);
    assert.equal(store.get("root").tokens.total, 0);
    release();
    registry.dispose();

    const successfulApi = createSessionDataApi(async () => [message("root", 4)]);
    const successfulStore = new SessionMetricsStore(successfulApi, { includeSubagents: false });
    const successfulRegistry = new RefreshSchedulerRegistry({
      api: successfulApi,
      store: successfulStore,
    });
    const releaseSuccessful = successfulRegistry.retain("root", false);
    await settle();
    assert.equal(successfulStore.get("root").tokens.total, 4);
    releaseSuccessful();
    successfulRegistry.dispose();
  });

  it("coalesces ordinary events into one follow-up refresh", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    let calls = 0;
    const events = createRefreshApi();
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
        if (calls === 1) await pending;
      },
    });
    const registry = new RefreshSchedulerRegistry({ api: events.api, store });
    const release = registry.retain("root");
    await settle();
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "root" } });
    events.emitMalformed({ type: "session.updated", properties: { sessionID: "root" } });
    finish();
    await settle();
    assert.equal(calls, 2);
    release();
  });

  it("debounces repeated part deltas at 100 milliseconds", async () => {
    const timers = new FakeTimers();
    const events = createRefreshApi();
    let calls = 0;
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
      },
    });
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      timers: timers.timers,
    });
    const release = registry.retain("root");
    await settle();
    calls = 0;
    events.emitMalformed({ type: "message.part.delta", properties: { sessionID: "root" } });
    events.emitMalformed({ type: "message.part.delta", properties: { sessionID: "root" } });
    assert.equal(calls, 0);
    timers.run(100);
    await settle();
    assert.equal(calls, 1);
    release();
  });

  it("lets every immediate event cancel a pending debounce", async () => {
    for (const type of [
      "session.idle",
      "session.deleted",
      "session.compacted",
      "session.next.compaction.started",
      "session.next.compaction.delta",
      "session.next.compaction.ended",
    ]) {
      const timers = new FakeTimers();
      const events = createRefreshApi();
      let calls = 0;
      const { store } = createFakeStore({
        refresh: async () => {
          calls += 1;
        },
      });
      const registry = new RefreshSchedulerRegistry({
        api: events.api,
        store,
        timers: timers.timers,
      });
      const release = registry.retain("root");
      await settle();
      calls = 0;
      events.emitMalformed({ type: "message.part.delta", properties: { sessionID: "root" } });
      events.emitMalformed({ type, properties: { sessionID: "root" } });
      await settle();
      assert.equal(calls, 1);
      timers.run(100);
      assert.equal(calls, 1);
      release();
    }
  });

  it("polls idle sessions at 30000 and busy sessions at 2000", async () => {
    const timers = new FakeTimers();
    let busy = false;
    const events = createRefreshApi({ isBusy: () => busy });
    let calls = 0;
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
      },
    });
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      timers: timers.timers,
    });
    const release = registry.retain("root");
    await settle();
    assert.equal(calls, 1);
    timers.run(30_000);
    busy = true;
    await settle();
    assert.equal(calls, 2);
    assert.equal(timers.tasks.size > 0, true);
    timers.run(2_000);
    await settle();
    assert.equal(calls, 3);
    release();
  });

  it("backs off failures at 2k, 4k, 8k, 16k, then caps at 30k and resets", async () => {
    const timers = new FakeTimers();
    const events = createRefreshApi();
    let calls = 0;
    let failed = true;
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
        if (failed) throw new Error("offline");
      },
    });
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      timers: timers.timers,
    });
    const release = registry.retain("root");
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000]) {
      await settle();
      timers.run(delay);
    }
    await settle();
    assert.equal(calls, 6);
    failed = false;
    timers.run(30_000);
    await settle();
    timers.run(30_000);
    await settle();
    assert.equal(calls, 8);
    release();
  });

  it("aborts a released refresh and schedules no late follow-up", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    let signal!: AbortSignal;
    let calls = 0;
    const events = createRefreshApi();
    const { store } = createFakeStore({
      refresh: async (_id, refreshSignal) => {
        calls += 1;
        signal = refreshSignal;
        await pending;
      },
    });
    const timers = new FakeTimers();
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      timers: timers.timers,
    });
    const release = registry.retain("root");
    await settle();
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "root" } });
    release();
    assert.equal(signal.aborted, true);
    finish();
    await settle();
    assert.equal(calls, 1);
    assert.equal(timers.tasks.size, 0);
  });

  it("shares cadence for repeated retains and stops after final release", async () => {
    const timers = new FakeTimers();
    const events = createRefreshApi();
    let calls = 0;
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
      },
    });
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      timers: timers.timers,
    });
    const first = registry.retain("root");
    const second = registry.retain("root");
    await settle();
    assert.equal(calls, 1);
    first();
    timers.run(30_000);
    await settle();
    assert.equal(calls, 2);
    second();
    timers.run(30_000);
    assert.equal(calls, 2);
  });

  it("isolates includeSubagents leases", async () => {
    const events = createRefreshApi();
    let calls = 0;
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
      },
    });
    const registry = new RefreshSchedulerRegistry({ api: events.api, store });
    const withChildren = registry.retain("root", true);
    const withoutChildren = registry.retain("root", false);
    await settle();
    assert.equal(calls, 2);
    withChildren();
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "root" } });
    await settle();
    assert.equal(calls, 3);
    withoutChildren();
  });

  it("classifies all fourteen recognized event types", async () => {
    const events = createRefreshApi();
    const { store, invalidated } = createFakeStore();
    const registry = new RefreshSchedulerRegistry({ api: events.api, store });
    const release = registry.retain("root");
    await settle();
    invalidated.length = 0;
    for (const type of [
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
    ]) {
      events.emitMalformed({
        type,
        properties: { sessionID: "root", status: { type: "working" } },
      });
    }
    assert.equal(invalidated.length, 14);
    release();
  });

  it("refreshes relevant descendants but ignores unrelated sessions", async () => {
    const events = createRefreshApi();
    const { store, invalidated } = createFakeStore({ descendants: () => ["child"] });
    const registry = new RefreshSchedulerRegistry({ api: events.api, store });
    const release = registry.retain("root", true);
    await settle();
    invalidated.length = 0;
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "child" } });
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "other" } });
    await settle();
    assert.deepEqual(invalidated, ["child", "root"]);
    release();
  });

  it("ignores descendants and child creation when includeSubagents is false", async () => {
    const events = createRefreshApi();
    const { store, invalidated } = createFakeStore({ descendants: () => ["child"] });
    const registry = new RefreshSchedulerRegistry({ api: events.api, store });
    const release = registry.retain("root", false);
    await settle();
    invalidated.length = 0;
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "child" } });
    events.emitMalformed({
      type: "session.created",
      properties: { info: { id: "child", parentID: "root" } },
    });
    events.emitMalformed({ type: "message.updated", properties: { sessionID: "root" } });
    await settle();
    assert.deepEqual(invalidated, ["root"]);
    release();
  });

  it("prefers properties.sessionID over properties.info.id", async () => {
    const events = createRefreshApi();
    const { store, invalidated } = createFakeStore();
    const registry = new RefreshSchedulerRegistry({ api: events.api, store });
    const release = registry.retain("root");
    await settle();
    invalidated.length = 0;
    events.emitMalformed({
      type: "message.updated",
      properties: { sessionID: "root", info: { id: "wrong" } },
    });
    await settle();
    assert.deepEqual(invalidated, ["root"]);
    release();
  });

  it("warns once per malformed recognized envelope without redaction leaks or work", async () => {
    const events = createRefreshApi();
    const warnings: string[] = [];
    let calls = 0;
    const { store, invalidated } = createFakeStore({
      refresh: async () => {
        calls += 1;
      },
    });
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      logger: { warn: (warning) => warnings.push(warning) },
    });
    const release = registry.retain("root");
    await settle();
    warnings.length = 0;
    invalidated.length = 0;
    calls = 0;
    events.emitMalformed(null);
    events.emitMalformed({ type: "message.updated", properties: "payload-secret" });
    events.emitMalformed({
      type: "session.status",
      properties: { sessionID: "session-secret", status: {} },
    });
    events.emitMalformed({
      type: "session.created",
      properties: { sessionID: "created-secret", info: "info-secret" },
    });
    await settle();
    assert.equal(warnings.length, 3);
    assert.equal(
      warnings.every((warning) => !warning.includes("secret")),
      true,
    );
    assert.deepEqual(invalidated, []);
    assert.equal(calls, 0);
    release();
  });

  it("keeps unknown events silent and makes dispose idempotent and inert", async () => {
    const events = createRefreshApi();
    const warnings: string[] = [];
    let calls = 0;
    const { store } = createFakeStore({
      refresh: async () => {
        calls += 1;
      },
    });
    const timers = new FakeTimers();
    const registry = new RefreshSchedulerRegistry({
      api: events.api,
      store,
      timers: timers.timers,
      logger: { warn: (warning) => warnings.push(warning) },
    });
    const release = registry.retain("root");
    await settle();
    registry.dispose();
    registry.dispose();
    release();
    events.emitMalformed({ type: "unknown.event", properties: { sessionID: "root" } });
    const inert = registry.retain("root");
    inert();
    assert.equal(warnings.length, 0);
    assert.equal(calls, 1);
    assert.equal(timers.tasks.size, 0);
  });
});
