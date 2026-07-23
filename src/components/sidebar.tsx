import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import type { Config } from "../config";
import { isContextCountWarning, isContextWarning, loadContext } from "../context";
import type { ContextUsage } from "../context";
import { Metrics } from "../metrics";
import { formatTokens } from "../utils";
import { Panel } from "./panel";

export function Sidebar(props: { api: TuiPluginApi; config: Config; session_id: string }) {
  const theme = () => props.api.theme.current;
  const cfg = () => props.config;

  const [sessionMetrics, setSessionMetrics] = createSignal<Metrics>(new Metrics());
  const [childMetrics, setChildMetrics] = createSignal<Metrics>(new Metrics());
  const [loading, setLoading] = createSignal(false);
  const [context, setContext] = createSignal<ContextUsage>();

  createEffect(
    on(
      () => [props.session_id, cfg().include_subagents] as const,
      ([sessionId, includeSubagents]) => {
        const session = props.api.state.session.get(sessionId);
        const messages = props.api.state.session.messages(sessionId);
        const localMetrics =
          messages.length > 0
            ? Metrics.fromMessages(messages)
            : session
              ? Metrics.fromSessionRollup(session)
              : undefined;

        setSessionMetrics(localMetrics ?? new Metrics());
        setChildMetrics(new Metrics());
        setContext(undefined);
        setLoading(includeSubagents);
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

  createEffect(
    on(
      () => [props.session_id, cfg().include_subagents] as const,
      ([sessionId, includeSubagents]) => {
        const sequence = {
          cancelled: false,
          inFlight: false,
          timeout: undefined as ReturnType<typeof setTimeout> | undefined,
        };

        const refresh = async () => {
          if (sequence.cancelled || sequence.inFlight) return;
          sequence.inFlight = true;

          try {
            const [session, children] = await Promise.all([
              (async () => {
                const session = props.api.state.session.get(sessionId);
                if (!session) return new Metrics();
                return Metrics.fromSessionMessages(props.api, session);
              })(),
              includeSubagents
                ? Metrics.fromSessionDescendants(props.api, sessionId)
                : Promise.resolve(new Metrics()),
            ]);

            if (!sequence.cancelled && sessionId === props.session_id) {
              setSessionMetrics(session);
              setChildMetrics(children);
              setLoading(false);
            }
          } catch {
            if (!sequence.cancelled && sessionId === props.session_id) {
              setLoading(false);
            }
          } finally {
            sequence.inFlight = false;
            if (!sequence.cancelled) {
              sequence.timeout = setTimeout(() => void refresh(), 2000);
            }
          }
        };

        void refresh();

        onCleanup(() => {
          sequence.cancelled = true;
          if (sequence.timeout !== undefined) clearTimeout(sequence.timeout);
        });
      },
    ),
  );

  const data = createMemo(() => {
    const base = sessionMetrics();
    if (!cfg().include_subagents) return base;
    return Metrics.merge(base, childMetrics());
  });

  return (
    <box gap={1}>
      <Panel
        metrics={data()}
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
