import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { currentSessionID, createCommand } from "#command";
import { ConfigSchema } from "#config";
import { SessionMetricsStore } from "#lib/metrics-store";
import plugin from "#plugin";

import { pluginHost as createPluginHost } from "./fixtures/plugin.tsx";
import { defaultMessage } from "./fixtures/ui.tsx";

describe("metrics command", () => {
  it("resolves only the session route's current session", () => {
    assert.equal(
      currentSessionID({
        route: { current: { name: "session", params: { sessionID: "session-1" } } },
      }),
      "session-1",
    );
    assert.equal(currentSessionID({ route: { current: { name: "home" } } }), undefined);
    assert.equal(
      currentSessionID({ route: { current: { name: "session", params: {} } } }),
      undefined,
    );
  });

  it("registers through the plugin boundary and renders the real dialog", async () => {
    const host = await createPluginHost({
      sessionID: "boundary-session",
      message: {
        ...defaultMessage(),
        sessionID: "boundary-session",
        providerID: "boundary-provider",
        modelID: "boundary-model",
      },
    });
    const options = {
      include_subagents: false,
      context: { show: false },
      models: { show: true },
    };

    await plugin.tui(host.api, options, {
      id: "session-metrics",
      source: "file",
      spec: "./src/plugin.tsx",
      target: "./src/plugin.tsx",
      state: "first",
      first_time: 1,
      last_time: 1,
      time_changed: 1,
      load_count: 1,
      fingerprint: "boundary-test",
    });

    const command = host.command();
    assert.ok(command);
    assert.equal(command.name, "session-metrics.open");
    assert.equal(command.slashName, "metrics");
    assert.equal(command.namespace, "palette");
    assert.equal(host.calls.slots.length, 1);

    command.run();
    const replacement = host.replacement;
    assert.ok(replacement);

    const setup = await testRender(replacement, {
      width: 100,
      height: 60,
    });
    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      assert.match(frame, /Context/);
      assert.match(frame, /Session/);
      assert.match(frame, /Boundary Provider/);
      assert.match(frame, /Boundary Model/);
      assert.match(frame, /Used\s+6/);
      assert.match(frame, /Total\s+100/);
      assert.doesNotMatch(frame, /Loading/);
      assert.ok(host.calls.stateMessages.includes("boundary-session"));
    } finally {
      setup.renderer.destroy();
      host.dispose();
    }
  });

  it("shows an informational toast when run without a current session", async () => {
    const host = await createPluginHost({ sessionID: undefined });
    const store = new SessionMetricsStore(host.api);
    const command = createCommand(host.api, ConfigSchema.parse({}), store);

    command.run();

    assert.equal(host.replacement, undefined);
    assert.equal(host.calls.toasts.length, 1);
    assert.equal(host.calls.toasts[0]?.variant, "info");
    assert.ok(host.calls.toasts[0]?.message);
    store.dispose();
    host.dispose();
  });
});
