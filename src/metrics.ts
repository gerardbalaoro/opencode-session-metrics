import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { getSessionDescendants, type Message, type Session } from "./session";
import { hasPricing, type Catalog, type Pricing } from "./pricing";

export type SessionRollup = Omit<Session, "cost" | "tokens"> & {
  cost?: number;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
};

type SessionWithRollup = SessionRollup &
  ({ cost: number } | { tokens: NonNullable<SessionRollup["tokens"]> });

export function hasSessionRollup(data: SessionRollup): data is SessionWithRollup {
  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);

  return (
    isFiniteNumber(data.cost) ||
    isFiniteNumber(data.tokens?.total) ||
    isFiniteNumber(data.tokens?.input) ||
    isFiniteNumber(data.tokens?.output) ||
    isFiniteNumber(data.tokens?.reasoning) ||
    isFiniteNumber(data.tokens?.cache?.read) ||
    isFiniteNumber(data.tokens?.cache?.write)
  );
}

export class Metrics {
  public cost = 0;

  public estimatedCostByProvider = new Map<string, { name: string; cost: number }>();

  public tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
  };

  static fromMessages(messages: ReadonlyArray<Message>, api?: TuiPluginApi, catalog?: Catalog) {
    const metrics = new Metrics();

    for (const message of messages) {
      if (message.role !== "assistant" || !message.tokens) {
        continue;
      }

      const { input, output, reasoning } = message.tokens;
      const cache = message.tokens.cache;

       const messageCost = message.cost ?? 0;
       metrics.cost += messageCost;
       if (api && messageCost === 0) {
          const estimate = estimateMessageCost(api, message, catalog);
         if (estimate) {
           const current = metrics.estimatedCostByProvider.get(estimate.id);
           metrics.estimatedCostByProvider.set(estimate.id, {
             name: estimate.name,
             cost: (current?.cost ?? 0) + estimate.cost,
           });
         }
       }
      metrics.tokens.input += input;
      metrics.tokens.output += output;
      metrics.tokens.reasoning += reasoning;
      metrics.tokens.cache_read += cache?.read ?? 0;
      metrics.tokens.cache_write += cache?.write ?? 0;
      metrics.tokens.total += message.tokens.total ?? input + output + reasoning;
    }

    return metrics;
  }

  static fromSessionRollup(session: Session): Metrics | undefined {
    const isFiniteNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);

    if (!hasSessionRollup(session)) return undefined;
    const data = session;

    const metrics = new Metrics();
    metrics.cost = isFiniteNumber(data.cost) ? data.cost : 0;

    if (data.tokens) {
      metrics.tokens.input = isFiniteNumber(data.tokens.input) ? data.tokens.input : 0;
      metrics.tokens.output = isFiniteNumber(data.tokens.output) ? data.tokens.output : 0;
      metrics.tokens.reasoning = isFiniteNumber(data.tokens.reasoning) ? data.tokens.reasoning : 0;
      metrics.tokens.cache_read = isFiniteNumber(data.tokens.cache?.read)
        ? data.tokens.cache.read
        : 0;
      metrics.tokens.cache_write = isFiniteNumber(data.tokens.cache?.write)
        ? data.tokens.cache.write
        : 0;
      metrics.tokens.total = isFiniteNumber(data.tokens.total)
        ? data.tokens.total
        : metrics.tokens.input + metrics.tokens.output + metrics.tokens.reasoning;
    }

    return metrics;
  }

  static async fromSession(api: TuiPluginApi, session: Session) {
    const local = Metrics.fromSessionRollup(session);
    const data = local
      ? session
      : await api.client.session
          .get({ sessionID: session.id })
          .then((r) => r.data)
          .catch(() => undefined);

    return data ? (Metrics.fromSessionRollup(data) ?? new Metrics()) : new Metrics();
  }

  static async fromSessionMessages(api: TuiPluginApi, session: Session, catalog?: Catalog) {
    // Prefer complete HTTP messages so totals are authoritative even when the
    // local TUI state is windowed or incomplete. Use a high explicit limit to
    // avoid the server default truncating long sessions.
    try {
      const response = await api.client.session.messages({
        sessionID: session.id,
        limit: 100_000,
      });
      const rows = (response.data ?? []) as Array<{ info?: unknown }>;
      const messages = rows.map((row) => row.info).filter((info): info is Message => !!info);

      if (messages.length > 0) {
        return Metrics.fromMessages(messages, api, catalog);
      }
    } catch {
      // Ignore HTTP errors and fall back to the next source.
    }

    // Fall back to live TUI message state when the session is already loaded.
    const stateMessages = api.state.session.messages(session.id);
    if (stateMessages.length > 0) {
      return Metrics.fromMessages(stateMessages, api, catalog);
    }

    // Fall back to session aggregate data.
    return await Metrics.fromSession(api, session);
  }

  static async fromSessionDescendants(api: TuiPluginApi, rootSessionId: string, catalog?: Catalog): Promise<Metrics> {
    const totals = new Metrics();

    for (const descendant of await getSessionDescendants(api, rootSessionId)) {
      totals.add(await Metrics.fromSessionMessages(api, descendant, catalog));
    }

    return totals;
  }

  static merge(a: Metrics, b: Metrics) {
    const metrics = new Metrics();

    metrics.cost = a.cost;
    metrics.tokens = { ...a.tokens };
    metrics.estimatedCostByProvider = new Map(a.estimatedCostByProvider);

    metrics.add(b);

    return metrics;
  }

  add(metrics: Metrics) {
    this.cost += metrics.cost;
    for (const [id, estimate] of metrics.estimatedCostByProvider) {
      const current = this.estimatedCostByProvider.get(id);
      this.estimatedCostByProvider.set(id, {
        name: estimate.name,
        cost: (current?.cost ?? 0) + estimate.cost,
      });
    }
    this.tokens.input += metrics.tokens.input;
    this.tokens.output += metrics.tokens.output;
    this.tokens.reasoning += metrics.tokens.reasoning;
    this.tokens.cache_read += metrics.tokens.cache_read;
    this.tokens.cache_write += metrics.tokens.cache_write;
    this.tokens.total += metrics.tokens.total;
  }
}

