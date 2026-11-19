import { z } from "zod";
import { organizationCatalogQuery, organizationCatalogResponse, type OrganizationRuntimeStates } from "./official-organization-catalog";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const id = z.string().regex(new RegExp("^" + uuid + "$", "i"));
const name = z.string().trim().min(1).max(200);
const organizations = z.array(z.object({
  id,
  name,
  role: z.enum(["member", "admin"]),
})).max(200);
const marketplaces = z.array(z.object({
  id,
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  display_name: name,
})).max(200);

const membershipsPath = "/api/claudex/plugin-organizations";
const marketplacesPath = new RegExp(
  "^/api/organizations/(" + uuid + ")/marketplaces/list-org-marketplaces$",
  "i",
);
const discoveryPath = new RegExp("^/api/organizations/(" + uuid + ")/library/discover/(home|browse)$", "i");
const mutationPath = new RegExp(`^/api/organizations/(${uuid})/plugins/(plugin_[a-f0-9]{24})(/enabled)?\\?source=organization$`);

export function officialOrganizationPluginMutation(method: string, path: string) {
  const match = mutationPath.exec(path);
  if (!match) return undefined;
  if (method === "PUT" && match[3]) return { kind: "enable", organization: match[1], id: match[2] } as const;
  if (method === "DELETE" && !match[3]) return { kind: "remove", organization: match[1], id: match[2] } as const;
}

export function officialPluginOrganizationTarget(method: string, pathname: string, search = "") {
  if (method !== "GET") return undefined;
  if (pathname === membershipsPath) return { kind: "memberships" } as const;
  const organization = marketplacesPath.exec(pathname)?.[1];
  if (organization) return { kind: "marketplaces", organization } as const;
  const discovery = discoveryPath.exec(pathname);
  if (discovery) {
    const view = discovery[2] === "home" ? "home" : "browse";
    if (view === "home" || new URLSearchParams(search).get("source") === "organization")
      return { kind: "catalog", organization: discovery[1], view } as const;
  }
}

export type OfficialPluginOrganizationTarget = NonNullable<ReturnType<typeof officialPluginOrganizationTarget>>;
export const pluginOrganizationNotFoundCode = "CLAUDEX_PLUGIN_ORGANIZATION_NOT_FOUND";

export function pluginOrganizationServicePath(target: OfficialPluginOrganizationTarget) {
  if (target.kind === "catalog") return "/claudex/plugin-organization-catalog";
  const base = "/claudex/plugin-organizations";
  return target.kind === "memberships"
    ? base
    : base + "/" + id.parse(target.organization).toLowerCase() + "/marketplaces";
}

export function pluginOrganizationResponse(target: OfficialPluginOrganizationTarget, value: unknown, search = "", desktop?: OrganizationRuntimeStates) {
  if (target.kind === "catalog") {
    const query = organizationCatalogQuery(target.view, search);
    if (!query) throw Error("Invalid organization catalog query.");
    return organizationCatalogResponse(target.view, query, value, desktop);
  }
  const parsed = (target.kind === "memberships" ? organizations : marketplaces).parse(value);
  if (new Set(parsed.map((row) => row.id.toLowerCase())).size !== parsed.length)
    throw Error("Duplicate organization marketplace identity.");
  return target.kind === "memberships" ? { organizations: parsed } : { marketplaces: parsed };
}

export function validPluginOrganizationQuery(target: OfficialPluginOrganizationTarget, search: string) {
  return target.kind === "catalog" ? !!organizationCatalogQuery(target.view, search) : search === "";
}

export function pluginOrganizationRefusal(status: number) {
  const error = status === 400
    ? { type: "invalid_request_error", message: "Invalid organization marketplace request." }
    : status === 404
    ? { type: "not_found_error", message: "Organization not found." }
    : status === 401
      ? { type: "authentication_error", message: "Sign in to continue." }
      : status === 409
        ? { type: "account_changed", message: "The active account changed." }
        : { type: "organization_marketplaces_unavailable", message: "Organization marketplaces are unavailable." };
  return { error };
}
