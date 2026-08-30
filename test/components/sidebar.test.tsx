import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { MetricsDialog } from "#components/dialog";
import { Sidebar } from "#components/sidebar";
import { ConfigSchema } from "#config";
import { clickText, defaultMessage, renderApi } from "#fixtures/ui";
import { loadContext } from "#lib/context";
import { SessionMetricsStore } from "#lib/metrics-store";

describe("rendered metrics UI", () => {
  it("mounts Sidebar wiring for gated context, defaults, and interactive disclosures", async () => {
    const initialMessage = {
      ...defaultMessage(),
      id: "message-1",
      role: "assistant" as const,
      providerID: "provider",
      modelID: "model",
      cost: 1,
      tokens: {
        input: 11,
        output: 7,
        reasoning: 3,
        total: 28,
        cache: { read: 5, write: 2 },
      },
    };
    const providers = [
      {
        id: "provider",
        name: "Provider",
        source: "custom" as const,
        env: [],
        options: {},
        models: {
          model: {
            id: "model",
            providerID: "provider",
            api: { id: "api", url: "https://example.test", npm: "example" },
            name: "Readable Model",
            family: "model",
            options: {},
            headers: {},
            capabilities: {
              temperature: true,
              reasoning: true,
              attachment: false,
              toolcall: true,
              input: { text: true, audio: false, image: false, video: false, pdf: false },
              output: { text: true, audio: false, image: false, video: false, pdf: false },
              interleaved: false,
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: { context: 400, output: 1 },
            status: "active" as const,
            release_date: "2026-01-01",
          },
        },
      },
    ];
    const rendered = renderApi({ providers, messagesBySession: { root: [initialMessage] } });
    const store = new SessionMetricsStore(rendered.api);
    const hiddenSetup = await testRender(
      () => (
        <Sidebar
          api={rendered.api}
          config={ConfigSchema.parse({ context: { show: false }, models: { show: true } })}
          session_id="root"
          store={store}
        />
      ),
      { width: 100, height: 40 },
    );

    try {
      await hiddenSetup.flush();
      assert.doesNotMatch(hiddenSetup.captureCharFrame(), /context/);
    } finally {
      hiddenSetup.renderer.destroy();
    }

    const setup = await testRender(
      () => (
        <Sidebar
          api={rendered.api}
          config={ConfigSchema.parse({ context: { show: true }, models: { show: true } })}
          session_id="root"
          store={store}
        />
      ),
      { width: 100, height: 40 },
    );

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /▼ Session/);
      assert.match(frame, /28 context • 7% used/);
      assert.match(frame, /▸ 28 tokens/);
      assert.match(frame, /▸ \$1\.00 spent/);
      assert.match(frame, /▶ Models/);
      assert.doesNotMatch(frame, /Readable Model/);

      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ 28 tokens/);
      assert.match(frame, /Input\s+11/);
      await clickText(setup, "28 tokens");
      assert.match(setup.captureCharFrame(), /▸ 28 tokens/);
      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ 28 tokens/);
      assert.match(frame, /Cache write\s+2/);

      await clickText(setup, "$1.00 spent");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ \$1\.00 spent/);
      assert.match(frame, /Provider\s+\$1\.00/);

      await clickText(setup, "Models");
      frame = setup.captureCharFrame();
      assert.match(frame, /▼ Models/);
      assert.match(frame, /▸ Readable Model/);

      await clickText(setup, "Readable Model");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ Readable Model/);
      assert.match(frame, /Input\s+11/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });

  it("expands the mounted token disclosure through Sidebar's real mouse handler", async () => {
    const initialMessage = {
      ...defaultMessage(),
      id: "message-1",
      role: "assistant" as const,
      providerID: "provider",
      modelID: "model",
      cost: 1,
      tokens: {
        input: 11,
        output: 7,
        reasoning: 3,
        total: 28,
        cache: { read: 5, write: 2 },
      },
    };
    const rendered = renderApi({ messagesBySession: { root: [initialMessage] } });
    const store = new SessionMetricsStore(rendered.api);
    const setup = await testRender(
      () => (
        <Sidebar
          api={rendered.api}
          config={ConfigSchema.parse({
            include_subagents: false,
            context: { show: false },
            models: { show: false },
          })}
          session_id="root"
          store={store}
        />
      ),
      { width: 100, height: 20 },
    );

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /▸ 28 tokens/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.doesNotMatch(frame, new RegExp(label));
      }

      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ 28 tokens/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.match(frame, new RegExp(label));
      }

      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▸ 28 tokens/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.doesNotMatch(frame, new RegExp(label));
      }

      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ 28 tokens/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.match(frame, new RegExp(label));
      }

      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▸ 28 tokens/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.doesNotMatch(frame, new RegExp(label));
      }

      await clickText(setup, "28 tokens");
      frame = setup.captureCharFrame();
      assert.match(frame, /▾ 28 tokens/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.match(frame, new RegExp(label));
      }
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });

  it("shares ownership between sidebar and dialog across session changes", async () => {
    const rendered = renderApi();
    const store = new SessionMetricsStore(rendered.api);
    const config = ConfigSchema.parse({});
    const setup = await testRender(
      () => (
        <box>
          <Sidebar api={rendered.api} config={config} session_id="root" store={store} />
          <MetricsDialog api={rendered.api} config={config} session_id="root" store={store} />
        </box>
      ),
      { width: 100, height: 24 },
    );

    try {
      await setup.flush();
      const initialRequests = rendered.requests();
      assert.ok(initialRequests > 0);

      rendered.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await setup.flush();
      assert.ok(rendered.requests() > initialRequests);

      setup.renderer.destroy();
      const afterRootRelease = rendered.requests();

      rendered.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await Promise.resolve();
      assert.equal(rendered.requests(), afterRootRelease);

      const nextSetup = await testRender(
        () => <Sidebar api={rendered.api} config={config} session_id="next" store={store} />,
        { width: 100, height: 24 },
      );
      await nextSetup.flush();
      const nextRequests = rendered.requests();
      rendered.emit({ type: "message.updated", properties: { sessionID: "next" } });
      await nextSetup.flush();
      assert.ok(rendered.requests() > nextRequests);
      nextSetup.renderer.destroy();
    } finally {
      store.dispose();
    }
  });

  it("cleans up independently mounted roots while coalescing their refresh lease", async () => {
    const rendered = renderApi();
    const store = new SessionMetricsStore(rendered.api);
    const config = ConfigSchema.parse({});
    const sidebarSetup = await testRender(
      () => <Sidebar api={rendered.api} config={config} session_id="root" store={store} />,
      { width: 80, height: 24 },
    );
    const dialogSetup = await testRender(
      () => <MetricsDialog api={rendered.api} config={config} session_id="root" store={store} />,
      { width: 80, height: 24 },
    );

    try {
      await sidebarSetup.flush();
      await dialogSetup.flush();
      const initialRequests = rendered.requests();
      assert.ok(initialRequests > 0);

      rendered.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await dialogSetup.flush();
      assert.ok(rendered.requests() > initialRequests);
      const sharedRequests = rendered.requests();

      sidebarSetup.renderer.destroy();

      rendered.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await dialogSetup.flush();
      assert.ok(rendered.requests() > sharedRequests);
      const remainingRequests = rendered.requests();

      dialogSetup.renderer.destroy();

      rendered.emit({ type: "message.updated", properties: { sessionID: "root" } });
      await Promise.resolve();
      assert.equal(rendered.requests(), remainingRequests);
    } finally {
      store.dispose();
    }
  });

  it("disposes Sidebar's internally owned store and refresh activity on unmount", async () => {
    const rendered = renderApi();
    const config = ConfigSchema.parse({
      include_subagents: false,
      context: { show: false },
      models: { show: false },
    });
    const setup = await testRender(
      () => <Sidebar api={rendered.api} config={config} session_id="root" />,
      { width: 80, height: 12 },
    );

    let requests = 0;
    try {
      await setup.flush();
      requests = rendered.requests();
      assert.ok(requests > 0);
    } finally {
      setup.renderer.destroy();
    }

    rendered.emit({ type: "message.updated", properties: { sessionID: "root" } });
    await Promise.resolve();
    assert.equal(rendered.requests(), requests);
  });

  it("refreshes Sidebar context from store notifications", async () => {
    const messages = [
      {
        ...defaultMessage(),
        id: "message-1",
        role: "assistant" as const,
        providerID: "provider",
        modelID: "model",
        cost: 1,
        tokens: {
          input: 3,
          output: 2,
          reasoning: 1,
          total: 6,
          cache: { read: 0, write: 0 },
        },
      },
    ];
    const rendered = renderApi({ messagesBySession: { root: messages } });
    const store = new SessionMetricsStore(rendered.api);
    const setup = await testRender(
      () => (
        <Sidebar
          api={rendered.api}
          config={ConfigSchema.parse({ context: { show: true }, models: { show: false } })}
          session_id="root"
          store={store}
        />
      ),
      { width: 80, height: 12 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /6 context/);
      let notifications = 0;
      const unsubscribe = store.subscribe("root", () => (notifications += 1));

      messages.push({
        ...messages[0],
        id: "message-2",
        tokens: {
          input: 8,
          output: 4,
          reasoning: 2,
          total: 14,
          cache: { read: 0, write: 0 },
        },
      });
      assert.equal(loadContext(rendered.api, "root")?.tokens, 14);
      store.invalidate("root");
      assert.equal(notifications, 1);
      unsubscribe();
      await setup.waitFor(() => setup.captureCharFrame().includes("14 context"));

      const frame = setup.captureCharFrame();
      assert.match(frame, /14 context/);
      assert.doesNotMatch(frame, /6 context/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });
});
