import type { PluginEntry } from "../../shared/collections-api";
import { formatText, t } from "../i18n";
import type { DirectoryIcon } from "../../shared/directory-icon";

/** The marketplace Claudex offers by name (Anthropic's). */
export const officialMarketplace = {
  name: "claude-plugins-official",
  source: "anthropics/claude-plugins-official",
};

const words: Record<string, string> = {
  api: "API",
  apis: "APIs",
  ai: "AI",
  ci: "CI",
  cd: "CD",
  devops: "DevOps",
  ui: "UI",
  ux: "UX",
  sql: "SQL",
  mcp: "MCP",
  seo: "SEO",
};

/** "developer-tools" → "Developer tools", "api" → "API". */
export function categoryLabel(category: string): string {
  const spaced = category.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Other";
  const label = spaced
    .split(" ")
    .map((word) => words[word.toLowerCase()] ?? word)
    .join(" ");
  return label[0].toUpperCase() + label.slice(1);
}

const icons: [RegExp, DirectoryIcon][] = [
  [/design|creative|art|ui|ux/, "palette"],
  [/secur|compliance|audit/, "server"],
  [/data|database|sql|analytic/, "database"],
  [/monitor|observ|metric|chart/, "chart"],
  [/deploy|cloud|infra|devops|launch/, "rocket"],
  [/market|seo|social|content/, "megaphone"],
  [/financ|bank|payment|account/, "landmark"],
  [/commerce|shop|store|retail/, "cart"],
  [/learn|educat|doc|research|book/, "book"],
  [/product|workflow|automat|task/, "zap"],
  [/sale|crm|people|team|hr/, "users"],
  [/develop|code|test|debug|language|lsp|git/, "code"],
];

/** The glyph a plugin's category is drawn with. */
export function pluginIcon(category?: string): DirectoryIcon {
  if (!category) return "briefcase";
  return icons.find(([pattern]) => pattern.test(category))?.[1] ?? "briefcase";
}

/** "by Anthropic", or where it comes from. */
export function pluginByline(plugin: PluginEntry): string {
  if (
    plugin.developer === "Anthropic" ||
    (!plugin.developer && plugin.marketplace === officialMarketplace.name)
  )
    return t("Community");
  // The byline is shown as data (not translated in place), so it is put in
  // the window's language here: "来自 OpenAI", never "from OpenAI".
  return formatText("from {name}", {
    name: plugin.developer || plugin.marketplace,
  });
}

export interface PluginFilter {
  query?: string;
  category?: string;
  marketplace?: string;
  /** Runtime marketplaces expose titles, but no install totals or added dates. */
  sort?: "name";
}

// Empty lines.
export function pluginEmptyMessage(
  filter: PluginFilter,
  personal: boolean,
  uploaded = false,
) {
  if (filter.query?.trim()) return "No plugins match your search.";
  if (filter.category) return "No plugins match your filters";
  return personal
    ? uploaded
      ? "When you upload plugins, they will appear here."
      : "When you add plugins to your marketplace, they will appear here."
    : filter.marketplace
      ? "No plugins match your filters"
      : "No plugins available";
}

/** Plugins matching the search, the category and the marketplace, in order. */
export function filterPlugins(
  list: PluginEntry[],
  { query = "", category, marketplace, sort }: PluginFilter,
): PluginEntry[] {
  const search = query.trim().toLowerCase();
  const found = list.filter(
    (plugin) =>
      (!category || plugin.category === category) &&
      (!marketplace || plugin.marketplace === marketplace) &&
      (!search ||
        `${plugin.title} ${plugin.name} ${plugin.description ?? ""} ${plugin.developer ?? ""} ${plugin.category ?? ""}`
          .toLowerCase()
          .includes(search)),
  );
  return sort === "name"
    ? found.sort(
        (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
      )
    : found;
}

/** The categories in use, most plugins first. */
export function pluginCategoriesOf(list: PluginEntry[]) {
  const counts = new Map<string, number>();
  for (const plugin of list)
    if (plugin.category)
      counts.set(plugin.category, (counts.get(plugin.category) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, label: categoryLabel(id), count }));
}

/** Error text for the person: the runtime's, or a plain reason. */
export function pluginErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': /, "");
}

/**
 * Why adding a marketplace failed, in the original's sentences for the reasons
 * it names rather than the runtime's own words; any other reason keeps the
 * runtime's sentence, and an empty one is "Failed to add marketplace.".
 */
export function marketplaceAddError(error: unknown): string {
  const text = pluginErrorText(error);
  const known: [RegExp, string][] = [
    [
      /spawn git|git: command not found|git is required|ENOENT.*git/i,
      "Git is required to add marketplaces. Install Git, then restart the app.",
    ],
    [
      /could not resolve host|getaddrinfo|ENOTFOUND|name or service not known/i,
      "Could not connect to the marketplace host. Check the URL and your network connection.",
    ],
    [/timed? ?out|ETIMEDOUT/i, "The operation timed out. You can try again."],
    [
      /ECONNREFUSED|ECONNRESET|EAI_AGAIN|network is unreachable|unable to access/i,
      "Could not connect to the marketplace. Check the URL and your network connection.",
    ],
    [
      /repository not found|not found|does not exist|\b404\b/i,
      "Repository not found or not accessible.",
    ],
    [
      /authentication failed|could not read username|permission denied|terminal prompts disabled|\b40[13]\b/i,
      "This marketplace could not be accessed. Private repositories are only supported using the GitHub owner/repo format.",
    ],
  ];
  return (
    known.find(([pattern]) => pattern.test(text))?.[1] ??
    (text.trim() || "Failed to add marketplace.")
  );
}
