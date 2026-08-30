import { testRender } from "@opentui/solid";
import { afterEach, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import plugin from "#plugin";

import { pluginHost, pluginMeta } from "./fixtures/plugin.tsx";
import { defaultMessage } from "./fixtures/ui.tsx";

describe("plugin boundary", () => {
  const originalCache = process.env.XDG_CACHE_HOME;
  let temporaryCache: string | undefined;

  afterEach(async () => {
    if (originalCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCache;
    if (temporaryCache) await rm(temporaryCache, { recursive: true, force: true });
    temporaryCache = undefined;
  });

  it("deactivates the context plugin only when configured", async () => {
    const enabled = await pluginHost();
    await plugin.tui(enabled.api, { context: { show: true } }, pluginMeta);
    assert.deepEqual(enabled.deactivationCalls, ["internal:sidebar-context"]);
    enabled.dispose();

    const disabled = await pluginHost();
    await plugin.tui(disabled.api, { context: { show: false } }, pluginMeta);
    assert.deepEqual(disabled.deactivationCalls, []);
    disabled.dispose();
  });

  it("removes the registered command when the plugin lifecycle is disposed", async () => {
    const host = await pluginHost();
    await plugin.tui(host.api, { context: { show: false } }, pluginMeta);

    assert.ok(
      host.api.keymap.getCommands().some((command) => command.name === "session-metrics.open"),
    );
    host.triggerLifecycleDispose();
    assert.equal(
      host.api.keymap.getCommands().some((command) => command.name === "session-metrics.open"),
      false,
    );
    host.dispose();
  });

  it("aborts deferred sidebar loading through lifecycle disposal", async () => {
    const host = await pluginHost({ sessionID: "lifecycle-session", deferMessages: true });
    await plugin.tui(host.api, { include_subagents: false, context: { show: false } }, pluginMeta);
    const slot = host.calls.slots[0];
    assert.ok(slot);
    const setup = await testRender(
      () => slot.slots.sidebar_content({}, { session_id: "lifecycle-session" }),
      { width: 100, height: 60 },
    );
    try {
      await setup.flush();
      const frameBeforeDispose = setup.captureCharFrame();
      host.triggerLifecycleDispose();
      host.releaseMessages();
      await setup.flush();
      assert.equal(host.messageSignals.length, 1);
      assert.equal(host.messageSignals[0]?.aborted, true);
      assert.equal(setup.captureCharFrame(), frameBeforeDispose);
    } finally {
      setup.renderer.destroy();
      host.dispose();
    }
  });

  it("renders catalog pricing after the plugin refreshes the registered sidebar", async () => {
    temporaryCache = await mkdtemp(join(tmpdir(), "session-metrics-catalog-"));
    process.env.XDG_CACHE_HOME = temporaryCache;
    await mkdir(join(temporaryCache, "opencode"), { recursive: true });
    await writeFile(
      join(temporaryCache, "opencode", "models.json"),
      JSON.stringify({
        "boundary-provider": {
          models: {
            "boundary-model": {
              name: "Catalog Model",
              cost: { input: 7, output: 0, cache: { read: 0, write: 0 } },
            },
          },
        },
      }),
    );
    const host = await pluginHost({
      sessionID: "catalog-session",
      message: {
        ...defaultMessage(),
        sessionID: "catalog-session",
        providerID: "boundary-provider",
        modelID: "boundary-model",
        cost: 0,
        tokens: {
          input: 1_000_000,
          output: 0,
          reasoning: 0,
          total: 1_000_000,
          cache: { read: 0, write: 0 },
        },
      },
    });
    await plugin.tui(host.api, { include_subagents: false, context: { show: false } }, pluginMeta);
    const slot = host.calls.slots[0];
    assert.ok(slot);
    const setup = await testRender(
      () => slot.slots.sidebar_content({}, { session_id: "catalog-session" }),
      { width: 100, height: 60 },
    );
    try {
      await setup.flush();
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (setup.captureCharFrame().includes("$7.00 spent")) break;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await setup.flush();
      }
      assert.match(setup.captureCharFrame(), /\$7\.00 spent/);
      assert.ok(host.calls.clientMessages.length > 0);
    } finally {
      setup.renderer.destroy();
      host.dispose();
    }
  });

  it("forwards configured sidebar behavior through the registered plugin boundary", async () => {
    temporaryCache = await mkdtemp(join(tmpdir(), "session-metrics-boundary-"));
    process.env.XDG_CACHE_HOME = temporaryCache;
    await mkdir(join(temporaryCache, "opencode"), { recursive: true });
    await writeFile(join(temporaryCache, "opencode", "models.json"), "{}");
    const rootMessage = {
      ...defaultMessage(),
      sessionID: "root",
      providerID: "boundary-provider",
      modelID: "boundary-model",
      cost: 0,
      tokens: { input: 1, output: 0, reasoning: 0, total: 1, cache: { read: 0, write: 0 } },
    };
    const host = await pluginHost({
      sessionID: "root",
      message: rootMessage,
    });
    await plugin.tui(
      host.api,
      { include_subagents: false, context: { show: true }, models: { show: false } },
      pluginMeta,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const slot = host.calls.slots[0];
    assert.ok(slot);
    const setup = await testRender(() => slot.slots.sidebar_content({}, { session_id: "root" }), {
      width: 100,
      height: 20,
    });

    try {
      await setup.flush();
      await setup.waitFor(() => setup.captureCharFrame().includes("1 tokens"));
      const frame = setup.captureCharFrame();
      assert.match(frame, /1 tokens/);
      assert.doesNotMatch(frame, /Models/);
    } finally {
      setup.renderer.destroy();
      host.dispose();
    }
  });
});
