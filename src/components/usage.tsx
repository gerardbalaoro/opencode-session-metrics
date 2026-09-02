/** @jsxImportSource @opentui/solid */
import { createMemo, Show } from "solid-js";

import type { Metrics } from "../lib/metrics";

import { ConfigContextSchema, type Config } from "../config";
import { isContextCountWarning, isContextWarning, type ContextUsage } from "../lib/context";
import { formatCost, formatNumber } from "../lib/utils";
import { type Reactive } from "./common";
import { createNonZeroMetric, MetricList } from "./metrics";
import { useTheme } from "./theme-provider";

export function Context(props: {
  usage?: Reactive<ContextUsage | undefined>;
  config?: Config["context"];
}) {
  const theme = useTheme();
  const usage = () => props.usage?.();
  const config = () => props.config ?? ConfigContextSchema.parse({});
  const tokens = () => usage()?.tokens ?? 0;
  const percentage = createMemo(() => {
    const value = usage()?.percentage;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  });

  return (
    <Show when={usage()}>
      <text>
        <span
          style={{
            fg: isContextCountWarning(tokens(), config().warn_on_count)
              ? (theme().warning ?? theme().textMuted)
              : theme().textMuted,
          }}
        >
          {() => formatNumber(tokens())} context
        </span>
        <Show when={percentage() !== undefined}>
          {() => {
            const value = percentage();
            if (value === undefined) return;

            return (
              <>
                <span style={{ fg: theme().textMuted }}> • </span>
                <span
                  style={{
                    fg: isContextWarning(Math.round(value), config().warn_on_usage)
                      ? (theme().warning ?? theme().textMuted)
                      : theme().textMuted,
                  }}
                >
                  {() => `${Math.round(value)}% used`}
                </span>
              </>
            );
          }}
        </Show>
      </text>
    </Show>
  );
}

export function TokenBreakdown(props: { metrics: Reactive<Metrics> }) {
  const tokenMetrics = createMemo(() => {
    const metrics = props.metrics();

    return [
      { label: "Input", value: formatNumber(metrics.tokens.input) },
      { label: "Output", value: formatNumber(metrics.tokens.output) },
      createNonZeroMetric("Reasoning", metrics.tokens.reasoning),
      createNonZeroMetric("Cache read", metrics.tokens.cache_read),
      createNonZeroMetric("Cache write", metrics.tokens.cache_write),
    ];
  });

  return <MetricList rows={tokenMetrics} />;
}

export function TokenSpend(props: { metrics: Reactive<Metrics> }) {
  const providers = createMemo(() =>
    [...props.metrics().providerCosts.values()].sort(
      (left, right) => right.cost - left.cost || left.name.localeCompare(right.name),
    ),
  );
  const rows = createMemo(() =>
    providers().map((provider) => ({
      label: provider.name,
      value: formatCost(provider.cost),
    })),
  );

  return <MetricList rows={rows} />;
}
