import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderApi } from "./api";

import { modelKey, type ModelKey } from "./model-key";

export type PricingTier = Pricing & { tier: { type: "context"; size: number } };
export type Pricing = {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tiers?: PricingTier[];
};

export type CatalogEntry = { id: string; name: string; cost: Pricing };
export type Catalog = ReadonlyMap<ModelKey, CatalogEntry>;

export function openCodeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(cacheHome, "opencode", "models.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type CanonicalPricing = {
  fingerprint: string;
  sourceFingerprint: string;
  value: Pricing;
};

const canonicalPricingCache = new WeakMap<object, CanonicalPricing>();

/**
 * Builds the alias-resolved pricing shape used by both estimation and cache
 * invalidation. The source fingerprint detects in-place edits without sorting
 * unchanged tiers; the returned canonical value is sorted only when needed.
 */
function canonicalizePricing(value: unknown): CanonicalPricing {
  const pricingRecord = isRecord(value) ? value : {};
  const cache = isRecord(pricingRecord.cache) ? pricingRecord.cache : {};
  const normalized: Pricing = {
    input: normalizeFiniteNumber(pricingRecord.input),
    output: normalizeFiniteNumber(pricingRecord.output),
    cache: {
      read: normalizeFiniteNumber(pricingRecord.cache_read ?? cache.read),
      write: normalizeFiniteNumber(pricingRecord.cache_write ?? cache.write),
    },
  };

  const tiers: PricingTier[] = Array.isArray(pricingRecord.tiers)
    ? pricingRecord.tiers
        .map(normalizeContextTier)
        .filter((tier): tier is PricingTier => tier !== undefined)
    : [];

  // Some models.dev records flatten the second context tier under this name.
  const over200k = pricingRecord.context_over_200k ?? pricingRecord.experimentalOver200K;
  if (isRecord(over200k)) {
    tiers.push(createContextTier(over200k, 200_000));
  }
  if (tiers.length) normalized.tiers = tiers;

  // This is the single canonical shape: aliases are resolved before it is
  // fingerprinted, so adding a normalized field updates both paths together.
  const sourceFingerprint = JSON.stringify(normalized);
  const object = isObject(value) ? value : undefined;
  const cached = object ? canonicalPricingCache.get(object) : undefined;
  if (cached?.sourceFingerprint === sourceFingerprint) return cached;

  if (normalized.tiers) normalized.tiers.sort((a, b) => b.tier.size - a.tier.size);
  const canonical = {
    sourceFingerprint,
    fingerprint: JSON.stringify(normalized),
    value: normalized,
  };
  if (object) canonicalPricingCache.set(object, canonical);
  return canonical;
}

function normalizeContextTier(value: unknown): PricingTier | undefined {
  if (!isRecord(value)) return undefined;
  const tier = isRecord(value.tier) ? value.tier : {};
  const size = normalizeFiniteNumber(tier.size ?? value.size);
  if (!(size > 0)) return undefined;
  return createContextTier(value, size);
}

