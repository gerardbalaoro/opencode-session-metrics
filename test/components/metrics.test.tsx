import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createSignal } from "solid-js";

import { createNonZeroMetric, MetricLine, type MetricData } from "#components/metrics";
import { ThemeProvider } from "#components/theme-provider";
import { theme } from "#fixtures/ui";

describe("rendered metrics UI", () => {
  it("aligns metric values at the right edge of a fixed-width row", async () => {
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <box width={24}>
              <MetricLine metric={() => ({ label: "Input", value: "1" })} />
              <MetricLine metric={() => ({ label: "Cache write", value: "22,222" })} />
            </box>
          )}
        />
      ),
      { width: 24, height: 2 },
    );

    try {
      await setup.flush();
      assert.deepEqual(setup.captureCharFrame().split("\n").slice(0, 2), [
        "Input                  1",
        "Cache write       22,222",
      ]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("updates flat styled metric nodes through reactive row data", async () => {
    const [data, setData] = createSignal<MetricData>({
      label: { content: "Before", fg: "red" },
      value: "1",
    });
    const setup = await testRender(
      () => <ThemeProvider value={() => theme} children={() => <MetricLine metric={data} />} />,
      { width: 24, height: 1 },
    );
    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /Before\s+1/);
      setData({ label: { content: "After", fg: "blue", bold: true }, value: "2" });
      await setup.flush();
      const frame = setup.captureCharFrame();
      assert.match(frame, /After\s+2/);
      assert.doesNotMatch(frame, /Before\s+1/);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("creates visible, hidden, and custom-formatted metric data", () => {
    assert.deepEqual(createNonZeroMetric("Count", 12_345.4), {
      label: "Count",
      value: "12,345.4",
      hidden: false,
    });
    assert.deepEqual(
      createNonZeroMetric("Rate", 0.5, (value) => `${value * 100}%`),
      {
        label: "Rate",
        value: "50%",
        hidden: false,
      },
    );
    assert.deepEqual(createNonZeroMetric("Empty", 0), { label: "Empty", value: "0", hidden: true });
  });
});
