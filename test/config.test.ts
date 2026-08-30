import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { ConfigSchema } from "#config";

describe("Metrics", () => {
  it("uses nested context defaults and fills partial configuration", () => {
    assert.deepEqual(ConfigSchema.parse({}), {
      include_subagents: true,
      context: { show: false, warn_on_usage: 80, warn_on_count: 120_000 },
      models: { show: true },
    });
    assert.deepEqual(ConfigSchema.parse({ context: { show: true } }), {
      include_subagents: true,
      context: { show: true, warn_on_usage: 80, warn_on_count: 120_000 },
      models: { show: true },
    });
    assert.deepEqual(ConfigSchema.parse({ models: { show: true } }).models, { show: true });
    assert.throws(() => ConfigSchema.parse({ include_context: true }));
    assert.throws(() => ConfigSchema.parse({ context: { unknown: true } }));
    assert.throws(() => ConfigSchema.parse({ models: { unknown: true } }));
  });

  it("accepts inclusive integer boundaries for context warnings", () => {
    const cases = [
      {
        name: "zero usage percentage",
        input: { context: { warn_on_usage: 0 } },
        expected: { show: false, warn_on_usage: 0, warn_on_count: 120_000 },
      },
      {
        name: "full usage percentage",
        input: { context: { warn_on_usage: 100 } },
        expected: { show: false, warn_on_usage: 100, warn_on_count: 120_000 },
      },
      {
        name: "zero token count",
        input: { context: { warn_on_count: 0 } },
        expected: { show: false, warn_on_usage: 80, warn_on_count: 0 },
      },
    ];

    for (const { name, input, expected } of cases) {
      assert.deepEqual(ConfigSchema.parse(input).context, expected, name);
    }
  });

  it("rejects out-of-range and non-integer usage warnings", () => {
    const cases = [
      { name: "below zero", value: -1 },
      { name: "above one hundred", value: 101 },
      { name: "fraction below range", value: 0.5 },
      { name: "fraction in range", value: 50.5 },
      { name: "numeric string", value: "50" },
      { name: "boolean", value: true },
      { name: "null", value: null },
    ] as const;

    for (const { name, value } of cases) {
      assert.equal(
        ConfigSchema.safeParse({ context: { warn_on_usage: value } }).success,
        false,
        name,
      );
    }
  });

  it("rejects negative and non-number token count warnings", () => {
    const cases = [
      { name: "below zero", value: -1 },
      { name: "numeric string", value: "120000" },
      { name: "boolean", value: false },
      { name: "null", value: null },
    ] as const;

    for (const { name, value } of cases) {
      assert.equal(
        ConfigSchema.safeParse({ context: { warn_on_count: value } }).success,
        false,
        name,
      );
    }
  });

  it("rejects non-boolean values for every visibility flag", () => {
    const cases = [
      { name: "top-level include_subagents", input: { include_subagents: "true" } },
      { name: "context show", input: { context: { show: 1 } } },
      { name: "models show", input: { models: { show: null } } },
    ] as const;

    for (const { name, input } of cases) {
      assert.equal(ConfigSchema.safeParse(input).success, false, name);
    }
  });
});
