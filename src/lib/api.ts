import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export type SessionClient = {
  [Key in "messages" | "children" | "get"]: (
    ...args: Parameters<TuiPluginApi["client"]["session"][Key]>
  ) => Promise<Awaited<ReturnType<TuiPluginApi["client"]["session"][Key]>>>;
};
export type SessionClientApi = { client: { session: Pick<SessionClient, "children"> } };
export type SessionState = Pick<TuiPluginApi["state"]["session"], "messages" | "get" | "status">;
type UnknownStateMessages = (
  ...args: Parameters<SessionState["messages"]>
) => ReadonlyArray<unknown>;
type UnknownSessionRequest<Key extends "messages" | "get"> = (
  ...args: Parameters<TuiPluginApi["client"]["session"][Key]>
) => Promise<unknown>;
type TuiProvider = TuiPluginApi["state"]["provider"][number];
type TuiModel = TuiProvider["models"][string];
type ProviderModel = Pick<TuiModel, "name"> & {
  limit?: Pick<TuiModel["limit"], "context">;
  cost?: Pick<TuiModel["cost"], "input" | "output" | "cache" | "tiers" | "experimentalOver200K">;
};
export type ProviderState = ReadonlyArray<
  Pick<TuiProvider, "id" | "name"> & { models: Record<string, ProviderModel> }
>;
export type ProviderApi = { state: { provider: ProviderState } };
export type ThemeApi = { theme: Pick<TuiPluginApi["theme"], "current"> };
export type RouteApi = { route: Pick<TuiPluginApi["route"], "current"> };
export type UiApi = {
  ui: Pick<TuiPluginApi["ui"], "toast"> & {
    dialog: Pick<TuiPluginApi["ui"]["dialog"], "replace">;
  };
};
export type ContextApi = {
  state: {
    session: { messages: UnknownStateMessages };
    provider: ProviderState;
  };
};

export type MetricsLoaderApi = {
  state: {
    session: Pick<SessionState, "get" | "status"> & { messages: UnknownStateMessages };
    provider: ProviderState;
  };
  client: {
    session: Pick<SessionClient, "children"> & {
      messages: UnknownSessionRequest<"messages">;
      get: UnknownSessionRequest<"get">;
    };
  };
};

export type RefreshApi = {
  event: Pick<TuiPluginApi["event"], "on">;
  state: {
    session: Pick<TuiPluginApi["state"]["session"], "status">;
  };
};

export type SessionDataApi = RefreshApi & {
  state: {
    session: SessionState;
    provider: ProviderState;
  };
  client: {
    session: SessionClient;
  };
};

export type MetricsProviderApi = SessionDataApi & ContextApi & ThemeApi;
export type CommandApi = MetricsProviderApi & RouteApi & UiApi;
