import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { SessionDataApi } from "#lib/api";
import type { Metrics } from "#lib/metrics";
import type { AssistantMessage, NormalizedMessage } from "#lib/session";

import { SessionMetricsStore } from "#lib/metrics-store";
import { modelKey } from "#lib/model-key";
import { normalizeCatalog } from "#lib/pricing";

function assertEmptyMetrics(actual: Metrics) {
  assert.equal(actual.cost, 0);
  assert.deepEqual(actual.tokens, {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
  });
  assert.deepEqual([...actual.estimatedCostByProvider], []);
  assert.deepEqual([...actual.models], []);
  assert.deepEqual([...actual.providerCosts], []);
  assert.equal(actual.totalCost, 0);
  assert.equal(actual.estimatedCost, 0);
  assert.equal(actual.cacheRate, undefined);
  assert.equal(actual.speed, undefined);
  assert.equal(actual.generationSpeed, undefined);
}

const PRESSURE_SAFETY_BOUND = 256;

async function applyPressure(store: SessionMetricsStore, prefix: string) {
  for (let index = 0; index < PRESSURE_SAFETY_BOUND; index += 1) {
    await store.refresh(`${prefix}-${index}`);
  }
}

async function pressureUntilEvicted(store: SessionMetricsStore, sessionID: string, prefix: string) {
  for (let index = 0; index < PRESSURE_SAFETY_BOUND; index += 1) {
    await store.refresh(`${prefix}-${index}`);
    if (!store.hasUsableSnapshot(sessionID)) return;
  }
  assert.fail(`session ${sessionID} was not evicted within the pressure safety bound`);
}

function message(input: number, id: string): AssistantMessage {
  return {
    id,
    sessionID: "session",
    role: "assistant",
    time: { created: 0 },
    parentID: "parent",
    providerID: "provider",
    modelID: "model",
    mode: "default",
    agent: "default",
    path: { cwd: ".", root: "." },
    cost: 0,
    tokens: { input, output: 0, reasoning: 0, total: input, cache: { read: 0, write: 0 } },
  };
}

type MessageRow = AssistantMessage | NormalizedMessage;
type ClientSession = SessionDataApi["client"]["session"];
type SessionState = SessionDataApi["state"]["session"];
type SessionDataApiOverrides = {
  event?: SessionDataApi["event"];
  client?: {
    session?: {
      messages?: (...args: Parameters<ClientSession["messages"]>) => unknown;
      children?: (...args: Parameters<ClientSession["children"]>) => unknown;
      get?: (...args: Parameters<ClientSession["get"]>) => unknown;
    };
  };
  state?: {
    session?: {
      messages?: (...args: Parameters<SessionState["messages"]>) => unknown;
      get?: (...args: Parameters<NonNullable<SessionState["get"]>>) => unknown;
      status?: (...args: Parameters<NonNullable<SessionState["status"]>>) => unknown;
    };
    provider?: SessionDataApi["state"]["provider"];
  };
};

function selectMethod<Args extends readonly unknown[], Result>(
  fallback: (...args: Args) => Result,
  override: ((...args: Args) => unknown) | undefined,
): (...args: Args) => Result {
  function selected(...args: Args): Result;
  function selected(...args: Args): unknown {
    return override ? override(...args) : fallback(...args);
  }
  return selected;
}

function isAssistantMessage(value: MessageRow): value is AssistantMessage {
  return "sessionID" in value && typeof value.sessionID === "string" && "tokens" in value;
}

function assistantFixture(value: MessageRow): AssistantMessage {
  if (isAssistantMessage(value)) return value;
  const input = value.tokens?.input ?? 0;
  return {
    ...message(input, value.id ?? "message"),
    role: "assistant",
    providerID: value.providerID ?? "provider",
    modelID: value.modelID ?? "model",
    cost: value.cost ?? 0,
    time: { created: value.time?.created ?? 0, completed: value.time?.completed },
    tokens: {
      input,
      output: value.tokens?.output ?? 0,
      reasoning: value.tokens?.reasoning ?? 0,
      total: value.tokens?.total ?? input,
      cache: { read: value.tokens?.cache?.read ?? 0, write: value.tokens?.cache?.write ?? 0 },
    },
  };
}

