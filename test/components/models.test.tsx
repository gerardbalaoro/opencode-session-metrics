import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createMemo, createSignal, onCleanup, type Accessor } from "solid-js";

import { Collapsible } from "#components/common";
import { ModelBreakdown, ModelList } from "#components/models";
import { ModelsProvider, useModels } from "#components/models-provider";
import { ThemeProvider } from "#components/theme-provider";
import {
  metricsWithModels,
  modelUsage,
  populatedMetrics,
  providerState,
  theme,
  clickText,
} from "#fixtures/ui";
import { Metrics } from "#lib/metrics";
import { modelKey } from "#lib/model-key";

function RenderedModel(props: { usage: Accessor<import("#lib/metrics").ModelUsage> }) {
  const { getModelName } = useModels();
  const name = createMemo(() => {
    const usage = props.usage();
    return getModelName(usage.providerID, usage.modelID);
  });
  return (
    <box>
      <box>
        <text>
          <span>{name}</span>
        </text>
      </box>
    </box>
  );
}

function NamedModelDisclosure(props: {
  usage: Accessor<import("#lib/metrics").ModelUsage>;
  level: number;
  indent?: number;
}) {
  const { getModelName } = useModels();
  const name = createMemo(() => {
    const usage = props.usage();
    return getModelName(usage.providerID, usage.modelID);
  });
  return (
    <Collapsible
      title={name}
      level={props.level}
      indent={props.indent}
      children={() => <ModelBreakdown usage={props.usage} />}
    />
  );
}

function TrackedRenderedModel(props: {
  usage: Accessor<import("#lib/metrics").ModelUsage>;
  onCleanup: () => void;
}) {
  onCleanup(props.onCleanup);
  return (
    <Collapsible
      title={() => props.usage().modelID}
      level={2}
      indent={0}
      children={() => <ModelBreakdown usage={props.usage} />}
    />
  );
}