function createContextTier(value: unknown, size: number): PricingTier {
  return {
    ...canonicalizePricing(value).value,
    tier: { type: "context", size },
  };
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function normalizePricing(value: unknown): Pricing {
  return canonicalizePricing(value).value;
}

export function normalizeCatalog(raw: unknown): Catalog {
  const catalog = new Map<ModelKey, CatalogEntry>();
  if (!isRecord(raw)) return catalog;
  for (const [providerID, provider] of Object.entries(raw)) {
    if (!isRecord(provider)) continue;
    if (!isRecord(provider.models)) continue;
    for (const [modelID, model] of Object.entries(provider.models)) {
      if (!isRecord(model) || !isRecord(model.cost)) continue;
      catalog.set(modelKey(providerID, modelID), {
        id: modelID,
        name: typeof model.name === "string" ? model.name : `${providerID}/${modelID}`,
        cost: normalizePricing(model.cost),
      });
    }
  }
  return catalog;
}

export async function loadCatalog(path = openCodeCachePath()): Promise<Catalog> {
  try {
    return normalizeCatalog(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return new Map();
  }
}

const memoizedCatalogs = new Map<string, Promise<Catalog>>();

/** Shared memoized catalog loading for callers that use the same cache path. */
export function loadCatalogMemoized(path = openCodeCachePath()) {
  const catalogPromise = memoizedCatalogs.get(path) ?? loadCatalog(path);
  memoizedCatalogs.set(path, catalogPromise);
  return catalogPromise;
}

export function hasPricing(cost: Pricing): boolean {
  return (
    [cost.input, cost.output, cost.cache.read, cost.cache.write].some((rate) => rate > 0) ||
    (cost.tiers?.some((tier) => hasPricing(tier)) ?? false)
  );
}

export type PricingResolution = {
  providerID: string;
  modelID: string;
  provider: { id: string; name?: string };
  model?: { cost?: unknown };
  catalog?: CatalogEntry;
  cost?: Pricing;
};

export type PricingPair = { providerID: string; modelID: string };

type PricingApi = ProviderApi;

const objectIdentities = new WeakMap<object, number>();
let nextObjectIdentity = 1;

function objectIdentity(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const object = value;
  const identity = objectIdentities.get(object);
  if (identity !== undefined) return identity;
  const newIdentity = nextObjectIdentity++;
  objectIdentities.set(object, newIdentity);
  return newIdentity;
}

function fingerprintProviderList(providers: readonly unknown[]): string {
  return JSON.stringify(
    providers.map((provider) => {
      const providerRecord = isRecord(provider) ? provider : undefined;
      return [objectIdentity(provider), providerRecord?.id, providerRecord?.name];
    }),
  );
}

type CachedResolution = {
  providerID: string;
  providerListIdentity: number | undefined;
  providerListFingerprint: string | undefined;
  providerIndex: number;
  providerIdentity: number | undefined;
  providerName: string | undefined;
  modelIdentity: number | undefined;
  runtimeFingerprint: string;
  catalog: Catalog | undefined;
  catalogEntry: CatalogEntry | undefined;
  catalogFingerprint: string;
  resolution: PricingResolution | undefined;
};

/**
 * Resolves runtime and cached model pricing once per provider/model pair.
 * Pricing fingerprints also detect supported in-place edits without sorting
 * context tiers or searching providers again for every message.
 */
export class PricingResolver {
  private readonly resolutions = new Map<ModelKey, CachedResolution>();
  private catalog: Catalog | undefined;
  private generation = 0;

  constructor(catalog?: Catalog) {
    this.catalog = catalog;
  }

  get pricingGeneration() {
    return this.generation;
  }

  setCatalog(catalog?: Catalog) {
    if (catalog === this.catalog) return;
    this.catalog = catalog;
    this.generation += 1;
    this.resolutions.clear();
  }

  invalidate(providerID?: string, modelID?: string) {
    if (providerID === undefined) {
      this.resolutions.clear();
    } else if (modelID !== undefined) {
      this.resolutions.delete(modelKey(providerID, modelID));
    } else {
      for (const [key, cached] of this.resolutions) {
        if (cached.providerID === providerID) this.resolutions.delete(key);
      }
    }
    this.generation += 1;
  }

  resolve(
    api: PricingApi,
    providerID: string,
    modelID: string,
    catalog: Catalog | undefined = this.catalog,
  ): PricingResolution | undefined {
    if (catalog !== this.catalog) this.setCatalog(catalog);

    const providers = api.state.provider;
    const catalogEntry = catalog?.get(modelKey(providerID, modelID));
    const catalogPricing = canonicalizePricing(catalogEntry?.cost);
    const catalogFingerprint = catalogPricing.fingerprint;
    const key = modelKey(providerID, modelID);
    const cached = this.resolutions.get(key);
    const providerListIdentity = objectIdentity(providers);

    if (
      cached &&
      cached.providerListIdentity === providerListIdentity &&
      cached.catalog === catalog
    ) {
      const currentProvider = providers[cached.providerIndex];
      const currentModel = currentProvider?.models[modelID];
      const runtimePricing = canonicalizePricing(currentModel?.cost);
      if (
        currentProvider?.id === providerID &&
        objectIdentity(currentProvider) === cached.providerIdentity &&
        objectIdentity(currentModel) === cached.modelIdentity &&
        runtimePricing.fingerprint === cached.runtimeFingerprint &&
        currentProvider.name === cached.providerName &&
        cached.catalogEntry === catalogEntry &&
        catalogFingerprint === cached.catalogFingerprint
      ) {
        return cached.resolution;
      }
      if (
        cached.providerIndex < 0 &&
        cached.providerListFingerprint === fingerprintProviderList(providers)
      ) {
        return cached.resolution;
      }
    }

    const provider = providers.find((item) => item.id === providerID);
    const model = provider?.models[modelID];
    const providerIndex = provider ? providers.indexOf(provider) : -1;
    const runtimeCost = model?.cost;
    const runtimePricing = canonicalizePricing(runtimeCost);
    const runtimeFingerprint = runtimePricing.fingerprint;
    if (cached) this.generation += 1;
    const normalizedRuntime = runtimeCost ? runtimePricing.value : undefined;
    const normalizedCatalog = catalogEntry?.cost ? catalogPricing.value : undefined;
    const cost =
      normalizedRuntime && hasPricing(normalizedRuntime) ? normalizedRuntime : normalizedCatalog;
    const resolution = provider
      ? {
          providerID,
          modelID,
          provider: { id: provider.id, name: provider.name },
          model,
          catalog: catalogEntry,
          cost: cost && hasPricing(cost) ? cost : undefined,
        }
      : undefined;

    this.resolutions.set(key, {
      providerID,
      providerListIdentity,
      providerListFingerprint: provider ? undefined : fingerprintProviderList(providers),
      providerIndex,
      providerIdentity: objectIdentity(provider),
      providerName: provider?.name,
      modelIdentity: objectIdentity(model),
      runtimeFingerprint,
      catalog,
      catalogEntry,
      catalogFingerprint,
      resolution,
    });
    return resolution;
  }

  validate(api: PricingApi, pairs: ReadonlyArray<PricingPair>, catalog = this.catalog) {
    for (const { providerID, modelID } of pairs) {
      this.resolve(api, providerID, modelID, catalog);
    }
    return this.generation;
  }
}

const defaultResolvers = new WeakMap<object, PricingResolver>();

export function getPricingResolver(api: PricingApi, catalog?: Catalog): PricingResolver {
  const key = api;
  const resolver = defaultResolvers.get(key) ?? new PricingResolver(catalog);
  resolver.setCatalog(catalog);
  defaultResolvers.set(key, resolver);
  return resolver;
}