const defaultProviders: SessionDataApi["state"]["provider"] = [
  {
    id: "provider",
    name: "Provider",
    models: {
      model: { name: "model", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      "model-new": {
        name: "model-new",
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    },
  },
  {
    id: "provider-new",
    name: "Provider New",
    models: {
      model: { name: "model", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      "model-new": {
        name: "model-new",
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      },
    },
  },
];

function apiFor(
  messages: MessageRow[] | (() => Promise<MessageRow[]>),
  providers: SessionDataApi["state"]["provider"] = defaultProviders,
) {
  let requests = 0;
  function sessionMessages(
    ...args: Parameters<ClientSession["messages"]>
  ): ReturnType<ClientSession["messages"]>;
  async function sessionMessages(...args: Parameters<ClientSession["messages"]>): Promise<unknown> {
    void args;
    requests += 1;
    const data = typeof messages === "function" ? await messages() : messages;
    return Promise.resolve({
      data: data.map((info) => ({ info: assistantFixture(info), parts: [] })),
      request: new Request("http://localhost"),
      response: new Response(),
    });
  }
  function sessionGet(...args: Parameters<ClientSession["get"]>): ReturnType<ClientSession["get"]>;
  function sessionGet(...args: Parameters<ClientSession["get"]>): Promise<unknown> {
    void args;
    return Promise.resolve({
      data: undefined,
      error: undefined,
      request: new Request("http://localhost"),
      response: new Response(),
    });
  }
  function sessionChildren(
    ...args: Parameters<ClientSession["children"]>
  ): ReturnType<ClientSession["children"]>;
  function sessionChildren(...args: Parameters<ClientSession["children"]>): Promise<unknown> {
    void args;
    return Promise.resolve({
      data: [],
      error: undefined,
      request: new Request("http://localhost"),
      response: new Response(),
    });
  }
  const api = {
    event: { on: () => () => {} },
    client: {
      session: {
        messages: sessionMessages,
        get: sessionGet,
        children: sessionChildren,
      },
    },
    state: {
      provider: providers,
      session: {
        messages: () => [],
        get: () => undefined,
        status: () => ({ type: "idle" as const }),
      },
    },
  } satisfies SessionDataApi;
  return { api, requests: () => requests };
}

function createSessionDataApi(overrides: SessionDataApiOverrides) {
  const defaults: SessionDataApi = apiFor([]).api;
  return {
    event: {
      ...defaults.event,
      ...overrides.event,
    },
    client: {
      session: {
        ...defaults.client.session,
        messages: selectMethod(
          defaults.client.session.messages,
          overrides.client?.session?.messages,
        ),
        children: selectMethod(
          defaults.client.session.children,
          overrides.client?.session?.children,
        ),
        get: selectMethod(defaults.client.session.get, overrides.client?.session?.get),
      },
    },
    state: {
      provider: overrides.state?.provider ?? defaults.state.provider,
      session: {
        ...defaults.state.session,
        messages: selectMethod(defaults.state.session.messages, overrides.state?.session?.messages),
        get: selectMethod(defaults.state.session.get!, overrides.state?.session?.get),
        status: selectMethod(defaults.state.session.status!, overrides.state?.session?.status),
      },
    },
  } satisfies SessionDataApi;
}

function deferredMessages() {
  let resolve!: (messages: MessageRow[]) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<MessageRow[]>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SessionMetricsStore", () => {
  it("coalesces duplicate refreshes and returns defensive snapshots", async () => {
    let release!: (value: MessageRow[]) => void;
    const pending = new Promise<MessageRow[]>((resolve) => {
      release = resolve;
    });
    const fixture = apiFor(() => pending);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    const first = store.refresh("session");
    const second = store.refresh("session");
    assert.equal(fixture.requests(), 1);
    release([message(3, "message-1")]);

    const metrics = await first;
    assert.equal((await second).tokens.total, 3);
    assert.equal(metrics.tokens.total, 3);

    metrics.tokens.total = 99;
    assert.equal(store.get("session").tokens.total, 3);
  });

  it("starts one successor refresh after invalidation during an empty refresh", async () => {
    const firstResponse = deferredMessages();
    const secondResponse = deferredMessages();
    const responses = [firstResponse, secondResponse];
    const fixture = apiFor(() => responses.shift()!.promise);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    const first = store.refresh("session");
    store.invalidate("session");
    const second = store.refresh("session");
    assert.equal(fixture.requests(), 1);

    firstResponse.resolve([]);
    assert.equal((await first).tokens.total, 0);
    assert.equal(fixture.requests(), 2);

    secondResponse.resolve([message(3, "message-1")]);
    assert.equal((await second).tokens.total, 3);
    assert.equal(store.get("session").tokens.total, 3);
    assert.equal(store.isDirty("session"), false);
  });

  it("refreshes again when invalidated during an already-started successor", async () => {
    const firstResponse = deferredMessages();
    const secondResponse = deferredMessages();
    const thirdResponse = deferredMessages();
    const responses = [firstResponse, secondResponse, thirdResponse];
    const fixture = apiFor(() => responses.shift()!.promise);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    const first = store.refresh("session");
    store.invalidate("session");
    const second = store.refresh("session");
    assert.equal(fixture.requests(), 1);

    firstResponse.resolve([]);
    assert.equal((await first).tokens.total, 0);
    assert.equal(fixture.requests(), 2);

    store.invalidate("session");
    const third = store.refresh("session");
    assert.equal(fixture.requests(), 2);

    secondResponse.resolve([message(2, "message-2")]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(fixture.requests(), 3);

    thirdResponse.resolve([message(3, "message-3")]);
    assert.equal((await second).tokens.total, 3);
    assert.equal((await third).tokens.total, 3);
    assert.equal(store.get("session").tokens.total, 3);
    assert.equal(store.isDirty("session"), false);
    assert.equal(fixture.requests(), 3);
  });

  it("coalesces repeated invalidations and callers onto one latest successor", async () => {
    const firstResponse = deferredMessages();
    const secondResponse = deferredMessages();
    const responses = [firstResponse, secondResponse];
    const fixture = apiFor(() => responses.shift()!.promise);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    const first = store.refresh("session");
    store.invalidate("session");
    const callers = [store.refresh("session"), store.refresh("session"), store.refresh("session")];
    store.invalidate("session");
    store.invalidate("session");
    assert.equal(fixture.requests(), 1);

    firstResponse.resolve([]);
    assert.equal((await first).tokens.total, 0);
    assert.equal(fixture.requests(), 2);

    secondResponse.resolve([message(4, "message-1")]);
    for (const caller of callers) assert.equal((await caller).tokens.total, 4);
    assert.equal(store.get("session").tokens.total, 4);
    assert.equal(store.isDirty("session"), false);
    assert.equal(fixture.requests(), 2);
  });

  it("does not notify when an invalidated refresh completes stale", async () => {
    const firstResponse = deferredMessages();
    const secondResponse = deferredMessages();
    const responses = [firstResponse, secondResponse];
    const fixture = apiFor(() => responses.shift()!.promise);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const published: number[] = [];
    store.subscribe("session", () => published.push(store.get("session").tokens.total));

    const first = store.refresh("session");
    store.invalidate("session");
    published.length = 0;
    const second = store.refresh("session");

    firstResponse.resolve([]);
    await first;
    assert.deepEqual(published, []);
    assert.equal(fixture.requests(), 2);

    secondResponse.resolve([message(5, "message-1")]);
    await second;
    assert.deepEqual(published, [5, 5]);
  });

  it("starts a successor when the invalidated first refresh fails", async () => {
    const firstResponse = deferredMessages();
    const secondResponse = deferredMessages();
    const responses = [firstResponse, secondResponse];
    const fixture = apiFor(() => responses.shift()!.promise);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    const first = store.refresh("session");
    store.invalidate("session");
    const second = store.refresh("session");
    firstResponse.reject(new Error("offline"));
    assert.equal((await first).tokens.total, 0);
    assert.equal(fixture.requests(), 2);

    secondResponse.resolve([message(6, "message-1")]);
    assert.equal((await second).tokens.total, 6);
    assert.equal(store.get("session").tokens.total, 6);
    assert.equal(store.isDirty("session"), false);
  });

  it("does not start or notify a successor after disposal", async () => {
    const firstResponse = deferredMessages();
    const secondResponse = deferredMessages();
    const responses = [firstResponse, secondResponse];
    const fixture = apiFor(() => responses.shift()!.promise);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    let notifications = 0;
    store.subscribe("session", () => {
      notifications += 1;
    });

    const first = store.refresh("session");
    store.invalidate("session");
    const successor = store.refresh("session");
    notifications = 0;
    store.dispose();
    firstResponse.resolve([message(7, "message-1")]);

    assert.equal((await first).tokens.total, 0);
    assert.equal((await successor).tokens.total, 0);
    assert.equal(fixture.requests(), 1);
    assert.equal(notifications, 0);
    assert.equal(store.get("session").tokens.total, 0);
  });

  it("lets a second active caller finish after the first caller aborts", async () => {
    let release!: (value: MessageRow[]) => void;
    const pending = new Promise<MessageRow[]>((resolve) => {
      release = resolve;
    });
    const fixture = apiFor(() => pending);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = store.refresh("session", { signal: firstController.signal });
    const second = store.refresh("session", { signal: secondController.signal });
    assert.equal(fixture.requests(), 1);

    firstController.abort();
    assertEmptyMetrics(await first);

    release([message(3, "message-1")]);
    assert.equal((await second).tokens.total, 3);
    assert.equal(store.get("session").tokens.total, 3);
    assert.equal(fixture.requests(), 1);
  });

  it("keeps the first active caller committed after the second caller aborts", async () => {
    let release!: (value: MessageRow[]) => void;
    const pending = new Promise<MessageRow[]>((resolve) => {
      release = resolve;
    });
    const fixture = apiFor(() => pending);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = store.refresh("session", { signal: firstController.signal });
    const second = store.refresh("session", { signal: secondController.signal });
    assert.equal(fixture.requests(), 1);

    secondController.abort();
    assertEmptyMetrics(await second);

    release([message(4, "message-1")]);
    assert.equal((await first).tokens.total, 4);
    assert.equal(store.get("session").tokens.total, 4);
    assert.equal(fixture.requests(), 1);
  });

  it("shares descendant own loads between parent and direct refresh callers", async () => {
    let releaseChild!: () => void;
    const childPending = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    let childRequests = 0;
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root") return { data: [{ info: message(1, "root-message") }] };
            childRequests += 1;
            markChildStarted();
            await childPending;
            return { data: [{ info: message(2, "child-message") }] };
          },
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
          get: async () => ({ data: undefined }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });
    const parentController = new AbortController();
    const parent = store.refresh("root", { signal: parentController.signal });

    await childStarted;
    const childController = new AbortController();
    const direct = store.refresh("child", { signal: childController.signal });
    const childObserver = store.refresh("child");
    childController.abort();
    assert.equal((await direct).tokens.total, 0);

    releaseChild();
    assert.equal((await parent).tokens.total, 3);
    assert.equal((await childObserver).tokens.total, 2);
    assert.equal(store.get("root").tokens.total, 3);
    assert.equal(childRequests, 1);
  });

  it("starts a successor when a descendant own load is invalidated before direct refresh", async () => {
    const staleResponse = deferredMessages();
    const freshResponse = deferredMessages();
    let childRequests = 0;
    let activeChildRequests = 0;
    let maximumChildRequests = 0;
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    const messageResponse = (rows: MessageRow[]) => ({
      data: rows.map((info) => ({ info, parts: [] })),
      error: undefined,
      request: new Request("http://localhost"),
      response: new Response(),
    });
    const api = createSessionDataApi({
      client: {
        session: {
          messages: async ({ sessionID }: Parameters<ClientSession["messages"]>[0]) => {
            if (sessionID === "root") return messageResponse([message(1, "root-message")]);

            childRequests += 1;
            activeChildRequests += 1;
            maximumChildRequests = Math.max(maximumChildRequests, activeChildRequests);
            markChildStarted();
            const result =
              childRequests === 1 ? await staleResponse.promise : await freshResponse.promise;
            activeChildRequests -= 1;
            return messageResponse(result);
          },
          children: async ({ sessionID }: Parameters<ClientSession["children"]>[0]) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
            error: undefined,
            request: new Request("http://localhost"),
            response: new Response(),
          }),
        },
      },
    });
    const store = new SessionMetricsStore(api, { includeSubagents: true });

    const parent = store.refresh("root");
    await childStarted;
    store.invalidate("child");
    const direct = store.refresh("child");

    assert.equal(childRequests, 1);
    assert.equal(maximumChildRequests, 1);

    staleResponse.resolve([message(0, "stale-child-message")]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal(childRequests, 2);
    assert.equal(maximumChildRequests, 1);

    freshResponse.resolve([message(7, "fresh-child-message")]);
    await parent;
    assert.equal((await direct).tokens.total, 7);
    assert.equal(store.get("child").tokens.total, 7);
    assert.equal(store.isDirty("child"), false);
    assert.equal(childRequests, 2);
    assert.equal(maximumChildRequests, 1);
  });

  it("does not publish an aggregate from an obsolete include-subagents mode", async () => {
    let releaseChild!: () => void;
    const childPending = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let markChildStarted!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      markChildStarted = resolve;
    });
    let rootRequests = 0;
    let childRequests = 0;
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root") {
              rootRequests += 1;
              return { data: [{ info: message(1, "root-message") }] };
            }
            childRequests += 1;
            markChildStarted();
            await childPending;
            return { data: [{ info: message(10, "child-message") }] };
          },
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
          get: async () => ({ data: undefined }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });
    const aggregate = store.refresh("root");

    await childStarted;
    store.setIncludeSubagents(false);
    releaseChild();

    assert.equal((await aggregate).tokens.total, 1);
    assert.equal(store.get("root").tokens.total, 1);
    assert.equal(store.isDirty("root"), true);

    const ownOnly = await store.refresh("root");
    assert.equal(ownOnly.tokens.total, 1);
    assert.deepEqual(store.descendants("root"), []);
    assert.equal(store.isDirty("root"), false);
    assert.equal(rootRequests, 2);
    assert.equal(childRequests, 1);
  });

  it("retains the last successful snapshot after an HTTP error with no fallback", async () => {
    let fail = false;
    const fixture = apiFor(async () => {
      if (fail) throw new Error("offline");
      return [message(4, "message-1")];
    });
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    assert.equal((await store.refresh("session")).tokens.total, 4);
    fail = true;
    store.invalidate("session");
    assert.equal((await store.refresh("session")).tokens.total, 4);
    assert.equal(store.isDirty("session"), true);
  });

  it("rebuilds an empty snapshot instead of appending to stale metrics", async () => {
    let rows: MessageRow[] = [message(5, "message-1")];
    const fixture = apiFor(async () => rows);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    assert.equal((await store.refresh("session")).tokens.total, 5);

    rows = [];
    store.invalidate("session");
    assert.equal((await store.refresh("session")).tokens.total, 0);

    rows = [message(5, "message-1"), message(2, "message-2")];
    store.invalidate("session");
    assert.equal((await store.refresh("session")).tokens.total, 7);
    assert.equal(store.isDirty("session"), false);
    assert.equal(store.hasUsableSnapshot("session"), true);
  });

  it("treats a successful zero snapshot as usable", async () => {
    const fixture = apiFor([]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    assertEmptyMetrics(await store.refresh("session"));
    assert.equal(store.hasUsableSnapshot("session"), true);
  });

  it("keeps a successful descendant aggregate usable when the root load fails", async () => {
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root") throw new Error("offline");
            return { data: [{ info: { ...message(2, "child-message"), cost: 1 } }] };
          },
          get: async () => ({ data: undefined }),
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });

    const partial = await store.refresh("root");

    assert.equal(partial.tokens.total, 2);
    assert.equal(partial.cost, 1);
    assert.equal(store.hasUsableSnapshot("root"), true);
    assert.equal(store.isDirty("root"), true);
  });

  it("keeps an aggregate usable when the root load fails but the child succeeds", async () => {
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "child") return { data: [{ info: message(2, "child-message") }] };
            throw new Error("offline");
          },
          get: async () => ({ data: undefined }),
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });

    assert.equal((await store.refresh("root")).tokens.total, 2);
    assert.equal(store.hasUsableSnapshot("root"), true);
    assert.equal(store.isDirty("root"), true);

    await pressureUntilEvicted(store, "child", "pressure");
    assertEmptyMetrics(store.prime("child"));
  });

  it("publishes only valid primed TUI messages and session rollups", () => {
    const tuiMessage = { ...message(5, "message-1"), cost: 1.23 };
    const tuiApi = {
      state: {
        provider: [],
        session: { messages: () => [tuiMessage], get: () => undefined },
      },
    };
    const tuiStore = new SessionMetricsStore(createSessionDataApi(tuiApi), {
      includeSubagents: true,
    });

    assert.equal(tuiStore.prime("session").tokens.total, 5);
    assert.equal(tuiStore.get("session").cost, 1.23);
    assert.equal(tuiStore.hasUsableSnapshot("session"), true);

    const rollupApi = {
      state: {
        provider: [],
        session: {
          messages: () => [],
          get: () => ({ id: "session", cost: 0, tokens: { total: 0 } }),
        },
      },
    };
    const rollupStore = new SessionMetricsStore(createSessionDataApi(rollupApi), {
      includeSubagents: true,
    });

    assertEmptyMetrics(rollupStore.prime("session"));
    assert.equal(rollupStore.hasUsableSnapshot("session"), true);

    const emptyApi = {
      state: {
        provider: [],
        session: { messages: () => [], get: () => ({ id: "session" }) },
      },
    };
    const emptyStore = new SessionMetricsStore(createSessionDataApi(emptyApi), {
      includeSubagents: true,
    });

    assertEmptyMetrics(emptyStore.prime("session"));
    assert.equal(emptyStore.hasUsableSnapshot("session"), false);
  });

  it("rebuilds follow-up HTTP messages after a rollup transition", async () => {
    let rows: MessageRow[] = [];
    const api = {
      client: {
        session: {
          messages: async () => ({ data: rows.map((info) => ({ info })) }),
          get: async () => ({ data: undefined }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [],
        session: {
          messages: () => [],
          get: () => ({ id: "session", cost: 2, tokens: { total: 7 } }),
        },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: false });

    assert.equal((await store.refresh("session")).tokens.total, 7);

    rows = [message(5, "message-1"), message(2, "message-2")];
    store.invalidate("session");
    assert.equal((await store.refresh("session")).tokens.total, 7);
  });

  it("keeps the root dirty when a descendant metric refresh fails", async () => {
    let failChild = false;
    let childRequests = 0;
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "child") {
              childRequests += 1;
              if (failChild) throw new Error("offline");
            }
            return {
              data: [{ info: message(sessionID === "child" ? 2 : 1, `${sessionID}-message`) }],
            };
          },
          get: async () => ({ data: undefined }),
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });

    assert.equal((await store.refresh("root")).tokens.total, 3);
    assert.equal(store.isDirty("root"), false);

    failChild = true;
    const stale = await store.refresh("root");
    assert.equal(stale.tokens.total, 3);
    assert.equal(store.get("root").tokens.total, 3);
    assert.equal(store.hasUsableSnapshot("root"), true);
    assert.equal(store.isDirty("child"), true);
    assert.equal(store.isDirty("root"), true);

    failChild = false;
    assert.equal((await store.refresh("root")).tokens.total, 3);
    assert.equal(store.isDirty("root"), false);
    assert.equal(childRequests, 3);
  });

  it("treats SDK-shaped message errors as failed refreshes", async () => {
    let failed = false;
    const initial = { ...message(5, "message-1"), cost: 1 };
    const api = {
      client: {
        session: {
          messages: async () =>
            failed
              ? { data: undefined, error: { name: "Offline" } }
              : { data: [{ info: initial }] },
          get: async () => ({ data: undefined, error: { name: "Offline" } }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => ({ id: "session" }) },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: false });

    assert.equal((await store.refresh("session")).tokens.total, 5);
    failed = true;
    store.invalidate("session");
    const stale = await store.refresh("session");
    assert.equal(stale.tokens.total, 5);
    assert.equal(stale.cost, 1);
    assert.equal(store.isDirty("session"), true);
  });

  it("aggregates only the appended message delta", async () => {
    const reads = new Map<string, number>();
    const trackedMessage = (input: number, id: string) => {
      const value = message(input, id);
      Object.defineProperty(value, "tokens", {
        get() {
          reads.set(id, (reads.get(id) ?? 0) + 1);
          return { input, output: 0, reasoning: 0, total: input, cache: { read: 0, write: 0 } };
        },
      });
      return value;
    };
    const first = trackedMessage(1, "message-1");
    const second = trackedMessage(2, "message-2");
    let rows: MessageRow[] = [first, second];
    const fixture = apiFor(async () => rows);
    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 1 } } } } });
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });

    await store.refresh("session");
    assert.deepEqual([...reads.values()], [2, 2]);

    const appended = trackedMessage(3, "message-3");
    rows = [...rows, appended];
    store.invalidate("session");
    const metrics = await store.refresh("session");

    assert.equal(reads.get("message-1"), 4);
    assert.equal(reads.get("message-2"), 4);
    assert.equal(reads.get("message-3"), 2);
    assert.deepEqual(metrics.tokens, {
      input: 6,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      total: 6,
    });
    assert.equal(metrics.cost, 0);
    assert.deepEqual(
      [...metrics.estimatedCostByProvider.entries()],
      [["provider", { name: "Provider", cost: 0.000006 }]],
    );
    assert.equal(metrics.models.size, 1);
    assert.deepEqual(metrics.models.get(modelKey("provider", "model")), {
      providerID: "provider",
      modelID: "model",
      input: 6,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheRate: 0,
      speed: undefined,
      cost: 0.000006,
      reportedCost: 0,
      estimatedCost: 0.000006,
    });
  });

  it("keeps colliding pricing pairs distinct through incremental refresh", async () => {
    const first = { ...message(1_000_000, "message-1"), providerID: "a/b", modelID: "c" };
    const second = { ...message(1_000_000, "message-2"), providerID: "a", modelID: "b/c" };
    let rows: MessageRow[] = [first];
    const catalog = normalizeCatalog({
      "a/b": { models: { c: { cost: { input: 1 } } } },
      a: { models: { "b/c": { cost: { input: 9 } } } },
    });
    const api = {
      client: {
        session: {
          messages: async () => ({ data: rows.map((info) => ({ info })) }),
          get: async () => ({ data: undefined }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [
          {
            id: "a/b",
            name: "A/B",
            models: {
              c: { name: "c", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
              "b/c": { name: "b/c", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
            },
          },
          {
            id: "a",
            name: "A",
            models: {
              c: { name: "c", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
              "b/c": { name: "b/c", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
            },
          },
        ] satisfies SessionDataApi["state"]["provider"],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), {
      catalog,
      includeSubagents: false,
    });

    const initial = await store.refresh("session");
    assert.equal(initial.models.get(modelKey("a/b", "c"))?.cost, 1);

    rows = [first, second];
    store.invalidate("session");
    const incremental = await store.refresh("session");

    assert.equal(incremental.models.size, 2);
    assert.equal(incremental.models.get(modelKey("a/b", "c"))?.cost, 1);
    assert.equal(incremental.models.get(modelKey("a", "b/c"))?.cost, 9);
    assert.equal(incremental.estimatedCostByProvider.get("a/b")?.cost, 1);
    assert.equal(incremental.estimatedCostByProvider.get("a")?.cost, 9);
  });

  it("rebuilds speed when an existing message completion changes", async () => {
    let rows: MessageRow[] = [
      {
        ...message(1, "message-1"),
        time: { created: 0, completed: 1_000 },
        tokens: { input: 1, output: 10, reasoning: 0, total: 11, cache: { read: 0, write: 0 } },
      },
    ];
    const fixture = apiFor(async () => rows);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    assert.equal((await store.refresh("session")).speed, 10);
    rows = [
      {
        ...rows[0],
        time: { created: 0, completed: 2_000 },
      },
    ];
    store.invalidate("session");

    assert.equal((await store.refresh("session")).speed, 5);
    assert.equal(store.get("session").models.get(modelKey("provider", "model"))?.speed, 5);
  });

  it("rebuilds public metrics when a stable message changes a metric input", async () => {
    const catalog = normalizeCatalog({
      provider: {
        models: {
          model: { cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
          "model-new": { cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
        },
      },
      "provider-new": {
        models: {
          model: { cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
        },
      },
    });
    const cases: Array<{
      name: string;
      mutate: (value: {
        role: "assistant" | "user";
        providerID: string;
        modelID: string;
        cost: number;
        time: { created: number; completed?: number };
        tokens: {
          input: number;
          output: number;
          reasoning: number;
          cache: { read: number; write: number };
        };
      }) => void;
      check: (metrics: Metrics) => void;
    }> = [
      {
        name: "role",
        mutate: (value) => {
          value.role = "user";
        },
        check: (metrics) => {
          assertEmptyMetrics(metrics);
        },
      },
      {
        name: "input tokens",
        mutate: (value) => {
          value.tokens.input = 11;
        },
        check: (metrics) => {
          assert.equal(metrics.tokens.input, 11);
          assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 0.000089);
        },
      },
      {
        name: "output tokens",
        mutate: (value) => {
          value.tokens.output = 21;
        },
        check: (metrics) => {
          assert.equal(metrics.tokens.output, 21);
          assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 0.00009);
        },
      },
      {
        name: "reasoning tokens",
        mutate: (value) => {
          value.tokens.reasoning = 4;
        },
        check: (metrics) => {
          assert.equal(metrics.tokens.reasoning, 4);
          assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 0.00009);
        },
      },
      {
        name: "cache read",
        mutate: (value) => {
          value.tokens.cache.read = 5;
        },
        check: (metrics) => {
          assert.equal(metrics.tokens.cache_read, 5);
          assert.equal(metrics.cacheRate, 1 / 3);
          assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 0.000091);
        },
      },
      {
        name: "cache write",
        mutate: (value) => {
          value.tokens.cache.write = 6;
        },
        check: (metrics) => {
          assert.equal(metrics.tokens.cache_write, 6);
          assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 0.000092);
        },
      },
      {
        name: "reported cost",
        mutate: (value) => {
          value.cost = 8;
        },
        check: (metrics) => {
          assert.equal(metrics.cost, 8);
          assert.equal(metrics.estimatedCost, 0);
          assert.equal([...metrics.models.values()][0]?.cost, 8);
        },
      },
      {
        name: "provider ID",
        mutate: (value) => {
          value.providerID = "provider-new";
        },
        check: (metrics) => {
          assert.equal(metrics.models.size, 1);
          assert.equal(
            metrics.models.get(modelKey("provider-new", "model"))?.providerID,
            "provider-new",
          );
          assert.equal(metrics.providerCosts.has("provider"), false);
          assert.equal(metrics.providerCosts.get("provider-new")?.reportedCost, 0);
        },
      },
      {
        name: "model ID",
        mutate: (value) => {
          value.modelID = "model-new";
        },
        check: (metrics) => {
          assert.equal(metrics.models.size, 1);
          assert.equal(metrics.models.get(modelKey("provider", "model-new"))?.modelID, "model-new");
        },
      },
      {
        name: "created time",
        mutate: (value) => {
          value.time.created = 100;
        },
        check: (metrics) => assert.equal(metrics.speed, 25.555555555555554),
      },
      {
        name: "completed time",
        mutate: (value) => {
          value.time.completed = 2_000;
        },
        check: (metrics) => assert.equal(metrics.speed, 11.5),
      },
    ];

    for (const { name, mutate, check } of cases) {
      let rows = [
        {
          ...message(10, "message-1"),
          cost: 0,
          time: { created: 0, completed: 1_000 },
          tokens: {
            total: 42,
            input: 10,
            output: 20,
            reasoning: 3,
            cache: { read: 4, write: 5 },
          },
        },
      ];
      const fixture = apiFor(async () => rows);
      const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });
      await store.refresh("session");
      mutate(rows[0]);
      store.invalidate("session");
      check(await store.refresh("session"));
      assert.equal(store.isDirty("session"), false, `${name} should refresh the cache`);
    }
  });

  it("reports finite metrics and catalog estimates for a non-finite message cost", async () => {
    const fixture = apiFor([
      {
        ...message(1_000_000, "message-1"),
        cost: Number.NaN,
      },
    ]);
    const catalog = normalizeCatalog({
      provider: { models: { model: { cost: { input: 2 } } } },
    });
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });

    const metrics = await store.refresh("session");
    assert.equal(metrics.cost, 0);
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 2);
  });

  it("keeps model and provider aggregation aligned with include-subagents", async () => {
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => ({
            data: [
              {
                info:
                  sessionID === "root"
                    ? message(1, "root-message")
                    : {
                        ...message(2, "child-message"),
                        providerID: "child-provider",
                        modelID: "child-model",
                        cost: 2,
                      },
              },
            ],
          }),
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
          get: async () => ({ data: undefined }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });

    const included = await store.refresh("root");
    assert.deepEqual(
      [...included.models.keys()],
      [modelKey("provider", "model"), modelKey("child-provider", "child-model")],
    );
    assert.equal(included.providerCosts.get("child-provider")?.cost, 2);

    store.setIncludeSubagents(false);
    const ownOnly = await store.refresh("root");
    assert.deepEqual([...ownOnly.models.keys()], [modelKey("provider", "model")]);
    assert.equal(ownOnly.providerCosts.has("child-provider"), false);
  });

  it("fully rebuilds edited, reordered, truncated, and ambiguous histories", async () => {
    let rows: MessageRow[] = [message(1, "message-1"), message(2, "message-2")];
    const fixture = apiFor(async () => rows);
    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 1 } } } } });
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });

    const histories = [
      { rows: [message(1, "message-1"), message(2, "message-2")], total: 3, estimate: 0.000003 },
      {
        rows: [message(1, "message-1"), message(2, "message-2"), message(3, "message-3")],
        total: 6,
        estimate: 0.000006,
      },
      {
        rows: [message(9, "message-1"), message(2, "message-2"), message(3, "message-3")],
        total: 14,
        estimate: 0.000014,
      },
      {
        rows: [message(2, "message-2"), message(9, "message-1"), message(3, "message-3")],
        total: 14,
        estimate: 0.000014,
      },
      { rows: [message(2, "message-2")], total: 2, estimate: 0.000002 },
      { rows: [message(2, "message-2"), message(2, "message-2")], total: 4, estimate: 0.000004 },
      { rows: [{ ...message(2, "message-2"), id: undefined }], total: 2, estimate: 0.000002 },
    ];

    for (const history of histories) {
      rows = history.rows;
      store.invalidate("session");
      const actual = await store.refresh("session");
      assert.deepEqual(actual.tokens, {
        input: history.total,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
        total: history.total,
      });
      assert.equal(actual.cost, 0);
      assert.deepEqual(
        [...actual.estimatedCostByProvider.entries()],
        [["provider", { name: "Provider", cost: history.estimate }]],
      );
      assert.equal(actual.models.size, 1);
      assert.equal(actual.models.get(modelKey("provider", "model"))?.providerID, "provider");
      assert.equal(actual.models.get(modelKey("provider", "model"))?.modelID, "model");
    }
  });

  it("invalidates estimates when the catalog changes", async () => {
    const fixture = apiFor([message(1_000_000, "message-1")]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const firstCatalog = normalizeCatalog({
      provider: { models: { model: { cost: { input: 1 } } } },
    });
    const secondCatalog = normalizeCatalog({
      provider: { models: { model: { cost: { input: 2 } } } },
    });

    store.setCatalog(firstCatalog);
    assert.equal((await store.refresh("session")).estimatedCostByProvider.get("provider")?.cost, 1);
    store.setCatalog(secondCatalog);
    assert.equal(store.isDirty("session"), true);
    assert.equal((await store.refresh("session")).estimatedCostByProvider.get("provider")?.cost, 2);
  });

  it("rebuilds estimates after in-place runtime pricing changes with unchanged messages", async () => {
    const runtimeCost = { input: 1, output: 0, cache: { read: 0, write: 0 } };
    const rows = [message(1_000_000, "message-1")];
    const api = {
      client: {
        session: {
          messages: async () => ({ data: rows.map((info) => ({ info })) }),
          get: async () => ({ data: undefined }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [
          {
            id: "provider",
            name: "Provider",
            models: { model: { name: "model", cost: runtimeCost } },
          },
        ],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: false });

    const first = await store.refresh("session");
    assert.equal(first.estimatedCostByProvider.get("provider")?.cost, 1);

    runtimeCost.input = 2;
    store.invalidate("session");
    const second = await store.refresh("session");

    assert.equal(second.estimatedCostByProvider.get("provider")?.cost, 2);
  });

  it("rebuilds estimates after in-place catalog pricing changes with unchanged messages", async () => {
    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 1 } } } } });
    const runtimeCost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    const provider = {
      id: "provider",
      name: "Provider",
      models: {
        model: { name: "model", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
      },
    };
    const fixture = apiFor([message(1_000_000, "message-1")], [provider]);
    provider.models.model.cost = runtimeCost;
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });

    const first = await store.refresh("session");
    assert.equal(first.estimatedCostByProvider.get("provider")?.cost, 1);

    catalog.get(modelKey("provider", "model"))!.cost.input = 2;
    store.invalidate("session");
    const second = await store.refresh("session");

    assert.equal(second.estimatedCostByProvider.get("provider")?.cost, 2);
  });

  it("refreshes estimates promptly when catalog loading follows the first refresh", async () => {
    let release!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const api = {
      client: {
        session: {
          messages: async () => {
            requests += 1;
            if (requests === 1) await firstResponse;
            return { data: [{ info: message(1_000_000, "message-1") }] };
          },
          get: async () => ({ data: undefined }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [
          {
            id: "provider",
            name: "Provider",
            models: {
              model: { name: "model", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
            },
          },
        ],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: false });
    const initial = store.refresh("session");
    release();
    await initial;

    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 2 } } } } });
    store.setCatalog(catalog);
    const refreshed = await store.refreshAll();

    assert.equal(requests, 2);
    assert.equal(refreshed.get("session")?.estimatedCostByProvider.get("provider")?.cost, 2);
    assert.equal(store.isDirty("session"), false);
  });

  it("bounds descendant metric requests and preserves BFS order after out-of-order completion", async () => {
    const descendants = ["a", "b", "c", "d", "a1", "a2", "b1", "c1"];
    const childrenByParent: Record<string, string[]> = {
      root: ["a", "b", "c", "d"],
      a: ["a1", "a2"],
      b: ["b1"],
      c: ["c1"],
    };
    const pending: Array<{
      id: string;
      resolve: (response: { data: Array<{ info: unknown }> }) => void;
    }> = [];
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    let markFirstBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      markFirstBatch = resolve;
    });
    let markSecondBatch!: () => void;
    const secondBatch = new Promise<void>((resolve) => {
      markSecondBatch = resolve;
    });
    const metric = (id: string, input = 1) => ({
      id: `message-${id}`,
      role: "assistant" as const,
      providerID: `provider-${id}`,
      modelID: "model",
      cost: 0,
      tokens: { input, output: 0, reasoning: 0, total: input, cache: { read: 0, write: 0 } },
    });
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: (childrenByParent[sessionID] ?? []).map((id) => ({ id })),
          }),
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root")
              return { data: [{ info: { id: "root-message", role: "user" } }] };
            active += 1;
            maximum = Math.max(maximum, active);
            started.push(sessionID);
            if (started.length === 4) markFirstBatch();
            if (started.length === descendants.length) markSecondBatch();
            return await new Promise<{ data: Array<{ info: unknown }> }>((resolve) => {
              pending.push({ id: sessionID, resolve });
            }).finally(() => {
              active -= 1;
            });
          },
          get: async () => ({ data: undefined }),
        },
      },
      state: {
        provider: descendants.map((id) => ({
          id: `provider-${id}`,
          name: id,
          models: {
            model: { name: "model", cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } },
          },
        })),
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });
    const refresh = store.refresh("root");

    await firstBatch;
    assert.equal(started.length, 4);
    assert.equal(pending.length, 4);
    for (const request of pending.splice(0).reverse()) {
      request.resolve({ data: [{ info: metric(request.id) }] });
    }

    await secondBatch;
    assert.equal(pending.length, 4);
    for (const request of pending.splice(0).reverse()) {
      request.resolve({ data: [{ info: metric(request.id) }] });
    }

    const metrics = await refresh;
    assert.equal(maximum, 4);
    assert.deepEqual(started, descendants);
    assert.deepEqual(store.descendants("root"), descendants);
    assert.equal(metrics.tokens.total, descendants.length);
    assert.deepEqual(
      [...metrics.estimatedCostByProvider.keys()],
      descendants.map((id) => `provider-${id}`),
    );
  });

  it("loads all descendants before trimming idle aggregate records", async () => {
    const descendants = Array.from({ length: 40 }, (_, index) => `child-${index}`);
    const pending: Array<{
      id: string;
      resolve: (response: { data: Array<{ info: unknown }> }) => void;
    }> = [];
    const started: string[] = [];
    const startedWaiters = new Map<number, () => void>();
    let active = 0;
    let maximum = 0;

    const waitForStarted = (count: number) => {
      if (started.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => startedWaiters.set(count, resolve));
    };
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? descendants.map((id) => ({ id })) : [],
          }),
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root")
              return { data: [{ info: { id: "root-message", role: "user" } }] };
            active += 1;
            maximum = Math.max(maximum, active);
            started.push(sessionID);
            startedWaiters.get(started.length)?.();
            return await new Promise<{ data: Array<{ info: unknown }> }>((resolve) => {
              pending.push({ id: sessionID, resolve });
            }).finally(() => {
              active -= 1;
            });
          },
          get: async () => ({ data: undefined }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });
    const refresh = store.refresh("root");

    for (let count = 4; count <= descendants.length; count += 4) {
      await waitForStarted(count);
      assert.equal(active, 4);
      assert.equal(pending.length, 4);
      for (const request of pending.splice(0)) {
        request.resolve({ data: [{ info: message(1, `message-${request.id}`) }] });
      }
    }

    const metrics = await refresh;
    assert.equal(started.length, descendants.length);
    assert.equal(maximum, 4);
    assert.equal(metrics.tokens.total, descendants.length);
    assert.equal(store.get("root").tokens.total, descendants.length);
    assert.deepEqual(store.descendants("root"), descendants);
  });

  it("continues shared descendant metric requests after a caller aborts", async () => {
    const descendants = Array.from({ length: 8 }, (_, index) => `child-${index}`);
    const pending: Array<{
      id: string;
      resolve: (response: { data: Array<{ info: unknown }> }) => void;
    }> = [];
    let deferred = false;
    let releasePending = false;
    let started = 0;
    let markFirstBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => {
      markFirstBatch = resolve;
    });
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? descendants.map((id) => ({ id })) : [],
          }),
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root")
              return { data: [{ info: { id: "root-message", role: "user" } }] };
            if (!deferred) return { data: [{ info: message(1, `message-${sessionID}`) }] };
            started += 1;
            if (started === 4) markFirstBatch();
            if (releasePending) return { data: [{ info: message(100, `late-${sessionID}`) }] };
            return await new Promise<{ data: Array<{ info: unknown }> }>((resolve) => {
              pending.push({ id: sessionID, resolve });
            });
          },
          get: async () => ({ data: undefined }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });
    const initial = await store.refresh("root");
    deferred = true;
    store.invalidate("root");

    const controller = new AbortController();
    const refresh = store.refresh("root", { signal: controller.signal });
    await firstBatch;
    assert.equal(started, 4);
    assert.equal(pending.length, 4);
    const observer = store.refresh("root");
    controller.abort();
    releasePending = true;
    for (const request of pending.splice(0)) {
      request.resolve({ data: [{ info: message(100, `late-${request.id}`) }] });
    }

    const afterAbort = await refresh;
    assert.equal(afterAbort.tokens.total, initial.tokens.total);
    assert.equal((await observer).tokens.total, descendants.length * 100);
    assert.equal(started, descendants.length);
    assert.equal(store.get("root").tokens.total, descendants.length * 100);
    assert.equal(store.hasUsableSnapshot("root"), true);
    assert.equal(store.isDirty("root"), false);
  });

  it("evicts the least-recent idle records and reloads evicted sessions", async () => {
    const fixture = apiFor([message(1, "message-1")]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    await store.refresh("session-0");
    await pressureUntilEvicted(store, "session-0", "pressure");

    const requests = fixture.requests();
    assert.equal((await store.refresh("session-0")).tokens.total, 1);
    assert.equal(fixture.requests(), requests + 1);
  });

  it("protects a retained root from pressure until its final release", async () => {
    const fixture = apiFor([message(1, "message-1")]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const release = store.retain("root");

    assert.equal(store.prime("root").tokens.total, 0);
    assert.equal((await store.refresh("root")).tokens.total, 1);
    await applyPressure(store, "child");

    assert.equal(store.get("root").tokens.total, 1);
    release();
    await pressureUntilEvicted(store, "root", "after-release");
    assertEmptyMetrics(store.prime("root"));
    const requests = fixture.requests();
    assert.equal((await store.refresh("root")).tokens.total, 1);
    assert.equal(fixture.requests(), requests + 1);
  });

  it("requires the final reference-counted lease release before eviction", async () => {
    const fixture = apiFor([message(1, "message-1")]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const firstRelease = store.retain("root");
    const secondRelease = store.retain("root");

    assert.equal((await store.refresh("root")).tokens.total, 1);
    await applyPressure(store, "child");

    firstRelease();
    assert.equal(store.get("root").tokens.total, 1);
    secondRelease();
    await pressureUntilEvicted(store, "root", "after-release");
    assertEmptyMetrics(store.prime("root"));
    const requests = fixture.requests();
    assert.equal((await store.refresh("root")).tokens.total, 1);
    assert.equal(fixture.requests(), requests + 1);
  });

  it("does not evict in-flight records or publish after disposal", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            requests += 1;
            if (sessionID === "in-flight") await pending;
            return { data: [{ info: message(1, `${sessionID}-${requests}`) }] };
          },
          get: async () => ({ data: undefined }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: false });
    const inFlight = store.refresh("in-flight");

    await applyPressure(store, "session");
    assert.equal(store.get("in-flight").tokens.total, 0);

    release();
    assert.equal((await inFlight).tokens.total, 1);
    assert.equal(store.get("in-flight").tokens.total, 1);
    await pressureUntilEvicted(store, "in-flight", "after-release");

    let lateRelease!: () => void;
    const latePending = new Promise<void>((resolve) => {
      lateRelease = resolve;
    });
    const lateApi = {
      client: {
        session: {
          messages: async () => {
            await latePending;
            return { data: [{ info: message(2, "late-message") }] };
          },
          get: async () => ({ data: undefined }),
          children: async () => ({ data: [] }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const lateStore = new SessionMetricsStore(createSessionDataApi(lateApi), {
      includeSubagents: false,
    });
    const lateRefresh = lateStore.refresh("session");
    lateStore.dispose();
    lateRelease();
    assert.equal((await lateRefresh).tokens.total, 0);
    assertEmptyMetrics(lateStore.get("session"));
    assert.deepEqual(lateStore.descendants("session"), []);
    assert.equal(lateStore.prime("session").tokens.total, 0);
    assert.equal((await lateStore.refreshAll()).size, 0);
  });

  it("disposes through public behavior without late notifications", async () => {
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = {
      client: {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => {
            requests += 1;
            if (requests > 2) await pending;
            return { data: [{ info: message(1, `${sessionID}-${requests}`) }] };
          },
          get: async () => ({ data: undefined }),
          children: async ({ sessionID }: { sessionID: string }) => ({
            data: sessionID === "root" ? [{ id: "child" }] : [],
          }),
        },
      },
      state: {
        provider: [],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(createSessionDataApi(api), { includeSubagents: true });
    await store.refresh("root");
    const releaseLease = store.retain("root");
    let notifications = 0;
    store.subscribe("root", () => {
      notifications += 1;
    });
    notifications = 0;
    store.invalidate("root");
    notifications = 0;
    const late = store.refresh("root");

    store.dispose();
    releaseLease();
    release();
    await late;

    assertEmptyMetrics(store.get("root"));
    assert.deepEqual(store.descendants("root"), []);
    assert.equal(store.prime("root").tokens.total, 0);
    assert.equal(notifications, 0);
    assertEmptyMetrics(await store.refresh("root"));
    assert.deepEqual(await store.refreshAll(), new Map());
    const unsubscribe = store.subscribe("root", () => {
      notifications += 1;
    });
    unsubscribe();
    assert.equal(notifications, 0);
  });
});
