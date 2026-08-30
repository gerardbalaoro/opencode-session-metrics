import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { modelKey } from "#lib/model-key";
describe("model keys", () => {
  it("uses distinct canonical keys for slash-containing provider/model tuples", () => {
    assert.notEqual(modelKey("provider/model", "id"), modelKey("provider", "model/id"));
  });
});
