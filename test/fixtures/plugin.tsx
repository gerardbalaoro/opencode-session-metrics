import type { Renderable } from "@opencode-ai/plugin/tui";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { JSX } from "solid-js";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { BoxRenderable, KeyEvent } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { Keymap } from "@opentui/keymap";

import { defaultMessage, renderApi } from "./ui.tsx";

type Command = ReturnType<typeof import("#command").createCommand>;
type Toast = Parameters<TuiPluginApi["ui"]["toast"]>[0];

export const pluginMeta = {
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
} as const;
type SidebarSlot = {
  slots: {
    sidebar_content: (context: unknown, props: { session_id: string }) => JSX.Element;
  };
};

function isSidebarSlot(value: unknown): value is SidebarSlot {
  if (value === null || typeof value !== "object" || !("slots" in value)) return false;
  const slots = value.slots;
  return (
    slots !== null &&
    typeof slots === "object" &&
    "sidebar_content" in slots &&
    typeof slots.sidebar_content === "function"
  );
}

export async function pluginHost({
  sessionID,
  message = defaultMessage(),
  deferMessages = false,
}: {
  sessionID?: string;
  message?: ReturnType<typeof defaultMessage>;
  deferMessages?: boolean;
} = {}) {
  const providers = [
    {
      id: "boundary-provider",
      name: "Boundary Provider",
      source: "custom" as const,
      env: [],
      options: {},
      models: {
        "boundary-model": {
          id: "boundary-model",
          providerID: "boundary-provider",
          api: { id: "boundary-api", url: "https://boundary.test", npm: "boundary" },
          name: "Boundary Model",
          family: "boundary",
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
          limit: { context: 100, output: 10 },
          status: "active" as const,
          options: {},
          headers: {},
          release_date: "2026-01-01",
        },
      },
    },
  ];
  const rendered = renderApi({
    messagesBySession: { [sessionID ?? "none"]: [message] },
    providers,
    deferMessages,
  });
  const layers: Array<{ commands: readonly unknown[] }> = [];
  const slots: SidebarSlot[] = [];
  const kvGets: string[] = [];
  const kvSets: Array<{ key: string; value: unknown }> = [];
  const calls = {
    ...rendered.calls,
    layers,
    slots,
    kvGets,
    kvSets,
    toasts: [] as Toast[],
  };
  let replacement: (() => JSX.Element) | undefined;
  const scopeDisposals: Array<() => void> = [];
  let lifecycleDisposed = false;
  let hostDisposed = false;
  const deactivationCalls: string[] = [];
  const renderer = await createTestRenderer({ width: 100, height: 60 });
  const target = new BoxRenderable(renderer.renderer, {});
  const keymap = new Keymap<Renderable, KeyEvent>({
    metadata: {
      platform: "linux",
      primaryModifier: "ctrl",
      modifiers: {
        ctrl: "supported",
        shift: "supported",
        meta: "supported",
        super: "supported",
        hyper: "supported",
      },
    },
    rootTarget: target,
    isDestroyed: false,
    getFocusedTarget: () => target,
    getParentTarget: () => null,
    isTargetDestroyed: () => false,
    onKeyPress: () => () => {},
    onKeyRelease: () => () => {},
    onFocusChange: () => () => {},
    onTargetDestroy: () => () => {},
    createCommandEvent: () =>
      new KeyEvent({
        name: "",
        ctrl: false,
        shift: false,
        meta: false,
        option: false,
        sequence: "",
        number: false,
        raw: "",
        eventType: "press",
        source: "raw",
      }),
  });
  const registerLayer = keymap.registerLayer.bind(keymap);
  keymap.registerLayer = (layer) => {
    if (layer.commands) calls.layers.push({ commands: layer.commands });
    const dispose = registerLayer(layer);
    scopeDisposals.push(dispose);
    return dispose;
  };
  const client = createOpencodeClient({ baseUrl: "http://localhost" });
  Object.defineProperty(client, "session", { value: rendered.api.client.session });
  const api = {
    app: { version: "test" },
    attention: {
      notify: async () => ({ notification: false, ok: true, sound: false }),
      soundboard: {
        registerPack: () => () => {},
        activate: () => false,
        current: () => "default",
        list: () => [],
      },
    },
    keys: { formatSequence: () => "", formatBindings: () => undefined },
    keymap,
    mode: { current: () => "default", push: () => () => {} },
    ...rendered.api,
    state: {
      ready: true,
      config: {},
      path: { state: "/tmp", config: "/tmp", worktree: "/tmp", directory: "/tmp" },
      vcs: undefined,
      provider: providers,
      session: {
        count: () => 0,
        get: rendered.api.state.session.get,
        diff: () => [],
        todo: () => [],
        messages: rendered.api.state.session.messages,
        status: () => undefined,
        permission: () => [],
        question: () => [],
      },
      part: () => [],
      lsp: () => [],
      mcp: () => [],
    },
    theme: {
      current: rendered.api.theme.current,
      selected: "default",
      has: () => true,
      set: () => true,
      install: async () => {},
      mode: () => "dark" as const,
      ready: true,
    },
    route: {
      register: () => () => {},
      navigate: () => {},
      current: sessionID ? { name: "session", params: { sessionID } } : { name: "home" },
    },
    ui: {
      Dialog: () => <></>,
      DialogAlert: () => <></>,
      DialogConfirm: () => <></>,
      DialogPrompt: () => <></>,
      DialogSelect: () => <></>,
      Slot: () => null,
      Prompt: () => <></>,
      toast: (value: Toast) => {
        calls.toasts.push(value);
      },
      dialog: {
        replace: (callback: () => JSX.Element) => {
          replacement = callback;
        },
        clear: () => undefined,
        setSize: () => undefined,
        size: "medium",
        depth: 0,
        open: false,
      },
    },
    tuiConfig: {
      leader_timeout: 0,
      attention: {
        enabled: false,
        notifications: false,
        sound: false,
        volume: 0,
        sound_pack: "default",
        sounds: {},
      },
      keybinds: {
        bindings: [],
        get: () => [],
        has: () => false,
        gather: () => [],
        pick: () => [],
        omit: () => [],
      },
    },
    kv: {
      get: function get<Value>(key: string, fallback?: Value): Value {
        kvGets.push(key);
        if (fallback === undefined) throw new Error(`No fixture value for key: ${key}`);
        return fallback;
      },
      set: (key: string, value: unknown) => {
        kvSets.push({ key, value });
      },
      ready: true,
    },
    slots: {
      register: (slot: unknown) => {
        if (isSidebarSlot(slot)) calls.slots.push(slot);
        return "boundary-slot";
      },
    },
    renderer: renderer.renderer,
    client,
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (callback: () => void) => {
        scopeDisposals.push(callback);
        return () => {};
      },
    },
    plugins: {
      list: () => [],
      activate: async () => true,
      deactivate: async (pluginID: string) => {
        deactivationCalls.push(pluginID);
        return true;
      },
      add: async () => true,
      install: async () => ({ ok: true, dir: "/tmp", tui: true }),
    },
  } satisfies TuiPluginApi;

  return {
    api,
    calls,
    get replacement() {
      return replacement;
    },
    get toast() {
      return calls.toasts.at(-1);
    },
    deactivationCalls,
    messageSignals: calls.messageSignals,
    triggerLifecycleDispose() {
      if (lifecycleDisposed) return;
      lifecycleDisposed = true;
      scopeDisposals
        .splice(0)
        .reverse()
        .forEach((dispose) => dispose());
    },
    releaseMessages: rendered.releaseMessages,
    command() {
      const command = calls.layers[0]?.commands[0];
      if (
        !command ||
        typeof command !== "object" ||
        !("title" in command) ||
        !("name" in command) ||
        !("category" in command) ||
        !("desc" in command) ||
        !("namespace" in command) ||
        !("slashName" in command) ||
        !("run" in command) ||
        typeof command.title !== "string" ||
        typeof command.name !== "string" ||
        typeof command.category !== "string" ||
        typeof command.desc !== "string" ||
        typeof command.namespace !== "string" ||
        typeof command.slashName !== "string" ||
        typeof command.run !== "function"
      )
        return undefined;
      return command as Command;
    },
    dispose() {
      if (hostDisposed) return;
      hostDisposed = true;
      if (!lifecycleDisposed) {
        lifecycleDisposed = true;
        scopeDisposals
          .splice(0)
          .reverse()
          .forEach((dispose) => dispose());
      }
      renderer.renderer.destroy();
    },
  };
}
