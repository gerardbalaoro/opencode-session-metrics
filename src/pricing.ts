import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export type PricingTier = Pricing & { tier: { type: "context"; size: number } };
export type Pricing = {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tiers?: PricingTier[];
};

export type CatalogEntry = { id: string; name: string; cost: Pricing };
export type Catalog = ReadonlyMap<string, CatalogEntry>;

export function openCodeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(cacheHome, "opencode", "models.json");
}

const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

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
  const data = value as any;
  const cache = data?.cache ?? {};
  const normalized: Pricing = {
    input: number(data?.input),
    output: number(data?.output),
    cache: {
      read: number(data?.cache_read ?? cache.read),
      write: number(data?.cache_write ?? cache.write),
    },
  };

  const tiers: PricingTier[] = Array.isArray(data?.tiers)
    ? data.tiers
        .map((tier: any) => {
          const size = number(tier?.tier?.size ?? tier?.size);
          if (!(size > 0)) return undefined;
          return {
            ...canonicalizePricing(tier).value,
            tier: { type: "context" as const, size },
          };
        })
        .filter((tier: any): tier is PricingTier => !!tier)
    : [];

  // Some models.dev records flatten the second context tier under this name.
  const over200k = data?.context_over_200k ?? data?.experimentalOver200K;
  if (over200k && typeof over200k === "object") {
    tiers.push({
      ...canonicalizePricing(over200k).value,
      tier: { type: "context" as const, size: 200_000 },
    });
  }
  if (tiers.length) normalized.tiers = tiers;

  // This is the single canonical shape: aliases are resolved before it is
  // fingerprinted, so adding a normalized field updates both paths together.
  const sourceFingerprint = JSON.stringify(normalized);
  const object = value && typeof value === "object" ? (value as object) : undefined;
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

function normalizePricing(value: unknown): Pricing {
  return canonicalizePricing(value).value;
}

export function normalizeCatalog(raw: unknown): Catalog {
  const catalog = new Map<string, CatalogEntry>();
  if (!raw || typeof raw !== "object") return catalog;
  for (const [providerID, provider] of Object.entries(raw as Record<string, any>)) {
    if (!provider?.models || typeof provider.models !== "object") continue;
    for (const [modelID, model] of Object.entries(provider.models) as Array<[string, any]>) {
      if (!model || typeof model !== "object" || !model.cost) continue;
      catalog.set(`${providerID}/${modelID}`, {
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
  let loaded = memoizedCatalogs.get(path);
  if (!loaded) {
    loaded = loadCatalog(path);
    memoizedCatalogs.set(path, loaded);
  }
  return loaded;
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

type PricingApi = Pick<TuiPluginApi, "state">;

const objectIdentities = new WeakMap<object, number>();
let nextObjectIdentity = 1;

function objectIdentity(value: unknown): number | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function")
    return undefined;
  const object = value as object;
  let identity = objectIdentities.get(object);
  if (identity === undefined) {
    identity = nextObjectIdentity++;
    objectIdentities.set(object, identity);
  }
  return identity;
}

function fingerprintProviderList(providers: readonly unknown[]): string {
  return JSON.stringify(
    providers.map((provider) => {
      const data = provider as { id?: unknown; name?: unknown } | undefined;
      return [objectIdentity(provider), data?.id, data?.name];
    }),
  );
}

type CachedResolution = {
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
  private readonly resolutions = new Map<string, CachedResolution>();
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
    if (!providerID) {
      this.resolutions.clear();
    } else if (modelID) {
      this.resolutions.delete(`${providerID}/${modelID}`);
    } else {
      for (const key of this.resolutions.keys()) {
        if (key.startsWith(`${providerID}/`)) this.resolutions.delete(key);
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
    const catalogEntry = catalog?.get(`${providerID}/${modelID}`);
    const catalogPricing = canonicalizePricing(catalogEntry?.cost);
    const catalogFingerprint = catalogPricing.fingerprint;
    const key = `${providerID}/${modelID}`;
    const cached = this.resolutions.get(key);
    const providerListIdentity = objectIdentity(providers);

    if (
      cached &&
      cached.providerListIdentity === providerListIdentity &&
      cached.catalog === catalog
    ) {
      const currentProvider =
        cached.providerIndex >= 0 && cached.providerIndex < providers.length
          ? providers[cached.providerIndex]
          : undefined;
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
  const key = api as object;
  let resolver = defaultResolvers.get(key);
  if (!resolver) {
    resolver = new PricingResolver(catalog);
    defaultResolvers.set(key, resolver);
  } else {
    resolver.setCatalog(catalog);
  }
  return resolver;
}
