/** Account-installed plugin inventory for the official readonly library.
 * Never promote an available marketplace listing into an installed plugin.
 * IDs are opaque, stable derivatives of the runtime's name@marketplace key;
 * filesystem paths and catalog diagnostics do not cross this wire boundary.
 */
import { createHash } from "node:crypto";
import type {
  PluginCatalog,
  PluginEntry,
} from "../../../shared/collections-api";

export function runtimePluginLibraryId(id: string) {
  return "plugin_" + createHash("sha256").update(id).digest("hex").slice(0, 24);
}

export function isPersonalRuntimePlugin(
  entry: PluginEntry,
  catalog: PluginCatalog,
) {
  return (
    (entry.personal === true && entry.source === "local") ||
    ((entry.source === "local" || entry.source === "git") &&
      catalog.marketplaces.some(
        (row) => row.name === entry.marketplace && row.userAdded === true,
      ))
  );
}

export function installedPluginLibrary(
  catalog: PluginCatalog,
  desktop = false,
) {
  if (
    !catalog ||
    !Array.isArray(catalog.plugins) ||
    !Array.isArray(catalog.marketplaces) ||
    !Array.isArray(catalog.loadErrors) ||
    catalog.plugins.length > 4096 ||
    catalog.marketplaces.length > 1024
  )
    throw Error("The installed plugin catalog is invalid.");
  if (catalog.loadErrors.length)
    throw Error(
      "Some plugin marketplaces could not be read. Retry when the catalog is available.",
    );
  const bounded = (value: unknown, max: number) =>
    typeof value === "string" &&
    value.length <= max &&
    Buffer.byteLength(value, "utf8") <= max;
  if (
    catalog.marketplaces.some(
      (m) =>
        !m ||
        !bounded(m.name, 512) ||
        (m.title !== undefined && !bounded(m.title, 1024)),
    )
  )
    throw Error("The plugin marketplace metadata is invalid.");
  let bytes = 0;
  const seen = new Set<string>();
  return catalog.plugins.flatMap((entry) => {
    if (!entry || typeof entry.installed !== "boolean")
      throw Error("The plugin installation state is invalid.");
    if (!entry.installed) return [];
    if (
      typeof entry.id !== "string" ||
      !entry.id ||
      typeof entry.name !== "string" ||
      !entry.name ||
      typeof entry.title !== "string" ||
      typeof entry.marketplace !== "string" ||
      !entry.marketplace ||
      typeof entry.enabled !== "boolean" ||
      (entry.personal !== undefined && typeof entry.personal !== "boolean") ||
      [entry.description, entry.developer, entry.installedVersion].some(
        (value) => value !== undefined && typeof value !== "string",
      )
    )
      throw Error("An installed plugin has invalid metadata.");
    if (
      !bounded(entry.id, 1024) ||
      !bounded(entry.name, 512) ||
      !bounded(entry.title, 1024) ||
      !bounded(entry.marketplace, 512) ||
      !bounded(entry.description ?? "", 20000) ||
      !bounded(entry.developer ?? "", 1024) ||
      !bounded(entry.installedVersion ?? "", 256)
    )
      throw Error("The installed plugin metadata is too large.");
    bytes += Buffer.byteLength(
      [
        entry.id,
        entry.name,
        entry.title,
        entry.marketplace,
        entry.description,
        entry.developer,
        entry.installedVersion,
      ].join(""),
      "utf8",
    );
    if (bytes > 1024 * 1024)
      throw Error("The installed plugin catalog is too large.");
    if (seen.has(entry.id))
      throw Error(
        "The plugin catalog contains duplicate installed identities.",
      );
    seen.add(entry.id);
    const id = runtimePluginLibraryId(entry.id);
    const mutable = desktop && isPersonalRuntimePlugin(entry, catalog);
    const own = entry.personal === true || mutable;
    return [
      {
        id,
        name: entry.name,
        display_name: entry.title || null,
        description: entry.description ?? null,
        // Listing versions are not proof of the installed version. Likewise,
        // marketplace sync time is not a plugin creation or installation time.
        version: entry.installedVersion ?? null,
        created_at: null,
        updated_at: null,
        plugin: {
          backend_id: id,
          partition_by: own ? "account" : "marketplace",
        },
        skill: null,
        provenance: {
          source: own ? "personal" : "default",
          author: entry.developer ?? null,
          marketplace_id: null,
          marketplace_name: entry.marketplace,
          marketplace_display_name:
            catalog.marketplaces.find(
              (marketplace) => marketplace.name === entry.marketplace,
            )?.title ?? null,
          marketplace_kind: own ? "account_marketplace" : "other_catalog",
          shared_via: null,
        },
        viewer: {
          added: true,
          installed: {
            enabled: entry.enabled,
            installation_preference: null,
            can_edit: false,
            can_remove: mutable,
            can_toggle: mutable,
            shared_by_you: false,
          },
          usage: null,
          own_usage: null,
        },
        install_count: null,
        content_scan: null,
        // Components are unknown to listPlugins; do not invent skill/tool lists.
      },
    ];
  });
}
