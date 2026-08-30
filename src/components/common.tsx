/** @jsxImportSource @opentui/solid */
import type { Accessor, JSX } from "solid-js";

import { createComponent, createSignal, For, onCleanup } from "solid-js";

import { useTheme } from "./theme-provider";

export type Reactive<T> = Accessor<T>;

export function Chevron({ open = false, small = false }): JSX.Element {
  if (small) {
    return open ? "▾" : "▸";
  }

  return open ? "▼" : "▶";
}

export function Loader({
  symbols = ["⬝", "⬝", "⬝", "⬝", "⬝"],
  speed = 120,
}: {
  symbols?: string[];
  speed?: number;
}): JSX.Element {
  const theme = useTheme();
  const [activeIndex, setActiveIndex] = createSignal(0);
  const timer = setInterval(() => setActiveIndex((value) => (value + 1) % symbols.length), speed);
  onCleanup(() => clearInterval(timer));

  return (
    <text>
      {symbols.map((bullet, index) => (
        <span style={{ fg: index === activeIndex() ? theme().text : theme().textMuted }}>
          {bullet}
        </span>
      ))}
    </text>
  );
}

export function Collapsible(props: {
  title: Reactive<string>;
  children: () => JSX.Element;
  level?: number;
  indent?: number;
  open?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = createSignal(props.open ?? false);
  const level = Math.max(1, props.level ?? 0);

  return (
    <box>
      <box onMouseDown={() => setOpen((value) => !value)}>
        <text>
          {() => (
            <>
              <span>{Chevron({ open: open(), small: level > 1 })} </span>
              <span
                style={{
                  fg: level < 3 ? theme().text : theme().textMuted,
                  bold: level === 1 ? true : undefined,
                }}
              >
                {props.title()}
              </span>
            </>
          )}
        </text>
      </box>
      {() => (open() ? <box paddingLeft={props.indent ?? 2}>{props.children()}</box> : undefined)}
    </box>
  );
}

export function ReactiveFor<T>(props: {
  each: Accessor<ReadonlyArray<T>>;
  children: (item: T, index: Accessor<number>) => JSX.Element;
}) {
  return createComponent(For, {
    get each() {
      return props.each();
    },
    children: props.children,
  });
}