export function estimateMessageCost(api: TuiPluginApi, message: Message, catalog?: Catalog) {
  if (message.role !== "assistant" || !message.tokens) return undefined;

  const candidate = message as Message & { providerID?: string; modelID?: string };
  if (!candidate.providerID || !candidate.modelID) return undefined;

  const provider = api.state.provider.find((item) => item.id === candidate.providerID);
  const model = provider?.models[candidate.modelID];
  const runtimeCost = model?.cost as Pricing | undefined;
  const cached = catalog?.get(`${candidate.providerID}/${candidate.modelID}`);
  const baseRates = runtimeCost && hasPricing(runtimeCost) ? runtimeCost : cached?.cost;
  if (!provider || !baseRates || !hasPricing(baseRates)) return undefined;

  const input = message.tokens.input ?? 0;
  const output = message.tokens.output ?? 0;
  const reasoning = message.tokens.reasoning ?? 0;
  const cacheRead = message.tokens.cache?.read ?? 0;
  const cacheWrite = message.tokens.cache?.write ?? 0;
  const contextInput = input + cacheRead + cacheWrite;
  const tier = baseRates.tiers
    ?.filter((item) => item.tier.type === "context" && contextInput > item.tier.size)
    .sort((a, b) => b.tier.size - a.tier.size)[0];
  const rates = tier ?? baseRates;
  const cost =
    (input * rates.input +
      output * rates.output +
      reasoning * rates.output +
      cacheRead * rates.cache.read +
      cacheWrite * rates.cache.write) /
    1_000_000;

  if (!(cost > 0)) return undefined;
  return { id: provider.id, name: provider.name || cached?.name || provider.id, cost };
}
