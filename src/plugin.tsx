import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ConfigSchema } from "./config";
import { Sidebar } from "./components/sidebar";
import { SessionMetricsStore } from "./metrics-store";
import { loadCatalogMemoized } from "./pricing";

const tui: TuiPlugin = async (api, options) => {
  const config = ConfigSchema.parse(options ?? {});
  const store = new SessionMetricsStore(api, { includeSubagents: config.include_subagents });

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <Sidebar api={api} session_id={props.session_id} config={config} store={store} />;
      },
    },
  });

  api.lifecycle.onDispose(() => store.dispose());
  void loadCatalogMemoized().then((catalog) => {
    if (!store.isDisposed) {
      store.setCatalog(catalog);
      void store.refreshAll();
    }
  });
};

export default { id: "session-metrics", tui } satisfies TuiPluginModule;
