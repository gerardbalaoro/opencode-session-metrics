import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import type { MetricsProviderApi } from "#lib/api";
import type { MetricsStore } from "#lib/metrics-store";
import type { Catalog } from "#lib/pricing";

import { MetricsProvider, useMetrics } from "#components/metrics-provider";
import { ThemeProvider } from "#components/theme-provider";
import { Context } from "#components/usage";
import { ConfigSchema } from "#config";
import { defaultMessage, renderApi, theme } from "#fixtures/ui";
import { Metrics } from "#lib/metrics";
import { SessionMetricsStore } from "#lib/metrics-store";
import { modelKey } from "#lib/model-key";

type ControlledMetricsStoreCall =
  | { method: "get"; sessionID: string }
  | { method: "prime"; sessionID: string }
  | { method: "subscribe"; sessionID: string }
  | { method: "retain"; sessionID: string }
  | { method: "retainRefresh"; sessionID: string; includeSubagents: boolean }
  | { method: "hasUsableSnapshot"; sessionID: string }
  | { method: "setCatalog"; catalog?: Catalog }
  | { method: "setIncludeSubagents"; includeSubagents: boolean }
  | { method: "release"; kind: "subscribe" | "retain" | "retainRefresh" };

class ControlledMetricsStore implements MetricsStore {
  private metrics = new Metrics();
  private usable = false;
  private listener?: (sessionID: string) => void;
  readonly calls: ControlledMetricsStoreCall[] = [];

  constructor(
    private readonly expectedSessionID = "root",
    private readonly expectedIncludeSubagents = true,
    private readonly expectedCatalog?: Catalog,
  ) {}

  get(sessionID: string) {
    this.calls.push({ method: "get", sessionID });
    assert.equal(sessionID, this.expectedSessionID);
    return this.metrics;
  }

  prime(sessionID: string) {
    this.calls.push({ method: "prime", sessionID });
    assert.equal(sessionID, this.expectedSessionID);
    return this.metrics;
  }

  hasUsableSnapshot(sessionID: string) {
    this.calls.push({ method: "hasUsableSnapshot", sessionID });
    assert.equal(sessionID, this.expectedSessionID);
    return this.usable;
  }

  subscribe(sessionID: string, listener: (sessionID: string) => void) {
    this.calls.push({ method: "subscribe", sessionID });
    assert.equal(sessionID, this.expectedSessionID);
    this.listener = listener;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.calls.push({ method: "release", kind: "subscribe" });
      this.listener = undefined;
    };
  }

  retainRefresh(sessionID: string, includeSubagents: boolean) {
    this.calls.push({ method: "retainRefresh", sessionID, includeSubagents });
    assert.equal(sessionID, this.expectedSessionID);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.calls.push({ method: "release", kind: "retainRefresh" });
    };
  }

  retain(sessionID: string) {
    this.calls.push({ method: "retain", sessionID });
    assert.equal(sessionID, this.expectedSessionID);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.calls.push({ method: "release", kind: "retain" });
    };
  }

  setCatalog(catalog?: Catalog) {
    this.calls.push({ method: "setCatalog", catalog });
    assert.equal(catalog, this.expectedCatalog);
    return false;
  }

  setIncludeSubagents(includeSubagents: boolean) {
    this.calls.push({ method: "setIncludeSubagents", includeSubagents });
    assert.equal(includeSubagents, this.expectedIncludeSubagents);
    return false;
  }

  publish(total: number, usable = true) {
    this.metrics = new Metrics();
    this.metrics.tokens.total = total;
    this.usable = usable;
  }

  notify() {
    this.listener?.("root");
  }
}

function RenderedProviderState() {
  const { loading, metrics } = useMetrics();
  return <text>{() => `${loading() ? "loading" : "ready"}:${metrics().tokens.total}`}</text>;
}

function RenderedContextMetrics() {
  const { context } = useMetrics();
  return <Context usage={context} config={ConfigSchema.parse({}).context} />;
}

