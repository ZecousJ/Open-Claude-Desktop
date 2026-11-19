import { z } from "zod";

const rowSchema = z.object({
  id: z.string().regex(/^plugin_[a-f0-9]{24}$/),
  marketplace_id: z.guid(),
  marketplace_display_name: z.string().min(1).max(200),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/),
  display_name: z.string().min(1).max(200),
  description: z.string().max(1000),
  version: z.string().max(100),
  installation_preference: z.enum(["available", "auto_install", "required"]),
  package_available: z.boolean().optional(),
});
export function checkedOrganizationCatalog(value: unknown) {
  const rows = z.array(rowSchema).max(1000).parse(value);
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw Error("Duplicate organization plugin identity.");
  return rows;
}
export const organizationRuntimeCandidates = z.array(rowSchema.pick({
  id: true,
  marketplace_id: true,
  name: true,
})).max(1000);
export type OrganizationRuntimeCandidates = z.infer<typeof organizationRuntimeCandidates>;
export type OrganizationRuntimeStates = Record<string, { enabled: boolean }>;

const catalogQuery = z.object({
  source: z.literal("organization"),
  q: z.string().max(200).default(""),
  marketplace_id: z.guid().optional(),
  sort: z.enum(["name", "installs"]).optional(),
  limit: z.string().regex(/^(?:[1-9][0-9]{0,2}|1000)$/).default("50"),
  cursor: z.string().regex(/^[0-9]{1,4}$/).default("0"),
  include_added: z.enum(["true", "false"]).optional(),
}).strict();

export function organizationCatalogQuery(view: "home" | "browse", search: string) {
  if (view === "home") return search ? undefined : { q: "", start: 0, limit: 12, plugins: true };
  const params = new URLSearchParams(search);
  const kinds = params.getAll("kind");
  params.delete("kind");
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size || kinds.some((kind) => kind !== "plugin" && kind !== "skill"))
    return undefined;
  const parsed = catalogQuery.safeParse(Object.fromEntries(params));
  if (!parsed.success) return undefined;
  const { q, marketplace_id, cursor, limit } = parsed.data;
  return {
    q,
    marketplace: marketplace_id,
    start: Number(cursor),
    limit: Number(limit),
    plugins: kinds.length === 0 || kinds.includes("plugin"),
  };
}

function catalogItem(
  row: z.infer<typeof rowSchema>,
  desktop: OrganizationRuntimeStates | undefined,
) {
  const installed = desktop?.[row.id];
  const canInstall = desktop !== undefined && row.package_available === true && row.installation_preference === "available";
  const canToggle = !!installed && row.package_available === true && row.installation_preference !== "required";
  return {
    id: row.id,
    name: row.name,
    display_name: row.display_name,
    description: row.description,
    version: row.version || null,
    updated_at: null,
    claudex_organization_catalog_only: !canInstall,
    ...((canInstall || canToggle) && { claudex_organization_plugin: true }),
    plugin: { backend_id: row.id, partition_by: "organization" },
    skill: null,
    provenance: {
      source: "organization",
      marketplace_id: row.marketplace_id,
      marketplace_name: "org-" + row.marketplace_id + "-" + row.id.slice(7),
      marketplace_display_name: row.marketplace_display_name,
      marketplace_kind: "org_marketplace",
    },
    viewer: {
      added: installed !== undefined,
      installed: installed ? {
        ...installed,
        installation_preference: row.installation_preference,
        can_toggle: canToggle,
        can_remove: canInstall,
      } : null,
    },
  };
}

export function installedOrganizationPluginItems(value: unknown, states: OrganizationRuntimeStates) {
  return checkedOrganizationCatalog(value)
    .filter((row) => states[row.id] !== undefined)
    .map((row) => catalogItem(row, states));
}

export function organizationCatalogResponse(
  view: "home" | "browse",
  query: NonNullable<ReturnType<typeof organizationCatalogQuery>>,
  value: unknown,
  desktop?: OrganizationRuntimeStates,
) {
  const catalog = checkedOrganizationCatalog(value);
  const search = query.q.trim().toLowerCase();
  const matching = query.plugins ? catalog.filter((row) =>
    (!query.marketplace || row.marketplace_id === query.marketplace) &&
    (!search || [row.name, row.display_name, row.description].some((text) => text.toLowerCase().includes(search))),
  ) : [];
  const items = matching.slice(query.start, query.start + query.limit).map((row) => catalogItem(row, desktop));
  if (view === "home")
    return {
      blocks: items.length ? [{
        kind: "items",
        key: "from_your_organization",
        items,
        see_all: { source: "organization", sort: "installs" },
      }] : [],
      facets: { sources: matching.length ? [{ source: "organization" }] : [] },
    };
  return {
    items,
    next_cursor: query.start + query.limit < matching.length ? String(query.start + query.limit) : null,
    facets: { sources: matching.length ? [{ source: "organization" }] : [] },
  };
}
