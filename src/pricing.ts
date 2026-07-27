import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Pricing = {
  input: number;
  output: number;
  cache: { read: number; write: number };
  tiers?: Array<Pricing & { tier: { type: "context"; size: number } }>;
};

export type CatalogEntry = { id: string; name: string; cost: Pricing };
export type Catalog = ReadonlyMap<string, CatalogEntry>;

export function openCodeCachePath(env: NodeJS.ProcessEnv = process.env): string {
  const cacheHome = env.XDG_CACHE_HOME ? env.XDG_CACHE_HOME : join(homedir(), ".cache");
  return join(cacheHome, "opencode", "models.json");
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function normalizeCost(value: any): Pricing {
  const cache = value?.cache ?? {};
  const normalized: Pricing = {
    input: number(value?.input),
    output: number(value?.output),
    cache: {
      read: number(value?.cache_read ?? cache.read),
      write: number(value?.cache_write ?? cache.write),
    },
  };

  const tiers = Array.isArray(value?.tiers)
    ? value.tiers
        .map((tier: any) => {
          const size = number(tier?.tier?.size ?? tier?.size);
          if (!(size > 0)) return undefined;
          return { ...normalizeCost(tier), tier: { type: "context" as const, size } };
        })
        .filter((tier: any): tier is NonNullable<typeof tier> => !!tier)
    : [];

  // Some models.dev records flatten the second context tier under this name.
  const over200k = value?.context_over_200k;
  if (over200k && typeof over200k === "object") {
    tiers.push({ ...normalizeCost(over200k), tier: { type: "context", size: 200_000 } });
  }
  if (tiers.length) normalized.tiers = tiers;
  return normalized;
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
        cost: normalizeCost(model.cost),
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

export function hasPricing(cost: Pricing): boolean {
  return (
    [cost.input, cost.output, cost.cache.read, cost.cache.write].some((rate) => rate > 0) ||
    (cost.tiers?.some((tier) => hasPricing(tier)) ?? false)
  );
}
