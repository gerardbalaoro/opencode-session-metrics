import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { abortable } from "../src/utils.ts";

function trackedSignal() {
  let aborted = false;
  const listeners = new Set<() => void>();
  const reason = new Error("aborted");
  const signal = {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    throwIfAborted() {
      if (aborted) throw reason;
    },
    addEventListener(_type: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
  } as unknown as AbortSignal;

  return {
    signal,
    abort() {
      aborted = true;
      for (const listener of Array.from(listeners)) listener();
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

describe("abortable", () => {
  it("returns the original promise without a signal", () => {
    const promise = Promise.resolve("done");
    assert.equal(abortable(promise), promise);
  });

  it("throws the signal reason synchronously when already aborted", () => {
    const promise = Promise.resolve("done");
    const controller = new AbortController();
    const reason = { type: "cancelled" };
    controller.abort(reason);
    assert.throws(
      () => abortable(promise, controller.signal),
      (actual) => actual === reason,
    );
  });

  it("rejects with the exact default and custom abort reasons", async () => {
    const defaultController = new AbortController();
    const defaultPromise = abortable(new Promise<never>(() => undefined), defaultController.signal);
    defaultController.abort();
    await assert.rejects(defaultPromise, (actual) => actual === defaultController.signal.reason);

    const customController = new AbortController();
    const customReason = { type: "cancelled" };
    const customPromise = abortable(new Promise<never>(() => undefined), customController.signal);
    customController.abort(customReason);
    await assert.rejects(customPromise, (actual) => actual === customReason);
  });

  it("removes listeners after resolution, rejection, and abort", async () => {
    const resolved = trackedSignal();
    const resolvedPromise = abortable(Promise.resolve("resolved"), resolved.signal);
    assert.equal(resolved.listenerCount(), 1);
    assert.equal(await resolvedPromise, "resolved");
    assert.equal(resolved.listenerCount(), 0);

    const rejected = trackedSignal();
    const rejection = new Error("rejected");
    const rejectedPromise = abortable(Promise.reject(rejection), rejected.signal);
    assert.equal(rejected.listenerCount(), 1);
    await assert.rejects(rejectedPromise, (actual) => actual === rejection);
    assert.equal(rejected.listenerCount(), 0);

    const aborted = trackedSignal();
    const abortedPromise = abortable(new Promise<never>(() => undefined), aborted.signal);
    assert.equal(aborted.listenerCount(), 1);
    aborted.abort();
    await assert.rejects(abortedPromise, (actual) => actual === aborted.signal.reason);
    assert.equal(aborted.listenerCount(), 0);
  });
});
