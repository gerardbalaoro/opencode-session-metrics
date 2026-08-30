import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { onCleanup } from "solid-js";

import { Collapsible } from "#components/common";
import { ThemeProvider } from "#components/theme-provider";
import { clickText, theme } from "#fixtures/ui";

describe("rendered metrics UI", () => {
  it("remounts Collapsible children and cleans up each closed instance", async () => {
    let mounts = 0;
    let cleanups = 0;
    const Child = () => {
      const instance = ++mounts;
      onCleanup(() => (cleanups += 1));
      return <text>{`instance ${instance}`}</text>;
    };
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => <Collapsible title={() => "Details"} children={() => <Child />} />}
        />
      ),
      { width: 30, height: 3 },
    );

    const clickDisclosure = () => clickText(setup, "Details");

    try {
      await setup.flush();
      assert.equal(mounts, 0);
      assert.equal(cleanups, 0);

      await clickDisclosure();
      assert.equal(mounts, 1);
      assert.equal(cleanups, 0);
      assert.match(setup.captureCharFrame(), /instance 1/);

      await clickDisclosure();
      assert.equal(mounts, 1);
      assert.equal(cleanups, 1);
      assert.doesNotMatch(setup.captureCharFrame(), /instance/);

      await clickDisclosure();
      assert.equal(mounts, 2);
      assert.equal(cleanups, 1);
      assert.match(setup.captureCharFrame(), /instance 2/);
      assert.doesNotMatch(setup.captureCharFrame(), /instance 1/);
    } finally {
      setup.renderer.destroy();
    }

    assert.equal(cleanups, 2);
  });
});
