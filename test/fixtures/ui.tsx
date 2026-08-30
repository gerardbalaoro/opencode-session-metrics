import type { TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui";
import type { Event } from "@opencode-ai/sdk/v2";
import type { TestRendererSetup } from "@opentui/core/testing";

import { Renderable, RGBA, TextRenderable } from "@opentui/core";

import type { MetricsProviderApi, ProviderState, SessionDataApi } from "#lib/api";
import type { MetricsStore } from "#lib/metrics-store";

import { Metrics, type ModelUsage } from "#lib/metrics";
import { modelKey } from "#lib/model-key";

const color = RGBA.fromHex("#ffffff");

export const theme: TuiThemeCurrent = {
  primary: color,
  secondary: color,
  accent: color,
  error: color,
  warning: color,
  success: color,
  info: color,
  text: color,
  textMuted: color,
  selectedListItemText: color,
  background: color,
  backgroundPanel: color,
  backgroundElement: color,
  backgroundMenu: color,
  border: color,
  borderActive: color,
  borderSubtle: color,
  diffAdded: color,
  diffRemoved: color,
  diffContext: color,
  diffHunkHeader: color,
  diffHighlightAdded: color,
  diffHighlightRemoved: color,
  diffAddedBg: color,
  diffRemovedBg: color,
  diffContextBg: color,
  diffLineNumber: color,
  diffAddedLineNumberBg: color,
  diffRemovedLineNumberBg: color,
  markdownText: color,
  markdownHeading: color,
  markdownLink: color,
  markdownLinkText: color,
  markdownCode: color,
  markdownBlockQuote: color,
  markdownEmph: color,
  markdownStrong: color,
  markdownHorizontalRule: color,
  markdownListItem: color,
  markdownListEnumeration: color,
  markdownImage: color,
  markdownImageText: color,
  markdownCodeBlock: color,
  syntaxComment: color,
  syntaxKeyword: color,
  syntaxFunction: color,
  syntaxVariable: color,
  syntaxString: color,
  syntaxNumber: color,
  syntaxType: color,
  syntaxOperator: color,
  syntaxPunctuation: color,
  thinkingOpacity: 1,
};

type Message = ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number];
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type Session = NonNullable<ReturnType<NonNullable<TuiPluginApi["state"]["session"]["get"]>>>;
type Provider = TuiPluginApi["state"]["provider"];
type ProviderModel = ProviderState[number]["models"][string];
type MessageRequest = Parameters<TuiPluginApi["client"]["session"]["messages"]>[0];
type SessionRequest = Parameters<TuiPluginApi["client"]["session"]["get"]>[0];
type ChildrenRequest = Parameters<TuiPluginApi["client"]["session"]["children"]>[0];
type SessionClient = SessionDataApi["client"]["session"];
type MessagesResponse = Awaited<ReturnType<SessionClient["messages"]>>;
type ChildrenResponse = Awaited<ReturnType<SessionClient["children"]>>;
type GetResponse = Awaited<ReturnType<SessionClient["get"]>>;
type EventType = Event["type"];
type EventHandler<Type extends EventType> = (event: Extract<Event, { type: Type }>) => void;
type UnknownEventHandler = (event: unknown) => void;

function isEventOfType<Type extends EventType>(
  event: unknown,
  type: Type,
): event is Extract<Event, { type: Type }> {
  return event !== null && typeof event === "object" && "type" in event && event.type === type;
}

export function defaultMessage(): AssistantMessage {
  return {
    id: "message-1",
    sessionID: "root",
    role: "assistant" as const,
    time: { created: 1, completed: 2 },
    parentID: "",
    modelID: "model",
    providerID: "provider",
    mode: "default",
    agent: "default",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 1,
    tokens: { input: 3, output: 2, reasoning: 1, total: 6, cache: { read: 0, write: 0 } },
  };
}

export type RenderApiOptions = {
  providers?: ProviderState | Provider;
  messagesBySession?: Readonly<Record<string, ReadonlyArray<Message>>>;
  sessionsById?: Readonly<Record<string, Session>>;
  childrenByParent?: Readonly<Record<string, ReadonlyArray<Session>>>;
  deferMessages?: boolean;
};

