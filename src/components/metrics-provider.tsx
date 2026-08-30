import {
  createContext,
  createEffect,
  createSignal,
  on,
  onCleanup,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";

import type { MetricsProviderApi } from "#lib/api";
import type { ContextUsage } from "#lib/context";
import type { Metrics } from "#lib/metrics";
import type { Catalog } from "#lib/pricing";

import { loadContext } from "#lib/context";
import { SessionMetricsStore, type MetricsStore } from "#lib/metrics-store";

function isMetricsLoading(includeSubagents: boolean, hasUsableSnapshot: boolean) {
  return includeSubagents && !hasUsableSnapshot;
}

export type MetricsContextValue = Readonly<{
  metrics: Accessor<Metrics>;
  loading: Accessor<boolean>;
  context: Accessor<ContextUsage | undefined>;
}>;

const MetricsContext = createContext<MetricsContextValue>();

export function MetricsProvider(props: {
  api: MetricsProviderApi;
  sessionID: string;
  includeSubagents: boolean;
  store?: MetricsStore;
  catalog?: Catalog;
  children: () => JSX.Element;
}): JSX.Element {
  const { store, dispose } = (() => {
    if (props.store !== undefined) return { store: props.store };
    const store = new SessionMetricsStore(props.api, { catalog: props.catalog });
    return { store, dispose: () => store.dispose() };
  })();
  if (dispose !== undefined) onCleanup(dispose);

  const [metrics, setMetrics] = createSignal(store.get(props.sessionID));
  const [loading, setLoading] = createSignal(
    isMetricsLoading(props.includeSubagents, store.hasUsableSnapshot(props.sessionID)),
  );
  const [context, setContext] = createSignal<ContextUsage | undefined>(
    loadContext(props.api, props.sessionID),
  );

  createEffect(
    on(
      () => [props.sessionID, props.includeSubagents, props.catalog] as const,
      ([sessionID, includeSubagents, catalog]) => {
        let active = true;
        const release = store.retain(sessionID);
        store.setIncludeSubagents(includeSubagents);
        if (catalog !== undefined) store.setCatalog(catalog);

        setMetrics(store.prime(sessionID));
        let hasUsableSnapshot = store.hasUsableSnapshot(sessionID);
        setLoading(isMetricsLoading(includeSubagents, hasUsableSnapshot));
        setContext(loadContext(props.api, sessionID));

        const unsubscribe = store.subscribe(sessionID, (notifiedSessionID?: string) => {
          if (
            !active ||
            (notifiedSessionID !== undefined && notifiedSessionID !== sessionID) ||
            props.sessionID !== sessionID ||
            props.includeSubagents !== includeSubagents ||
            props.catalog !== catalog
          ) {
            return;
          }

          hasUsableSnapshot ||= store.hasUsableSnapshot(sessionID);
          setMetrics(store.get(sessionID));
          setLoading(isMetricsLoading(includeSubagents, hasUsableSnapshot));
          setContext(loadContext(props.api, sessionID));
        });
        const releaseRefresh = store.retainRefresh(sessionID, includeSubagents);

        onCleanup(() => {
          active = false;
          unsubscribe();
          releaseRefresh();
          release();
        });
      },
    ),
  );

  const value: MetricsContextValue = { metrics, loading, context };
  return MetricsContext.Provider({
    value,
    get children() {
      return props.children();
    },
  });
}

export function useMetrics(): MetricsContextValue {
  const metrics = useContext(MetricsContext);
  if (metrics === undefined) {
    throw new Error("useMetrics() must be called within a MetricsProvider");
  }
  return metrics;
}
