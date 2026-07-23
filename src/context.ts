import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { AssistantMessage, Message } from "./session";

export type ContextUsage = {
  tokens: number;
  percentage?: number;
};

export function isContextWarning(percentage: number, threshold: number) {
  return percentage >= threshold;
}

export function isContextCountWarning(tokens: number, threshold: number) {
  return tokens >= threshold;
}

type AssistantContextMessage = AssistantMessage & {
  providerID?: string;
  modelID?: string;
};

export function latestContextMessage(messages: ReadonlyArray<Message>) {
  return messages
    .filter(
      (message): message is AssistantContextMessage =>
        message.role === "assistant" && (message.tokens?.output ?? 0) > 0,
    )
    .at(-1);
}

export function contextTokens(messages: ReadonlyArray<Message>) {
  const message = latestContextMessage(messages);
  if (!message?.tokens) return 0;

  return (
    message.tokens.input +
    message.tokens.output +
    message.tokens.reasoning +
    (message.tokens.cache?.read ?? 0) +
    (message.tokens.cache?.write ?? 0)
  );
}

export function contextLimit(api: TuiPluginApi, message?: AssistantContextMessage) {
  if (!message?.providerID || !message.modelID) return undefined;

  const provider = api.state.provider.find((item) => item.id === message.providerID);
  const limit = provider?.models[message.modelID]?.limit?.context;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

export function loadContext(api: TuiPluginApi, sessionID: string): ContextUsage | undefined {
  const messages = api.state.session.messages(sessionID);
  const message = latestContextMessage(messages);
  const tokens = contextTokens(messages);
  const limit = contextLimit(api, message);

  if (!message) return undefined;

  return {
    tokens,
    ...(limit === undefined ? {} : { percentage: Math.round((tokens / limit) * 100) }),
  };
}
