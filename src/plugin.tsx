/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";

import { createCommand } from "./command";
import { Sidebar } from "./components/sidebar";
import { ConfigSchema } from "./config";
import { SessionMetricsStore } from "./lib/metrics-store";
import { loadCatalogMemoized } from "./lib/pricing";

type TuiParameters = Parameters<TuiPlugin>;
type TuiReturn = ReturnType<TuiPlugin>;

async function tui(
  api: TuiParameters[0],
  options: TuiParameters[1],
  _meta: TuiParameters[2],
): TuiReturn {
  const config = ConfigSchema.parse(options ?? {});
  const store = new SessionMetricsStore(api, { includeSubagents: config.include_subagents });

  api.keymap.registerLayer({ commands: [createCommand(api, config, store)] });
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <Sidebar api={api} session_id={props.session_id} config={config} store={store} />;
      },
    },
  });

  if (config.context.show) {
    void api.plugins.deactivate("internal:sidebar-context");
  }

  api.lifecycle.onDispose(() => store.dispose());
  void loadCatalogMemoized().then((catalog) => {
    store.setCatalog(catalog);
    void store.refreshAll();
  });
}

export default { id: "session-metrics", tui } satisfies TuiPluginModule;
