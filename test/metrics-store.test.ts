import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Metrics } from "../src/metrics.ts";
import { SessionMetricsStore } from "../src/metrics-store.ts";
import { normalizeCatalog } from "../src/pricing.ts";
import { DESCENDANT_CONCURRENCY } from "../src/session.ts";

function message(input: number, id: string) {
  return {
    id,
    role: "assistant",
    providerID: "provider",
    modelID: "model",
    cost: 0,
    tokens: { input, output: 0, reasoning: 0, total: input, cache: { read: 0, write: 0 } },
  };
}

function apiFor(messages: unknown[] | (() => Promise<unknown[]>)) {
  let requests = 0;
  const api = {
    client: {
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => {
          void sessionID;
          requests += 1;
          const data = typeof messages === "function" ? await messages() : messages;
          return { data: data.map((info) => ({ info })) };
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
          models: { model: { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } },
        },
      ],
      session: {
        messages: () => [],
        get: () => undefined,
      },
    },
  };
  return { api: api as never, requests: () => requests };
}

describe("SessionMetricsStore", () => {
  it("coalesces duplicate refreshes and returns defensive snapshots", async () => {
    let release!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => {
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

  it("lets a second active caller finish after the first caller aborts", async () => {
    let release!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => {
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
    assert.deepEqual(await first, new Metrics());

    release([message(3, "message-1")]);
    assert.equal((await second).tokens.total, 3);
    assert.equal(store.get("session").tokens.total, 3);
    assert.equal(fixture.requests(), 1);
  });

  it("keeps the first active caller committed after the second caller aborts", async () => {
    let release!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => {
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
    assert.deepEqual(await second, new Metrics());

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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });
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
    assert.equal(store.get("child").tokens.total, 2);
    assert.equal(store.get("root").tokens.total, 3);
    assert.equal(childRequests, 1);
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });
    const aggregate = store.refresh("root");

    await childStarted;
    store.setIncludeSubagents(false);
    releaseChild();

    assert.equal((await aggregate).tokens.total, 0);
    assert.equal(store.get("root").tokens.total, 0);
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

  it("rebuilds the final deletion to defensive zero metrics", async () => {
    let rows: unknown[] = [message(5, "message-1")];
    const fixture = apiFor(async () => rows);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    assert.equal((await store.refresh("session")).tokens.total, 5);

    rows = [];
    store.invalidate("session");
    const metrics = await store.refresh("session");

    assert.deepEqual(metrics, new Metrics());
    assert.equal(store.isDirty("session"), false);
    assert.equal(store.hasUsableSnapshot("session"), true);
    const record = (store as any).records.get("session");
    assert.equal(record.source, "http");
    assert.deepEqual(record.messageKeys, []);
    assert.deepEqual(record.pricingPairs, []);
  });

  it("treats a successful zero snapshot as usable", async () => {
    const fixture = apiFor([]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });

    assert.deepEqual(await store.refresh("session"), new Metrics());
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });

    const partial = await store.refresh("root");

    assert.equal(partial.tokens.total, 2);
    assert.equal(partial.cost, 1);
    assert.equal(store.hasUsableSnapshot("root"), true);
    assert.equal(store.isDirty("root"), true);
  });

  it("keeps an initial aggregate unusable when own and descendant loads fail", async () => {
    const api = {
      client: {
        session: {
          messages: async () => {
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });

    assert.deepEqual(await store.refresh("root"), new Metrics());
    assert.equal(store.hasUsableSnapshot("root"), false);
    assert.equal(store.isDirty("root"), true);
    assert.equal((store as any).temporaryPins.size, 0);
  });

  it("publishes only valid primed TUI messages and session rollups", () => {
    const tuiMessage = { ...message(5, "message-1"), cost: 1.23 };
    const tuiApi = {
      state: {
        provider: [],
        session: { messages: () => [tuiMessage], get: () => undefined },
      },
    };
    const tuiStore = new SessionMetricsStore(tuiApi as never, { includeSubagents: true });

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
    const rollupStore = new SessionMetricsStore(rollupApi as never, { includeSubagents: true });

    assert.deepEqual(rollupStore.prime("session"), new Metrics());
    assert.equal(rollupStore.hasUsableSnapshot("session"), true);

    const emptyApi = {
      state: {
        provider: [],
        session: { messages: () => [], get: () => ({ id: "session" }) },
      },
    };
    const emptyStore = new SessionMetricsStore(emptyApi as never, { includeSubagents: true });

    assert.deepEqual(emptyStore.prime("session"), new Metrics());
    assert.equal(emptyStore.hasUsableSnapshot("session"), false);
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });

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
    const store = new SessionMetricsStore(api as never, { includeSubagents: false });

    assert.equal((await store.refresh("session")).tokens.total, 5);
    failed = true;
    store.invalidate("session");
    const stale = await store.refresh("session");
    assert.equal(stale.tokens.total, 5);
    assert.equal(stale.cost, 1);
    assert.equal(store.isDirty("session"), true);
  });

  it("aggregates only the appended message delta", async () => {
    let rows: unknown[] = [
      message(1, "message-1"),
      message(2, "message-2"),
      message(3, "message-3"),
    ];
    const fixture = apiFor(async () => rows);
    const lengths: number[] = [];
    const original = Metrics.fromMessages;
    (Metrics as any).fromMessages = (...args: Parameters<typeof Metrics.fromMessages>) => {
      lengths.push(args[0].length);
      return original(...args);
    };

    try {
      const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
      await store.refresh("session");
      rows = [...rows, message(4, "message-4")];
      store.invalidate("session");
      await store.refresh("session");
    } finally {
      (Metrics as any).fromMessages = original;
    }

    assert.deepEqual(lengths, [3, 1]);
  });

  it("fully rebuilds edited, reordered, truncated, and ambiguous histories", async () => {
    let rows: unknown[] = [message(1, "message-1"), message(2, "message-2")];
    const fixture = apiFor(async () => rows);
    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 1 } } } } });
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });
    const lengths: number[] = [];
    const original = Metrics.fromMessages;
    (Metrics as any).fromMessages = (...args: Parameters<typeof Metrics.fromMessages>) => {
      lengths.push(args[0].length);
      return original(...args);
    };

    const assertParity = async (nextRows: unknown[]) => {
      rows = nextRows;
      store.invalidate("session");
      const actual = await store.refresh("session");
      const expected = original(nextRows as never, fixture.api, catalog);
      assert.deepEqual(actual.tokens, expected.tokens);
      assert.equal(actual.cost, expected.cost);
      assert.deepEqual(actual.estimatedCostByProvider, expected.estimatedCostByProvider);
    };

    try {
      await assertParity(rows);
      await assertParity([...rows, message(3, "message-3")]);
      await assertParity([
        message(9, "message-1"),
        message(2, "message-2"),
        message(3, "message-3"),
      ]);
      await assertParity([
        message(2, "message-2"),
        message(9, "message-1"),
        message(3, "message-3"),
      ]);
      await assertParity([message(2, "message-2")]);
      await assertParity([message(2, "message-2"), message(2, "message-2")]);
      await assertParity([{ ...message(2, "message-2"), id: undefined }]);
    } finally {
      (Metrics as any).fromMessages = original;
    }

    assert.deepEqual(lengths, [2, 1, 3, 3, 1, 2, 1]);
  });

  it("invalidates estimate generations when the catalog changes", async () => {
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
    const generation = store.pricingGeneration;
    store.setCatalog(secondCatalog);
    assert.equal(store.pricingGeneration > generation, true);
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
        provider: [{ id: "provider", name: "Provider", models: { model: { cost: runtimeCost } } }],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(api as never, { includeSubagents: false });

    const first = await store.refresh("session");
    const generation = store.pricingGeneration;
    assert.equal(first.estimatedCostByProvider.get("provider")?.cost, 1);

    runtimeCost.input = 2;
    store.invalidate("session");
    const second = await store.refresh("session");

    assert.equal(second.estimatedCostByProvider.get("provider")?.cost, 2);
    assert.equal(store.pricingGeneration > generation, true);
  });

  it("rebuilds estimates after in-place catalog pricing changes with unchanged messages", async () => {
    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 1 } } } } });
    const runtimeCost = { input: 0, output: 0, cache: { read: 0, write: 0 } };
    const fixture = apiFor([message(1_000_000, "message-1")]);
    (fixture.api as any).state.provider[0].models.model.cost = runtimeCost;
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });

    const first = await store.refresh("session");
    const generation = store.pricingGeneration;
    assert.equal(first.estimatedCostByProvider.get("provider")?.cost, 1);

    catalog.get("provider/model")!.cost.input = 2;
    store.invalidate("session");
    const second = await store.refresh("session");

    assert.equal(second.estimatedCostByProvider.get("provider")?.cost, 2);
    assert.equal(store.pricingGeneration > generation, true);
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
            models: { model: { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } },
          },
        ],
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(api as never, { includeSubagents: false });
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

  it("keeps incremental output equal to full rebuilds across reconciliation cases", async () => {
    let rows: unknown[] = [message(1, "message-1"), message(2, "message-2")];
    const fixture = apiFor(async () => rows);
    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 1 } } } } });
    const store = new SessionMetricsStore(fixture.api, { catalog, includeSubagents: false });

    const assertParity = async (nextRows: unknown[]) => {
      rows = nextRows;
      store.invalidate("session");
      const actual = await store.refresh("session");
      const expected = Metrics.fromMessages(nextRows as never, fixture.api, catalog);
      assert.deepEqual(actual.tokens, expected.tokens);
      assert.equal(actual.cost, expected.cost);
      assert.deepEqual(actual.estimatedCostByProvider, expected.estimatedCostByProvider);
    };

    await assertParity(rows);
    await assertParity([...rows, message(3, "message-3")]);
    await assertParity([message(9, "message-1"), message(2, "message-2"), message(3, "message-3")]);
    await assertParity([message(2, "message-2"), message(9, "message-1"), message(3, "message-3")]);
    await assertParity([message(2, "message-2")]);
    await assertParity([message(2, "message-2"), message(2, "message-2")]);
    await assertParity([{ ...message(2, "message-2"), id: undefined }]);

    const nextCatalog = normalizeCatalog({
      provider: { models: { model: { cost: { input: 3 } } } },
    });
    rows = [message(2, "message-2")];
    store.setCatalog(nextCatalog);
    const actual = await store.refresh("session");
    const expected = Metrics.fromMessages(rows as never, fixture.api, nextCatalog);
    assert.deepEqual(actual.estimatedCostByProvider, expected.estimatedCostByProvider);
    assert.equal("messages" in ((store as any).records.get("session") ?? {}), false);
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
            if (started.length === DESCENDANT_CONCURRENCY) markFirstBatch();
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
          models: { model: { cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } } },
        })),
        session: { messages: () => [], get: () => undefined },
      },
    };
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });
    const refresh = store.refresh("root");

    await firstBatch;
    assert.equal(pending.length, DESCENDANT_CONCURRENCY);
    for (const request of pending.splice(0).reverse()) {
      request.resolve({ data: [{ info: metric(request.id) }] });
    }

    await secondBatch;
    assert.equal(pending.length, DESCENDANT_CONCURRENCY);
    for (const request of pending.splice(0).reverse()) {
      request.resolve({ data: [{ info: metric(request.id) }] });
    }

    const metrics = await refresh;
    assert.equal(maximum, DESCENDANT_CONCURRENCY);
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });
    const refresh = store.refresh("root");

    for (
      let count = DESCENDANT_CONCURRENCY;
      count <= descendants.length;
      count += DESCENDANT_CONCURRENCY
    ) {
      await waitForStarted(count);
      assert.equal(active, DESCENDANT_CONCURRENCY);
      assert.equal(pending.length, DESCENDANT_CONCURRENCY);
      for (const request of pending.splice(0)) {
        request.resolve({ data: [{ info: message(1, `message-${request.id}`) }] });
      }
    }

    const metrics = await refresh;
    const records = (store as any).records as Map<string, unknown>;
    assert.equal(started.length, descendants.length);
    assert.equal(maximum, DESCENDANT_CONCURRENCY);
    assert.equal(metrics.tokens.total, descendants.length);
    assert.equal(records.size, 32);
    assert.equal(records.has("root"), true);
    assert.equal(store.get("root").tokens.total, descendants.length);
    assert.equal((store as any).temporaryPins.size, 0);
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
            if (started === DESCENDANT_CONCURRENCY) markFirstBatch();
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });
    const initial = await store.refresh("root");
    deferred = true;
    store.invalidate("root");

    const controller = new AbortController();
    const refresh = store.refresh("root", { signal: controller.signal });
    await firstBatch;
    assert.equal(pending.length, DESCENDANT_CONCURRENCY);
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
    const records = (store as any).records as Map<string, unknown>;

    for (let index = 0; index <= 32; index += 1) {
      await store.refresh(`session-${index}`);
    }

    assert.equal(records.size, 32);
    assert.equal(records.has("session-0"), false);
    assert.equal(records.has("session-1"), true);

    const requests = fixture.requests();
    await store.refresh("session-0");
    assert.equal(fixture.requests(), requests + 1);
    assert.equal(records.has("session-0"), true);
    assert.equal(records.has("session-1"), false);
  });

  it("protects a retained root from pressure until its final release", async () => {
    const fixture = apiFor([message(1, "message-1")]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const records = (store as any).records as Map<string, unknown>;
    const release = store.retain("root");

    await store.refresh("root");
    for (let index = 0; index < 32; index += 1) {
      await store.refresh(`child-${index}`);
    }

    assert.equal(records.has("root"), true);
    release();
    assert.equal(records.has("root"), false);
    assert.equal(records.size, 32);
  });

  it("requires the final reference-counted lease release before eviction", async () => {
    const fixture = apiFor([message(1, "message-1")]);
    const store = new SessionMetricsStore(fixture.api, { includeSubagents: false });
    const records = (store as any).records as Map<string, unknown>;
    const firstRelease = store.retain("root");
    const secondRelease = store.retain("root");

    await store.refresh("root");
    for (let index = 0; index < 32; index += 1) {
      await store.refresh(`child-${index}`);
    }

    firstRelease();
    assert.equal(records.has("root"), true);
    secondRelease();
    assert.equal(records.has("root"), false);
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: false });
    const inFlight = store.refresh("in-flight");
    const records = (store as any).records as Map<string, unknown>;

    for (let index = 0; index < 32; index += 1) {
      await store.refresh(`session-${index}`);
    }
    assert.equal(records.has("in-flight"), true);

    release();
    assert.equal((await inFlight).tokens.total, 1);
    assert.equal(records.has("in-flight"), true);

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
    const lateStore = new SessionMetricsStore(lateApi as never, { includeSubagents: false });
    const lateRefresh = lateStore.refresh("session");
    lateStore.dispose();
    lateRelease();
    await lateRefresh;
    assert.equal((lateStore as any).records.size, 0);
  });

  it("clears records, index state, leases, and listeners on disposal", async () => {
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
    const store = new SessionMetricsStore(api as never, { includeSubagents: true });
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

    const index = (store as any).sessionIndex;
    assert.equal((store as any).records.size, 0);
    assert.equal((store as any).leases.size, 0);
    assert.equal((store as any).listeners.size, 0);
    assert.equal(index.childrenByParent.size, 0);
    assert.equal(index.descendantsByRoot.size, 0);
    assert.equal(index.staleParents.size, 0);
    assert.equal(index.staleRoots.size, 0);
    assert.deepEqual(store.get("root"), new Metrics());
    assert.equal(notifications, 0);
  });
});
