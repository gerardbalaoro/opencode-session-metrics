import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESCENDANT_CONCURRENCY, getSessionDescendants, SessionIndex } from "../src/session.ts";
import { mapWithConcurrency } from "../src/utils.ts";

type ChildMap = Record<string, string[] | undefined>;

function apiFor(childrenByParent: ChildMap, failures = new Set<string>()) {
  const requests: string[] = [];
  const api = {
    client: {
      session: {
        children: async ({ sessionID }: { sessionID: string }) => {
          requests.push(sessionID);
          if (failures.has(sessionID)) throw new Error("request failed");
          const children = childrenByParent[sessionID];
          return { data: children?.map((id) => ({ id })) };
        },
      },
    },
  };

  return { api: api as never, requests };
}

const ids = (sessions: Array<{ id: string }>) => sessions.map((session) => session.id);

describe("mapWithConcurrency", () => {
  it("honors requested concurrency above the descendant traversal limit", async () => {
    const concurrency = DESCENDANT_CONCURRENCY + 1;
    const inputs = Array.from({ length: concurrency }, (_, index) => index);
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
    assert.equal(active, concurrency);
    for (const resolve of pending) resolve();

    assert.equal(maximum, concurrency);
    assert.deepEqual(await mapped, inputs);
  });
});

