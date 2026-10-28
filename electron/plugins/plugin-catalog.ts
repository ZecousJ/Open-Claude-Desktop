import type {
  PluginCatalog,
  PluginDetails,
  PluginEntry,
  PluginMarketplace,
} from "../../shared/collections-api";
import { samePath } from "./plugin-copy";

import { text } from "./plugins-support";

/**
 * The runtime's plugin list as the pages show it, plugins by name. With
 * `personalFile` (the personal marketplace this computer's home folder
 * keeps), its local plugins are marked `personal`: the person's own, which
 * Rename offers.
 */
export function pluginCatalog(
  response: any,
  personalFile?: string,
): PluginCatalog {
  const marketplaces: PluginMarketplace[] = [];
  const plugins: PluginEntry[] = [];
  for (const marketplace of response?.marketplaces ?? []) {
    const name = text(marketplace?.name, 200);
    const path = text(marketplace?.path, 1000) ?? "";
    if (!name) continue;
    const list: any[] = Array.isArray(marketplace.plugins)
      ? marketplace.plugins
      : [];
    const personal = personalFile !== undefined && samePath(path, personalFile);
    marketplaces.push({
      name,
      path,
      plugins: list.length,
      ...(marketplace.sourceType === "manual" ? { source: "manual" } : {}),
      ...(text(marketplace.interface?.displayName, 200)
        ? { title: text(marketplace.interface.displayName, 200) }
        : {}),
    });
    for (const plugin of list) {
      const id = text(plugin?.id, 400);
      const pluginName = text(plugin?.name, 200);
      if (!id || !pluginName) continue;
      const face = plugin.interface ?? {};
      const source = plugin.source?.type;
      plugins.push({
        id,
        name: pluginName,
        title: text(face.displayName, 200) ?? pluginName,
        marketplace: name,
        marketplacePath: path,
        installed: plugin.installed === true,
        enabled: plugin.enabled === true,
        installable:
          plugin.availability !== "DISABLED_BY_ADMIN" &&
          plugin.installPolicy !== "NOT_AVAILABLE",
        source:
          source === "git" ? "git" : source === "local" ? "local" : "other",
        ...(personal && source === "local" ? { personal: true } : {}),
        ...(text(face.shortDescription ?? face.longDescription, 600)
          ? {
              description: text(
                face.shortDescription ?? face.longDescription,
                600,
              ),
            }
          : {}),
        ...(text(face.developerName, 200)
          ? { developer: text(face.developerName, 200) }
          : {}),
        ...(text(face.category, 100)
          ? { category: text(face.category, 100)!.toLowerCase() }
          : {}),
        ...(text(face.websiteUrl, 500)
          ? { website: text(face.websiteUrl, 500) }
          : {}),
        // A remote marketplace advertises `version`; a git or local one
        // only has the manifest's (`localVersion`).
        ...(text(plugin.version ?? plugin.localVersion, 100)
          ? {
              availableVersion: text(
                plugin.version ?? plugin.localVersion,
                100,
              ),
            }
          : {}),
      });
    }
  }
  const loadErrors = (response?.marketplaceLoadErrors ?? [])
    .map((error: any) => text(error?.message, 300))
    .filter((message: string | undefined): message is string => !!message);
  plugins.sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
  );
  return { marketplaces, plugins, loadErrors };
}

/** What `plugin/read` says about one plugin. */
export function pluginDetails(response: any): PluginDetails {
  const plugin = response?.plugin ?? {};
  const named = (list: unknown) =>
    (Array.isArray(list) ? list : [])
      .map((item: any) => ({
        name:
          typeof item === "string"
            ? (text(item, 200) ?? "")
            : (text(item?.name ?? item?.displayName ?? item?.id, 200) ?? ""),
        ...(text(item?.description ?? item?.shortDescription, 400)
          ? {
              description: text(
                item?.description ?? item?.shortDescription,
                400,
              ),
            }
          : {}),
      }))
      .filter((item) => item.name)
      .slice(0, 100);
  return {
    description: text(plugin.description, 4000) ?? "",
    skills: named(plugin.skills),
    apps: named(plugin.apps),
    mcpServers: named(plugin.mcpServers),
    hooks: Array.isArray(plugin.hooks) ? plugin.hooks.length : 0,
  };
}

/**
 * A marketplace to add: a GitHub `owner/repo` or an https repository
 * address. Local paths, file: and ssh addresses are refused, so a page
 * cannot make the runtime read other folders or use other people's keys.
 */
export function marketplaceSource(value: unknown): string {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) throw new Error("Enter a GitHub repository or a Git URL.");
  if (ownerRepo.test(source)) return source.replace(/\.git$/, "");
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error(
      "Use a GitHub owner/repo or an https:// address of a Git repository.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !url.hostname
  )
    throw new Error(
      "Use a GitHub owner/repo or an https:// address of a Git repository.",
    );
  if (source.length > 500) throw new Error("That address is too long.");
  return url.toString();
}

export const ownerRepo =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})\/[A-Za-z0-9._-]{1,100}$/;
