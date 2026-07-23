import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getSessionDescendants } from "../src/session.ts";

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
});
