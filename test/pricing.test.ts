import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PricingResolver } from "../src/pricing.ts";

function pricingApi(providers: any[]) {
  return { state: { provider: providers } } as never;
}

function provider(id: string, name = id) {
  return {
    id,
    name,
    models: {
      model: { cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } },
    },
  };
}

describe("PricingResolver", () => {
  it("invalidates a cached resolution after an in-place provider rename", () => {
    const currentProvider = provider("provider", "Before");
    const api = pricingApi([currentProvider]);
    const resolver = new PricingResolver();

    const first = resolver.resolve(api, "provider", "model");
    assert.equal(first?.provider.name, "Before");
    assert.equal(resolver.resolve(api, "provider", "model"), first);

    currentProvider.name = "After";
    const renamed = resolver.resolve(api, "provider", "model");

    assert.notEqual(renamed, first);
    assert.equal(renamed?.provider.name, "After");
  });

  it("invalidates a negative resolution after same-length in-place replacement", () => {
    const providers = [provider("other")];
    const api = pricingApi(providers);
    const resolver = new PricingResolver();

    assert.equal(resolver.resolve(api, "requested", "model"), undefined);
    const generation = resolver.pricingGeneration;
    assert.equal(resolver.resolve(api, "requested", "model"), undefined);
    assert.equal(resolver.pricingGeneration, generation);

    providers[0] = provider("requested", "Found");
    const resolved = resolver.resolve(api, "requested", "model");

    assert.equal(resolved?.provider.name, "Found");
  });
});
