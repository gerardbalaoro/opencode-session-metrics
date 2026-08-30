/** @jsxImportSource @opentui/solid */
import { createMemo, Show, type Accessor } from "solid-js";

import type { Config } from "#config";
import type { MetricsProviderApi } from "#lib/api";
import type { ModelUsage } from "#lib/metrics";
import type { MetricsStore } from "#lib/metrics-store";
import type { Catalog } from "#lib/pricing";

import { formatCost, formatNumber } from "#lib/utils";

import { Collapsible, Loader } from "./common";
import { MetricsProvider, useMetrics } from "./metrics-provider";
import { ModelBreakdown, ModelList } from "./models";
import { ModelsProvider, useModels } from "./models-provider";
import { ThemeProvider } from "./theme-provider";
import { TokenSpend, TokenBreakdown, Context } from "./usage";

function UsageModel(props: { usage: Accessor<ModelUsage> }) {
  const { getModelName } = useModels();
  const name = createMemo(() => {
    const usage = props.usage();
    return getModelName(usage.providerID, usage.modelID);
  });

  return (
    <Collapsible title={name} level={2} children={() => <ModelBreakdown usage={props.usage} />} />
  );
}

function UsageTokens(props: { config: Config }) {
  const { metrics, loading, context } = useMetrics();

  return (
    <>
      <Show when={props.config.context.show}>
        <Context usage={context} config={props.config.context} />
      </Show>
      <Show when={!loading()} fallback={<Loader />}>
        <Collapsible
          title={() => `${formatNumber(metrics().tokens.total)} tokens`}
          level={3}
          children={() => <TokenBreakdown metrics={metrics} />}
        />
        <Collapsible
          title={() => `${formatCost(metrics().totalCost)} spent`}
          level={3}
          children={() => <TokenSpend metrics={metrics} />}
        />
      </Show>
    </>
  );
}

function SidebarContent(props: { config: Config }) {
  const { metrics, loading } = useMetrics();

  return (
    <box gap={1}>
      <Collapsible
        title={() => "Session"}
        open={true}
        indent={0}
        children={() => <UsageTokens config={props.config} />}
      />
      <Show when={props.config.models.show && metrics().models.size > 0}>
        <Collapsible
          title={() => "Models"}
          indent={0}
          children={() => (
            <ModelList
              metrics={metrics}
              loading={loading()}
              renderModel={(usage) => <UsageModel usage={usage} />}
            />
          )}
        />
      </Show>
    </box>
  );
}

export function Sidebar(props: {
  api: MetricsProviderApi;
  config: Config;
  session_id: string;
  catalog?: Catalog;
  store?: MetricsStore;
}) {
  return (
    <MetricsProvider
      api={props.api}
      sessionID={props.session_id}
      includeSubagents={props.config.include_subagents}
      store={props.store}
      catalog={props.catalog}
      children={() => (
        <ThemeProvider
          value={() => props.api.theme.current}
          children={() => (
            <ModelsProvider
              value={() => props.api.state.provider}
              children={() => <SidebarContent config={props.config} />}
            />
          )}
        />
      )}
    />
  );
}
