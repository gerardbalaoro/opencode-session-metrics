import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createSignal, type Accessor } from "solid-js";

import { Collapsible } from "#components/common";
import { ThemeProvider } from "#components/theme-provider";
import { Context, TokenSpend, TokenBreakdown } from "#components/usage";
import { ConfigSchema } from "#config";
import { clickText, populatedMetrics, theme } from "#fixtures/ui";
import { Metrics } from "#lib/metrics";

function MountedMetrics(props: { metrics: Accessor<Metrics> }) {
  return (
    <ThemeProvider
      value={() => theme}
      children={() => (
        <box>
          <TokenBreakdown metrics={props.metrics} />
          <TokenSpend metrics={props.metrics} />
        </box>
      )}
    />
  );
}

describe("rendered metrics UI", () => {
  it("updates mounted token and provider spend rows when metrics are replaced", async () => {
    const metricsWithValues = (input: number, cost: number) => {
      const metrics = populatedMetrics();
      metrics.tokens.input = input;
      const provider = metrics.providerCosts.get("provider");
      assert.ok(provider);
      provider.cost = cost;
      return metrics;
    };
    const [metrics, setMetrics] = createSignal(metricsWithValues(1, 1));
    const setup = await testRender(() => <MountedMetrics metrics={metrics} />, {
      width: 40,
      height: 10,
    });

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /Input\s+1/);
      assert.match(frame, /Provider\s+\$1\.00/);

      for (const value of [9, 17]) {
        setMetrics(metricsWithValues(value, value));
        await setup.flush();

        frame = setup.captureCharFrame();
        assert.match(frame, new RegExp(`Input\\s+${value}`));
        assert.match(frame, new RegExp(`Provider\\s+\\$${value}\\.00`));
      }
    } finally {
      setup.renderer.destroy();
    }
  });
  it("keeps context numbers and percentage visible after disclosure", async () => {
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <Collapsible
              title={() => "Usage details"}
              children={() => (
                <Context
                  usage={() => ({ tokens: 35_443, percentage: 7 })}
                  config={ConfigSchema.parse({ context: { show: true } }).context}
                />
              )}
            />
          )}
        />
      ),
      { width: 80, height: 2 },
    );

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /▶/);
      assert.doesNotMatch(frame, /35,443/);

      await clickText(setup, "Usage details");
      frame = setup.captureCharFrame();
      assert.match(frame, /▼/);
      assert.match(frame, /35,443/);
      assert.match(frame, /7%/);

      await clickText(setup, "Usage details");
      frame = setup.captureCharFrame();
      assert.match(frame, /▶/);
      assert.doesNotMatch(frame, /35,443/);
    } finally {
      setup.renderer.destroy();
    }
  });
});
