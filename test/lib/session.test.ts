import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { SessionClientApi } from "#lib/api";

import { getSessionDescendants, normalizeMessage, SessionIndex } from "#lib/session";

type ChildMap = Record<string, string[] | undefined>;
type SessionChild = NonNullable<
  Awaited<ReturnType<SessionClientApi["client"]["session"]["children"]>>["data"]
>[number];
type SessionChildren = SessionClientApi["client"]["session"]["children"];
type SessionSuccess = Extract<Awaited<ReturnType<SessionChildren>>, { data: SessionChild[] }>;
type SessionFailure = Extract<Awaited<ReturnType<SessionChildren>>, { data: undefined }>;
type SessionRequest = { sessionID: string };

function sessionRow(id: string): SessionChild {
  return {
    id,
    slug: id,
    projectID: "project",
    directory: "/project",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  };
}

function sessionResponse(data: SessionChild[]): SessionSuccess {
  return { data, request: new Request("http://localhost"), response: new Response() };
}

function sessionFailure(): SessionFailure {
  return {
    data: undefined,
    error: { _tag: "InvalidRequestError", message: "Offline" },
    request: new Request("http://localhost"),
    response: new Response(),
  };
}

function apiFor(childrenByParent: ChildMap, failures = new Set<string>()) {
  const requests: string[] = [];
  const children: SessionChildren = ({ sessionID }: SessionRequest) => {
    requests.push(sessionID);
    if (failures.has(sessionID)) return Promise.reject(new Error("request failed"));
    const children = childrenByParent[sessionID];
    return Promise.resolve(sessionResponse(children?.map(sessionRow) ?? []));
  };
  const api: SessionClientApi = {
    client: {
      session: {
        children,
      },
    },
  };

  return { api, requests };
}

function ids(sessions: Array<{ id: string }>) {
  return sessions.map((session) => session.id);
}

