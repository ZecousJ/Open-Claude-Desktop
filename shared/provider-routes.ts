/**
 * Accounts with several service groups (MG): the Sub2API service gives a
 * device one key per group the account may use, so the model menu offers
 * the models of every group and each request goes out with the key (and
 * protocol) of its model's group. A single group keeps the provider's own
 * key and protocol, exactly as before.
 */
import type { Protocol, Provider, ProviderRoute } from "./types";
import type { ServiceCatalog } from "./model-catalog-api";

/** The key vault entry of a group's device key, next to the provider's own. */
export function groupKeyId(providerId: string, groupId: number) {
  return `${providerId}:g${groupId}`;
}

/** The group that serves a model, when the provider has several. */
export function routeForModel(
  provider: Pick<Provider, "routes">,
  model: string | undefined,
): ProviderRoute | undefined {
  if (!model || !provider.routes?.length) return undefined;
  return provider.routes.find((route) => route.models.includes(model));
}

/** How the gateway talks to the service for a model. */
export function modelProtocol(
  provider: Pick<Provider, "protocol" | "routes">,
  model: string | undefined,
): Protocol {
  return routeForModel(provider, model)?.protocol ?? provider.protocol;
}

/** Every model of the provider goes out over the Responses protocol. */
export function allResponses(provider: Pick<Provider, "protocol" | "routes">) {
  return (
    provider.protocol === "responses" &&
    (provider.routes ?? []).every((route) => route.protocol === "responses")
  );
}

/** The vault entries of a provider: its own and its groups' keys. */
export function providerKeyIds(provider: Pick<Provider, "id" | "routes">) {
  return [
    ...new Set([
      provider.id,
      ...(provider.routes ?? []).map((route) => route.keyId),
    ]),
  ];
}

/** One group's key and the models the gateway listed for it. */
export interface GroupModels {
  groupId: number;
  groupName: string;
  protocol: Protocol;
  keyId: string;
  primary: boolean;
  models: string[];
}

/**
 * Which group serves each model, when several list it: the group in use
 * (`preferred`, chosen on the API page) when it lists the model, else the
 * group the service's catalog names for it (when that group lists it), else
 * the plan group, else the smallest group id. Returns the models of all
 * groups (the plan group's first) and the routes with the models each one
 * serves.
 */
export function mergeGroupModels(
  groups: GroupModels[],
  catalog: ServiceCatalog | null | undefined,
  preferred: number | readonly number[] = [],
): { models: string[]; routes: ProviderRoute[] } {
  const preferredIds = typeof preferred === "number" ? [preferred] : preferred;
  const ordered = [...groups].sort(
    (a, b) => Number(b.primary) - Number(a.primary) || a.groupId - b.groupId,
  );
  const tagged = new Map<string, number>();
  for (const item of catalog?.items ?? [])
    if (item.groupId !== undefined && !tagged.has(item.id))
      tagged.set(item.id, item.groupId);
  const owner = new Map<string, number>();
  const models: string[] = [];
  for (const group of ordered)
    for (const model of group.models) {
      if (owner.has(model)) continue;
      const listing = ordered.filter((g) => g.models.includes(model));
      const named = tagged.get(model);
      const chosen =
        listing.find((g) => preferredIds.includes(g.groupId)) ??
        listing.find((g) => g.groupId === named) ??
        listing.find((g) => g.primary) ??
        listing[0]!;
      owner.set(model, chosen.groupId);
      models.push(model);
    }
  const routes = ordered.map((group): ProviderRoute => ({
    groupId: group.groupId,
    groupName: group.groupName,
    protocol: group.protocol,
    keyId: group.keyId,
    primary: group.primary,
    models: models.filter((model) => owner.get(model) === group.groupId),
  }));
  return { models, routes };
}
