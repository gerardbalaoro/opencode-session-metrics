import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";

import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createSignal } from "solid-js";

import { ThemeProvider, useTheme } from "#components/theme-provider";
import { theme } from "#fixtures/ui";

describe("rendered metrics UI", () => {
  it("passes through accessor-backed themes and updates consumers", async () => {
    const updatedTheme = {
      ...theme,
      text: RGBA.fromHex("#000000"),
    };
    const [currentTheme, setTheme] = createSignal<TuiThemeCurrent>(theme);
    const ThemeConsumer = () => {
      const providedTheme = useTheme();
      return (
        <text>{() => (providedTheme().text === updatedTheme.text ? "updated" : "initial")}</text>
      );
    };
    const setup = await testRender(
      () => <ThemeProvider value={currentTheme} children={() => <ThemeConsumer />} />,
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /initial/);

      setTheme(updatedTheme);
      await setup.flush();

      const frame = setup.captureCharFrame();
      assert.match(frame, /updated/);
      assert.doesNotMatch(frame, /initial/);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("throws when used outside a ThemeProvider", () => {
    assert.throws(() => useTheme());
  });
});