describe("normalizeMessage", () => {
  it("rejects null, arrays, scalars, and messages with unknown roles", () => {
    for (const value of [null, [], "assistant", 42, { role: "system" }, { id: "missing-role" }]) {
      assert.equal(normalizeMessage(value), undefined);
    }
  });

  it("projects a complete SDK assistant message into the canonical fields", () => {
    const message = {
      id: "msg-assistant-001",
      sessionID: "session-001",
      role: "assistant",
      parentID: "msg-user-001",
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      mode: "build",
      agent: "coder",
      cost: 0.0125,
      time: { created: 1_725_000_001_000, completed: 1_725_000_004_500 },
      tokens: {
        total: 321,
        input: 100,
        output: 180,
        reasoning: 41,
        cache: { read: 12, write: 8 },
      },
    };

    assert.deepEqual(normalizeMessage(message), {
      role: "assistant",
      id: "msg-assistant-001",
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      cost: 0.0125,
      time: { created: 1_725_000_001_000, completed: 1_725_000_004_500 },
      tokens: {
        total: 321,
        input: 100,
        output: 180,
        reasoning: 41,
        cache: { read: 12, write: 8 },
      },
    });
  });

  it("preserves user identity and time without assistant-only fields", () => {
    const message = {
      id: "msg-user-001",
      sessionID: "session-001",
      role: "user",
      time: { created: 1_725_000_000_000, completed: 1_725_000_000_100 },
      agent: "coder",
      providerID: "should-not-survive",
      modelID: "should-not-survive",
      cost: 99,
      tokens: { total: 99, input: 99 },
    };

    assert.deepEqual(normalizeMessage(message), {
      role: "user",
      id: "msg-user-001",
      time: { created: 1_725_000_000_000, completed: 1_725_000_000_100 },
    });
  });

  it("accepts an assistant message with only a partial valid payload", () => {
    assert.deepEqual(normalizeMessage({ role: "assistant", id: "msg-partial" }), {
      role: "assistant",
      id: "msg-partial",
    });
  });

  it("omits non-string identifiers and non-finite numeric fields", () => {
    assert.deepEqual(
      normalizeMessage({
        role: "assistant",
        id: 123,
        providerID: null,
        modelID: {},
        cost: Number.NaN,
        time: { created: Infinity, completed: 1_725_000_004_500 },
        tokens: {
          total: Number.POSITIVE_INFINITY,
          input: 100,
          output: Number.NaN,
          reasoning: 41,
          cache: { read: -Infinity, write: 8 },
        },
      }),
      {
        role: "assistant",
        time: { completed: 1_725_000_004_500 },
        tokens: { input: 100, reasoning: 41, cache: { write: 8 } },
      },
    );
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

  it("limits independent child-list requests to four and keeps BFS order", async () => {
    const children = [
      "child-0",
      "child-1",
      "child-2",
      "child-3",
      "child-4",
      "child-5",
      "child-6",
      "child-7",
    ];
    const pending: Array<{
      id: string;
      resolve: (value: SessionSuccess) => void;
    }> = [];
    let markFourStarted!: () => void;
    const fourStarted = new Promise<void>((resolve) => {
      markFourStarted = resolve;
    });
    let markSecondBatch!: () => void;
    const secondBatchStarted = new Promise<void>((resolve) => {
      markSecondBatch = resolve;
    });
    let active = 0;
    let maximum = 0;
    let childRequests = 0;
    const api: SessionClientApi = {
      client: {
        session: {
          children: ({ sessionID }: SessionRequest) => {
            if (sessionID === "root")
              return Promise.resolve(sessionResponse(children.map(sessionRow)));
            active += 1;
            childRequests += 1;
            maximum = Math.max(maximum, active);
            if (childRequests === 4) markFourStarted();
            if (childRequests === 8) markSecondBatch();
            return new Promise<SessionSuccess>((resolve) => {
              pending.push({ id: sessionID, resolve });
            }).finally(() => {
              active -= 1;
            });
          },
        },
      },
    };

    const traversal = getSessionDescendants(api, "root");
    await fourStarted;
    assert.equal(pending.length, 4);
    assert.equal(
      pending.some(({ id }) => id === "child-4"),
      false,
    );
    for (const request of pending.splice(0)) request.resolve(sessionResponse([]));
    await secondBatchStarted;
    assert.equal(pending.length, 4);
    for (const request of pending.splice(0)) request.resolve(sessionResponse([]));

    assert.equal(maximum, 4);
    assert.deepEqual(
      (await traversal).map(({ id }) => id),
      ["child-0", "child-1", "child-2", "child-3", "child-4", "child-5", "child-6", "child-7"],
    );
  });

  it("retains stale descendants on failure and retries the failed list", async () => {
    const index = new SessionIndex();
    let attempts = 0;
    const api: SessionClientApi = {
      client: {
        session: {
          children: ({ sessionID }: SessionRequest) => {
            if (sessionID !== "root") return Promise.resolve(sessionResponse([]));
            attempts += 1;
            if (attempts === 2) return Promise.reject(new Error("transient"));
            return Promise.resolve(
              sessionResponse([sessionRow(attempts === 1 ? "child-a" : "child-b")]),
            );
          },
        },
      },
    };

    assert.deepEqual(
      (await getSessionDescendants(api, "root", { index })).map(({ id }) => id),
      ["child-a"],
    );
    assert.deepEqual(
      (await getSessionDescendants(api, "root", { index })).map(({ id }) => id),
      ["child-a"],
    );
    assert.deepEqual(
      (await getSessionDescendants(api, "root", { index })).map(({ id }) => id),
      ["child-b"],
    );
    assert.equal(attempts, 3);
  });

  it("treats SDK-shaped child-list errors as stale and retries them", async () => {
    const index = new SessionIndex();
    let attempts = 0;
    const api: SessionClientApi = {
      client: {
        session: {
          children: ({ sessionID }: SessionRequest) => {
            if (sessionID !== "root") return Promise.resolve(sessionResponse([]));
            attempts += 1;
            return attempts === 2
              ? Promise.resolve(sessionFailure())
              : Promise.resolve(sessionResponse(attempts === 1 ? [sessionRow("child")] : []));
          },
        },
      },
    };

    assert.deepEqual(ids(await getSessionDescendants(api, "root", { index })), ["child"]);
    assert.deepEqual(ids(await getSessionDescendants(api, "root", { index })), ["child"]);
    assert.equal(index.isStale("root"), true);
    assert.deepEqual(ids(await getSessionDescendants(api, "root", { index })), []);
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
    const api: SessionClientApi = {
      client: {
        session: {
          children: ({ sessionID }: SessionRequest) => {
            if (sessionID === "root")
              return Promise.resolve(sessionResponse(children.map(sessionRow)));
            started += 1;
            if (started === 4) markFourStarted();
            return new Promise<SessionSuccess>(() => undefined);
          },
        },
      },
    };

    const traversal = getSessionDescendants(api, "root", {
      signal: controller.signal,
    });
    await fourStarted;
    assert.equal(started, 4);
    controller.abort();
    await assert.rejects(traversal, { name: "AbortError" });
    assert.equal(started, 4);
  });

  it("clears one root closure without corrupting unrelated traversal caches", async () => {
    const index = new SessionIndex();
    const failures = new Set<string>();
    const { api } = apiFor(
      {
        rootA: ["a"],
        a: ["a-child"],
        "a-child": [],
        rootB: ["b"],
        b: ["b-child"],
        "b-child": [],
      },
      failures,
    );

    await getSessionDescendants(api, "rootA", { index });
    await getSessionDescendants(api, "rootB", { index });
    index.clear("rootA");

    failures.add("rootA");
    failures.add("a");
    failures.add("a-child");
    failures.add("rootB");

    assert.deepEqual(ids(await getSessionDescendants(api, "rootA", { index })), []);
    assert.deepEqual(ids(await getSessionDescendants(api, "rootB", { index })), ["b", "b-child"]);
  });
});
