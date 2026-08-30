import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import {
  abortable,
  formatCost,
  formatNumber,
  formatPercentage,
  formatSpeed,
  mapWithConcurrency,
} from "#lib/utils";

function trackedController() {
  const controller = new AbortController();
  const listeners = new Set<NonNullable<Parameters<AbortSignal["addEventListener"]>[1]>>();
  const signal = new Proxy(controller.signal, {
    get(target, property) {
      if (property === "addEventListener") {
        return (
          type: Parameters<AbortSignal["addEventListener"]>[0],
          listener: Parameters<AbortSignal["addEventListener"]>[1],
          options?: Parameters<AbortSignal["addEventListener"]>[2],
        ) => {
          if (listener) listeners.add(listener);
          target.addEventListener(type, listener, options);
        };
      }
      if (property === "removeEventListener") {
        return (
          type: Parameters<AbortSignal["removeEventListener"]>[0],
          listener: Parameters<AbortSignal["removeEventListener"]>[1],
          options?: Parameters<AbortSignal["removeEventListener"]>[2],
        ) => {
          if (listener) listeners.delete(listener);
          target.removeEventListener(type, listener, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    signal,
    abort: controller.abort.bind(controller),
    listenerCount: () => listeners.size,
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
    const resolved = trackedController();
    const resolvedPromise = abortable(Promise.resolve("resolved"), resolved.signal);
    assert.equal(resolved.listenerCount(), 1);
    assert.equal(await resolvedPromise, "resolved");
    assert.equal(resolved.listenerCount(), 0);

    const rejected = trackedController();
    const rejection = new Error("rejected");
    const rejectedPromise = abortable(Promise.reject(rejection), rejected.signal);
    assert.equal(rejected.listenerCount(), 1);
    await assert.rejects(rejectedPromise, (actual) => actual === rejection);
    assert.equal(rejected.listenerCount(), 0);

    const aborted = trackedController();
    const abortedPromise = abortable(new Promise<never>(() => undefined), aborted.signal);
    assert.equal(aborted.listenerCount(), 1);
    aborted.abort();
    await assert.rejects(abortedPromise, (actual) => actual === aborted.signal.reason);
    assert.equal(aborted.listenerCount(), 0);
  });
});

describe("component formatting", () => {
  it("formats numbers with grouping and up to two fractional digits", () => {
    assert.equal(formatNumber(12_345), "12,345");
    assert.equal(formatNumber(12_345.4), "12,345.4");
    assert.equal(formatNumber(12_345.67), "12,345.67");
    assert.equal(formatNumber(12_345.678), "12,345.68");
    assert.equal(formatNumber(-12_345.6), "-12,345.6");
    assert.equal(formatNumber(1.005), "1.01");
    assert.equal(formatNumber(2.675), "2.68");
    assert.equal(formatCost(1), "$1.00");
  });

  it("formats unavailable model rates as an em dash", () => {
    assert.equal(formatPercentage(undefined), "—");
    assert.equal(formatSpeed(undefined), "—");
    assert.equal(formatPercentage(1 / 3), "33.3%");
    assert.equal(formatSpeed(12.5), "12.5 t/s");
  });
});

describe("mapWithConcurrency", () => {
  it("honors requested concurrency above the descendant traversal limit", async () => {
    const concurrency = 5;
    const inputs = [0, 1, 2, 3, 4];
    const pending: Array<() => void> = [];
    let markAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    let active = 0;
    let maximum = 0;

    const mapped = mapWithConcurrency(inputs, concurrency, async (input) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (active === concurrency) markAllStarted();
      await new Promise<void>((resolve) => pending.push(resolve));
      active -= 1;
      return input;
    });

    await allStarted;
    assert.equal(active, 5);
    for (const resolve of pending) resolve();

    assert.equal(maximum, 5);
    assert.deepEqual(await mapped, [0, 1, 2, 3, 4]);
  });
});
