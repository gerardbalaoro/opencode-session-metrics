import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { ConfigSchema } from "./config";
import { Sidebar } from "./components/sidebar";
import { loadCatalog } from "./pricing";

const tui: TuiPlugin = async (api, options) => {
  const config = ConfigSchema.parse(options ?? {});
  const catalog = await loadCatalog();

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        return <Sidebar api={api} session_id={props.session_id} config={config} catalog={catalog} />;
      },
    },
  });
};

export default { id: "session-metrics", tui } satisfies TuiPluginModule;
