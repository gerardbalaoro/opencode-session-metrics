import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";
import type { Config } from "../config";
import { isContextCountWarning, isContextWarning, loadContext } from "../context";
import type { ContextUsage } from "../context";
import { SessionMetricsStore } from "../metrics-store";
import { RefreshScheduler } from "../refresh";
import { formatTokens } from "../utils";
import { Panel } from "./panel";
import type { Catalog } from "../pricing";

export function shouldShowLoading(includeSubagents: boolean, hasUsableSnapshot: boolean) {
  return includeSubagents && !hasUsableSnapshot;
}

export function Sidebar(props: {
  api: TuiPluginApi;
  config: Config;
  session_id: string;
  catalog?: Catalog;
  store?: SessionMetricsStore;
}) {
  const theme = () => props.api.theme.current;
  const cfg = () => props.config;
  const store = props.store ?? new SessionMetricsStore(props.api, { catalog: props.catalog });
  if (!props.store) onCleanup(() => store.dispose());

  const [sessionMetrics, setSessionMetrics] = createSignal(store.get(props.session_id));
  const [loading, setLoading] = createSignal(true);
  const [context, setContext] = createSignal<ContextUsage>();

  createEffect(
    on(
      () => [props.session_id, cfg().include_subagents, props.catalog] as const,
      ([sessionId, includeSubagents, catalog]) => {
        const release = store.retain(sessionId);
        store.setIncludeSubagents(includeSubagents);
        if (catalog) store.setCatalog(catalog);
        setSessionMetrics(store.prime(sessionId));
        let hasUsableSnapshot = store.hasUsableSnapshot(sessionId);
        setContext(undefined);
        setLoading(shouldShowLoading(includeSubagents, hasUsableSnapshot));

        const unsubscribe = store.subscribe(sessionId, () => {
          if (sessionId === props.session_id) {
            hasUsableSnapshot ||= store.hasUsableSnapshot(sessionId);
            setSessionMetrics(store.get(sessionId));
          }
        });
        const scheduler = new RefreshScheduler({
          api: props.api,
          store,
          sessionID: sessionId,
          includeSubagents,
          onRefresh: async (signal) => {
            hasUsableSnapshot ||= store.hasUsableSnapshot(sessionId);
            setLoading(shouldShowLoading(includeSubagents, hasUsableSnapshot));
            await store.refresh(sessionId, { signal });
            if (!signal.aborted && sessionId === props.session_id) {
              setSessionMetrics(store.get(sessionId));
              hasUsableSnapshot ||= store.hasUsableSnapshot(sessionId);
              setLoading(shouldShowLoading(includeSubagents, hasUsableSnapshot));
            }
            return !store.isDirty(sessionId);
          },
        });
        scheduler.start();

        onCleanup(() => {
          scheduler.dispose();
          unsubscribe();
          release();
        });
      },
    ),
  );

  createEffect(() => {
    if (!cfg().context.show) {
      setContext(undefined);
      return;
    }
    setContext(loadContext(props.api, props.session_id));
  });

  return (
    <box gap={1}>
      <Panel
        metrics={sessionMetrics()}
        theme={theme}
        loading={loading()}
        before={context() && <ContextLine usage={context()} config={cfg().context} theme={theme} />}
      />
    </box>
  );
}

function ContextLine(props: {
  usage?: ContextUsage;
  config: Config["context"];
  theme: () => { textMuted: unknown; warning: unknown };
}) {
  const usage = () => props.usage;

  return (
    <Show when={usage()}>
      <text>
        <span
          style={{
            fg: isContextCountWarning(usage()!.tokens, props.config.warn_on_count)
              ? props.theme().warning
              : props.theme().textMuted,
          }}
        >
          {formatTokens(usage()!.tokens)} context
        </span>
        <Show when={usage()!.percentage !== undefined}>
          <span style={{ fg: props.theme().textMuted }}> • </span>
          <span
            style={{
              fg: isContextWarning(usage()!.percentage!, props.config.warn_on_usage)
                ? props.theme().warning
                : props.theme().textMuted,
            }}
          >
            {usage()!.percentage}% used
          </span>
        </Show>
      </text>
    </Show>
  );
}
