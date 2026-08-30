import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { AssistantMessage, NormalizedMessage } from "#lib/session";

import {
  compareMessageSnapshots,
  snapshotMessages,
  uniquePricingPairs,
  type MessageSnapshot,
} from "#lib/message-snapshot";

type MessageFields = Pick<
  Partial<NormalizedMessage>,
  "id" | "providerID" | "modelID" | "cost" | "tokens"
>;

function message(fields: MessageFields = {}) {
  return {
    id: "message",
    sessionID: "session",
    role: "assistant",
    time: { created: 0 },
    parentID: "parent",
    modelID: "model",
    providerID: "provider",
    mode: "mode",
    agent: "agent",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    ...fields,
    tokens: {
      input: fields.tokens?.input ?? 0,
      output: fields.tokens?.output ?? 0,
      reasoning: fields.tokens?.reasoning ?? 0,
      cache: {
        read: fields.tokens?.cache?.read ?? 0,
        write: fields.tokens?.cache?.write ?? 0,
      },
    },
  } satisfies AssistantMessage;
}

function snapshot(keys: readonly string[] | undefined): MessageSnapshot {
  return { keys, pricingPairs: [] };
}

describe("message snapshots", () => {
  it("normalizes keys and extracts deduplicated pricing pairs in message order", () => {
    const messages = [
      message({ id: "one", providerID: "p", modelID: "m", tokens: { input: 1 } }),
      message({ id: "two", providerID: "p", modelID: "m", tokens: { input: 2 } }),
      message({ id: "three", providerID: "other", modelID: "m", tokens: { input: 3 } }),
      message({ id: "four", providerID: "ignored", modelID: "m", tokens: { input: 4 }, cost: 1 }),
    ];

    const result = snapshotMessages(messages);

    assert.equal(result.keys?.length, 4);
    assert.deepEqual(result.pricingPairs, [
      { providerID: "p", modelID: "m" },
      { providerID: "other", modelID: "m" },
    ]);
  });

  it("invalidates keys for missing or duplicate IDs while retaining pricing data", () => {
    const result = snapshotMessages([
      message({ id: "same", providerID: "p", modelID: "m", tokens: {} }),
      message({ id: "same", providerID: "q", modelID: "n", tokens: {} }),
      message({ id: "", providerID: "r", modelID: "o", tokens: {} }),
    ]);

    assert.equal(result.keys, undefined);
    assert.deepEqual(result.pricingPairs, [
      { providerID: "p", modelID: "m" },
      { providerID: "q", modelID: "n" },
      { providerID: "r", modelID: "o" },
    ]);
  });

  it("does not alias source messages or returned pricing pairs", () => {
    const source = message({
      id: "one",
      providerID: "provider",
      modelID: "model",
      tokens: { input: 1 },
    });
    const result = snapshotMessages([source]);
    const union = uniquePricingPairs(result);

    source.providerID = "changed";
    source.modelID = "changed";
    union[0]!.providerID = "mutated";
    union[0]!.modelID = "mutated";

    assert.deepEqual(snapshotMessages([]), { keys: [], pricingPairs: [] });
    assert.deepEqual(result.pricingPairs, [{ providerID: "provider", modelID: "model" }]);
    assert.deepEqual(union, [{ providerID: "mutated", modelID: "mutated" }]);
  });

  it("compares equality, strict extensions, and all other changes as rebuilds", () => {
    assert.deepEqual(compareMessageSnapshots(snapshot(["a"]), snapshot(["a"])), {
      kind: "unchanged",
    });
    assert.deepEqual(compareMessageSnapshots(snapshot(["a"]), snapshot(["a", "b"])), {
      kind: "append-only",
      deltaStart: 1,
    });
    for (const next of [[], ["b"], ["a", "x"], ["b", "a"], ["a"]]) {
      const result = compareMessageSnapshots(snapshot(["a", "b"]), snapshot(next));
      if (next.length !== 2 || next[0] !== "a" || next[1] !== "b") {
        assert.deepEqual(result, { kind: "rebuild" });
      }
    }
  });

  it("rebuilds when either key set is invalid", () => {
    assert.deepEqual(compareMessageSnapshots(snapshot(undefined), snapshot([])), {
      kind: "rebuild",
    });
    assert.deepEqual(compareMessageSnapshots(snapshot([]), snapshot(undefined)), {
      kind: "rebuild",
    });
  });

  it("deduplicates pricing pairs across snapshots without delimiter collisions", () => {
    const first = snapshotMessages([
      message({ id: "one", providerID: "a", modelID: "b:c", tokens: {} }),
      message({ id: "two", providerID: "a:b", modelID: "c", tokens: {} }),
    ]);
    const second = snapshotMessages([
      message({ id: "three", providerID: "a", modelID: "b:c", tokens: {} }),
      message({ id: "four", providerID: "z", modelID: "m", tokens: {} }),
    ]);

    assert.deepEqual(uniquePricingPairs(first, second), [
      { providerID: "a", modelID: "b:c" },
      { providerID: "a:b", modelID: "c" },
      { providerID: "z", modelID: "m" },
    ]);
  });
});
