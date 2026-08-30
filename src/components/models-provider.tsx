/** @jsxImportSource @opentui/solid */
import type { JSX } from "solid-js";

import { createContext, useContext, type Accessor } from "solid-js";

import type { ProviderState } from "#lib/api";

export type Providers = ProviderState;

export type ModelsContextValue = Readonly<{
  getModelName: (providerID: string, modelID: string) => string;
}>;

const ModelsContext = createContext<ModelsContextValue>();

export function ModelsProvider(props: {
  value: Accessor<Providers>;
  children: () => JSX.Element;
}): JSX.Element {
  const providers = props.value;
  const value: ModelsContextValue = {
    getModelName: (providerID, modelID) =>
      providers().find((provider) => provider.id === providerID)?.models[modelID]?.name ?? modelID,
  };

  return ModelsContext.Provider({
    value,
    get children() {
      return props.children();
    },
  });
}

export function useModels(): ModelsContextValue {
  const models = useContext(ModelsContext);
  if (models === undefined) {
    throw new Error("useModels() must be called within a ModelsProvider");
  }
  return models;
}
