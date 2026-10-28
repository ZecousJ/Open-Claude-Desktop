import type { ChatEffort, Provider } from "../../../shared/types";
import type {
  ModelCatalog,
  ModelCatalogItem,
} from "../../../shared/model-catalog-api";
import { chatEffortLevels } from "../../../shared/chat-effort";
import { onForgetAccountData } from "../../app/forget-account-data";
import { isDrawingModel } from "../../../shared/model-catalog-api";
import { compareVersions } from "../../../shared/client-policy-rules";

export type CodeModelChoice = {
  providerId: string;
  name: string;
  /** The catalog's display name; the model id without a catalog. */
  label?: string;
  description?: string;
  badges?: string[];
  updateRequired?: boolean;
};

/**
 * Model ids a provider offers, its default first. Picture models are not the
 * model menus'.
 */
const providerModels = (provider: Provider) =>
  [...new Set([provider.model, ...provider.models])].filter(
    (id) => id && !isDrawingModel(id),
  );

/**
 * The administrator's catalog laid over the providers' models (C2 already
 * intersected it with the gateway's list): catalog entries in their order,
 * `hidden` ones under More models (owner decision 11), and any model the
 * gateway lists that the catalog leaves out also under More models, by id.
 * Without a catalog every model is listed by id, as before.
 */
