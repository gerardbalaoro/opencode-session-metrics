import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { MetricsLoaderApi } from "#lib/api";
import type { Metrics } from "#lib/metrics";
import type { Message, NormalizedMessage, Session } from "#lib/session";

import { MetricsLoader } from "#lib/metrics-loader";

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

function assistant(input: number, output: number): NormalizedMessage {
  return {
    role: "assistant",
    cost: input / 10,
    tokens: { input, output, reasoning: 0, total: input + output },
  };
}

type ClientSession = MetricsLoaderApi["client"]["session"];
type StateMessages = ReturnType<MetricsLoaderApi["state"]["session"]["messages"]>;
type StateGet = ReturnType<MetricsLoaderApi["state"]["session"]["get"]>;
type LoaderApiOptions = {
  messages?: unknown;
  get?: unknown;
  stateMessages?: StateMessages | ((sessionID: string) => StateMessages);
  stateGet?: StateGet | ((sessionID: string) => StateGet);
};

function stateAssistant(input: number, output: number): Message {
  return {
    id: "message",
    sessionID: "session",
    role: "assistant",
    time: { created: 0, completed: 1 },
    parentID: "parent",
    modelID: "model",
    providerID: "provider",
    mode: "default",
    agent: "default",
    path: { cwd: ".", root: "." },
    cost: input / 10,
    tokens: { input, output, reasoning: 0, total: input + output, cache: { read: 0, write: 0 } },
  };
}

function stateSession(cost?: number): Session {
  return {
    id: "session",
    slug: "session",
    projectID: "project",
    directory: ".",
    title: "Session",
    version: "1",
    time: { created: 0, updated: 1 },
    ...(cost === undefined
      ? {}
      : { cost, tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 0, write: 0 } } }),
  };
}

function createLoaderApi(options: LoaderApiOptions = {}): MetricsLoaderApi {
  const messages: ClientSession["messages"] = async (...args) => {
    if (typeof options.messages === "function") return await options.messages(...args);
    return options.messages ?? { data: [] };
  };

  const get: ClientSession["get"] = async (...args) => {
    if (typeof options.get === "function") return await options.get(...args);
    return options.get ?? { data: undefined };
  };

  const children: ClientSession["children"] = async (...args) => {
    void args;
    return { data: [], request: new Request("http://localhost"), response: new Response() };
  };

  return {
    client: {
      session: {
        messages,
        get,
        children,
      },
    },
    state: {
      provider: [],
      session: {
        messages: (sessionID) =>
          (typeof options.stateMessages === "function"
            ? options.stateMessages(sessionID)
            : options.stateMessages) ?? [],
        get: (sessionID) =>
          (typeof options.stateGet === "function"
            ? options.stateGet(sessionID)
            : options.stateGet) ?? undefined,
        status: () => ({ type: "idle" as const }),
      },
    },
  } satisfies MetricsLoaderApi;
}

