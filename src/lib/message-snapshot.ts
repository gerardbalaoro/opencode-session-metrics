import type { PricingPair } from "./pricing";

import { modelKey, type ModelKey } from "./model-key";
import { normalizeMessage, type Message, type NormalizedMessage } from "./session";

export type MessageSnapshot = {
  readonly keys: readonly string[] | undefined;
  readonly pricingPairs: readonly PricingPair[];
};

function messageID(message: NormalizedMessage) {
  return message.id && message.id.length > 0 ? message.id : undefined;
}

function messageSignature(message: NormalizedMessage, source: Message | NormalizedMessage) {
  const created = Reflect.get(source, "created");
  const completed = Reflect.get(source, "completed");
  const tokens = message.tokens;
  return JSON.stringify([
    message.role,
    message.cost,
    message.providerID,
    message.modelID,
    message.time?.created,
    message.time?.completed,
    typeof created === "number" && Number.isFinite(created) ? created : undefined,
    typeof completed === "number" && Number.isFinite(completed) ? completed : undefined,
    tokens?.total,
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache?.read,
    tokens?.cache?.write,
  ]);
}

export function snapshotMessages(
  messages: ReadonlyArray<Message | NormalizedMessage>,
): MessageSnapshot {
  const keys: string[] = [];
  const seen = new Set<string>();
  const pairs = new Map<ModelKey, PricingPair>();
  let validKeys = true;

  for (const message of messages) {
    const normalized = normalizeMessage(message);
    if (!normalized) continue;

    const id = messageID(normalized);
    if (!id || seen.has(id)) validKeys = false;
    else {
      seen.add(id);
      keys.push(`${id}:${messageSignature(normalized, message)}`);
    }

    if (
      normalized.role === "assistant" &&
      Reflect.get(message, "tokens") &&
      (normalized.cost === undefined || normalized.cost === 0) &&
      normalized.providerID !== undefined &&
      normalized.modelID !== undefined
    ) {
      const pair = { providerID: normalized.providerID, modelID: normalized.modelID };
      pairs.set(modelKey(pair.providerID, pair.modelID), pair);
    }
  }

  return { keys: validKeys ? [...keys] : undefined, pricingPairs: [...pairs.values()] };
}

export function uniquePricingPairs(...snapshots: ReadonlyArray<MessageSnapshot | undefined>) {
  const pairs = new Map<ModelKey, PricingPair>();
  for (const snapshot of snapshots) {
    for (const pair of snapshot?.pricingPairs ?? []) {
      pairs.set(modelKey(pair.providerID, pair.modelID), {
        providerID: pair.providerID,
        modelID: pair.modelID,
      });
    }
  }
  return [...pairs.values()];
}

export function compareMessageSnapshots(
  previous: MessageSnapshot,
  next: MessageSnapshot,
): { kind: "unchanged" } | { kind: "append-only"; deltaStart: number } | { kind: "rebuild" } {
  if (!previous.keys || !next.keys) return { kind: "rebuild" };
  const previousKeys = previous.keys;
  const nextKeys = next.keys;
  if (
    previousKeys.length === nextKeys.length &&
    previousKeys.every((key, index) => key === nextKeys[index])
  ) {
    return { kind: "unchanged" };
  }
  if (
    nextKeys.length > previousKeys.length &&
    previousKeys.every((key, index) => key === nextKeys[index])
  ) {
    return { kind: "append-only", deltaStart: previous.keys.length };
  }
  return { kind: "rebuild" };
}
