import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigSchema } from "../src/config.ts";
import { Metrics } from "../src/metrics.ts";
import {
  contextLimit,
  contextTokens,
  isContextCountWarning,
  isContextWarning,
  latestContextMessage,
  loadContext,
} from "../src/context.ts";
import { formatTokens } from "../src/utils.ts";

describe("Metrics", () => {
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
