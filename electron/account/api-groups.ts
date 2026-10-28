import {
  apiProviderDefs,
  apiProviderOf,
  type ApiGroups,
  type ApiImages,
  type ApiProvider,
} from "../../shared/api-keys-api";
import {
  isDrawingModel,
  type ModelCatalog,
} from "../../shared/model-catalog-api";

/** A service group this account holds a key for (the plan group first). */
export interface ServiceGroup {
  id: number;
  name: string;
  primary: boolean;
  protocol: "responses" | "chat";
  /** The service's platform of the group: openai, grok, anthropic, … */
  platform: string;
  /**
   * The models the group's own key lists, when they are known: a model can
   * be listed by several groups. Without them a model belongs to the group
   * its catalog item names.
   */
  models?: readonly string[];
  /**
   * A group that only draws: never offered on the API page or chosen for a
   * provider; its models are always in the menus, under Images.
   */
  drawing?: boolean;
}

/** A group whose key lists only GPT's image models. */
export function drawsOnly(models: readonly string[] | undefined) {
  return Boolean(models?.length) && models!.every(isDrawingModel);
}

/** Provider id → the group chosen for it (the `apiGroups` setting). */
export type GroupChoices = Readonly<Record<string, number>>;

/** The group in use for each provider that has one: the choice, else the plan group, else the first. */
export function activeGroups(
  groups: readonly ServiceGroup[],
  choices: GroupChoices,
): Map<string, ServiceGroup> {
  const byProvider = new Map<string, ServiceGroup[]>();
  for (const group of groups) {
    if (group.drawing) continue;
    const id = apiProviderOf(group.platform).id;
    byProvider.set(id, [...(byProvider.get(id) ?? []), group]);
  }
  const active = new Map<string, ServiceGroup>();
  for (const [id, list] of byProvider)
    active.set(
      id,
      list.find((group) => group.id === choices[id]) ??
        list.find((group) => group.primary) ??
        list[0]!,
    );
  return active;
}

/** The ids of the groups in use, one per provider. */
export function activeGroupIds(
  groups: readonly ServiceGroup[],
  choices: GroupChoices,
): number[] {
  return [...activeGroups(groups, choices).values()].map((group) => group.id);
}

/**
 * Whether a catalog item is one of the group's models: the catalog names
 * the group (it lists each group's models, also ones its key's /v1/models
 * leaves out, such as an OpenAI group's pinned Codex manifest), or the
 * group's key lists the model (a model several groups serve).
 */
function inGroup(
  item: { id: string; groupId?: number },
  group: ServiceGroup,
  groups: readonly ServiceGroup[],
) {
  if (item.groupId !== undefined && item.groupId === group.id) return true;
  if (group.models) return group.models.includes(item.id);
  return (
    (item.groupId ?? groups.find((other) => other.primary)?.id) === group.id
  );
}

/**
 * The catalog as the menus list it: only the models of the group in use for
 * each provider. One group (or none) leaves it whole. The administrator's
 * default stays when a group in use serves it; otherwise the first shown
 * model is the default.
 */
export function catalogInGroup(
  catalog: ModelCatalog | null,
  groups: readonly ServiceGroup[],
  choices: GroupChoices,
): ModelCatalog | null {
  if (!catalog || groups.length < 2) return catalog;
  const use = [
    ...activeGroups(groups, choices).values(),
    ...groups.filter((group) => group.drawing),
  ];
  const items = catalog.items.filter((item) =>
    use.some((group) => inGroup(item, group, groups)),
  );
  const listed = (id: string | null) => items.some((item) => item.id === id);
  const defaultModel = listed(catalog.defaultModel)
    ? catalog.defaultModel
    : ((
        items.find(
          (item) => item.isDefault && !item.hidden && !isDrawingModel(item.id),
        ) ??
        items.find((item) => !item.hidden && !isDrawingModel(item.id)) ??
        items[0]
      )?.id ?? null);
  return { ...catalog, defaultModel, items };
}

/**
 * The drawing group's image models in catalog order (the administrator puts
 * the default first) and the one pictures are made with: the setting while
 * the group serves it, else the first. Undefined without a drawing group.
 */
export function imagesFor(
  catalog: ModelCatalog | null,
  groups: readonly ServiceGroup[],
  setting: string | undefined,
): ApiImages | undefined {
  const group = groups.find((item) => item.drawing);
  if (!group) return undefined;
  const listed = group.models ?? [];
  const named = (catalog?.items ?? []).filter(
    (item) => isDrawingModel(item.id) && listed.includes(item.id),
  );
  const models = [
    ...named.map((item) => ({
      id: item.id,
      name: item.displayName || item.id,
    })),
    ...listed
      .filter(
        (id) => isDrawingModel(id) && !named.some((item) => item.id === id),
      )
      .map((id) => ({ id, name: id })),
  ];
  if (!models.length) return undefined;
  const selected = models.some((model) => model.id === setting)
    ? setting!
    : models[0]!.id;
  return { groupId: group.id, models, selected };
}

/**
 * The providers the API page lists (those the account has a group of: the
 * well-known ones first, then any other platform), each with its groups and
 * how many models every group serves.
 */
export function apiGroupsFor(
  catalog: ModelCatalog | null,
  groups: readonly ServiceGroup[],
  choices: GroupChoices,
  imageModel?: string,
): ApiGroups {
  const listOf = (group: ServiceGroup) =>
    (catalog?.items ?? [])
      .filter((item) => inGroup(item, group, groups))
      .map((item) => ({ id: item.id, name: item.displayName || item.id }));
  const all = groups
    .filter((group) => !group.drawing)
    .map((group) => ({
      id: group.id,
      name: group.name,
      models: listOf(group).length,
      modelList: listOf(group),
      primary: group.primary,
      protocol: group.protocol,
      platform: group.platform,
    }));
  const active = activeGroups(groups, choices);
  const known = apiProviderDefs.map(({ id, name }) => ({ id, name }));
  const extra = all
    .map((group) => apiProviderOf(group.platform))
    .filter(
      (provider, index, list) =>
        !known.some((item) => item.id === provider.id) &&
        list.findIndex((other) => other.id === provider.id) === index,
    );
  // Only the providers the account has a group of, the well-known ones first.
  const providers: ApiProvider[] = [...known, ...extra]
    .map((provider) => ({
      ...provider,
      groups: all.filter(
        (group) => apiProviderOf(group.platform).id === provider.id,
      ),
      selected: active.get(provider.id)?.id ?? null,
    }))
    .filter((provider) => provider.groups.length > 0);
  const images = imagesFor(catalog, groups, imageModel);
  return { groups: all, providers, ...(images ? { images } : {}) };
}
