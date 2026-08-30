import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderApi, ProviderState } from "#lib/api";
import type { NormalizedMessage } from "#lib/session";

import { Metrics } from "#lib/metrics";
import { modelKey } from "#lib/model-key";
import {
  loadCatalog,
  loadCatalogMemoized,
  normalizeCatalog,
  openCodeCachePath,
  PricingResolver,
} from "#lib/pricing";

function pricingApi(providers: ProviderState): ProviderApi {
  return { state: { provider: providers } } satisfies ProviderApi;
}

function provider(id: string, name = id): ProviderState[number] {
  return {
    id,
    name,
    models: {
      model: {
        name: "Model",
        cost: { input: 1, output: 0, cache: { read: 0, write: 0 } },
      },
    },
  };
}

function pricedMessage(tokens: NonNullable<NormalizedMessage["tokens"]>): NormalizedMessage {
  return {
    role: "assistant",
    providerID: "provider",
    modelID: "model",
    tokens,
  };
}

describe("PricingResolver", () => {
  it("invalidates a cached resolution after an in-place provider rename", () => {
    const currentProvider = provider("provider", "Before");
    const api = pricingApi([currentProvider]);
    const resolver = new PricingResolver();

    const first = resolver.resolve(api, "provider", "model");
    assert.equal(first?.provider.name, "Before");
    assert.equal(resolver.resolve(api, "provider", "model"), first);

    currentProvider.name = "After";
    const renamed = resolver.resolve(api, "provider", "model");

    assert.notEqual(renamed, first);
    assert.equal(renamed?.provider.name, "After");
  });
  it("invalidates a negative resolution after same-length in-place replacement", () => {
    const providers = [provider("other")];
    const api = pricingApi(providers);
    const resolver = new PricingResolver();

    assert.equal(resolver.resolve(api, "requested", "model"), undefined);
    assert.equal(resolver.resolve(api, "requested", "model"), undefined);

    providers[0] = provider("requested", "Found");
    const resolved = resolver.resolve(api, "requested", "model");

    assert.equal(resolved?.provider.name, "Found");
  });

  it("keeps colliding provider/model tuples separate in catalog and resolver caches", () => {
    const catalog = normalizeCatalog({
      "a/b": { models: { c: { cost: { input: 1 } } } },
      a: { models: { "b/c": { cost: { input: 9 } } } },
    });
    const api = pricingApi([
      {
        id: "a/b",
        name: "A/B",
        models: {
          c: {
            name: "C",
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
      {
        id: "a",
        name: "A",
        models: {
          "b/c": {
            name: "B/C",
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    ]);
    const resolver = new PricingResolver(catalog);
    const first = resolver.resolve(api, "a/b", "c");
    const second = resolver.resolve(api, "a", "b/c");

    assert.equal(catalog.size, 2);
    assert.equal(catalog.get(modelKey("a/b", "c"))?.cost.input, 1);
    assert.equal(catalog.get(modelKey("a", "b/c"))?.cost.input, 9);
    assert.equal(first?.cost?.input, 1);
    assert.equal(second?.cost?.input, 9);

    resolver.invalidate("a/b", "c");
    assert.equal(resolver.resolve(api, "a/b", "c")?.cost?.input, 1);
    assert.equal(resolver.resolve(api, "a", "b/c"), second);

    for (const [providerID, modelID, input] of [
      ["a/b", "c", 1],
      ["a", "b/c", 9],
      ["a/b", "c", 1],
      ["a", "b/c", 9],
    ] as const) {
      assert.equal(resolver.resolve(api, providerID, modelID)?.cost?.input, input);
    }
  });
});

describe("Metrics", () => {
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
          model: {
            name: "Model",
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    ]);
    const metrics = Metrics.fromMessages([pricedMessage({ input: 1_000_000 })], api, catalog);
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
            name: "Model",
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
    const metrics = Metrics.fromMessages([pricedMessage({ input: 2 })], api, catalog);
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
          model: {
            name: "Model",
            cost: { input: 5, output: 0, cache: { read: 0, write: 0 } },
          },
        },
      },
    ]);
    const metrics = Metrics.fromMessages([pricedMessage({ input: 1_000_000 })], runtime, catalog);
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 5);
    assert.equal(catalog.get(modelKey("provider", "unknown")), undefined);
  });

  it("caches provider/model resolution and invalidates changed runtime and catalog pricing", () => {
    const runtimeCost = { input: 1, output: 0, cache: { read: 0, write: 0 } };
    const runtime = { name: "Model", cost: runtimeCost };
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
    const zeroRuntime = {
      name: "Model",
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    };
    const catalogApi = pricingApi([
      {
        id: "provider",
        name: "Provider",
        models: { model: zeroRuntime },
      },
    ]);
    resolver.setCatalog(catalog);
    assert.equal(resolver.resolve(catalogApi, "provider", "model")?.cost?.input, 3);

    catalog.get(modelKey("provider", "model"))!.cost.input = 7;
    assert.equal(resolver.resolve(catalogApi, "provider", "model")?.cost?.input, 7);
  });

  it("invalidates pricing for every canonical pricing field", () => {
    type RuntimeCost = NonNullable<ProviderState[number]["models"][string]["cost"]>;
    const cases: ReadonlyArray<{
      name: string;
      mutate: (cost: RuntimeCost) => void;
      expected: {
        input: number;
        output: number;
        cache: { read: number; write: number };
        tiers: ReadonlyArray<{
          input: number;
          output: number;
          cache: { read: number; write: number };
          tier: { type: "context"; size: number };
        }>;
      };
    }> = [
      {
        name: "base input",
        mutate: (cost) => {
          cost.input = 13;
        },
        expected: {
          input: 13,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "base output",
        mutate: (cost) => {
          cost.output = 14;
        },
        expected: {
          input: 1,
          output: 14,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "base cache read",
        mutate: (cost) => {
          cost.cache.read = 15;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 15, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "base cache write",
        mutate: (cost) => {
          cost.cache.write = 16;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 16 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "context tier threshold",
        mutate: (cost) => {
          cost.tiers![0].tier.size = 101;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 101 },
            },
          ],
        },
      },
      {
        name: "context tier input",
        mutate: (cost) => {
          cost.tiers![0].input = 17;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 17,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "context tier output",
        mutate: (cost) => {
          cost.tiers![0].output = 18;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 18,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "context tier cache read",
        mutate: (cost) => {
          cost.tiers![0].cache.read = 19;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 19, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "context tier cache write",
        mutate: (cost) => {
          cost.tiers![0].cache.write = 20;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 20 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "over-200k input",
        mutate: (cost) => {
          cost.experimentalOver200K!.input = 21;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 21,
              output: 10,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "over-200k output",
        mutate: (cost) => {
          cost.experimentalOver200K!.output = 22;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 22,
              cache: { read: 11, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "over-200k cache read",
        mutate: (cost) => {
          cost.experimentalOver200K!.cache.read = 23;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 23, write: 12 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
      {
        name: "over-200k cache write",
        mutate: (cost) => {
          cost.experimentalOver200K!.cache.write = 24;
        },
        expected: {
          input: 1,
          output: 2,
          cache: { read: 3, write: 4 },
          tiers: [
            {
              input: 9,
              output: 10,
              cache: { read: 11, write: 24 },
              tier: { type: "context", size: 200_000 },
            },
            {
              input: 5,
              output: 6,
              cache: { read: 7, write: 8 },
              tier: { type: "context", size: 100 },
            },
          ],
        },
      },
    ];

    for (const { name, mutate, expected } of cases) {
      const runtimeCost = {
        input: 1,
        output: 2,
        cache: { read: 3, write: 4 },
        tiers: [
          {
            input: 5,
            output: 6,
            cache: { read: 7, write: 8 },
            tier: { type: "context" as const, size: 100 },
          },
        ],
        experimentalOver200K: {
          input: 9,
          output: 10,
          cache: { read: 11, write: 12 },
        },
      } satisfies RuntimeCost;
      const api = pricingApi([
        {
          id: "provider",
          name: "Provider",
          models: { model: { name: "Model", cost: runtimeCost } },
        },
      ]);
      const resolver = new PricingResolver();
      const previous = resolver.resolve(api, "provider", "model");
      mutate(runtimeCost);
      const next = resolver.resolve(api, "provider", "model");

      assert.notEqual(next, previous, name);
      assert.deepEqual(next?.cost, expected, name);
    }
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
    assert.equal(catalog.get(modelKey("provider", "model"))?.cost.tiers?.[0].cache.read, 7);
    assert.equal(normalizeCatalog(undefined).size, 0);
  });

  it("returns an empty catalog for array and scalar catalog roots", () => {
    const roots: unknown[] = [[{ models: { model: { cost: { input: 1 } } } }], null, "catalog", 42];

    for (const root of roots) {
      assert.deepEqual(Array.from(normalizeCatalog(root).entries()), []);
    }
  });

  it("skips providers with array models and models with invalid entries", () => {
    const catalog = normalizeCatalog({
      arrayProvider: { models: [{ cost: { input: 1 } }] },
      provider: {
        models: {
          nullModel: null,
          scalarCost: { cost: "invalid" },
          arrayCost: { cost: [] },
          valid: { name: "Valid", cost: { input: 2 } },
        },
      },
    });

    assert.deepEqual(Array.from(catalog.entries()), [
      [
        modelKey("provider", "valid"),
        {
          id: "valid",
          name: "Valid",
          cost: {
            input: 2,
            output: 0,
            cache: { read: 0, write: 0 },
          },
        },
      ],
    ]);
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
      assert.equal(
        (await loadCatalogMemoized(path)).get(modelKey("provider", "model"))?.cost.input,
        1,
      );
      await writeFile(path, "not json", "utf8");
      assert.equal(
        (await loadCatalogMemoized(path)).get(modelKey("provider", "model"))?.cost.input,
        1,
      );
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
});
