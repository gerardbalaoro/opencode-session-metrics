/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";

import { createEffect, createMemo, createSignal, Show, type Accessor } from "solid-js";

import { type Metrics, type ModelUsage } from "../lib/metrics";
import { modelKey, type ModelKey } from "../lib/model-key";
import { formatCost, formatNumber, formatPercentage, formatSpeed } from "../lib/utils";
import { Loader, ReactiveFor } from "./common";
import { createNonZeroMetric, MetricList } from "./metrics";
import { useTheme } from "./theme-provider";

function compareIDs(a: string, b: string) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// Canonical display order is provider ID, then model ID.
function compareUsage(a: ModelUsage, b: ModelUsage) {
  return compareIDs(a.providerID, b.providerID) || compareIDs(a.modelID, b.modelID);
}

function usageByIdentity(metrics: Metrics) {
  const usages = new Map<ModelKey, ModelUsage>();
  for (const usage of metrics.models.values()) {
    usages.set(modelKey(usage.providerID, usage.modelID), usage);
  }
  return usages;
}

function providerKeys(usages: ReadonlyMap<ModelKey, ModelUsage>) {
  const keys = new Set<string>();
  for (const usage of usages.values()) keys.add(usage.providerID);
  return [...keys].sort(compareIDs);
}

function modelKeys(usages: ReadonlyMap<ModelKey, ModelUsage>, providerID: string) {
  const models = new Map<ModelKey, ModelUsage>();
  for (const usage of usages.values()) {
    if (usage.providerID === providerID) {
      models.set(modelKey(usage.providerID, usage.modelID), usage);
    }
  }
  return [...models.entries()]
    .sort(([, a], [, b]) => compareUsage(a, b))
    .map(([identity]) => identity);
}

function ModelRow(props: {
  identity: ModelKey;
  usages: Accessor<ReadonlyMap<ModelKey, ModelUsage>>;
  renderModel: (usage: Accessor<ModelUsage>) => JSX.Element;
}) {
  const initialUsage = props.usages().get(props.identity);
  if (initialUsage === undefined) return undefined;

  const [currentUsage, setCurrentUsage] = createSignal(initialUsage);
  createEffect(() => {
    const usage = props.usages().get(props.identity);
    if (usage !== undefined) setCurrentUsage(() => usage);
  });

  return props.renderModel(currentUsage);
}

export function ModelList(props: {
  metrics: Accessor<Metrics>;
  loading?: boolean;
  renderModel: (usage: Accessor<ModelUsage>) => JSX.Element;
}) {
  const theme = useTheme();
  const usages = createMemo(() => usageByIdentity(props.metrics()));
  const providers = createMemo(() => {
    if (props.loading) return [];
    return providerKeys(usages());
  });

  return (
    <Show when={!props.loading} fallback={<Loader />}>
      <box flexDirection="column">
        <ReactiveFor each={providers}>
          {(providerID) => {
            const models = createMemo(() => modelKeys(usages(), providerID));
            return (
              <box flexDirection="column">
                <text>
                  <b style={{ fg: theme().accent }}>
                    {() => props.metrics().providerCosts.get(providerID)?.name ?? providerID}
                  </b>
                </text>
                <box paddingLeft={0} flexDirection="column">
                  <ReactiveFor each={models}>
                    {(identity) => (
                      <ModelRow
                        identity={identity}
                        usages={usages}
                        renderModel={props.renderModel}
                      />
                    )}
                  </ReactiveFor>
                </box>
              </box>
            );
          }}
        </ReactiveFor>
      </box>
    </Show>
  );
}

export function ModelBreakdown({ usage }: { usage: Accessor<ModelUsage> }) {
  const modelMetrics = createMemo(() => {
    const currentUsage = usage();

    return [
      { label: "Input", value: formatNumber(currentUsage.input) },
      { label: "Output", value: formatNumber(currentUsage.output) },
      createNonZeroMetric("Reasoning", currentUsage.reasoning),
      createNonZeroMetric("Cache read", currentUsage.cacheRead),
      createNonZeroMetric("Cache write", currentUsage.cacheWrite),
      createNonZeroMetric("Cache rate", currentUsage.cacheRate ?? 0, formatPercentage),
      { label: "Speed", value: formatSpeed(currentUsage.speed) },
      { label: "Cost", value: formatCost(currentUsage.cost) },
    ];
  });

  return <MetricList rows={modelMetrics} />;
}
