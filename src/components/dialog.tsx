/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";

import { useTerminalDimensions } from "@opentui/solid";
import { children, createMemo, type Accessor } from "solid-js";

import type { Config } from "#config";
import type { MetricsProviderApi } from "#lib/api";
import type { ModelUsage } from "#lib/metrics";
import type { MetricsStore } from "#lib/metrics-store";

import { formatCost, formatNumber } from "#lib/utils";

import { type Reactive } from "./common";
import { MetricLine, MetricList } from "./metrics";
import { MetricsProvider, useMetrics } from "./metrics-provider";
import { ModelBreakdown, ModelList } from "./models";
import { ModelsProvider, useModels } from "./models-provider";
import { ThemeProvider, useTheme } from "./theme-provider";
import { TokenBreakdown } from "./usage";

function getMaxHeight(height: number) {
  return Math.max(1, Math.floor(height / 2) - 6);
}

function Section(props: { title: Reactive<string>; children: JSX.Element }) {
  const theme = useTheme();
  const resolvedChildren = children(() => props.children);

  return (
    <box flexDirection="column" gap={1}>
      <box>
        <text>
          <b style={{ fg: theme().text }}>{props.title()}</b>
        </text>
      </box>
      <box>{resolvedChildren()}</box>
    </box>
  );
}

function DialogModel(props: { usage: Accessor<ModelUsage> }) {
  const theme = useTheme();
  const { getModelName } = useModels();
  const name = createMemo(() => {
    const usage = props.usage();
    return getModelName(usage.providerID, usage.modelID);
  });

  return (
    <box>
      <box paddingLeft={0}>
        <text>
          <span style={{ fg: theme().text }}>{name}</span>
        </text>
      </box>
      <box paddingLeft={2}>
        <ModelBreakdown usage={props.usage} />
      </box>
    </box>
  );
}

export function MetricsDialog(props: {
  api: MetricsProviderApi;
  config: Config;
  session_id: string;
  store: MetricsStore;
}) {
  function DialogContent() {
    const dimensions = useTerminalDimensions();
    const { metrics, loading, context } = useMetrics();

    return (
      <scrollbox
        width="100%"
        minWidth={0}
        maxHeight={getMaxHeight(dimensions().height)}
        flexGrow={1}
        scrollY={true}
      >
        <box width="100%" minWidth={0} gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
          <Section title={() => "Context"}>
            <MetricList
              rows={() => {
                const usage = context();
                return [
                  { label: "Used", value: formatNumber(usage?.tokens || 0) },
                  ...(usage?.total === undefined
                    ? []
                    : [{ label: "Total", value: formatNumber(usage.total) }]),
                ];
              }}
            />
          </Section>
          <Section title={() => "Session"}>
            <TokenBreakdown metrics={metrics} />
            <MetricLine
              metric={() => ({ label: "Cost", value: formatCost(metrics().totalCost) })}
            />
          </Section>
          <Section title={() => "Models"}>
            <ModelList
              metrics={metrics}
              loading={loading()}
              renderModel={(usage) => <DialogModel usage={usage} />}
            />
          </Section>
        </box>
      </scrollbox>
    );
  }

  return (
    <MetricsProvider
      api={props.api}
      sessionID={props.session_id}
      includeSubagents={props.config.include_subagents}
      store={props.store}
      children={() => (
        <ThemeProvider
          value={() => props.api.theme.current}
          children={() => (
            <ModelsProvider
              value={() => props.api.state.provider}
              children={() => <DialogContent />}
            />
          )}
        />
      )}
    />
  );
}
