import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../src/config.ts";
import { loadSessionMetrics, Metrics } from "../src/metrics.ts";
import {
  contextLimit,
  contextTokens,
  isContextCountWarning,
  isContextWarning,
  latestContextMessage,
  loadContext,
} from "../src/context.ts";
import { formatTokens } from "../src/utils.ts";
import {
  loadCatalog,
  loadCatalogMemoized,
  normalizeCatalog,
  openCodeCachePath,
  PricingResolver,
} from "../src/pricing.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

describe("Metrics", () => {
  function pricingApi(
    providers: any[] = [
      {
        id: "provider",
        name: "Provider",
        models: {
          model: {
            cost: { input: 1, output: 2, cache: { read: 3, write: 4 } },
          },
        },
      },
    ],
  ) {
    return { state: { provider: providers } } as never;
  }

  function pricedMessage(tokens: Record<string, unknown>, cost?: number) {
    return {
      role: "assistant",
      providerID: "provider",
      modelID: "model",
      tokens,
      ...(cost === undefined ? {} : { cost }),
    };
  }

  function descendantsApi(
    childrenByParent: Record<string, string[] | undefined>,
    messagesBySession: Record<string, unknown[]> = {},
    failures = new Set<string>(),
    stateMessagesBySession: Record<string, unknown[]> = {},
  ) {
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => {
            if (failures.has(`children:${sessionID}`)) throw new Error("request failed");
            return { data: (childrenByParent[sessionID] ?? []).map((id) => ({ id })) };
          },
          messages: async ({ sessionID }: { sessionID: string }) => {
            if (failures.has(`messages:${sessionID}`)) throw new Error("request failed");
            return { data: (messagesBySession[sessionID] ?? []).map((info) => ({ info })) };
          },
          get: async ({ sessionID }: { sessionID: string }) => ({ data: { id: sessionID } }),
        },
      },
      state: {
        session: {
          messages: (sessionID: string) => stateMessagesBySession[sessionID] ?? [],
        },
      },
    };

    return api as never;
  }

  const assistant = (input: number, output: number) => ({
    role: "assistant",
    cost: input / 10,
    tokens: { input, output, reasoning: 0, total: input + output },
  });

  it("aggregates all nested descendants while excluding the root", async () => {
    const api = descendantsApi(
      { root: ["child"], child: ["grandchild"] },
      { root: [assistant(100, 100)], child: [assistant(1, 2)], grandchild: [assistant(3, 4)] },
    );

    const metrics = await Metrics.fromSessionDescendants(api, "root");

    assert.equal(metrics.cost, 0.4);
    assert.equal(metrics.tokens.total, 10);
  });

  it("aggregates each descendant once through duplicate and cyclic relationships", async () => {
    const api = descendantsApi(
      { root: ["a", "b", "a"], a: ["b", "root"], b: ["a"] },
      { a: [assistant(1, 2)], b: [assistant(3, 4)] },
    );

    const metrics = await Metrics.fromSessionDescendants(api, "root");

    assert.equal(metrics.tokens.total, 10);
  });

  it("returns zero metrics when there are no descendants", async () => {
    const metrics = await Metrics.fromSessionDescendants(descendantsApi({ root: [] }), "root");

    assert.equal(metrics.cost, 0);
    assert.deepEqual(metrics.tokens, {
      input: 0,
      output: 0,
      reasoning: 0,
      cache_read: 0,
      cache_write: 0,
      total: 0,
    });
  });

  it("continues aggregation when a descendant list request fails", async () => {
    const api = descendantsApi(
      { root: ["working", "failed"], working: ["nested"] },
      { working: [assistant(1, 2)], nested: [assistant(3, 4)] },
      new Set(["children:failed"]),
    );

    const metrics = await Metrics.fromSessionDescendants(api, "root");

    assert.equal(metrics.tokens.total, 10);
  });

  it("preserves per-session message fallback when a descendant message request fails", async () => {
    const api = descendantsApi({ root: ["child"] }, {}, new Set(["messages:child"]), {
      child: [assistant(5, 6)],
    });

    const metrics = await Metrics.fromSessionDescendants(api, "root");

    assert.equal(metrics.tokens.total, 11);
  });

  it("aggregates assistant token and cost fields", () => {
    const metrics = Metrics.fromMessages([
      {
        role: "assistant",
        cost: 1.25,
        tokens: { input: 10, output: 20, reasoning: 3, total: 33, cache: { read: 4, write: 5 } },
      },
      { role: "user" },
      { role: "assistant", cost: 0.75, tokens: { input: 2, output: 4, reasoning: 1, cache: {} } },
    ] as never);
    assert.equal(metrics.cost, 2);
    assert.deepEqual(metrics.tokens, {
      input: 12,
      output: 24,
      reasoning: 4,
      cache_read: 4,
      cache_write: 5,
      total: 40,
    });
  });

  it("falls through SDK-shaped HTTP errors to TUI state", async () => {
    const stateMessage = assistant(7, 1);
    const result = await loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: undefined, error: { name: "Offline" } }),
            get: async () => ({ data: undefined, error: { name: "Offline" } }),
          },
        },
        state: {
          provider: [],
          session: { messages: () => [stateMessage], get: () => undefined },
        },
      } as never,
      "session",
    );

    assert.equal(result.source, "tui");
    assert.equal(result.successful, true);
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
    const loading = loadSessionMetrics(
      {
        client: {
          session: {
            messages: async (_input: unknown, options?: { signal?: AbortSignal }) => {
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
          },
        },
        state: {
          provider: [],
          session: {
            messages: () => {
              tuiCalls += 1;
              return [assistant(7, 1)];
            },
            get: () => {
              stateRollupCalls += 1;
              return { id: "session", cost: 2, tokens: { total: 8 } };
            },
          },
        },
      } as never,
      "session",
      { signal: controller.signal },
    );

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
    let resolveMessages!: (response: { data: unknown[] }) => void;
    const pendingMessages = new Promise<{ data: unknown[] }>((resolve) => {
      resolveMessages = resolve;
    });
    let tuiCalls = 0;
    let stateRollupCalls = 0;
    let httpRollupCalls = 0;
    const loading = loadSessionMetrics(
      {
        client: {
          session: {
            messages: () => {
              markStarted();
              return pendingMessages;
            },
            get: async () => {
              httpRollupCalls += 1;
              return { data: { id: "session", cost: 2, tokens: { total: 8 } } };
            },
          },
        },
        state: {
          provider: [],
          session: {
            messages: () => {
              tuiCalls += 1;
              return [];
            },
            get: () => {
              stateRollupCalls += 1;
              return { id: "session" };
            },
          },
        },
      } as never,
      "session",
      { signal: controller.signal },
    );

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
    let resolveRollup!: (response: { data: unknown }) => void;
    const pendingRollup = new Promise<{ data: unknown }>((resolve) => {
      resolveRollup = resolve;
    });
    let tuiCalls = 0;
    let stateRollupCalls = 0;
    const loading = loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            get: () => {
              markStarted();
              return pendingRollup;
            },
          },
        },
        state: {
          provider: [],
          session: {
            messages: () => {
              tuiCalls += 1;
              return [];
            },
            get: () => {
              stateRollupCalls += 1;
              return { id: "session" };
            },
          },
        },
      } as never,
      "session",
      { signal: controller.signal },
    );

    await started;
    controller.abort(reason);
    await assert.rejects(loading, (error) => error === reason);
    resolveRollup({ data: { id: "session", cost: 2, tokens: { total: 8 } } });
    await pendingRollup;
    assert.equal(tuiCalls, 1);
    assert.equal(stateRollupCalls, 1);
  });

  it("falls back from an empty HTTP history to populated TUI state", async () => {
    const stateMessage = assistant(7, 1);
    const result = await loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            get: async () => ({ data: undefined }),
          },
        },
        state: {
          provider: [],
          session: { messages: () => [stateMessage], get: () => undefined },
        },
      } as never,
      "session",
    );

    assert.equal(result.source, "tui");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("falls back from an empty HTTP history to a genuine session rollup", async () => {
    const result = await loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            get: async () => ({ data: undefined }),
          },
        },
        state: {
          provider: [],
          session: {
            messages: () => [],
            get: () => ({
              id: "session",
              cost: 2,
              tokens: { input: 3, output: 4, reasoning: 1, total: 8 },
            }),
          },
        },
      } as never,
      "session",
    );

    assert.equal(result.source, "rollup");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.tokens.total, 8);
  });

  it("fetches the HTTP rollup when the local session has no rollup fields", async () => {
    let httpGetCalls = 0;
    const result = await loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            get: async () => {
              httpGetCalls += 1;
              return { data: { id: "session", cost: 2, tokens: { total: 8 } } };
            },
          },
        },
        state: {
          provider: [],
          session: { messages: () => [], get: () => ({ id: "session" }) },
        },
      } as never,
      "session",
    );

    assert.equal(result.source, "rollup");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.tokens.total, 8);
    assert.equal(httpGetCalls, 1);
  });

  it("does not fetch the HTTP rollup when the local session rollup is genuine", async () => {
    let httpGetCalls = 0;
    const result = await loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            get: async () => {
              httpGetCalls += 1;
              throw new Error("should not fetch HTTP rollup");
            },
          },
        },
        state: {
          provider: [],
          session: {
            messages: () => [],
            get: () => ({ id: "session", cost: 2, tokens: { total: 8 } }),
          },
        },
      } as never,
      "session",
    );

    assert.equal(result.source, "rollup");
    assert.equal(result.successful, true);
    assert.equal(result.metrics.cost, 2);
    assert.equal(result.metrics.tokens.total, 8);
    assert.equal(httpGetCalls, 0);
  });

  it("uses an empty HTTP snapshot after no usable fallback source", async () => {
    const result = await loadSessionMetrics(
      {
        client: {
          session: {
            messages: async () => ({ data: [] }),
            get: async () => ({ data: { id: "session" } }),
          },
        },
        state: {
          provider: [],
          session: { messages: () => [], get: () => ({ id: "session" }) },
        },
      } as never,
      "session",
    );

    assert.equal(result.source, "http");
    assert.equal(result.successful, true);
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.metrics, new Metrics());
  });

  it("estimates zero-cost messages using normalized provider pricing", () => {
    const metrics = Metrics.fromMessages(
      [
        pricedMessage({
          input: 1_000_000,
          output: 2_000_000,
          reasoning: 3_000_000,
          cache: { read: 4_000_000, write: 5_000_000 },
        }),
      ] as never,
      pricingApi(),
    );

    assert.equal(metrics.cost, 0);
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 43);
  });

  it("falls back to the exact OpenCode catalog entry when runtime pricing is zero", () => {
    const catalog = normalizeCatalog({
      provider: {
        models: {
          model: {
            name: "Cached model",
            cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 },
          },
        },
      },
    });
    const api = pricingApi([
      {
        id: "provider",
        name: "Provider",
        models: {
          model: { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
        },
      },
    ]);
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1_000_000 })] as never,
      api,
      catalog,
    );
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 1);
  });

  it("keeps runtime pricing when only a runtime context tier is nonzero", () => {
    const catalog = normalizeCatalog({
      provider: {
        models: {
          model: {
            cost: { input: 1, output: 1, cache_read: 1, cache_write: 1 },
          },
        },
      },
    });
    const api = pricingApi([
      {
        id: "provider",
        name: "Provider",
        models: {
          model: {
            cost: {
              input: 0,
              output: 0,
              cache: { read: 0, write: 0 },
              tiers: [
                {
                  input: 5,
                  output: 0,
                  cache: { read: 0, write: 0 },
                  tier: { type: "context", size: 1 },
                },
              ],
            },
          },
        },
      },
    ]);
    const metrics = Metrics.fromMessages([pricedMessage({ input: 2 })] as never, api, catalog);
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 10 / 1_000_000);
  });

  it("does not use aliases for catalog lookup and prefers nonzero runtime pricing", () => {
    const catalog = normalizeCatalog({
      provider: {
        models: {
          model: { name: "Exact", cost: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
          alias: {
            name: "Alias",
            cost: { input: 100, output: 100, cache_read: 100, cache_write: 100 },
          },
        },
      },
    });
    const runtime = pricingApi([
      {
        id: "provider",
        name: "Provider",
        models: {
          model: { cost: { input: 5, output: 0, cache: { read: 0, write: 0 } } },
        },
      },
    ]);
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1_000_000 })] as never,
      runtime,
      catalog,
    );
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 5);
    assert.equal(catalog.get("provider/unknown"), undefined);
  });

  it("caches provider/model resolution and invalidates changed runtime and catalog pricing", () => {
    const runtimeCost = { input: 1, output: 0, cache: { read: 0, write: 0 } };
    const runtime = { cost: runtimeCost };
    const api = pricingApi([{ id: "provider", name: "Provider", models: { model: runtime } }]);
    const resolver = new PricingResolver();
    const first = resolver.resolve(api, "provider", "model");
    assert.equal(resolver.resolve(api, "provider", "model"), first);

    runtimeCost.input = 9;
    const inPlaceRuntime = resolver.resolve(api, "provider", "model");
    assert.notEqual(inPlaceRuntime, first);
    assert.equal(inPlaceRuntime?.cost?.input, 9);

    runtime.cost = { input: 2, output: 0, cache: { read: 0, write: 0 } };
    assert.equal(resolver.resolve(api, "provider", "model")?.cost?.input, 2);

    const catalog = normalizeCatalog({ provider: { models: { model: { cost: { input: 3 } } } } });
    const zeroRuntime = { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } };
    const catalogApi = pricingApi([
      { id: "provider", name: "Provider", models: { model: zeroRuntime } },
    ]);
    resolver.setCatalog(catalog);
    assert.equal(resolver.resolve(catalogApi, "provider", "model")?.cost?.input, 3);

    catalog.get("provider/model")!.cost.input = 7;
    assert.equal(resolver.resolve(catalogApi, "provider", "model")?.cost?.input, 7);
  });

  it("fingerprints every normalized pricing area from one canonical shape", () => {
    const runtimeCost = {
      input: 1,
      output: 2,
      cache_read: 3,
      cache_write: 4,
      tiers: [
        {
          input: 5,
          output: 6,
          cache_read: 7,
          cache_write: 8,
          tier: { type: "context", size: 100 },
        },
      ],
      context_over_200k: { input: 9, output: 10, cache_read: 11, cache_write: 12 },
    };
    const api = pricingApi([
      { id: "provider", name: "Provider", models: { model: { cost: runtimeCost } } },
    ]);
    const resolver = new PricingResolver();
    let resolution = resolver.resolve(api, "provider", "model");

    assert.deepEqual(
      resolution?.cost?.tiers?.map((tier) => [
        tier.tier.size,
        tier.input,
        tier.output,
        tier.cache.read,
        tier.cache.write,
      ]),
      [
        [200_000, 9, 10, 11, 12],
        [100, 5, 6, 7, 8],
      ],
    );

    const assertChanged = (
      change: () => void,
      check: (next: NonNullable<typeof resolution>) => void,
    ) => {
      const generation = resolver.pricingGeneration;
      const previous = resolution;
      change();
      resolution = resolver.resolve(api, "provider", "model");
      assert.notEqual(resolution, previous);
      assert.ok(resolver.pricingGeneration > generation);
      assert.ok(resolution);
      check(resolution);
    };

    assertChanged(
      () => {
        runtimeCost.input = 13;
      },
      (next) => assert.equal(next.cost?.input, 13),
    );
    assertChanged(
      () => {
        runtimeCost.output = 14;
      },
      (next) => assert.equal(next.cost?.output, 14),
    );
    assertChanged(
      () => {
        runtimeCost.cache_read = 15;
      },
      (next) => assert.equal(next.cost?.cache.read, 15),
    );
    assertChanged(
      () => {
        runtimeCost.cache_write = 16;
      },
      (next) => assert.equal(next.cost?.cache.write, 16),
    );
    assertChanged(
      () => {
        runtimeCost.tiers[0].input = 17;
      },
      (next) => assert.equal(next.cost?.tiers?.[1].input, 17),
    );
    assertChanged(
      () => {
        runtimeCost.context_over_200k.output = 18;
      },
      (next) => assert.equal(next.cost?.tiers?.[0].output, 18),
    );
  });

  it("normalizes context tiers and safely ignores malformed catalog data", () => {
    const catalog = normalizeCatalog({
      provider: {
        models: {
          model: {
            cost: {
              input: 1,
              output: 2,
              cache_read: 3,
              cache_write: 4,
              tiers: [
                {
                  input: 5,
                  output: 6,
                  cache_read: 7,
                  cache_write: 8,
                  tier: { type: "context", size: 200_000 },
                },
              ],
            },
          },
        },
      },
    });
    assert.equal(catalog.get("provider/model")?.cost.tiers?.[0].cache.read, 7);
    assert.equal(normalizeCatalog(undefined).size, 0);
  });

  it("gracefully handles missing and malformed cache files", async () => {
    assert.equal((await loadCatalog("/does/not/exist")).size, 0);
    const directory = await mkdtemp(join(tmpdir(), "session-metrics-"));
    try {
      const path = join(directory, "models.json");
      await writeFile(path, "not json", "utf8");
      assert.equal((await loadCatalog(path)).size, 0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("memoizes shared catalog loading without changing malformed-data fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-metrics-loader-"));
    try {
      const path = join(directory, "models.json");
      await writeFile(
        path,
        JSON.stringify({ provider: { models: { model: { cost: { input: 1 } } } } }),
        "utf8",
      );
      assert.equal((await loadCatalogMemoized(path)).get("provider/model")?.cost.input, 1);
      await writeFile(path, "not json", "utf8");
      assert.equal((await loadCatalogMemoized(path)).get("provider/model")?.cost.input, 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves the OpenCode cache path with set, empty, and unset XDG values", () => {
    assert.equal(
      openCodeCachePath({ XDG_CACHE_HOME: "/tmp/custom-cache" }),
      "/tmp/custom-cache/opencode/models.json",
    );
    assert.equal(
      openCodeCachePath({ XDG_CACHE_HOME: "" }),
      join(homedir(), ".cache", "opencode", "models.json"),
    );
    assert.equal(openCodeCachePath({}), join(homedir(), ".cache", "opencode", "models.json"));
  });

  it("does not estimate messages with positive actual cost", () => {
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1_000_000, output: 1_000_000 }, 2.5)] as never,
      pricingApi(),
    );

    assert.equal(metrics.cost, 2.5);
    assert.equal(metrics.estimatedCostByProvider.size, 0);
  });

  it("keeps input and cache buckets disjoint", () => {
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1, output: 0, reasoning: 0, cache: { read: 2, write: 3 } })] as never,
      pricingApi(),
    );

    assert.equal(
      metrics.estimatedCostByProvider.get("provider")?.cost,
      (1 + 2 * 3 + 3 * 4) / 1_000_000,
    );
  });

  it("aggregates providers and ignores unresolved or zero-rate estimates", () => {
    const api = pricingApi([
      {
        id: "provider",
        name: "Provider",
        models: { model: { cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } } },
      },
      {
        id: "zero",
        name: "Zero",
        models: { model: { cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } } },
      },
    ]);
    const metrics = Metrics.fromMessages(
      [
        pricedMessage({ input: 1_000_000, output: 0 }),
        pricedMessage({ input: 2_000_000, output: 0 }),
        { ...pricedMessage({ input: 1_000_000 }), providerID: "missing" },
        { ...pricedMessage({ input: 1_000_000 }), providerID: "zero" },
      ] as never,
      api,
    );

    assert.deepEqual(
      [...metrics.estimatedCostByProvider.entries()],
      [["provider", { name: "Provider", cost: 3 }]],
    );
  });

  it("uses the largest tier only when context input is strictly larger", () => {
    const api = pricingApi([
      {
        id: "provider",
        name: "Provider",
        models: {
          model: {
            cost: {
              input: 1,
              output: 1,
              cache: { read: 1, write: 1 },
              tiers: [
                {
                  input: 2,
                  output: 2,
                  cache: { read: 2, write: 2 },
                  tier: { type: "context", size: 10 },
                },
                {
                  input: 3,
                  output: 3,
                  cache: { read: 3, write: 3 },
                  tier: { type: "context", size: 20 },
                },
              ],
            },
          },
        },
      },
    ]);
    const atBoundary = Metrics.fromMessages(
      [pricedMessage({ input: 10, output: 1 })] as never,
      api,
    );
    const aboveBoundary = Metrics.fromMessages(
      [pricedMessage({ input: 21, output: 1 })] as never,
      api,
    );

    assert.equal(atBoundary.estimatedCostByProvider.get("provider")?.cost, 11 / 1_000_000);
    assert.equal(aboveBoundary.estimatedCostByProvider.get("provider")?.cost, 66 / 1_000_000);
  });

  it("merges estimated provider costs through descendants", async () => {
    const api = descendantsApi(
      { root: ["child"] },
      {
        child: [pricedMessage({ input: 1_000_000 })],
      },
    ) as never;
    (api as any).state = (pricingApi() as any).state;
    const metrics = await Metrics.fromSessionDescendants(api, "root");

    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 1);
  });

  it("selects the latest assistant with output tokens", () => {
    assert.equal(
      latestContextMessage([
        { role: "assistant", tokens: { input: 1, output: 0, reasoning: 0 } },
        { role: "assistant", tokens: { input: 2, output: 3, reasoning: 0 } },
      ] as never)?.tokens.input,
      2,
    );
  });

  it("computes input, output, reasoning, and cache tokens", () => {
    assert.equal(
      contextTokens([
        {
          role: "assistant",
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        },
      ] as never),
      42,
    );
  });

  it("returns zero without a qualifying assistant", () => {
    assert.equal(contextTokens([] as never), 0);
  });

  it("looks up the message model and rounds percentage", () => {
    const api = {
      state: {
        provider: [
          {
            id: "provider",
            models: { current: { limit: { context: 1_000 } } },
          },
        ],
      },
    };

    const messages = {
      session: {
        messages: () => [
          {
            role: "assistant",
            providerID: "provider",
            modelID: "current",
            tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } },
          },
        ],
      },
    };
    assert.deepEqual(
      loadContext(
        {
          state: { ...api.state, session: messages.session },
        } as never as import("@opencode-ai/plugin/tui").TuiPluginApi,
        "session",
      ),
      {
        tokens: 15,
        percentage: 2,
      },
    );
    assert.equal(
      contextLimit(api as never, { providerID: "provider", modelID: "current" } as never),
      1_000,
    );
  });

  it("uses nested context defaults and fills partial configuration", () => {
    assert.deepEqual(ConfigSchema.parse({}), {
      include_subagents: true,
      context: { show: false, warn_on_usage: 80, warn_on_count: 120_000 },
    });
    assert.deepEqual(ConfigSchema.parse({ context: { show: true } }), {
      include_subagents: true,
      context: { show: true, warn_on_usage: 80, warn_on_count: 120_000 },
    });
    assert.throws(() => ConfigSchema.parse({ include_context: true }));
    assert.throws(() => ConfigSchema.parse({ context: { unknown: true } }));
  });

  it("formats context tokens and applies independent inclusive warnings", () => {
    assert.equal(formatTokens(12_345.4), "12,345");
    assert.equal(formatTokens(12_345.6), "12,346");

    for (const [value, expected] of [
      [79, false],
      [80, true],
      [81, true],
    ] as const) {
      assert.equal(isContextWarning(value, 80), expected);
    }
    for (const [value, expected] of [
      [119_999, false],
      [120_000, true],
      [120_001, true],
    ] as const) {
      assert.equal(isContextCountWarning(value, 120_000), expected);
    }
    assert.equal(isContextWarning(0, 0), true);
    assert.equal(isContextWarning(100, 100), true);
    assert.equal(isContextCountWarning(0, 0), true);
  });
});