describe("getSessionDescendants", () => {
  it("returns direct children and excludes the root", async () => {
    const { api } = apiFor({ root: ["child-a", "child-b"] });

    assert.deepEqual(ids(await getSessionDescendants(api, "root")), ["child-a", "child-b"]);
  });

  it("traverses nested descendants", async () => {
    const { api } = apiFor({
      root: ["child"],
      child: ["grandchild"],
      grandchild: ["great-grandchild"],
    });

    assert.deepEqual(ids(await getSessionDescendants(api, "root")), [
      "child",
      "grandchild",
      "great-grandchild",
    ]);
  });

  it("treats an empty or undefined response as having no children", async () => {
    const empty = apiFor({ root: [] });
    const undefinedResponse = apiFor({});

    assert.deepEqual(await getSessionDescendants(empty.api, "root"), []);
    assert.deepEqual(await getSessionDescendants(undefinedResponse.api, "root"), []);
  });

  it("handles duplicate and cyclic relationships once", async () => {
    const { api, requests } = apiFor({
      root: ["a", "b", "a"],
      a: ["b", "root"],
      b: ["a"],
    });

    assert.deepEqual(ids(await getSessionDescendants(api, "root")), ["a", "b"]);
    assert.deepEqual(requests, ["root", "a", "b"]);
  });

  it("continues best effort when a child-list request fails", async () => {
    const { api } = apiFor(
      { root: ["working", "failed"], working: ["nested"] },
      new Set(["failed"]),
    );

    assert.deepEqual(ids(await getSessionDescendants(api, "root")), [
      "working",
      "failed",
      "nested",
    ]);
  });

  it("returns each descendant once for one-time aggregation", async () => {
    const { api } = apiFor({ root: ["a", "b"], a: ["b", "c"], b: ["c"], c: [] });

    const descendants = await getSessionDescendants(api, "root");
    const aggregationCalls = descendants.map(({ id }) => id);

    assert.deepEqual(aggregationCalls, ["a", "b", "c"]);
    assert.equal(new Set(aggregationCalls).size, aggregationCalls.length);
  });

  it("limits independent child-list requests to four and keeps BFS order", async () => {
    const children = Array.from({ length: 8 }, (_, index) => `child-${index}`);
    const pending: Array<{
      id: string;
      resolve: (value: { data: Array<{ id: string }> }) => void;
    }> = [];
    let markFourStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      markFourStarted = resolve;
    });
    let releasedFirstBatch = false;
    let markSecondBatch!: () => void;
    const secondBatchStarted = new Promise<void>((resolve) => {
      markSecondBatch = resolve;
    });
    let active = 0;
    let maximum = 0;
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root") return { data: children.map((id) => ({ id })) };
            active += 1;
            maximum = Math.max(maximum, active);
            if (pending.length === DESCENDANT_CONCURRENCY - 1) {
              if (releasedFirstBatch) markSecondBatch();
              else markFourStarted();
            }
            return await new Promise<{ data: Array<{ id: string }> }>((resolve) => {
              pending.push({ id: sessionID, resolve });
            }).finally(() => {
              active -= 1;
            });
          },
        },
      },
    };

    const traversal = getSessionDescendants(api as never, "root");
    await fourStarted;
    assert.equal(pending.length, DESCENDANT_CONCURRENCY);
    releasedFirstBatch = true;
    for (const request of pending.splice(0)) request.resolve({ data: [] });
    await secondBatchStarted;
    assert.equal(pending.length, DESCENDANT_CONCURRENCY);
    for (const request of pending.splice(0)) request.resolve({ data: [] });

    assert.equal(maximum, DESCENDANT_CONCURRENCY);
    assert.deepEqual(
      (await traversal).map(({ id }) => id),
      children,
    );
  });

  it("retains stale descendants on failure and retries the failed list", async () => {
    const index = new SessionIndex();
    let attempts = 0;
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== "root") return { data: [] };
            attempts += 1;
            if (attempts === 2) throw new Error("transient");
            return { data: [{ id: attempts === 1 ? "child-a" : "child-b" }] };
          },
        },
      },
    };

    assert.deepEqual(
      (await getSessionDescendants(api as never, "root", { index })).map(({ id }) => id),
      ["child-a"],
    );
    assert.deepEqual(
      (await getSessionDescendants(api as never, "root", { index })).map(({ id }) => id),
      ["child-a"],
    );
    assert.deepEqual(
      (await getSessionDescendants(api as never, "root", { index })).map(({ id }) => id),
      ["child-b"],
    );
    assert.equal(attempts, 3);
  });

  it("treats SDK-shaped child-list errors as stale and retries them", async () => {
    const index = new SessionIndex();
    let attempts = 0;
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID !== "root") return { data: [] };
            attempts += 1;
            return attempts === 2
              ? { data: undefined, error: { name: "Offline" } }
              : { data: attempts === 1 ? [{ id: "child" }] : [] };
          },
        },
      },
    };

    assert.deepEqual(ids(await getSessionDescendants(api as never, "root", { index })), ["child"]);
    assert.deepEqual(ids(await getSessionDescendants(api as never, "root", { index })), ["child"]);
    assert.equal(index.isStale("root"), true);
    assert.deepEqual(ids(await getSessionDescendants(api as never, "root", { index })), []);
    assert.equal(index.isStale("root"), false);
    assert.equal(attempts, 3);
  });

  it("does not start queued requests after cancellation", async () => {
    const controller = new AbortController();
    const children = Array.from({ length: 8 }, (_, index) => `child-${index}`);
    let started = 0;
    let markFourStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      markFourStarted = resolve;
    });
    const api = {
      client: {
        session: {
          children: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "root") return { data: children.map((id) => ({ id })) };
            started += 1;
            if (started === DESCENDANT_CONCURRENCY) markFourStarted();
            return await new Promise<{ data: Array<{ id: string }> }>(() => undefined);
          },
        },
      },
    };

    const traversal = getSessionDescendants(api as never, "root", { signal: controller.signal });
    await fourStarted;
    assert.equal(started, DESCENDANT_CONCURRENCY);
    controller.abort();
    await assert.rejects(traversal, { name: "AbortError" });
    assert.equal(started, DESCENDANT_CONCURRENCY);
  });

  it("clears one root closure without corrupting unrelated traversal caches", async () => {
    const index = new SessionIndex();
    const { api } = apiFor({
      rootA: ["a"],
      a: ["a-child"],
      "a-child": [],
      rootB: ["b"],
      b: ["b-child"],
      "b-child": [],
    });

    await getSessionDescendants(api, "rootA", { index });
    await getSessionDescendants(api, "rootB", { index });
    index.clear("rootA");

    assert.deepEqual(ids(index.lastKnown("rootA")), []);
    assert.deepEqual(ids(index.lastKnown("rootB")), ["b", "b-child"]);
    assert.equal(index.isStale("rootB"), false);

    const caches = index as any;
    assert.equal(caches.childrenByParent.has("rootA"), false);
    assert.equal(caches.childrenByParent.has("a"), false);
    assert.equal(caches.childrenByParent.has("a-child"), false);
    assert.equal(caches.childrenByParent.has("rootB"), true);
    assert.equal(caches.childrenByParent.has("b"), true);
    assert.equal(caches.descendantsByRoot.has("rootA"), false);
    assert.equal(caches.descendantsByRoot.has("rootB"), true);
  });
});
