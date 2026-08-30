declare const modelKeyBrand: unique symbol;

/** Canonical primitive identity for one provider/model tuple. */
export type ModelKey = string & { readonly [modelKeyBrand]: "ModelKey" };

/** Encodes provider and model IDs without introducing delimiter collisions. */
export function modelKey(providerID: string, modelID: string): ModelKey {
  return JSON.stringify([providerID, modelID]) as ModelKey;
}
