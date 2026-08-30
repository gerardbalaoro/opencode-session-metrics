import type { MetricsLoaderApi } from "./api";

import { Metrics } from "./metrics";
import { getPricingResolver, type Catalog, type PricingResolver } from "./pricing";
import { normalizeMessage, type NormalizedMessage } from "./session";
import { abortable, hasResponseError, isAbortError } from "./utils";

export type SessionMetricsSource = "http" | "tui" | "rollup" | "empty";

export type SessionMetricsLoadResult = {
  metrics: Metrics;
  source: SessionMetricsSource;
  messages?: ReadonlyArray<NormalizedMessage>;
  successful: boolean;
};

export type SessionMetricsLoadOptions = {
  catalog?: Catalog;
  resolver?: PricingResolver;
  signal?: AbortSignal;
};

function messageLoadResult(
  source: "http" | "tui",
  messages: ReadonlyArray<NormalizedMessage>,
  api: MetricsLoaderApi,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function normalizedMessages(value: unknown): NormalizedMessage[] {
  if (!isUnknownArray(value)) return [];

  const messages: NormalizedMessage[] = [];
  for (const row of value) {
    if (!isRecord(row)) continue;
    const message = normalizeMessage("info" in row ? row.info : row);
    if (message) messages.push(message);
  }
  return messages;
}

/** Loads session data while preserving the HTTP → TUI → rollup fallback order. */
export class MetricsLoader {
  constructor(readonly api: MetricsLoaderApi) {}

  async load(
    sessionID: string,
    options: SessionMetricsLoadOptions = {},
  ): Promise<SessionMetricsLoadResult> {
    const { catalog, resolver, signal } = options;
    signal?.throwIfAborted();
    const pricingResolver = resolver ?? getPricingResolver(this.api, catalog);
    let emptyHttpResult: SessionMetricsLoadResult | undefined;

    try {
      const response = await abortable(
        this.api.client.session.messages(
          { sessionID, limit: 100_000 },
          signal ? { signal } : undefined,
        ),
        signal,
      );
      signal?.throwIfAborted();
      if (hasResponseError(response)) throw new Error("Session messages request failed");
      const messageRows = isRecord(response) ? response.data : undefined;
      if (!isUnknownArray(messageRows)) throw new Error("Session messages response unavailable");
      const messages = normalizedMessages(messageRows);

      const result = messageLoadResult("http", messages, this.api, catalog, pricingResolver);
      if (messages.length > 0) return result;
      emptyHttpResult = result;
    } catch (error) {
      if (isAbortError(error)) throw error;
      signal?.throwIfAborted();
    }

    signal?.throwIfAborted();

    const stateMessages = (() => {
      try {
        return normalizedMessages(this.api.state.session.messages(sessionID));
      } catch (error) {
        if (isAbortError(error)) throw error;
        signal?.throwIfAborted();
        return [];
      }
    })();
    signal?.throwIfAborted();
    if (stateMessages.length > 0) {
      return messageLoadResult("tui", stateMessages, this.api, catalog, pricingResolver);
    }

    const session = (() => {
      try {
        return this.api.state.session.get?.(sessionID);
      } catch (error) {
        if (isAbortError(error)) throw error;
        signal?.throwIfAborted();
        return undefined;
      }
    })();
    signal?.throwIfAborted();
    const localMetrics = session ? Metrics.fromSessionRollup(session) : undefined;
    if (localMetrics) return { metrics: localMetrics, source: "rollup", successful: true };

    try {
      const response = await abortable(
        this.api.client.session.get({ sessionID }, signal ? { signal } : undefined),
        signal,
      );
      signal?.throwIfAborted();
      if (hasResponseError(response)) throw new Error("Session request failed");
      const sessionRollup = isRecord(response) ? response.data : undefined;
      const httpMetrics = isRecord(sessionRollup)
        ? Metrics.fromSessionRollup(sessionRollup)
        : undefined;
      if (httpMetrics) return { metrics: httpMetrics, source: "rollup", successful: true };
    } catch (error) {
      if (isAbortError(error)) throw error;
      signal?.throwIfAborted();
    }

    signal?.throwIfAborted();
    if (emptyHttpResult) return emptyHttpResult;
    return { metrics: new Metrics(), source: "empty", successful: false };
  }
}
