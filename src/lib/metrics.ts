import type { ProviderApi } from "./api";

import { modelKey, type ModelKey } from "./model-key";
import { getPricingResolver, type Catalog, type PricingResolver } from "./pricing";
import { normalizeMessage, type Message, type Session, type NormalizedMessage } from "./session";

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

export type ModelUsage = {
  providerID: string;
  modelID: string;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cacheRate: number | undefined;
  speed: number | undefined;
  /** Reported plus estimated cost for this model. */
  cost: number;
  reportedCost: number;
  estimatedCost: number;
};

export type ProviderCost = {
  providerID: string;
  name: string;
  /** Reported plus estimated cost for this provider. */
  cost: number;
  reportedCost: number;
  estimatedCost: number;
};

type SessionWithRollup = SessionRollup &
  ({ cost: number } | { tokens: NonNullable<SessionRollup["tokens"]> });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasSessionRollup(sessionRollup: unknown): sessionRollup is SessionWithRollup {
  if (!isRecord(sessionRollup)) return false;
  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value);
  const tokens = isRecord(sessionRollup.tokens) ? sessionRollup.tokens : undefined;

  return (
    isFiniteNumber(sessionRollup.cost) ||
    isFiniteNumber(tokens?.total) ||
    isFiniteNumber(tokens?.input) ||
    isFiniteNumber(tokens?.output) ||
    isFiniteNumber(tokens?.reasoning) ||
    isFiniteNumber(isRecord(tokens?.cache) ? tokens.cache.read : undefined) ||
    isFiniteNumber(isRecord(tokens?.cache) ? tokens.cache.write : undefined)
  );
}

type ModelUsageState = {
  generationTokens: number;
  completedDurationSeconds: number;
};

const modelUsageStates = new WeakMap<ModelUsage, ModelUsageState>();