describe("rendered metrics UI", () => {
  it("shows the loader while model data is loading", async () => {
    const metrics = populatedMetrics();
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <ModelList
              metrics={() => metrics}
              loading={true}
              renderModel={() => <text>model content</text>}
            />
          )}
        />
      ),
      { width: 80, height: 5 },
    );

    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      assert.match(frame, /⬝⬝⬝⬝⬝/);
      assert.doesNotMatch(frame, /Provider/);
      assert.doesNotMatch(frame, /model content/);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders runtime model names and falls back to exact model IDs", async () => {
    const metrics = new Metrics();
    metrics.providerCosts.set("provider", {
      providerID: "provider",
      name: "Provider",
      cost: 0,
      reportedCost: 0,
      estimatedCost: 0,
    });
    metrics.providerCosts.set("missing-provider", {
      providerID: "missing-provider",
      name: "Missing Provider",
      cost: 0,
      reportedCost: 0,
      estimatedCost: 0,
    });
    metrics.models.set(modelKey("provider", "known-model"), modelUsage("provider", "known-model"));
    metrics.models.set(
      modelKey("provider", "missing-model"),
      modelUsage("provider", "missing-model"),
    );
    metrics.models.set(
      modelKey("missing-provider", "missing-model"),
      modelUsage("missing-provider", "missing-model"),
    );

    const providers = providerState({ models: { "known-model": { name: "Readable Model" } } });
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <ModelsProvider
              value={() => providers}
              children={() => (
                <ModelList
                  metrics={() => metrics}
                  loading={false}
                  renderModel={(usage) => <RenderedModel usage={usage} />}
                />
              )}
            />
          )}
        />
      ),
      { width: 80, height: 8 },
    );

    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      assert.match(frame, /Readable Model/);
      assert.match(frame, /missing-model/);
      assert.doesNotMatch(frame, /known-model/);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("resolves identical model IDs against each provider's metadata", async () => {
    const metrics = new Metrics();
    for (const [providerID, name] of [
      ["first-provider", "First Provider"],
      ["second-provider", "Second Provider"],
    ]) {
      metrics.providerCosts.set(providerID, {
        providerID,
        name,
        cost: 0,
        reportedCost: 0,
        estimatedCost: 0,
      });
      metrics.models.set(
        modelKey(providerID, "shared-model"),
        modelUsage(providerID, "shared-model"),
      );
    }

    const providers = [
      ...providerState({
        id: "first-provider",
        models: { "shared-model": { name: "First Model" } },
      }),
      ...providerState({
        id: "second-provider",
        models: { "shared-model": { name: "Second Model" } },
      }),
    ];
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <ModelsProvider
              value={() => providers}
              children={() => (
                <ModelList
                  metrics={() => metrics}
                  loading={false}
                  renderModel={(usage) => <RenderedModel usage={usage} />}
                />
              )}
            />
          )}
        />
      ),
      { width: 80, height: 8 },
    );

    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      assert.match(frame, /First Model/);
      assert.match(frame, /Second Model/);
      assert.doesNotMatch(frame, /shared-model/);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("preserves the mounted model disclosure across metrics replacement", async () => {
    const initialMetrics = populatedMetrics();
    const refreshedMetrics = [6, 7, 8].map((cacheRead) => {
      const metrics = initialMetrics.clone();
      const usage = metrics.models.get(modelKey("provider", "model"));
      assert.ok(usage);
      usage.cacheRead = cacheRead;
      return metrics;
    });

    const [metrics, setMetrics] = createSignal(initialMetrics);
    const providers = providerState({ models: { model: { name: "Readable Model" } } });
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <ModelsProvider
              value={() => providers}
              children={() => (
                <Collapsible
                  title={() => "Models"}
                  children={() => (
                    <ModelList
                      metrics={metrics}
                      loading={false}
                      renderModel={(usage) => (
                        <NamedModelDisclosure usage={usage} level={2} indent={0} />
                      )}
                    />
                  )}
                />
              )}
            />
          )}
        />
      ),
      { width: 100, height: 20 },
    );

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /▶ Models/);

      await clickText(setup, "Models");
      await clickText(setup, "Readable Model");

      frame = setup.captureCharFrame();
      assert.match(frame, /▼ Models/);
      assert.match(frame, /▾ Readable Model/);
      for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
        assert.match(frame, new RegExp(label));
      }

      for (const [index, replacement] of refreshedMetrics.entries()) {
        setMetrics(replacement);
        await setup.flush();

        frame = setup.captureCharFrame();
        assert.match(frame, /▼ Models/);
        assert.match(frame, /▾ Readable Model/);
        for (const label of ["Input", "Output", "Reasoning", "Cache read", "Cache write"]) {
          assert.match(frame, new RegExp(label));
        }
        assert.match(frame, new RegExp(`Cache read\\s+${index + 6}`));
      }
    } finally {
      setup.renderer.destroy();
    }
  });
  it("keeps model disclosure state with canonical rows during insertion and reordering", async () => {
    const initialMetrics = metricsWithModels([
      ["provider", "zeta", 20],
      ["provider", "alpha", 10],
    ]);
    const [metrics, setMetrics] = createSignal(initialMetrics);
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <Collapsible
              title={() => "Models"}
              children={() => (
                <ModelList
                  metrics={metrics}
                  loading={false}
                  renderModel={(usage) => (
                    <Collapsible
                      title={() => usage().modelID}
                      level={2}
                      indent={0}
                      children={() => <ModelBreakdown usage={usage} />}
                    />
                  )}
                />
              )}
            />
          )}
        />
      ),
      { width: 80, height: 20 },
    );

    try {
      await setup.flush();
      await clickText(setup, "Models");

      let frame = setup.captureCharFrame();
      assert.match(frame, /▸ alpha/);
      assert.match(frame, /▸ zeta/);
      await clickText(setup, "zeta");

      setMetrics(
        metricsWithModels([
          ["provider", "zeta", 22],
          ["provider", "aardvark", 1],
          ["provider", "alpha", 11],
        ]),
      );
      await setup.flush();

      frame = setup.captureCharFrame();
      assert.match(frame, /▸ aardvark/);
      assert.match(frame, /▸ alpha/);
      assert.match(frame, /▾ zeta/);
      assert.doesNotMatch(frame, /▾ alpha/);
      assert.match(frame, /Input\s+22/);
      const modelTitles = frame
        .split("\n")
        .flatMap((line) => line.match(/[▸▾] (aardvark|alpha|zeta)/)?.[1] ?? []);
      assert.deepEqual(modelTitles, ["aardvark", "alpha", "zeta"]);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("disposes deleted model rows without transferring disclosure state", async () => {
    const [metrics, setMetrics] = createSignal(
      metricsWithModels([
        ["provider", "alpha", 10],
        ["provider", "zeta", 20],
      ]),
    );
    let cleanups = 0;
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <Collapsible
              title={() => "Models"}
              open
              children={() => (
                <ModelList
                  metrics={metrics}
                  loading={false}
                  renderModel={(usage) => (
                    <TrackedRenderedModel usage={usage} onCleanup={() => (cleanups += 1)} />
                  )}
                />
              )}
            />
          )}
        />
      ),
      { width: 80, height: 20 },
    );

    try {
      await setup.flush();
      await clickText(setup, "zeta");

      setMetrics(metricsWithModels([["provider", "zeta", 21]]));
      await setup.flush();

      const frame = setup.captureCharFrame();
      assert.doesNotMatch(frame, /alpha/);
      assert.match(frame, /▾ zeta/);
      assert.match(frame, /Input\s+21/);
      assert.equal(cleanups, 1);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("falls back to model IDs when reactive provider metadata disappears", async () => {
    const metrics = new Metrics();
    metrics.providerCosts.set("provider", {
      providerID: "provider",
      name: "Provider",
      cost: 0,
      reportedCost: 0,
      estimatedCost: 0,
    });
    metrics.models.set(modelKey("provider", "model"), modelUsage("provider", "model"));

    const [providers, setProviders] = createSignal(
      providerState({ models: { model: { name: "Before" } } }),
    );
    const setup = await testRender(
      () => (
        <ThemeProvider
          value={() => theme}
          children={() => (
            <ModelsProvider
              value={providers}
              children={() => (
                <ModelList
                  metrics={() => metrics}
                  loading={false}
                  renderModel={(usage) => <RenderedModel usage={usage} />}
                />
              )}
            />
          )}
        />
      ),
      { width: 80, height: 5 },
    );

    try {
      await setup.flush();
      assert.match(setup.captureCharFrame(), /Before/);

      setProviders(providerState({ models: {} }));
      await setup.flush();

      const frame = setup.captureCharFrame();
      assert.match(frame, /model/);
      assert.doesNotMatch(frame, /Before/);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("renders fractional model cache rates from message metrics distinctly", async () => {
    const message = (
      input: number,
      cacheRead: number,
    ): Parameters<typeof Metrics.fromMessages>[0][number] => ({
      id: "message-1",
      role: "assistant" as const,
      providerID: "provider",
      modelID: "model",
      tokens: {
        input,
        output: 0,
        reasoning: 0,
        total: input + cacheRead,
        cache: { read: cacheRead, write: 0 },
      },
    });
    const modelID = modelKey("provider", "model");
    const initial = Metrics.fromMessages([message(5, 5)]);
    const [metrics, setMetrics] = createSignal(initial);
    const usage = () => {
      const value = metrics().models.get(modelID);
      assert.ok(value);
      return value;
    };
    const setup = await testRender(
      () => <ThemeProvider value={() => theme} children={() => <ModelBreakdown usage={usage} />} />,
      { width: 40, height: 10 },
    );
    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /Cache rate\s+50\.0%/);
      assert.doesNotMatch(frame, /Cache rate\s+1/);
      setMetrics(Metrics.fromMessages([message(5, 0)]));
      await setup.flush();
      assert.doesNotMatch(setup.captureCharFrame(), /Cache rate/);
      setMetrics(Metrics.fromMessages([message(5, 15)]));
      await setup.flush();
      frame = setup.captureCharFrame();
      assert.match(frame, /Cache rate\s+75\.0%/);
      assert.doesNotMatch(frame, /Cache rate\s+50\.0%/);
      setMetrics(Metrics.fromMessages([message(0, 0)]));
      await setup.flush();
      assert.doesNotMatch(setup.captureCharFrame(), /Cache rate/);
    } finally {
      setup.renderer.destroy();
    }
  });
});
