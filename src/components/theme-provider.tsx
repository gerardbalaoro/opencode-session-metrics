import type { TuiThemeCurrent } from "@opencode-ai/plugin/tui";

import { createContext, useContext, type Accessor, type JSX } from "solid-js";

export const ThemeContext = createContext<Accessor<TuiThemeCurrent>>();

export function ThemeProvider(props: {
  value: Accessor<TuiThemeCurrent>;
  children: () => JSX.Element;
}): JSX.Element {
  return ThemeContext.Provider({
    value: props.value,
    get children() {
      return props.children();
    },
  });
}

export function useTheme(): Accessor<TuiThemeCurrent> {
  const theme = useContext(ThemeContext);
  if (theme === undefined) {
    throw new Error("useTheme() must be called within a ThemeProvider");
  }
  return theme;
}