describe("MetricsLoader", () => {
  it("falls through SDK-shaped HTTP errors to TUI state", async () => {
    const api = createLoaderApi({
      messages: { data: undefined, error: { name: "Offline" } },
      get: { data: undefined, error: { name: "Offline" } },
      stateMessages: [stateAssistant(7, 1)],
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "tui");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("falls through a non-array HTTP history envelope to TUI state", async () => {
    const stateMessage = assistant(7, 1);
    const api = createLoaderApi({
      messages: { data: { messages: [stateMessage] } },
      get: { data: undefined, error: { name: "Offline" } },
      stateMessages: [stateAssistant(7, 1)],
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "tui");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("skips malformed HTTP rows and preserves valid SDK-shaped messages", async () => {
    const validMessage = {
      id: "message-1",
      sessionID: "session",
      role: "assistant",
      time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
      parentID: "message-0",
      modelID: "model",
      providerID: "provider",
      mode: "default",
      agent: "default",
      cost: 2,
      tokens: {
        input: 3,
        output: 4,
        reasoning: 1,
        total: 8,
        cache: { read: 0, write: 0 },
      },
    };
    const api = createLoaderApi({
      messages: {
        data: [{ info: validMessage }, { info: null }, { info: "not a message" }, { info: 42 }],
      },
      get: { data: undefined },
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "http");
    assert.deepEqual(result.messages, [
      {
        id: "message-1",
        role: "assistant",
        time: { created: 1_700_000_000_000, completed: 1_700_000_001_000 },
        modelID: "model",
        providerID: "provider",
        cost: 2,
        tokens: {
          input: 3,
          output: 4,
          reasoning: 1,
          total: 8,
          cache: { read: 0, write: 0 },
        },
      },
    ]);
    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("skips a non-object HTTP row without discarding valid history", async () => {
    const stateMessage = assistant(7, 1);
    const api = createLoaderApi({
      messages: { data: [{ info: stateMessage }, null] },
      get: { data: undefined },
      stateMessages: [stateAssistant(7, 1)],
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "http");
    assert.deepEqual(result.messages, [stateMessage]);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("rejects an in-flight HTTP metrics request after cancellation without fallback", async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let tuiCalls = 0;
    let stateRollupCalls = 0;
    let httpRollupCalls = 0;
    const api = createLoaderApi({
      messages: async (
        _input: Parameters<ClientSession["messages"]>[0],
        options: Parameters<ClientSession["messages"]>[1],
      ) => {
        markStarted();
        await new Promise<void>((resolve) => {
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { data: [] };
      },
      get: async () => {
        httpRollupCalls += 1;
        return { data: { id: "session", cost: 2, tokens: { total: 8 } } };
      },
      stateMessages: () => {
        tuiCalls += 1;
        return [stateAssistant(7, 1)];
      },
      stateGet: () => {
        stateRollupCalls += 1;
        return stateSession(2);
      },
    });

    const loading = new MetricsLoader(api).load("session", {
      signal: controller.signal,
    });

    await started;
    controller.abort();
    await assert.rejects(loading, { name: "AbortError" });
    assert.equal(tuiCalls, 0);
    assert.equal(stateRollupCalls, 0);
    assert.equal(httpRollupCalls, 0);
  });

  it("cancels a signal-ignoring HTTP messages request without fallback", async () => {
    const controller = new AbortController();
    const reason = { message: "messages cancelled" };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveMessages!: (response: unknown) => void;
    const pendingMessages = new Promise<unknown>((resolve) => {
      resolveMessages = resolve;
    });
    let tuiCalls = 0;
    let stateRollupCalls = 0;
    let httpRollupCalls = 0;
    const api = createLoaderApi({
      messages: () => {
        markStarted();
        return pendingMessages;
      },
      get: async () => {
        httpRollupCalls += 1;
        return { data: { id: "session", cost: 2, tokens: { total: 8 } } };
      },
      stateMessages: () => {
        tuiCalls += 1;
        return [];
      },
      stateGet: () => {
        stateRollupCalls += 1;
        return stateSession();
      },
    });

    const loading = new MetricsLoader(api).load("session", {
      signal: controller.signal,
    });

    await started;
    controller.abort(reason);
    await assert.rejects(loading, (error) => error === reason);
    resolveMessages({ data: [] });
    await pendingMessages;
    assert.equal(tuiCalls, 0);
    assert.equal(stateRollupCalls, 0);
    assert.equal(httpRollupCalls, 0);
  });

  it("cancels a signal-ignoring HTTP rollup request without fallback", async () => {
    const controller = new AbortController();
    const reason = { message: "rollup cancelled" };
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let resolveRollup!: (response: unknown) => void;
    const pendingRollup = new Promise<unknown>((resolve) => {
      resolveRollup = resolve;
    });
    let tuiCalls = 0;
    let stateRollupCalls = 0;
    const api = createLoaderApi({
      messages: { data: [] },
      get: () => {
        markStarted();
        return pendingRollup;
      },
      stateMessages: () => {
        tuiCalls += 1;
        return [];
      },
      stateGet: () => {
        stateRollupCalls += 1;
        return stateSession();
      },
    });

    const loading = new MetricsLoader(api).load("session", {
      signal: controller.signal,
    });

    await started;
    controller.abort(reason);
    await assert.rejects(loading, (error) => error === reason);
    resolveRollup({ data: { id: "session", cost: 2, tokens: { total: 8 } } });
    await pendingRollup;
    assert.equal(tuiCalls, 1);
    assert.equal(stateRollupCalls, 1);
  });

  it("falls back from an empty HTTP history to populated TUI state", async () => {
    const api = createLoaderApi({
      messages: { data: [] },
      get: { data: undefined },
      stateMessages: [stateAssistant(7, 1)],
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "tui");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("falls back from an empty HTTP history to a genuine session rollup", async () => {
    const api = createLoaderApi({
      messages: { data: [] },
      get: { data: undefined },
      stateGet: stateSession(2),
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "rollup");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("fetches the HTTP rollup when the local session has no rollup fields", async () => {
    let httpGetCalls = 0;
    const api = createLoaderApi({
      messages: { data: [] },
      get: async () => {
        httpGetCalls += 1;
        return { data: { id: "session", cost: 2, tokens: { total: 8 } } };
      },
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "rollup");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.tokens.total, 8);
    assert.equal(httpGetCalls, 1);
  });

  it("does not fetch the HTTP rollup when the local session rollup is genuine", async () => {
    let httpGetCalls = 0;
    const api = createLoaderApi({
      messages: { data: [] },
      get: async () => {
        httpGetCalls += 1;
        throw new Error("should not fetch HTTP rollup");
      },
      stateGet: stateSession(2),
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "rollup");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.cost, 2);
    assert.equal(httpGetCalls, 0);
  });

  it("uses an empty HTTP snapshot after no usable fallback source", async () => {
    const api = createLoaderApi({
      messages: { data: [] },
      get: { data: { id: "session" } },
      stateGet: stateSession(),
    });

    const result = await new MetricsLoader(api).load("session");

    assert.equal(result.source, "http");
    assert.equal(result.successful, true);
    assert.deepEqual(result.messages, []);
    assertEmptyMetrics(result.metrics);
  });
});
