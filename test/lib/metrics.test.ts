import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { ProviderApi, ProviderState } from "#lib/api";
import type { SessionRollup } from "#lib/metrics";
import type { NormalizedMessage } from "#lib/session";

import { Metrics } from "#lib/metrics";
import { modelKey } from "#lib/model-key";

describe("Metrics", () => {
  function pricingApi(
    providers: ProviderState = [
      {
        id: "provider",
        name: "Provider",
        models: {
          model: {
            name: "Model",
            cost: { input: 1, output: 2, cache: { read: 3, write: 4 } },
          },
        },
      },
    ],
  ) {
    return { state: { provider: providers } } satisfies ProviderApi;
  }

  function pricedMessage(
    tokens: NonNullable<NormalizedMessage["tokens"]>,
    cost?: number,
  ): NormalizedMessage {
    return {
      role: "assistant",
      providerID: "provider",
      modelID: "model",
      tokens,
      ...(cost === undefined ? {} : { cost }),
    };
  }

  it("aggregates assistant token and cost fields", () => {
    const metrics = Metrics.fromMessages([
      {
        role: "assistant",
        cost: 1.25,
        tokens: { input: 10, output: 20, reasoning: 3, total: 33, cache: { read: 4, write: 5 } },
      },
      { role: "user" },
      { role: "assistant", cost: 0.75, tokens: { input: 2, output: 4, reasoning: 1, cache: {} } },
    ]);
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

  it("aggregates usage by exact provider/model and combines completed speed durations", () => {
    const metrics = Metrics.fromMessages([
      {
        role: "assistant",
        providerID: "provider-a",
        modelID: "model-a",
        cost: 1,
        time: { created: 0, completed: 2_000 },
        tokens: {
          input: 10,
          output: 20,
          reasoning: 5,
          total: 35,
          cache: { read: 5, write: 1 },
        },
      },
      {
        role: "assistant",
        providerID: "provider-a",
        modelID: "model-b",
        cost: 2,
        time: { created: 0, completed: 1_000 },
        tokens: { input: 4, output: 3, reasoning: 1, total: 8, cache: { read: 0, write: 2 } },
      },
      {
        role: "assistant",
        providerID: "provider-b",
        modelID: "model-a",
        cost: 3,
        time: { created: 10, completed: 1_010 },
        tokens: { input: 6, output: 4, reasoning: 2, total: 12, cache: { read: 6, write: 0 } },
      },
    ]);

    assert.deepEqual(
      [...metrics.models.keys()],
      [
        modelKey("provider-a", "model-a"),
        modelKey("provider-a", "model-b"),
        modelKey("provider-b", "model-a"),
      ],
    );
    assert.deepEqual(metrics.models.get(modelKey("provider-a", "model-a")), {
      providerID: "provider-a",
      modelID: "model-a",
      input: 10,
      output: 20,
      reasoning: 5,
      cacheRead: 5,
      cacheWrite: 1,
      cacheRate: 1 / 3,
      speed: 12.5,
      cost: 1,
      reportedCost: 1,
      estimatedCost: 0,
    });
    assert.equal(metrics.speed, 35 / 4);
    assert.equal(metrics.cacheRate, 11 / 31);
    assert.deepEqual(
      [...metrics.providerCosts.values()],
      [
        {
          providerID: "provider-a",
          name: "provider-a",
          cost: 3,
          reportedCost: 3,
          estimatedCost: 0,
        },
        {
          providerID: "provider-b",
          name: "provider-b",
          cost: 3,
          reportedCost: 3,
          estimatedCost: 0,
        },
      ],
    );
  });

  it("keeps slash-containing provider/model tuples separate through incremental merge", () => {
    const first: NormalizedMessage = {
      role: "assistant",
      providerID: "a/b",
      modelID: "c",
      cost: 1.25,
      tokens: { input: 10, output: 20, reasoning: 3, total: 33, cache: { read: 4, write: 5 } },
    };
    const second: NormalizedMessage = {
      role: "assistant",
      providerID: "a",
      modelID: "b/c",
      cost: 2.5,
      tokens: { input: 2, output: 4, reasoning: 1, total: 7, cache: { read: 6, write: 7 } },
    };
    const aggregate = Metrics.fromMessages([first, second]);
    const incremental = Metrics.merge(
      Metrics.fromMessages([first]),
      Metrics.fromMessages([second]),
    );
    const firstKey = modelKey("a/b", "c");
    const secondKey = modelKey("a", "b/c");

    for (const metrics of [aggregate, incremental]) {
      assert.equal(metrics.models.size, 2);
      assert.deepEqual([...metrics.models.keys()], [firstKey, secondKey]);
      assert.equal(metrics.models.get(firstKey)?.input, 10);
      assert.equal(metrics.models.get(firstKey)?.cost, 1.25);
      assert.equal(metrics.models.get(secondKey)?.input, 2);
      assert.equal(metrics.models.get(secondKey)?.cost, 2.5);
    }
  });

  it("includes reported and estimated portions once in model and provider costs", () => {
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1_000_000 }, 2), pricedMessage({ input: 1_000_000 })],
      pricingApi(),
    );

    const model = metrics.models.get(modelKey("provider", "model"));
    const provider = metrics.providerCosts.get("provider");
    assert.equal(metrics.cost, 2);
    assert.equal(metrics.estimatedCost, 1);
    assert.equal(metrics.totalCost, 3);
    assert.deepEqual(model, {
      providerID: "provider",
      modelID: "model",
      input: 2_000_000,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheRate: 0,
      speed: undefined,
      cost: 3,
      reportedCost: 2,
      estimatedCost: 1,
    });
    assert.deepEqual(provider, {
      providerID: "provider",
      name: "Provider",
      cost: 3,
      reportedCost: 2,
      estimatedCost: 1,
    });
  });

  it("leaves cache rate and speed unavailable without valid inputs", () => {
    const metrics = Metrics.fromMessages([
      {
        role: "assistant",
        providerID: "provider",
        modelID: "model",
        tokens: { input: 0, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 10, completed: 10 },
      },
      {
        role: "assistant",
        providerID: "provider",
        modelID: "model",
        tokens: { input: 0, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 10, completed: Number.NaN },
      },
    ]);

    assert.equal(metrics.cacheRate, undefined);
    assert.equal(metrics.speed, undefined);
    assert.equal(metrics.models.get(modelKey("provider", "model"))?.cacheRate, undefined);
    assert.equal(metrics.models.get(modelKey("provider", "model"))?.speed, undefined);
  });

  it("preserves metrics data and mutation independence through merge and clone", () => {
    const first = Metrics.fromMessages([
      {
        role: "assistant",
        providerID: "source-provider",
        modelID: "source-model",
        cost: 1.25,
        time: { created: 0, completed: 1_000 },
        tokens: { input: 1, output: 10, reasoning: 2, cache: { read: 1, write: 0 } },
      },
    ]);
    const second = Metrics.fromMessages([
      {
        role: "assistant",
        providerID: "source-provider",
        modelID: "source-model",
        cost: 2.75,
        time: { created: 0, completed: 3_000 },
        tokens: { input: 3, output: 30, reasoning: 4, cache: { read: 3, write: 0 } },
      },
    ]);

    const merged = Metrics.merge(first, second);
    const clone = merged.clone();
    const key = modelKey("source-provider", "source-model");

    assert.equal(merged.speed, 46 / 4);
    assert.equal(merged.models.get(key)?.speed, 46 / 4);
    assert.equal(merged.models.get(key)?.cacheRate, 4 / 8);
    assert.equal(clone.cost, 4);
    assert.deepEqual(clone.tokens, {
      input: 4,
      output: 40,
      reasoning: 6,
      cache_read: 4,
      cache_write: 0,
      total: 50,
    });
    assert.deepEqual(
      [...clone.models.entries()],
      [
        [
          key,
          {
            providerID: "source-provider",
            modelID: "source-model",
            input: 4,
            output: 40,
            reasoning: 6,
            cacheRead: 4,
            cacheWrite: 0,
            cacheRate: 4 / 8,
            speed: 46 / 4,
            cost: 4,
            reportedCost: 4,
            estimatedCost: 0,
          },
        ],
      ],
    );
    assert.deepEqual(
      [...clone.providerCosts.entries()],
      [
        [
          "source-provider",
          {
            providerID: "source-provider",
            name: "source-provider",
            cost: 4,
            reportedCost: 4,
            estimatedCost: 0,
          },
        ],
      ],
    );

    clone.models.get(key)!.input = 999;
    clone.providerCosts.get("source-provider")!.cost = 999;
    clone.tokens.input = 999;

    assert.equal(merged.models.get(key)?.input, 4);
    assert.equal(merged.providerCosts.get("source-provider")?.cost, 4);
    assert.equal(merged.tokens.input, 4);
  });

  it("does not fabricate model or provider records from a session rollup", () => {
    const metrics = Metrics.fromSessionRollup({
      id: "session",
      slug: "session",
      projectID: "project",
      directory: "/tmp",
      title: "Session",
      version: "1",
      time: { created: 0, updated: 0 },
      cost: 4,
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 5, write: 1 } },
    } satisfies SessionRollup);

    assert.ok(metrics);
    assert.equal(metrics.models.size, 0);
    assert.equal(metrics.providerCosts.size, 0);
    assert.equal(metrics.cacheRate, 1 / 3);
    assert.equal(metrics.speed, undefined);
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
      ],
      pricingApi(),
    );

    assert.equal(metrics.cost, 0);
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 43);
  });

  it("treats a non-finite input token as zero without discarding valid output pricing", () => {
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: Number.NaN, output: 1_000_000 })],
      pricingApi(),
    );

    assert.equal(metrics.tokens.input, 0);
    assert.equal(metrics.tokens.output, 1_000_000);
    assert.equal(metrics.estimatedCostByProvider.get("provider")?.cost, 2);
  });

  it("does not estimate messages with positive actual cost", () => {
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1_000_000, output: 1_000_000 }, 2.5)],
      pricingApi(),
    );

    assert.equal(metrics.cost, 2.5);
    assert.equal(metrics.estimatedCostByProvider.size, 0);
  });

  it("keeps input and cache buckets disjoint", () => {
    const metrics = Metrics.fromMessages(
      [pricedMessage({ input: 1, output: 0, reasoning: 0, cache: { read: 2, write: 3 } })],
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
        models: {
          model: { name: "Model", cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } },
        },
      },
      {
        id: "zero",
        name: "Zero",
        models: {
          model: { name: "Model", cost: { input: 0, output: 0, cache: { read: 0, write: 0 } } },
        },
      },
    ]);
    const metrics = Metrics.fromMessages(
      [
        pricedMessage({ input: 1_000_000, output: 0 }),
        pricedMessage({ input: 2_000_000, output: 0 }),
        { ...pricedMessage({ input: 1_000_000 }), providerID: "missing" },
        { ...pricedMessage({ input: 1_000_000 }), providerID: "zero" },
      ],
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
            name: "Model",
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
    const atBoundary = Metrics.fromMessages([pricedMessage({ input: 10, output: 1 })], api);
    const aboveBoundary = Metrics.fromMessages([pricedMessage({ input: 21, output: 1 })], api);

    assert.equal(atBoundary.estimatedCostByProvider.get("provider")?.cost, 11 / 1_000_000);
    assert.equal(aboveBoundary.estimatedCostByProvider.get("provider")?.cost, 66 / 1_000_000);
  });
});
