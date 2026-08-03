import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { abortable, hasResponseError, isAbortError, mapWithConcurrency } from "./utils";
import {
  DESCENDANT_CONCURRENCY,
  getSessionDescendants,
  type Message,
  type Session,
} from "./session";
import { getPricingResolver, type Catalog, type PricingResolver } from "./pricing";

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

export type SessionMetricsSource = "http" | "tui" | "rollup" | "empty";

export type SessionMetricsLoadResult = {
  metrics: Metrics;
  source: SessionMetricsSource;
  messages?: ReadonlyArray<Message>;
  successful: boolean;
};

type SessionMetricsLoadOptions = {
  catalog?: Catalog;
  resolver?: PricingResolver;
  signal?: AbortSignal;
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

  static fromMessages(
    messages: ReadonlyArray<Message>,
    api?: TuiPluginApi,
    catalog?: Catalog,
    resolver?: PricingResolver,
  ) {
    const metrics = new Metrics();
    const pricingResolver = api ? (resolver ?? getPricingResolver(api, catalog)) : undefined;

    for (const message of messages) {
      if (message.role !== "assistant" || !message.tokens) {
        continue;
      }

      const { input, output, reasoning } = message.tokens;
      const cache = message.tokens.cache;

      const messageCost = message.cost ?? 0;
      metrics.cost += messageCost;
      if (api && messageCost === 0) {
        const estimate = estimateMessageCost(api, message, catalog, pricingResolver);
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

  clone() {
    const metrics = new Metrics();
    metrics.cost = this.cost;
    metrics.tokens = { ...this.tokens };
    metrics.estimatedCostByProvider = new Map(
      [...this.estimatedCostByProvider.entries()].map(([id, estimate]) => [id, { ...estimate }]),
    );
    return metrics;
  }

  static async fromSessionMessages(
    api: TuiPluginApi,
    session: Session,
    options: SessionMetricsLoadOptions = {},
  ) {
    const result = await loadSessionMetrics(api, session.id, options);
    if (!result.successful) throw new Error("Session metrics unavailable");
    return result.messages
      ? Metrics.fromMessages(result.messages, api, options.catalog, options.resolver)
      : result.metrics.clone();
  }

  static async fromSessionDescendants(
    api: TuiPluginApi,
    rootSessionId: string,
    options: SessionMetricsLoadOptions = {},
  ): Promise<Metrics> {
    const totals = new Metrics();

    const descendants = await getSessionDescendants(api, rootSessionId, { signal: options.signal });
    const descendantMetrics = await mapWithConcurrency(
      descendants,
      DESCENDANT_CONCURRENCY,
      (descendant) =>
        Metrics.fromSessionMessages(api, descendant, options).catch((error) => {
          if (isAbortError(error)) throw error;
          options.signal?.throwIfAborted();
          return new Metrics();
        }),
      options.signal,
    );
    for (const metrics of descendantMetrics) totals.add(metrics);

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

function messageLoadResult(
  source: "http" | "tui",
  messages: ReadonlyArray<Message>,
  api: TuiPluginApi,
  catalog: Catalog | undefined,
  resolver: PricingResolver,
): SessionMetricsLoadResult {
  let metrics: Metrics | undefined;
  return {
    get metrics() {
      return (metrics ??= Metrics.fromMessages(messages, api, catalog, resolver));
    },
    source,
    messages,
    successful: true,
  };
}

/** Load one session while preserving the HTTP → TUI → rollup fallback order. */
export async function loadSessionMetrics(
  api: TuiPluginApi,
  sessionID: string,
  options: SessionMetricsLoadOptions = {},
): Promise<SessionMetricsLoadResult> {
  const { catalog, resolver, signal } = options;
  signal?.throwIfAborted();
  const pricingResolver = resolver ?? getPricingResolver(api, catalog);
  let emptyHttpResult: SessionMetricsLoadResult | undefined;

  try {
    const response = await abortable<any>(
      (api.client.session.messages as any)(
        { sessionID, limit: 100_000 },
        signal ? { signal } : undefined,
      ),
      signal,
    );
    signal?.throwIfAborted();
    if (hasResponseError(response)) throw new Error("Session messages request failed");
    if (!Array.isArray(response?.data)) throw new Error("Session messages response unavailable");
    const rows = response.data as Array<{ info?: unknown }>;
    const messages = rows.map((row) => row.info).filter((info): info is Message => !!info);

    const result = messageLoadResult("http", messages, api, catalog, pricingResolver);
    if (messages.length > 0) return result;
    emptyHttpResult = result;
  } catch (error) {
    if (isAbortError(error)) throw error;
    signal?.throwIfAborted();
  }

  signal?.throwIfAborted();

  let stateMessages: ReadonlyArray<Message> = [];
  try {
    stateMessages = api.state.session.messages(sessionID);
  } catch (error) {
    if (isAbortError(error)) throw error;
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
  if (stateMessages.length > 0) {
    return messageLoadResult("tui", stateMessages, api, catalog, pricingResolver);
  }

  let session: Session | undefined;
  try {
    session = api.state.session.get?.(sessionID);
  } catch (error) {
    if (isAbortError(error)) throw error;
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
  const localMetrics = session ? Metrics.fromSessionRollup(session) : undefined;
  if (localMetrics) return { metrics: localMetrics, source: "rollup", successful: true };

  try {
    const response = await abortable<any>(
      (api.client.session.get as any)({ sessionID }, signal ? { signal } : undefined),
      signal,
    );
    signal?.throwIfAborted();
    if (hasResponseError(response)) throw new Error("Session request failed");
    const httpMetrics = response?.data ? Metrics.fromSessionRollup(response.data) : undefined;
    if (httpMetrics) return { metrics: httpMetrics, source: "rollup", successful: true };
  } catch (error) {
    if (isAbortError(error)) throw error;
    signal?.throwIfAborted();
  }

  signal?.throwIfAborted();
  if (emptyHttpResult) return emptyHttpResult;
  return { metrics: new Metrics(), source: "empty", successful: false };
}

export function estimateMessageCost(
  api: TuiPluginApi,
  message: Message,
  catalog?: Catalog,
  resolver?: PricingResolver,
) {
  if (message.role !== "assistant" || !message.tokens) return undefined;

  const candidate = message as Message & { providerID?: string; modelID?: string };
  if (!candidate.providerID || !candidate.modelID) return undefined;

  const resolution = (resolver ?? getPricingResolver(api, catalog)).resolve(
    api,
    candidate.providerID,
    candidate.modelID,
    catalog,
  );
  if (!resolution?.cost) return undefined;

  const input = message.tokens.input ?? 0;
  const output = message.tokens.output ?? 0;
  const reasoning = message.tokens.reasoning ?? 0;
  const cacheRead = message.tokens.cache?.read ?? 0;
  const cacheWrite = message.tokens.cache?.write ?? 0;
  const contextInput = input + cacheRead + cacheWrite;
  const tier = resolution.cost.tiers?.find(
    (item) => item.tier.type === "context" && contextInput > item.tier.size,
  );
  const rates = tier ?? resolution.cost;
  const cost =
    (input * rates.input +
      output * rates.output +
      reasoning * rates.output +
      cacheRead * rates.cache.read +
      cacheWrite * rates.cache.write) /
    1_000_000;

  if (!(cost > 0)) return undefined;
  return {
    id: resolution.provider.id,
    name: resolution.provider.name || resolution.catalog?.name || resolution.provider.id,
    cost,
  };
}