export function catalogChoices(
  providers: Provider[],
  catalog: ModelCatalog | null | undefined,
) {
  const all: CodeModelChoice[] = providers.flatMap((provider) =>
    providerModels(provider).map((name) => ({
      providerId: provider.id,
      name,
    })),
  );
  if (!catalog?.items.length)
    return { listed: all, more: [] as CodeModelChoice[], catalogued: false };
  const items = [...catalog.items].sort((a, b) => a.sort - b.sort);
  const byId = new Map<string, ModelCatalogItem>(items.map((i) => [i.id, i]));
  const described = (choice: CodeModelChoice): CodeModelChoice => {
    const item = byId.get(choice.name);
    return item
      ? {
          ...choice,
          label: item.displayName || item.id,
          description: item.description || undefined,
          badges: item.badges.slice(0, 3),
          updateRequired: desktopModelUpdateRequired(
            catalog.desktopVersion,
            item.minimumDesktopVersion,
          ),
        }
      : choice;
  };
  const order = (choice: CodeModelChoice) => {
    const index = items.findIndex((i) => i.id === choice.name);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  const inCatalog = all
    .filter((c) => byId.has(c.name))
    .sort((a, b) => order(a) - order(b));
  return {
    listed: inCatalog.filter((c) => !byId.get(c.name)!.hidden).map(described),
    more: [
      ...inCatalog.filter((c) => byId.get(c.name)!.hidden).map(described),
      ...all.filter((c) => !byId.has(c.name)),
    ],
    catalogued: true,
  };
}

// .
export function desktopModelUpdateRequired(current?: string, minimum?: string) {
  if (!current || !minimum) return false;
  const valid = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
  return (
    !valid.test(current) ||
    !valid.test(minimum) ||
    compareVersions(current, minimum) < 0
  );
}

/** Models the menu lists before More models without a catalog (claude.ai lists four). */
export const quickModelCount = 4;

export function codeModelChoices(
  providers: Provider[],
  providerId: string,
  model: string,
  catalog?: ModelCatalog | null,
) {
  const cataloguedChoices = catalogChoices(providers, catalog);
  // The selected model remains enabled.
  const selectable = (choice: CodeModelChoice) =>
    choice.providerId === providerId && choice.name === model
      ? { ...choice, updateRequired: false }
      : choice;
  const listed = cataloguedChoices.listed.map(selectable);
  const more = cataloguedChoices.more.map(selectable);
  const { catalogued } = cataloguedChoices;
  const same = (a: CodeModelChoice, b: CodeModelChoice) =>
    a.providerId === b.providerId && a.name === b.name;
  const current = { providerId, name: model };
  if (catalogued) {
    // The catalog decides: every model the administrator put in the main menu
    // is listed there, in its order, the rest under More models. A current
    // choice from More models is shown first so the checked row stays visible.
    const all = [...listed, ...more];
    const chosen = all.find((c) => same(c, current));
    const quick =
      chosen && !listed.includes(chosen) ? [chosen, ...listed] : listed;
    return { quick, more: all.filter((c) => !quick.includes(c)) };
  }
  const selected = listed.find((c) => same(c, current));
  const quick = [
    ...(selected ? [selected] : []),
    ...listed.filter((choice) => choice !== selected),
  ].slice(0, quickModelCount);
  return { quick, more: listed.filter((choice) => !quick.includes(choice)) };
}

/**
 * The names the last catalog gave, kept in this browser: before the catalog
 * arrives the button shows the name, not the id.
 */
const labelsKey = "claudex.modelLabels";
let knownLabels: Record<string, string> | undefined;
function rememberedLabels(): Record<string, string> {
  if (!knownLabels) {
    try {
      const raw = JSON.parse(localStorage.getItem(labelsKey) ?? "{}");
      knownLabels = raw && typeof raw === "object" ? raw : {};
    } catch {
      knownLabels = {};
    }
  }
  return knownLabels!;
}
onForgetAccountData(() => {
  knownLabels = undefined;
});
function rememberLabel(model: string, label: string) {
  const labels = rememberedLabels();
  if (labels[model] === label) return;
  labels[model] = label;
  try {
    localStorage.setItem(labelsKey, JSON.stringify(labels));
  } catch {
    /* the name is only a convenience */
  }
}

/**
 * The name a model last had in a catalog, else its id: for a model the
 * catalog no longer lists (src/composer/retired-model.ts).
 */
export function rememberedModelLabel(model: string) {
  return rememberedLabels()[model] || model;
}

/** A model's name as the menus and buttons show it. */
export function modelLabel(
  catalog: ModelCatalog | null | undefined,
  model: string,
) {
  const name = catalog?.items.find((i) => i.id === model)?.displayName;
  if (name) {
    rememberLabel(model, name);
    return name;
  }
  return (!catalog && rememberedLabels()[model]) || model;
}

/**
 * Chat efforts the model accepts (the catalog's `efforts`, which the service
 * already limited to the group's ceiling); every level without a catalog
 * entry. `max` stays available only when the model offers it.
 */
export function chatEffortsFor(
  catalog: ModelCatalog | null | undefined,
  model: string,
): readonly ChatEffort[] {
  const efforts = catalog?.items.find((i) => i.id === model)?.efforts;
  if (!efforts) return chatEffortLevels;
  const offered = chatEffortLevels.filter((level) => efforts.includes(level));
  return offered.length ? offered : chatEffortLevels;
}

/** The catalog's default effort for a model, when it names a Chat level. */
export function catalogDefaultEffort(
  catalog: ModelCatalog | null | undefined,
  model: string,
): ChatEffort | undefined {
  const value = catalog?.items.find((i) => i.id === model)?.defaultEffort;
  return chatEffortLevels.find((level) => level === value);
}

/**
 * The service's model catalog (null for local accounts and services without
 * one). One implementation for every menu and model button: it remembers
 * the last catalog, so a menu opening draws the catalog at once instead of
 * its no-catalog state first.
 */
export { useModelCatalog, useModelCatalogState } from "../useComposerServices";

/** A model's maker, for the model menu's provider switch. */
export type ModelVendor = { id: string; name: string };

const vendorPatterns: [RegExp, ModelVendor][] = [
  [/^(gpt|chatgpt|codex|o\d)/i, { id: "openai", name: "OpenAI" }],
  [/^claude/i, { id: "anthropic", name: "Messages API" }],
  // Composer reaches Claudex through xAI (Grok Build).
  [/^(grok|composer)/i, { id: "xai", name: "xAI" }],
  [/^gemini/i, { id: "gemini", name: "Google" }],
  [/^qwen/i, { id: "qwen", name: "Qwen" }],
  [/^deepseek/i, { id: "deepseek", name: "DeepSeek" }],
];
const otherVendor: ModelVendor = { id: "other", name: "Other" };

/** Who makes the model, from its id (Other when unknown). */
export function modelVendor(model: string): ModelVendor {
  const id = model.replace(/^.*\//, "");
  return (
    vendorPatterns.find(([pattern]) => pattern.test(id))?.[1] ?? otherVendor
  );
}

/** The makers of the choices, in the order their first model appears. */
export function choiceVendors(choices: CodeModelChoice[]): ModelVendor[] {
  const seen = new Map<string, ModelVendor>();
  for (const choice of choices) {
    const vendor = modelVendor(choice.name);
    if (!seen.has(vendor.id)) seen.set(vendor.id, vendor);
  }
  return [...seen.values()];
}
