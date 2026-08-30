import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import { createMemo, createSignal } from "solid-js";

import { ModelsProvider, useModels } from "#components/models-provider";
import { providerState } from "#fixtures/ui";

describe("rendered metrics UI", () => {
  it("passes through accessor-backed providers and updates consumers", async () => {
    const initialProviders = providerState({ models: { model: { name: "initial" } } });
    const updatedProviders = providerState({ models: { model: { name: "updated" } } });
    const [currentProviders, setProviders] = createSignal(initialProviders);
    let getModelName: ReturnType<typeof useModels>["getModelName"] | undefined;
    const ProvidersConsumer = () => {
      const models = useModels();
      getModelName = models.getModelName;
      const name = createMemo(() => models.getModelName("provider", "model"));
      return <text>{name}</text>;
    };
    const setup = await testRender(
      () => <ModelsProvider value={currentProviders} children={() => <ProvidersConsumer />} />,
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.ok(getModelName);
      assert.equal(getModelName("provider", "model"), "initial");
      assert.match(setup.captureCharFrame(), /initial/);

      setProviders(updatedProviders);
      await setup.flush();

      const frame = setup.captureCharFrame();
      assert.match(frame, /updated/);
      assert.doesNotMatch(frame, /initial/);
    } finally {
      setup.renderer.destroy();
    }
  });
  it("resolves provider-scoped model names and falls back to model IDs", async () => {
    const providers = [
      ...providerState({
        id: "first-provider",
        name: "First Provider",
        models: { shared: { name: "First" } },
      }),
      ...providerState({
        id: "second-provider",
        name: "Second Provider",
        models: { shared: { name: "Second" } },
      }),
    ];
    let getModelName: ReturnType<typeof useModels>["getModelName"] | undefined;
    const ModelsConsumer = () => {
      getModelName = useModels().getModelName;
      return <text />;
    };
    const setup = await testRender(
      () => <ModelsProvider value={() => providers} children={() => <ModelsConsumer />} />,
      { width: 20, height: 1 },
    );

    try {
      await setup.flush();
      assert.ok(getModelName);
      assert.equal(getModelName("first-provider", "shared"), "First");
      assert.equal(getModelName("second-provider", "shared"), "Second");
      assert.equal(getModelName("first-provider", "missing"), "missing");
      assert.equal(getModelName("missing-provider", "shared"), "shared");
    } finally {
      setup.renderer.destroy();
    }
  });
  it("throws when used outside a ModelsProvider", () => {
    assert.throws(() => useModels());
  });
});
