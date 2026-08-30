import { testRender } from "@opentui/solid";
import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { MetricsDialog } from "#components/dialog";
import { ConfigSchema } from "#config";
import {
  clickText,
  defaultMessage,
  modelUsage,
  metricsWithModels,
  populatedMetrics,
  providerState,
  renderApi,
  staticDialogStore,
} from "#fixtures/ui";
import { SessionMetricsStore } from "#lib/metrics-store";
import { modelKey } from "#lib/model-key";

describe("rendered metrics UI", () => {
  it("requests only the configured session with the loader limit", async () => {
    const rendered = renderApi({
      messagesBySession: {
        root: [],
        other: [
          {
            ...defaultMessage(),
            id: "other-message",
            role: "assistant",
            providerID: "provider",
            modelID: "model",
            cost: 99,
            tokens: { input: 99, output: 0, reasoning: 0, total: 99, cache: { read: 0, write: 0 } },
          },
        ],
      },
    });
    const store = new SessionMetricsStore(rendered.api);
    const setup = await testRender(
      () => (
        <MetricsDialog
          api={rendered.api}
          config={ConfigSchema.parse({})}
          session_id="root"
          store={store}
        />
      ),
      { width: 80, height: 20 },
    );

    try {
      await setup.flush();
      assert.deepEqual(rendered.calls.clientMessages, [{ sessionID: "root", limit: 100_000 }]);
      assert.doesNotMatch(setup.captureCharFrame(), /99/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });

  it("renders static metric sections and expanded model details", async () => {
    const metrics = populatedMetrics();
    metrics.models.set(modelKey("provider", "second-model"), {
      ...modelUsage("provider", "second-model"),
      input: 7,
    });
    const providers = providerState({
      models: {
        model: { name: "First Model" },
        "second-model": { name: "Second Model" },
      },
    });
    const setup = await testRender(
      () => (
        <MetricsDialog
          api={renderApi({ providers }).api}
          config={ConfigSchema.parse({ include_subagents: false })}
          session_id="root"
          store={staticDialogStore(metrics, { sessionID: "root" })}
        />
      ),
      { width: 100, height: 100 },
    );

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      for (const label of [
        "Session",
        "Input",
        "Output",
        "Reasoning",
        "Cache read",
        "Cache write",
        "Models",
        "Provider",
        "First Model",
        "Second Model",
        "Cache rate",
        "Speed",
        "Cost",
      ]) {
        assert.match(frame, new RegExp(label.replace("$", "\\$")));
      }
      const lines = frame.split("\n");
      const modelsHeadingLine = lines.findIndex((line) => line.trimStart().startsWith("Models"));
      const firstModelLine = lines.findIndex((line) => line.trim() === "First Model");
      const secondModelLine = lines.findIndex((line) => line.trim() === "Second Model");
      const providerLine = lines.findIndex((line) => line.trimStart().startsWith("Provider"));
      const firstStatsLine = lines.findIndex(
        (line, index) =>
          index > firstModelLine && index < secondModelLine && line.trimStart().startsWith("Input"),
      );
      const secondStatsLine = lines.findIndex(
        (line, index) => index > secondModelLine && line.trimStart().startsWith("Input"),
      );
      const indent = (line: string) => line.length - line.trimStart().length;
      assert.ok(
        modelsHeadingLine >= 0 &&
          providerLine > modelsHeadingLine &&
          firstModelLine > providerLine &&
          secondModelLine > firstModelLine &&
          firstStatsLine > firstModelLine &&
          firstStatsLine < secondModelLine &&
          secondStatsLine > secondModelLine,
      );
      assert.equal(indent(lines[modelsHeadingLine]), indent(lines[providerLine]));
      assert.equal(indent(lines[firstModelLine]), indent(lines[providerLine]));
      assert.equal(indent(lines[secondModelLine]), indent(lines[providerLine]));
      assert.equal(indent(lines[firstStatsLine]), indent(lines[firstModelLine]) + 2);
      assert.equal(indent(lines[secondStatsLine]), indent(lines[secondModelLine]) + 2);
      const firstModelFrame = lines.slice(firstModelLine, secondModelLine).join("\n");
      assert.match(firstModelFrame, /Input\s+11/);
      assert.match(firstModelFrame, /Output\s+7/);
      assert.match(firstModelFrame, /Reasoning\s+3/);
      assert.match(firstModelFrame, /Cache read\s+5/);
      assert.match(firstModelFrame, /Cache write\s+2/);
      assert.match(firstModelFrame, /Cache rate\s+31\.3%/);
      assert.match(firstModelFrame, /Speed\s+10 t\/s/);
      assert.match(firstModelFrame, /Cost\s+\$1\.00/);
      const secondModelFrame = lines.slice(secondModelLine).join("\n");
      assert.match(secondModelFrame, /Input\s+7/);
      assert.doesNotMatch(frame, /[▸▾▶▼]/);
      const initialFrame = frame;
      for (const title of ["Session", "Models", "Provider", "First Model", "Second Model"]) {
        await clickText(setup, title);
      }
      await setup.flush();
      frame = setup.captureCharFrame();
      assert.equal(frame, initialFrame);
      assert.doesNotMatch(frame, /[▸▾▶▼]/);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("renders all static metric dialog data immediately", async () => {
    const metrics = populatedMetrics();
    const providers = providerState({
      models: { model: { name: "Readable Model", limit: undefined } },
    });
    const rendered = renderApi({ providers });
    const setup = await testRender(
      () => (
        <MetricsDialog
          api={rendered.api}
          config={ConfigSchema.parse({
            include_subagents: false,
            context: { show: false },
            models: { show: false },
          })}
          session_id="root"
          store={staticDialogStore(metrics, { sessionID: "root" })}
        />
      ),
      { width: 100, height: 60 },
    );

    try {
      await setup.flush();
      const frame = setup.captureCharFrame();
      for (const label of [
        "Used",
        "Input",
        "Output",
        "Reasoning",
        "Cache read",
        "Cache write",
        "Provider",
        "Readable Model",
        "Cache rate",
        "Speed",
        "Cost",
      ]) {
        assert.match(frame, new RegExp(label.replace("$", "\\$")));
      }
      assert.match(frame, /Used\s+6/);
      assert.match(frame, /Input\s+11/);
      assert.match(frame, /Output\s+7/);
      assert.match(frame, /Reasoning\s+3/);
      assert.match(frame, /Cost\s+\$1\.00/);
      const lines = frame.split("\n");
      const usedLine = lines.findIndex((line) => /Used\s+6/.test(line));
      const inputLine = lines.findIndex((line) => /Input\s+11/.test(line));
      assert.ok(usedLine >= 0 && inputLine > usedLine);
      assert.doesNotMatch(frame, /[▸▾▶▼]/);
      for (const title of ["Provider", "Readable Model"]) {
        await clickText(setup, title);
      }
      await setup.flush();
      const afterClickFrame = setup.captureCharFrame();
      assert.equal(afterClickFrame, frame);
      assert.doesNotMatch(afterClickFrame, /[▸▾▶▼]/);
    } finally {
      setup.renderer.destroy();
    }
  });

  it("clips dialog content at the terminal-height boundary", async () => {
    const metrics = metricsWithModels(
      Array.from(
        { length: 8 },
        (_, index) => ["provider", `model-${index + 1}`, index + 1] as const,
      ),
    );
    const providers = providerState({
      models: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `model-${index + 1}`,
          { name: `VISIBLE-${index + 1}` },
        ]),
      ),
    });
    const rendered = renderApi({ providers });
    const config = ConfigSchema.parse({});

    const expectedVisibleLines = new Map([
      [24, ["Context", "Used 6", "Session"]],
      [
        40,
        [
          "Context",
          "Used 6",
          "Session",
          "Input 0",
          "Output 0",
          "Cost $0.00",
          "Models",
          "provider",
          "VISIBLE-1",
        ],
      ],
    ]);

    for (const terminalHeight of [24, 40] as const) {
      const setup = await testRender(
        () => (
          <MetricsDialog
            api={rendered.api}
            config={config}
            session_id="root"
            store={staticDialogStore(metrics, { sessionID: "root" })}
          />
        ),
        { width: 80, height: terminalHeight },
      );

      try {
        await setup.flush();
        const visibleLines = setup
          .captureCharFrame()
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => line.replace("▀", "").trim().replace(/\s+/g, " "));
        assert.deepEqual(visibleLines, expectedVisibleLines.get(terminalHeight));
      } finally {
        setup.renderer.destroy();
      }
    }
  });

  it("refreshes a dialog without sidebar content and forces its sections visible", async () => {
    const rendered = renderApi();
    const store = new SessionMetricsStore(rendered.api);
    const config = ConfigSchema.parse({
      context: { show: false },
      models: { show: false },
    });
    const setup = await testRender(
      () => <MetricsDialog api={rendered.api} config={config} session_id="root" store={store} />,
      { width: 80, height: 60 },
    );

    try {
      await setup.waitFor(() => setup.captureCharFrame().includes("Used"));
      await setup.flush();
      const frame = setup.captureCharFrame();
      assert.ok(rendered.requests() > 0);
      assert.equal(store.get("root").tokens.total, 6);
      assert.match(frame, /Session/);
      assert.match(frame, /Used\s+6/);
      assert.match(frame, /Models/);
      assert.doesNotMatch(frame, /[▶▼▸▾]/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });

  it("renders and refreshes dialog context capacity", async () => {
    const messages = [
      {
        ...defaultMessage(),
        id: "message-1",
        role: "assistant" as const,
        providerID: "provider",
        modelID: "model",
        tokens: { input: 1, output: 2, reasoning: 0, total: 3, cache: { read: 0, write: 0 } },
      },
    ];
    const rendered = renderApi({
      providers: providerState({ models: { model: { limit: { context: 12_345 } } } }),
      messagesBySession: { root: messages },
    });
    const store = new SessionMetricsStore(rendered.api);
    const setup = await testRender(
      () => (
        <MetricsDialog
          api={rendered.api}
          config={ConfigSchema.parse({})}
          session_id="root"
          store={store}
        />
      ),
      { width: 80, height: 20 },
    );

    try {
      await setup.flush();
      let frame = setup.captureCharFrame();
      assert.match(frame, /Used\s+3/);
      assert.match(frame, /Total\s+12,345/);
      const contextLines = frame.split("\n");
      const usedLine = contextLines.findIndex((line) => /Used\s+3/.test(line));
      const totalLine = contextLines.findIndex((line) => /Total\s+12,345/.test(line));
      assert.ok(usedLine >= 0 && totalLine > usedLine);
      assert.doesNotMatch(frame, /Session/);

      messages[0]!.tokens.input = 4;
      store.invalidate("root");
      await setup.waitFor(() => /Used\s+6/.test(setup.captureCharFrame()));
      frame = setup.captureCharFrame();
      assert.match(frame, /Used\s+6/);
      assert.match(frame, /Total\s+12,345/);
    } finally {
      setup.renderer.destroy();
      store.dispose();
    }
  });
});
