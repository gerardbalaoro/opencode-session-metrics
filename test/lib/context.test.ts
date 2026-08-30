import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { ContextApi, ProviderState } from "#lib/api";
import type { AssistantMessage, Message } from "#lib/session";

import { isContextCountWarning, isContextWarning, loadContext } from "#lib/context";

describe("Metrics", () => {
  type Provider = ProviderState[number];

  function contextApi(
    messages: ContextApi["state"]["session"]["messages"],
    provider: ProviderState = [],
  ): ContextApi {
    return { state: { provider, session: { messages } } } satisfies ContextApi;
  }

  function assistantMessage(
    input: number,
    output: number,
    providerID = "provider",
    modelID = "model",
  ): AssistantMessage {
    return {
      id: "message",
      sessionID: "session",
      role: "assistant",
      time: { created: 0 },
      parentID: "parent",
      providerID,
      modelID,
      mode: "default",
      agent: "default",
      path: { cwd: ".", root: "." },
      cost: 0,
      tokens: {
        input,
        output,
        reasoning: 3,
        total: input + output + 3,
        cache: { read: 4, write: 5 },
      },
    };
  }

  function userMessage(): Message {
    return {
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 0 },
      agent: "default",
      model: { providerID: "provider", modelID: "model" },
    };
  }

  function provider(context = 1_000): Provider {
    return {
      id: "provider",
      name: "Provider",
      models: { model: { name: "Model", limit: { context } } },
    };
  }

  it("loads context through one state message access and preserves summary selection", () => {
    let messageAccesses = 0;
    const api = contextApi(
      (sessionID) => {
        assert.equal(sessionID, "session");
        messageAccesses += 1;
        return [
          userMessage(),
          assistantMessage(1, 0),
          {
            ...assistantMessage(10, 20, "provider", "current"),
            tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
          },
        ];
      },
      [{ ...provider(), models: { current: { name: "Current", limit: { context: 1_000 } } } }],
    );

    assert.deepEqual(loadContext(api, "session"), {
      tokens: 42,
      total: 1_000,
      percentage: 4,
    });
    assert.equal(messageAccesses, 1);
  });

  it("ignores users and assistants with zero output", () => {
    const api = contextApi(() => [userMessage(), assistantMessage(2, 0)]);

    assert.equal(loadContext(api, "session"), undefined);
  });

  it("ignores an assistant with non-finite output when selecting context", () => {
    const malformedMessage: unknown = {
      ...assistantMessage(999, 0),
      tokens: { input: 999, output: Number.POSITIVE_INFINITY, reasoning: 999 },
    };
    const api = contextApi(
      () => [
        {
          ...assistantMessage(10, 20),
          tokens: { input: 10, output: 20, reasoning: 3, total: 33, cache: { read: 0, write: 0 } },
        },
        malformedMessage,
      ],
      [provider()],
    );

    assert.deepEqual(loadContext(api, "session"), {
      tokens: 33,
      total: 1_000,
      percentage: 3,
    });
  });

  it("omits context capacity when provider, model, or limit is unavailable", () => {
    const message = assistantMessage(1, 2);
    const providers: (Provider | undefined)[] = [
      undefined,
      { id: "provider", name: "Provider", models: {} },
      {
        id: "provider",
        name: "Provider",
        models: { model: { name: "Model", limit: { context: 0 } } },
      },
      {
        id: "provider",
        name: "Provider",
        models: { model: { name: "Model", limit: { context: Number.NaN } } },
      },
      {
        id: "provider",
        name: "Provider",
        models: { model: { name: "Model", limit: { context: Number.POSITIVE_INFINITY } } },
      },
      {
        id: "provider",
        name: "Provider",
        models: { model: { name: "Model", limit: { context: -1 } } },
      },
    ];
    for (const provider of providers) {
      assert.deepEqual(
        loadContext(
          contextApi(() => [message], provider === undefined ? [] : [provider]),
          "session",
        ),
        { tokens: 15 },
      );
    }
  });

  it("applies independent inclusive context warnings", () => {
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
