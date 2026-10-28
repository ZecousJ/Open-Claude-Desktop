import type { PluginEntry } from "../../shared/collections-api";
import type { ApprovedDirectoryEntry } from "../../shared/directory-submissions";

/**
 * Discover's curated blocks: the entries are the marketplaces' real plugins;
 * which of them are featured, new or most installed is the Claudex directory's
 * curation. A curated entry names its plugin by slug (the plugin's marketplace
 * name); a featured block's members are directory entries (by id) or plugins
 * (`name@marketplace` or a name). A name two marketplaces share is not a match:
 * nothing is guessed.
 */
export interface PluginCuration {
  featured?: {
    plugins: PluginEntry[];
    title: string;
    subtitle: string;
    curator?: string;
  };
  newest: PluginEntry[];
  popular: PluginEntry[];
}

export const emptyCuration: PluginCuration = { newest: [], popular: [] };

export function pluginCuration(
  plugins: readonly PluginEntry[],
  directory: readonly ApprovedDirectoryEntry[] | undefined,
): PluginCuration {
  if (!directory?.length || !plugins.length) return emptyCuration;
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const byName = new Map<string, PluginEntry | null>();
  for (const plugin of plugins)
    byName.set(plugin.name, byName.has(plugin.name) ? null : plugin);
  const resolve = (key: string | undefined) =>
    key ? (byId.get(key) ?? byName.get(key) ?? undefined) : undefined;
  const entries = new Map(directory.map((entry) => [entry.id, entry]));
  const member = (id: string) => {
    const entry = entries.get(id);
    return entry
      ? entry.kind === "plugin"
        ? resolve(entry.slug)
        : undefined
      : resolve(id);
  };
  const curated = directory
    .filter((entry) => entry.kind === "plugin")
    .map((entry) => ({ entry, plugin: resolve(entry.slug) }));
  const unique = (list: (PluginEntry | undefined)[]) => [
    ...new Map(
      list
        .filter((plugin): plugin is PluginEntry => Boolean(plugin))
        .map((plugin) => [plugin.id, plugin]),
    ).values(),
  ];
  let featured: PluginCuration["featured"];
  for (const { entry, plugin } of curated) {
    const block = entry.curation?.featured;
    if (!block) continue;
    const members = unique(
      block.memberIds ? block.memberIds.map(member) : [plugin],
    );
    if (!members.length) continue;
    featured = {
      plugins: members,
      title: block.title,
      subtitle: block.subtitle,
      curator: block.curator,
    };
    break;
  }
  const newest = unique(
    curated
      .filter(({ entry }) => entry.curation?.isNew)
      .sort((a, b) => b.entry.added.localeCompare(a.entry.added))
      .map(({ plugin }) => plugin),
  );
  const popular = unique(
    curated
      .filter(({ entry }) => entry.curation?.popular)
      .map(({ plugin }) => plugin),
  );
  return { featured, newest, popular };
}
