/** @jsxImportSource @opentui/solid */
import type { createTextAttributes, StyleAttrs } from "@opentui/core";

import { splitProps, type ComponentProps } from "solid-js";

import { formatNumber } from "#lib/utils";

import { ReactiveFor, type Reactive } from "./common";
import { useTheme } from "./theme-provider";

type SpanStyle = Omit<
  Pick<StyleAttrs, "fg" | "bg"> & NonNullable<Parameters<typeof createTextAttributes>[0]>,
  "content" | "children"
>;

export type MetricNode = string | ({ content: string } & SpanStyle);
export type MetricData = { label: MetricNode; value: MetricNode; hidden?: boolean };
export function createNonZeroMetric(
  label: string,
  value: number,
  format: (value: number) => string = formatNumber,
): MetricData {
  return { label, value: format(value), hidden: value === 0 };
}

function renderMetricNode(node: MetricNode) {
  const theme = useTheme();

  if (typeof node === "string") {
    return <span style={{ fg: theme().textMuted }}>{node}</span>;
  }

  const { content, ...style } = node;
  return <span style={style}>{content}</span>;
}

export function MetricLine(props: { metric: Reactive<MetricData> } & ComponentProps<"box">) {
  const [metricProps, boxProps] = splitProps(props, ["metric"]);

  return (
    <box flexDirection="row" gap={1} {...boxProps}>
      <text flexGrow={1} overflow="hidden" wrapMode="none">
        {() => renderMetricNode(metricProps.metric().label)}
      </text>
      <box flexShrink={0}>
        <text>{() => renderMetricNode(metricProps.metric().value)}</text>
      </box>
    </box>
  );
}

export function MetricList(props: { rows: Reactive<MetricData[]> } & ComponentProps<"box">) {
  const [rowProps, boxProps] = splitProps(props, ["rows"]);

  return (
    <box flexDirection="column" {...boxProps}>
      <ReactiveFor each={rowProps.rows}>
        {(_, index) => {
          const key = index();
          const metric = rowProps.rows()[key];

          if (!metric || metric.hidden) return;

          return <MetricLine key={key} metric={() => metric} />;
        }}
      </ReactiveFor>
    </box>
  );
}
