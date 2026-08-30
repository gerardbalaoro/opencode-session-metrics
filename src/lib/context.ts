import type { ContextApi } from "./api";

import { normalizeMessage, type NormalizedMessage } from "./session";

export type ContextUsage = {
  tokens: number;
  total?: number;
  percentage?: number;
};

export function isContextWarning(percentage: number, threshold: number) {
  return percentage >= threshold;
}

export function isContextCountWarning(tokens: number, threshold: number) {
  return tokens >= threshold;
}

function latestContextMessage(messages: ReadonlyArray<unknown>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = normalizeMessage(messages[index]);
    if (message?.role === "assistant" && (message.tokens?.output ?? 0) > 0) return message;
  }

  return undefined;
}

function contextTokens(message?: NormalizedMessage) {
  if (!message?.tokens) return 0;

  return (
    (message.tokens.input ?? 0) +
    (message.tokens.output ?? 0) +
    (message.tokens.reasoning ?? 0) +
    (message.tokens.cache?.read ?? 0) +
    (message.tokens.cache?.write ?? 0)
  );
}

function contextLimit(api: ContextApi, message?: NormalizedMessage) {
  if (!message?.providerID || !message.modelID) return undefined;

  const provider = api.state.provider.find((item) => item.id === message.providerID);
  const limit = provider?.models[message.modelID]?.limit?.context;
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
}

export function loadContext(api: ContextApi, sessionID: string): ContextUsage | undefined {
  const messages = api.state.session.messages(sessionID);
  const message = latestContextMessage(messages);
  const tokens = contextTokens(message);
  const limit = contextLimit(api, message);

  if (!message) return undefined;
  if (limit === undefined) return { tokens };

  return { tokens, total: limit, percentage: Math.round((tokens / limit) * 100) };
}
