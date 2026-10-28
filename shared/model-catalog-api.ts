/**
 * The model catalog the administrator publishes (display names, badges,
 * efforts, context windows), already intersected with the models the gateway
 * lists for this device's key. Package C2 fills it; the model menus, the
 * context ring and web search / Research read it. Published fields keep their
 * types; new ones are added as optional fields.
 */
import type { Settings } from "./types";
import { bridgeMethods } from "./bridge-methods";

/** Reasoning efforts a catalog entry can offer, in the service's words. */
export type CatalogEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCatalogItem {
  /** The gateway's model id, as sent in requests. */
  id: string;
  displayName: string;
  description: string;
  /** Up to three short labels ("new", "beta", "legacy" have their own style). */
  badges: string[];
  sort: number;
  /** Listed under More models instead of the main menu (owner decision 11). */
  hidden: boolean;
  isDefault: boolean;
  /** Absent: the model takes no effort setting. */
  efforts?: CatalogEffort[];
  defaultEffort?: CatalogEffort;
  contextWindow?: number;
  /** Tokens after which the conversation is compacted automatically. */
  autoCompactTokens?: number;
  /**
   * @deprecated Fast mode was dropped (R6). The service no longer sends it,
   * the parser never sets it and nothing may read it; it stays optional only
   * so older objects still type-check.
   */
  fast?: boolean;
  /** A short usage note such as "1.5× usage"; empty for none. */
  usageHint: string;
  minimumDesktopVersion?: string;
  /**
   * How the model searches the web through the gateway: "native" (the
   * upstream's own search tool) or "none". Absent: the service did not say
   * (an older service, or a model the catalog does not list).
   */
  webSearch?: "native" | "none";
  /** The model can also search X (grok); only with `webSearch` "native". */
  xSearch?: boolean;
  /**
   * The service group whose device key serves the model (MG): an account
   * with several groups sends each model to its own group. Absent from an
   * older service or for a single group.
   */
  groupId?: number;
}

export interface ModelCatalog {
  desktopVersion?: string;
  /** The administrator's default when the gateway lists it. */
  defaultModel: string | null;
  items: ModelCatalogItem[];
}

export interface ModelCatalogAPI {
  /** null without a service catalog (local accounts, older services). */
  modelCatalog(): Promise<ModelCatalog | null>;
  /**
   * Asks the Sub2API service for the plan's models again (a balance or plan
   * fixed since sign-in); null for local accounts.
   */
  refreshModels(): Promise<{
    settings: Settings;
    /** Why there is still no model, when there is none. */
    reason?: string;
  } | null>;
}

export const modelCatalogMethods = bridgeMethods<ModelCatalogAPI>({
  modelCatalog: true,
  refreshModels: true,
});

/** An administrator's catalog before it meets the gateway's model list. */
export interface ServiceCatalog {
  defaultModel: string | null;
  items: ModelCatalogItem[];
}

/**
 * The catalog for the models the gateway lists for this device's key
 * (design 2.4): catalog entries the gateway does not list are dropped,
 * listed models without an entry are dropped too (the administrator hid
 * them), `hidden` entries stay (they go under More models). The default
 * is the administrator's when listed,
 * else the first entry in catalog order (a visible one first), else the
 * gateway's first model.
 */
/**
 * Models that can't hold a conversation (image, video, speech, embedding):
 * the service lists them for its API, the model menus leave them out.
 */
export function isConversationModel(id: string) {
  return !/(^|[-_/])(image|imagine|video|dall-e|tts|whisper|transcribe|embedding|embed|moderation)([-_./]|$)|^gpt-image/i.test(
    id,
  );
}

/**
 * GPT's image models: the model menu offers them under "Images", and a
 * conversation with one of them is answered with a picture
 * (electron/gateway.ts). Other image and video models stay out of the menus.
 */
export function isDrawingModel(id: string) {
  return /^gpt-image-/i.test(id);
}

export function catalogForModels(
  catalog: ServiceCatalog | null | undefined,
  gatewayModels: string[],
): { catalog: ModelCatalog | null; models: string[]; defaultModel: string } {
  const listed = [...new Set(gatewayModels)].filter(
    (id) => isConversationModel(id) || isDrawingModel(id),
  );
  // A new conversation never starts with a picture model.
  const talks = (id: string | null | undefined) =>
    Boolean(id) && !isDrawingModel(id!);
  if (!catalog)
    return {
      catalog: null,
      models: listed,
      defaultModel: listed.find(talks) ?? listed[0] ?? "",
    };
  const available = new Set(listed);
  const seen = new Set<string>();
  const known = catalog.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      if (!available.has(item.id) || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => a.item.sort - b.item.sort || a.index - b.index)
    .map(({ item }) => item);
  // A listed model the catalog leaves out is one the administrator hid (the
  // service lists every model a group offers, placed or not): it is not
  // offered. A catalog that names none of them leaves the gateway's list, by
  // id.
  const items: ModelCatalogItem[] = known.length
    ? known
    : listed.map((id, index) => ({
        id,
        displayName: id,
        description: "",
        badges: [],
        sort: index,
        hidden: false,
        isDefault: false,
        usageHint: "",
      }));
  const defaultModel =
    (catalog.defaultModel &&
    available.has(catalog.defaultModel) &&
    talks(catalog.defaultModel)
      ? catalog.defaultModel
      : undefined) ??
    known.find((item) => !item.hidden && talks(item.id))?.id ??
    known.find((item) => talks(item.id))?.id ??
    listed.find(talks) ??
    listed[0] ??
    "";
  return {
    catalog: {
      defaultModel: defaultModel || null,
      items: items.map((item) => ({
        ...item,
        displayName: item.displayName || item.id,
        isDefault: item.id === defaultModel,
      })),
    },
    models: items.map((item) => item.id),
    defaultModel,
  };
}