export type ProviderStateOptions = {
  id?: string;
  name?: string;
  models?: Readonly<Record<string, Partial<ProviderModel>>>;
};

export function providerState(options: ProviderStateOptions = {}): ProviderState {
  const defaultModel: ProviderModel = {
    name: "Model",
    limit: { context: 128_000 },
    cost: { input: 1, output: 2, cache: { read: 0.5, write: 1 } },
  };
  const models: Record<string, ProviderModel> = {};
  for (const [modelID, model] of Object.entries(options.models ?? { model: {} }))
    models[modelID] = { ...defaultModel, ...model };

  return [
    {
      id: options.id ?? "provider",
      name: options.name ?? "Provider",
      models,
    },
  ];
}

export function renderApi(options: RenderApiOptions = {}) {
  const providers: ProviderState = (options.providers ?? []).map(({ id, name, models }) => ({
    id,
    name,
    models,
  }));
  const messagesBySession = options.messagesBySession ?? { root: [defaultMessage()] };
  const sessionsById = options.sessionsById ?? {};
  const childrenByParent = options.childrenByParent ?? {};
  const clientMessages: MessageRequest[] = [];
  const messageSignals: AbortSignal[] = [];
  const messageResolvers: Array<() => void> = [];
  const clientGet: SessionRequest[] = [];
  const clientChildren: ChildrenRequest[] = [];
  const stateMessages: string[] = [];
  const stateGet: string[] = [];
  const calls = {
    clientMessages,
    messageSignals,
    clientGet,
    clientChildren,
    stateMessages,
    stateGet,
  };
  let subscriptions = 0;
  const listeners = new Set<{ type: EventType; listener: UnknownEventHandler }>();
  const api = {
    event: {
      on: <Type extends EventType>(type: Type, listener: EventHandler<Type>) => {
        subscriptions += 1;
        const subscription = {
          type,
          listener: (event: unknown) => {
            if (isEventOfType(event, type)) listener(event);
          },
        };
        listeners.add(subscription);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          listeners.delete(subscription);
          subscriptions -= 1;
        };
      },
    },
    state: {
      provider: providers,
      session: {
        messages: (sessionID: string) => {
          calls.stateMessages.push(sessionID);
          return messagesBySession[sessionID] ?? [];
        },
        get: (sessionID: string) => {
          calls.stateGet.push(sessionID);
          return sessionsById[sessionID];
        },
        status: () => ({ type: "idle" as const }),
      },
    },
    client: {
      session: {
        messages: async (
          request: MessageRequest,
          requestOptions?: { signal?: AbortSignal | null },
        ): Promise<MessagesResponse> => {
          calls.clientMessages.push(request);
          messageSignals.push(requestOptions?.signal ?? new AbortController().signal);
          const response = {
            data: (messagesBySession[request.sessionID] ?? []).map((info) => ({ info, parts: [] })),
            error: undefined,
            request: new Request("http://localhost"),
            response: new Response(),
          };
          if (options.deferMessages)
            await new Promise<void>((resolve) => messageResolvers.push(resolve));
          return response;
        },
        children: async (request: ChildrenRequest): Promise<ChildrenResponse> => {
          calls.clientChildren.push(request);
          return {
            data: [...(childrenByParent[request.sessionID] ?? [])],
            error: undefined,
            request: new Request("http://localhost"),
            response: new Response(),
          };
        },
        get: async (request: SessionRequest): Promise<GetResponse> => {
          calls.clientGet.push(request);
          const data = sessionsById[request.sessionID];
          return data
            ? {
                data,
                error: undefined,
                request: new Request("http://localhost"),
                response: new Response(),
              }
            : {
                data: undefined,
                error: { name: "NotFoundError", data: { message: "Session not found" } },
                request: new Request("http://localhost"),
                response: new Response(),
              };
        },
      },
    },
    theme: { current: theme },
  } satisfies MetricsProviderApi;
  return {
    api,
    calls,
    requests: () => calls.clientMessages.length,
    releaseMessages: () => messageResolvers.splice(0).forEach((resolve) => resolve()),
    subscriptions: () => subscriptions,
    emit: (event: unknown) => {
      const type =
        event !== null &&
        typeof event === "object" &&
        "type" in event &&
        typeof event.type === "string"
          ? event.type
          : undefined;
      for (const subscription of listeners)
        if (subscription.type === type) subscription.listener(event);
    },
  };
}