function numberOrZero(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function ratio(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : undefined;
}

function modelUsageState(usage: ModelUsage) {
  const state =
    modelUsageStates.get(usage) ??
    (() => {
      const state = { generationTokens: 0, completedDurationSeconds: 0 };
      modelUsageStates.set(usage, state);
      return state;
    })();
  return state;
}

function updateModelUsageRates(usage: ModelUsage) {
  const state = modelUsageState(usage);
  usage.cacheRate = ratio(usage.cacheRead, usage.input + usage.cacheRead);
  usage.speed = ratio(state.generationTokens, state.completedDurationSeconds);
  usage.cost = usage.reportedCost + usage.estimatedCost;
}

function copyModelUsage(source: ModelUsage) {
  const copy: ModelUsage = { ...source };
  const sourceState = modelUsageState(source);
  modelUsageStates.set(copy, { ...sourceState });
  return copy;
}

function completedDurationSeconds(message: NormalizedMessage) {
  const created = message.time?.created;
  const completed = message.time?.completed;
  if (
    typeof created !== "number" ||
    !Number.isFinite(created) ||
    typeof completed !== "number" ||
    !Number.isFinite(completed) ||
    completed <= created
  ) {
    return undefined;
  }
  return (completed - created) / 1_000;
}

export class Metrics {
  /** Reported message cost; use totalCost for reported plus estimated cost. */
  public cost = 0;

  public estimatedCostByProvider = new Map<string, { name: string; cost: number }>();

  /** Finished usage snapshots keyed by the exact provider/model pair. */
  public models = new Map<ModelKey, ModelUsage>();

  /** Full provider totals, with reported and estimated portions separated. */
  public providerCosts = new Map<string, ProviderCost>();

  public tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    total: 0,
  };

  private generationTokens = 0;
  private completedDurationSeconds = 0;

  /** Reported plus estimated cost for this aggregate. */
  get totalCost() {
    return this.cost + this.estimatedCost;
  }

  get estimatedCost() {
    let total = 0;
    for (const estimate of this.estimatedCostByProvider.values()) total += estimate.cost;
    return total;
  }

  /** Cache read divided by input plus cache read, or unavailable. */
  get cacheRate() {
    return ratio(this.tokens.cache_read, this.tokens.input + this.tokens.cache_read);
  }

  /** Output plus reasoning tokens per completed assistant second, or unavailable. */
  get speed() {
    return ratio(this.generationTokens, this.completedDurationSeconds);
  }

  /** Alias for callers that name the aggregate rate explicitly. */
  get generationSpeed() {
    return this.speed;
  }

  /** Read-only naming for render callers; aggregation still uses providerCosts. */
  get costByProvider(): ReadonlyMap<string, ProviderCost> {
    return this.providerCosts;
  }

  static fromMessages(
    messages: ReadonlyArray<Message | NormalizedMessage>,
    api?: ProviderApi,
    catalog?: Catalog,
    resolver?: PricingResolver,
  ) {
    const metrics = new Metrics();
    const pricingResolver = api ? (resolver ?? getPricingResolver(api, catalog)) : undefined;
    const providerNames = new Map<string, string>();
    for (const provider of api?.state.provider ?? []) {
      providerNames.set(provider.id, provider.name || provider.id);
    }

    for (const value of messages) {
      const message = normalizeMessage(value);
      if (!message) continue;
      if (message.role !== "assistant") continue;

      const tokens = message.tokens;
      const input = numberOrZero(tokens?.input);
      const output = numberOrZero(tokens?.output);
      const reasoning = numberOrZero(tokens?.reasoning);
      const cacheRead = numberOrZero(tokens?.cache?.read);
      const cacheWrite = numberOrZero(tokens?.cache?.write);
      const total =
        typeof tokens?.total === "number" && Number.isFinite(tokens.total)
          ? tokens.total
          : input + output + reasoning;
      const messageCost = numberOrZero(message.cost);
      const providerID = message.providerID;
      const modelID = message.modelID;
      const durationSeconds = completedDurationSeconds(message);
      const completedGenerationTokens = durationSeconds === undefined ? 0 : output + reasoning;

      metrics.cost += messageCost;
      metrics.generationTokens += completedGenerationTokens;
      if (durationSeconds !== undefined) metrics.completedDurationSeconds += durationSeconds;

      if (tokens) {
        metrics.tokens.input += input;
        metrics.tokens.output += output;
        metrics.tokens.reasoning += reasoning;
        metrics.tokens.cache_read += cacheRead;
        metrics.tokens.cache_write += cacheWrite;
        metrics.tokens.total += total;
      }

      const estimate =
        api && messageCost === 0
          ? estimateMessageCost(api, message, catalog, pricingResolver)
          : undefined;

      if (providerID) {
        metrics.addProviderCost(
          providerID,
          providerNames.get(providerID) ?? providerID,
          messageCost,
          0,
        );
      }

      if (providerID && modelID) {
        metrics.addModelUsage(
          providerID,
          modelID,
          { input, output, reasoning, cacheRead, cacheWrite },
          messageCost,
          0,
          completedGenerationTokens,
          durationSeconds,
        );
      }

      if (estimate) {
        const current = metrics.estimatedCostByProvider.get(estimate.id);
        metrics.estimatedCostByProvider.set(estimate.id, {
          name: estimate.name,
          cost: (current?.cost ?? 0) + estimate.cost,
        });
        metrics.addProviderCost(estimate.id, estimate.name, 0, estimate.cost);
        if (providerID && modelID) {
          metrics.addModelUsage(
            providerID,
            modelID,
            { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            0,
            estimate.cost,
            0,
            undefined,
          );
        }
      }
    }

    return metrics;
  }

  static fromSessionRollup(session: unknown): Metrics | undefined {
    const isFiniteNumber = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value);

    if (!hasSessionRollup(session)) return undefined;
    const sessionRollup = session;

    const metrics = new Metrics();
    metrics.cost = isFiniteNumber(sessionRollup.cost) ? sessionRollup.cost : 0;

    if (sessionRollup.tokens) {
      metrics.tokens.input = isFiniteNumber(sessionRollup.tokens.input)
        ? sessionRollup.tokens.input
        : 0;
      metrics.tokens.output = isFiniteNumber(sessionRollup.tokens.output)
        ? sessionRollup.tokens.output
        : 0;
      metrics.tokens.reasoning = isFiniteNumber(sessionRollup.tokens.reasoning)
        ? sessionRollup.tokens.reasoning
        : 0;
      metrics.tokens.cache_read = isFiniteNumber(sessionRollup.tokens.cache?.read)
        ? sessionRollup.tokens.cache.read
        : 0;
      metrics.tokens.cache_write = isFiniteNumber(sessionRollup.tokens.cache?.write)
        ? sessionRollup.tokens.cache.write
        : 0;
      metrics.tokens.total = isFiniteNumber(sessionRollup.tokens.total)
        ? sessionRollup.tokens.total
        : metrics.tokens.input + metrics.tokens.output + metrics.tokens.reasoning;
    }

    return metrics;
  }

  clone() {
    const metrics = new Metrics();
    metrics.cost = this.cost;
    metrics.tokens = { ...this.tokens };
    metrics.generationTokens = this.generationTokens;
    metrics.completedDurationSeconds = this.completedDurationSeconds;
    metrics.estimatedCostByProvider = new Map(
      [...this.estimatedCostByProvider.entries()].map(([id, estimate]) => [id, { ...estimate }]),
    );
    metrics.models = new Map<ModelKey, ModelUsage>(
      [...this.models.values()].map((usage) => [
        modelKey(usage.providerID, usage.modelID),
        copyModelUsage(usage),
      ]),
    );
    metrics.providerCosts = new Map(
      [...this.providerCosts.entries()].map(([id, provider]) => [id, { ...provider }]),
    );
    return metrics;
  }

  static merge(a: Metrics, b: Metrics) {
    const metrics = a.clone();
    metrics.add(b);
    return metrics;
  }

  add(metrics: Metrics) {
    this.cost += metrics.cost;
    this.generationTokens += metrics.generationTokens;
    this.completedDurationSeconds += metrics.completedDurationSeconds;
    for (const [id, estimate] of metrics.estimatedCostByProvider) {
      const current = this.estimatedCostByProvider.get(id);
      this.estimatedCostByProvider.set(id, {
        name: estimate.name,
        cost: (current?.cost ?? 0) + estimate.cost,
      });
    }
    for (const usage of metrics.models.values()) {
      const key = modelKey(usage.providerID, usage.modelID);
      const current = this.models.get(key);
      if (!current) {
        this.models.set(key, copyModelUsage(usage));
        continue;
      }

      const currentState = modelUsageState(current);
      const usageState = modelUsageState(usage);
      current.input += usage.input;
      current.output += usage.output;
      current.reasoning += usage.reasoning;
      current.cacheRead += usage.cacheRead;
      current.cacheWrite += usage.cacheWrite;
      current.reportedCost += usage.reportedCost;
      current.estimatedCost += usage.estimatedCost;
      currentState.generationTokens += usageState.generationTokens;
      currentState.completedDurationSeconds += usageState.completedDurationSeconds;
      updateModelUsageRates(current);
    }
    for (const [providerID, provider] of metrics.providerCosts) {
      this.addProviderCost(
        providerID,
        provider.name,
        provider.reportedCost,
        provider.estimatedCost,
      );
    }
    this.tokens.input += metrics.tokens.input;
    this.tokens.output += metrics.tokens.output;
    this.tokens.reasoning += metrics.tokens.reasoning;
    this.tokens.cache_read += metrics.tokens.cache_read;
    this.tokens.cache_write += metrics.tokens.cache_write;
    this.tokens.total += metrics.tokens.total;
  }

  private addModelUsage(
    providerID: string,
    modelID: string,
    tokens: Pick<ModelUsage, "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite">,
    reportedCost: number,
    estimatedCost: number,
    generationTokens: number,
    durationSeconds: number | undefined,
  ) {
    const key = modelKey(providerID, modelID);
    const usage =
      this.models.get(key) ??
      (() => {
        const usage = {
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
        this.models.set(key, usage);
        modelUsageStates.set(usage, { generationTokens: 0, completedDurationSeconds: 0 });
        return usage;
      })();

    const state = modelUsageState(usage);
    usage.input += tokens.input;
    usage.output += tokens.output;
    usage.reasoning += tokens.reasoning;
    usage.cacheRead += tokens.cacheRead;
    usage.cacheWrite += tokens.cacheWrite;
    usage.reportedCost += reportedCost;
    usage.estimatedCost += estimatedCost;
    state.generationTokens += generationTokens;
    if (durationSeconds !== undefined) state.completedDurationSeconds += durationSeconds;
    updateModelUsageRates(usage);
  }

  private addProviderCost(
    providerID: string,
    name: string,
    reportedCost: number,
    estimatedCost: number,
  ) {
    const provider =
      this.providerCosts.get(providerID) ??
      (() => {
        const provider = { providerID, name, cost: 0, reportedCost: 0, estimatedCost: 0 };
        this.providerCosts.set(providerID, provider);
        return provider;
      })();
    if (provider.name === provider.providerID && name !== provider.providerID) {
      provider.name = name;
    }

    provider.reportedCost += reportedCost;
    provider.estimatedCost += estimatedCost;
    provider.cost = provider.reportedCost + provider.estimatedCost;
  }
}

export function estimateMessageCost(
  api: ProviderApi,
  message: NormalizedMessage,
  catalog?: Catalog,
  resolver?: PricingResolver,
) {
  if (message.role !== "assistant" || !message.tokens) return undefined;

  if (!message.providerID || !message.modelID) return undefined;

  const resolution = (resolver ?? getPricingResolver(api, catalog)).resolve(
    api,
    message.providerID,
    message.modelID,
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
