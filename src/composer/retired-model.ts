import type { Conversation, Provider } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { formatText } from "../i18n";
import {
  catalogChoices,
  rememberedModelLabel,
} from "./model/code-model-choices";

export interface RetiredModel {
  /** The conversation's model, by the name it last had. */
  legacy: string;
  /** The model new replies use instead. */
  providerId: string;
  model: string;
}

/**
 * A Chat or Cowork conversation whose model the service no longer offers.
 * Nothing while the providers have not loaded, or for Code.
 */
export function retiredModel(
  conversation: Pick<Conversation, "mode" | "providerId" | "model"> | undefined,
  providers: Provider[],
  activeProviderId: string,
  catalog: ModelCatalog | null | undefined,
): RetiredModel | undefined {
  if (!conversation || conversation.mode === "code" || !conversation.model)
    return undefined;
  const { listed, more } = catalogChoices(providers, catalog);
  const offered = [...listed, ...more];
  if (!offered.length) return undefined;
  // Offered by any service, it is not retired (the official matches the
  // model alone).
  if (offered.some((choice) => choice.name === conversation.model))
    return undefined;
  // The catalog's default when it is offered, else the active service's
  // model, else the first one offered.
  const activeModel = providers.find(
    (provider) => provider.id === activeProviderId,
  )?.model;
  const fallback =
    (catalog?.defaultModel
      ? offered.find((choice) => choice.name === catalog.defaultModel)
      : undefined) ??
    offered.find(
      (choice) =>
        choice.providerId === activeProviderId && choice.name === activeModel,
    ) ??
    offered[0];
  return {
    legacy: rememberedModelLabel(conversation.model),
    providerId: fallback.providerId,
    model: fallback.name,
  };
}

/** The model menu's head line. */
export const retiredModelNotice = (legacy: string, current: string) =>
  formatText(
    "{legacyModel} is no longer available. New replies will use {defaultModel}.",
    { legacyModel: legacy, defaultModel: current },
  );
