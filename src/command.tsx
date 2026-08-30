/** @jsxImportSource @opentui/solid */

import type { Config } from "./config";
import type { CommandApi, RouteApi } from "./lib/api";
import type { MetricsStore } from "./lib/metrics-store";

import { MetricsDialog } from "./components/dialog";

export const METRICS_COMMAND_NAME = "session-metrics.open";
export const METRICS_SLASH_NAME = "metrics";

export function currentSessionID(api: RouteApi) {
  const route = api.route.current;
  if (route.name !== "session") return undefined;

  const sessionID = route.params?.sessionID;
  return typeof sessionID === "string" && sessionID.length > 0 ? sessionID : undefined;
}

export function createCommand(api: CommandApi, config: Config, store: MetricsStore) {
  return {
    title: "Open session metrics",
    name: METRICS_COMMAND_NAME,
    category: "Session",
    desc: "Show token usage and cost for the current session",
    namespace: "palette",
    slashName: METRICS_SLASH_NAME,
    run: () => {
      const sessionID = currentSessionID(api);
      if (!sessionID) {
        api.ui.toast({
          variant: "info",
          title: "Session metrics",
          message: "Open a session before using /metrics.",
        });
        return;
      }

      api.ui.dialog.replace(() => (
        <MetricsDialog api={api} config={config} session_id={sessionID} store={store} />
      ));
    },
  };
}
