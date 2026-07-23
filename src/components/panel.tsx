import { createSignal, onCleanup, Show, type JSX } from "solid-js";
import type { Metrics } from "../metrics";
import { formatCost, formatTokens } from "../utils";

export function Panel(props: {
  title?: string;
  metrics: Metrics;
  theme: () => { text: unknown; textMuted: unknown };
  loading?: boolean;
  before?: JSX.Element;
  after?: JSX.Element;
}) {
  const [expanded, setExpanded] = createSignal(false);
  const muted = () => props.theme().textMuted;

  return (
    <box>
      <text>
        <b style={{ fg: props.theme().text }}>{props.title || "Session"}</b>
      </text>
      {props.before}
      <Show when={!props.loading} fallback={<LoadingIndicator theme={props.theme} />}>
        <box onMouseDown={() => setExpanded((v) => !v)}>
          <text>
            <span style={{ fg: muted() }}>{formatTokens(props.metrics.tokens.total)}</span>
            <span style={{ fg: muted() }}> tokens</span>
            <Show when={props.metrics.tokens.total > 0}>
              <span style={{ fg: props.theme().text }}>{expanded() ? " ▾" : " ▸"}</span>
            </Show>
          </text>
        </box>
        <Show when={props.metrics.tokens.total > 0 && expanded()}>
          <box>
            <BreakdownLine value={props.metrics.tokens.input} label="input" muted={muted()} />
            <BreakdownLine value={props.metrics.tokens.output} label="output" muted={muted()} />
            <BreakdownLine
              value={props.metrics.tokens.reasoning}
              label="reasoning"
              muted={muted()}
            />
            <BreakdownLine
              value={props.metrics.tokens.cache_read}
              label="cache read"
              muted={muted()}
            />
            <BreakdownLine
              value={props.metrics.tokens.cache_write}
              label="cache write"
              muted={muted()}
            />
          </box>
        </Show>
        <text>
          <span style={{ fg: muted() }}>{formatCost(props.metrics.cost)}</span>
          <span style={{ fg: muted() }}> spent</span>
        </text>
      </Show>
      {props.after}
    </box>
  );
}

const LOADING_INTERVAL_MS = 120;
const LOADING_BULLETS = ["⬝", "⬝", "⬝", "⬝", "⬝"];

function LoadingIndicator(props: { theme: () => { text: unknown; textMuted: unknown } }) {
  const [activeIndex, setActiveIndex] = createSignal(0);
  const timer = setInterval(
    () => setActiveIndex((value) => (value + 1) % LOADING_BULLETS.length),
    LOADING_INTERVAL_MS,
  );
  onCleanup(() => clearInterval(timer));

  return (
    <text>
      {LOADING_BULLETS.map((bullet, index) => (
        <span
          style={{ fg: index === activeIndex() ? props.theme().text : props.theme().textMuted }}
        >
          {bullet}
        </span>
      ))}
    </text>
  );
}

function BreakdownLine(props: { value: number; label: string; muted: unknown }) {
  return (
    <Show when={props.value > 0}>
      <text>
        <span style={{ fg: props.muted }}> {formatTokens(props.value)}</span>
        <span style={{ fg: props.muted }}> {props.label}</span>
      </text>
    </Show>
  );
}