describe("rendered metrics UI", () => {
  it("throws when used outside a MetricsProvider", () => {
    assert.throws(() => useMetrics());
  });
  it("updates provider context accessors from store notifications", async () => {
    const messages = [
      {
        ...defaultMessage(),
        id: "message-1",
        role: "assistant" as const,
        providerID: "provider",
        modelID: "model",
        tokens: {
          input: 1,
          output: 1,
          reasoning: 0,
          total: 2,
          cache: { read: 0, write: 0 },
        },
      },
    ];
    const rendered = renderApi({ messagesBySession: { root: messages } });
    const store = new SessionMetricsStore(rendered.api);
    const setup = await testRender(
      () => (
        <MetricsProvider
          api={rendered.api}
          sessionID="root"
          includeSubagents={false}
          store={store}
          children={() => (
            <ThemeProvider value={() => theme} children={() => <RenderedContextMetrics />} />
          )}
        />
      ),
      { width: 30, height: 1 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /2 context/);
      messages[0]!.tokens.input = 3;
      messages[0]!.tokens.output = 2;
      store.invalidate("root");
      await setup.flush();
      assert.match(setup.captureCharFrame(), /5 context/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });

  it("shows loading while the initial refresh has no usable snapshot", async () => {
    const rendered = renderApi();
    const store = new ControlledMetricsStore();
    const setup = await testRender(
      () => (
        <MetricsProvider
          api={rendered.api}
          sessionID="root"
          includeSubagents={true}
          store={store}
          children={() => <RenderedProviderState />}
        />
      ),
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /loading:0/);
      assert.ok(
        store.calls.some(
          (call) => call.method === "hasUsableSnapshot" && call.sessionID === "root",
        ),
      );
      assert.deepEqual(
        store.calls.filter((call) => call.method === "setIncludeSubagents"),
        [{ method: "setIncludeSubagents", includeSubagents: true }],
      );
      assert.deepEqual(
        store.calls.filter((call) =>
          ["retain", "subscribe", "retainRefresh", "release"].includes(call.method),
        ),
        [
          { method: "retain", sessionID: "root" },
          { method: "subscribe", sessionID: "root" },
          { method: "retainRefresh", sessionID: "root", includeSubagents: true },
        ],
      );
    } finally {
      setup.renderer.destroy();
    }
    assert.deepEqual(
      store.calls.filter((call) =>
        ["retain", "subscribe", "retainRefresh", "release"].includes(call.method),
      ),
      [
        { method: "retain", sessionID: "root" },
        { method: "subscribe", sessionID: "root" },
        { method: "retainRefresh", sessionID: "root", includeSubagents: true },
        { method: "release", kind: "subscribe" },
        { method: "release", kind: "retainRefresh" },
        { method: "release", kind: "retain" },
      ],
    );
  });

  it("passes the supplied catalog to the store by identity and content", async () => {
    const rendered = renderApi();
    const catalog: Catalog = new Map([
      [
        modelKey("provider", "model"),
        {
          id: "model",
          name: "Model",
          cost: { input: 1, output: 2, cache: { read: 3, write: 4 } },
        },
      ],
    ]);
    const store = new ControlledMetricsStore("root", true, catalog);
    const setup = await testRender(
      () => (
        <MetricsProvider
          api={rendered.api}
          sessionID="root"
          includeSubagents={true}
          catalog={catalog}
          store={store}
          children={() => <RenderedProviderState />}
        />
      ),
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      const catalogCalls = store.calls.filter((call) => call.method === "setCatalog");
      assert.equal(catalogCalls.length, 1);
      assert.equal(catalogCalls[0]?.catalog, catalog);
      assert.deepEqual([...catalogCalls[0]!.catalog!.entries()], [...catalog.entries()]);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("keeps a usable cached snapshot visible and ready during refresh", async () => {
    const rendered = renderApi();
    const store = new ControlledMetricsStore();
    store.publish(7);
    const setup = await testRender(
      () => (
        <MetricsProvider
          api={rendered.api}
          sessionID="root"
          includeSubagents={true}
          store={store}
          children={() => <RenderedProviderState />}
        />
      ),
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /ready:7/);
      await Promise.resolve();
      assert.match(setup.captureCharFrame(), /ready:7/);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("transitions from an empty loading state after an initial snapshot notification", async () => {
    const rendered = renderApi();
    const store = new ControlledMetricsStore();
    const setup = await testRender(
      () => (
        <MetricsProvider
          api={rendered.api}
          sessionID="root"
          includeSubagents={true}
          store={store}
          children={() => <RenderedProviderState />}
        />
      ),
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /loading:0/);
      store.publish(41);
      await setup.flush();
      store.notify();
      await setup.flush();
      assert.match(setup.captureCharFrame(), /ready:41/);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("publishes the root-only aggregate before a descendant resolves", async () => {
    const rootMessage = {
      ...defaultMessage(),
      tokens: { input: 3, output: 2, reasoning: 0, total: 5, cache: { read: 0, write: 0 } },
    };
    const childMessage = {
      ...defaultMessage(),
      id: "child-message",
      sessionID: "child",
      tokens: { input: 2, output: 0, reasoning: 0, total: 2, cache: { read: 0, write: 0 } },
    };
    const child = {
      id: "child",
      slug: "child",
      projectID: "project",
      directory: ".",
      title: "Child",
      version: "1",
      metadata: {},
      time: { created: 0, updated: 1 },
    };
    const rendered = renderApi({
      messagesBySession: { root: [rootMessage], child: [childMessage] },
      childrenByParent: { root: [child] },
    });
    let resolveChild!: () => void;
    const childLoaded = new Promise<void>((resolve) => {
      resolveChild = resolve;
    });
    const api = {
      ...rendered.api,
      state: {
        ...rendered.api.state,
        session: {
          ...rendered.api.state.session,
          messages: () => [],
          get: () => undefined,
        },
      },
      client: {
        ...rendered.api.client,
        session: {
          ...rendered.api.client.session,
          messages: async (
            request: Parameters<MetricsProviderApi["client"]["session"]["messages"]>[0],
          ) => {
            if (request.sessionID === "child") await childLoaded;
            return rendered.api.client.session.messages(request);
          },
        },
      },
    } satisfies MetricsProviderApi;
    const store = new SessionMetricsStore(api, { includeSubagents: true });
    const setup = await testRender(
      () => (
        <MetricsProvider
          api={api}
          sessionID="root"
          includeSubagents={true}
          store={store}
          children={() => <RenderedProviderState />}
        />
      ),
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /ready:5/);
      resolveChild();
      await setup.flush();
      assert.match(setup.captureCharFrame(), /ready:7/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });
});