export function modelUsage(providerID: string, modelID: string): ModelUsage {
  return {
    providerID,
    modelID,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheRate: undefined,
    speed: undefined,
    cost: 0,
    reportedCost: 0,
    estimatedCost: 0,
  };
}

export function populatedMetrics() {
  const metrics = new Metrics();
  metrics.cost = 1;
  Object.assign(metrics.tokens, {
    input: 11,
    output: 7,
    reasoning: 3,
    cache_read: 5,
    cache_write: 2,
    total: 28,
  });
  metrics.providerCosts.set("provider", {
    providerID: "provider",
    name: "Provider",
    cost: 1,
    reportedCost: 1,
    estimatedCost: 0,
  });
  metrics.models.set(modelKey("provider", "model"), {
    ...modelUsage("provider", "model"),
    input: 11,
    output: 7,
    reasoning: 3,
    cacheRead: 5,
    cacheWrite: 2,
    cacheRate: 5 / 16,
    speed: 10,
    cost: 1,
    reportedCost: 1,
    estimatedCost: 0,
  });
  return metrics;
}

export function metricsWithModels(entries: ReadonlyArray<readonly [string, string, number]>) {
  const metrics = new Metrics();
  for (const [providerID, modelID, input] of entries)
    metrics.models.set(modelKey(providerID, modelID), {
      ...modelUsage(providerID, modelID),
      input,
    });
  return metrics;
}

export function findText(root: Renderable, text: string): TextRenderable | undefined {
  if (root instanceof TextRenderable && root.plainText.includes(text)) return root;

  for (const child of root.getChildren()) {
    const match = findText(child, text);
    if (match) return match;
  }

  return undefined;
}

export async function clickText(setup: TestRendererSetup, text: string): Promise<void> {
  const renderable = findText(setup.renderer.root, text);
  if (!renderable) throw new Error(`Text not found: ${text}`);

  await setup.mockMouse.click(
    renderable.screenX + Math.floor(renderable.width / 2),
    renderable.screenY + Math.floor(renderable.height / 2),
  );
  await setup.flush();
}

export function staticDialogStore(metrics: Metrics, { sessionID }: { sessionID: string }) {
  const get: string[] = [];
  const prime: string[] = [];
  const hasUsableSnapshot: string[] = [];
  const subscribe: string[] = [];
  const retain: string[] = [];
  const retainRefresh: Array<{ sessionID: string; includeSubagents: boolean }> = [];
  const includeSubagents: boolean[] = [];
  const calls = {
    get,
    prime,
    hasUsableSnapshot,
    subscribe,
    retain,
    retainRefresh,
    includeSubagents,
  };
  const assertSession = (requested: string) => {
    if (requested !== sessionID) throw new Error(`Unexpected session ID: ${requested}`);
  };
  const store = {
    get: (requested: string) => {
      assertSession(requested);
      calls.get.push(requested);
      return metrics;
    },
    retain: (requested: string) => {
      assertSession(requested);
      calls.retain.push(requested);
      return () => {};
    },
    setCatalog: () => false,
    setIncludeSubagents: (includeSubagents: boolean) => {
      calls.includeSubagents.push(includeSubagents);
      return false;
    },
    prime: (requested: string) => {
      assertSession(requested);
      calls.prime.push(requested);
      return metrics;
    },
    hasUsableSnapshot: (requested: string) => {
      assertSession(requested);
      calls.hasUsableSnapshot.push(requested);
      return true;
    },
    subscribe: (requested: string, _listener: (sessionID: string) => void) => {
      assertSession(requested);
      calls.subscribe.push(requested);
      return () => {};
    },
    retainRefresh: (requested: string, includeSubagents: boolean) => {
      assertSession(requested);
      calls.retainRefresh.push({ sessionID: requested, includeSubagents });
      return () => {};
    },
  } satisfies MetricsStore;
  return Object.assign(store, { calls });
}
