/**
 * The connector directory's entries: a local copy of the connectors the
 * original's Discover shows, with their topic and type. Details merge approved
 * service entries when available; remote servers without a published URL use
 * Add custom connector.
 */
import type { DirectoryIcon } from "./directory-icon";
import type {
  ApprovedDirectoryEntry,
  DirectoryCuration,
} from "./directory-submissions";
import type { McpServerState } from "./settings-desktop-api";
import { linearMcpUrl } from "./linear-api";
import type { ConnectorUrlConfiguration } from "./connector-url-configuration";

export type ConnectorType = "verified" | "community" | "custom";

export interface CatalogueConnector extends ConnectorUrlConfiguration {
  id: string;
  /** Service identity when a published entry enriches a bundled record. */
  directoryId?: string;
  name: string;
  description: string;
  /** Full published description, when the catalogue also has a short summary. */
  longDescription?: string;
  byline: string;
  publisherUrl?: string;
  categories?: string[];
  privacyPolicyUrl?: string;
  iconUrl?: string;
  relatedIds?: string[];
  type: ConnectorType;
  /** Joined the directory lately ("New" badge). */
  isNew?: boolean;
  topic: string;
  icon: DirectoryIcon;
  url?: string;
  supportUrl?: string;
  documentationUrl?: string;
  isAuthless?: boolean;
  added?: string;
  tools?: string[];
  isTrending?: boolean;
  inChatUi?: boolean;
  desktopExtension?: boolean;
  featured?: DirectoryCuration["featured"];
  installed?: boolean;
}

/** A bridge's runtime response must satisfy the published directory contract. */
export function isApprovedDirectoryEntries(
  value: unknown,
): value is ApprovedDirectoryEntry[] {
  const record = (item: unknown): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item);
  const strings = (item: Record<string, unknown>, keys: string[]) =>
    keys.every(
      (key) => item[key] === undefined || typeof item[key] === "string",
    );
  const booleans = (item: Record<string, unknown>, keys: string[]) =>
    keys.every(
      (key) => item[key] === undefined || typeof item[key] === "boolean",
    );
  const stringList = (item: unknown) =>
    item === undefined ||
    (Array.isArray(item) && item.every((part) => typeof part === "string"));
  const memberIds = (item: unknown) =>
    item === undefined ||
    (Array.isArray(item) &&
      item.length <= 50 &&
      item.every(
        (part) =>
          typeof part === "string" &&
          part.trim().length > 0 &&
          part.length <= 256,
      ));
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (
        !record(item) ||
        (item.kind !== "plugin" && item.kind !== "mcp") ||
        !["id", "name", "description", "url", "added"].every(
          (key) => typeof item[key] === "string",
        ) ||
        !strings(item, [
          "slug",
          "author",
          "supportUrl",
          "documentationUrl",
          "remoteUrlRegex",
          "remoteUrlTemplate",
          "testServerUrl",
        ]) ||
        !booleans(item, ["isAuthless"]) ||
        !stringList(item.tools)
      )
        return false;
      if (
        item.serverUrlType !== undefined &&
        !["universal", "multiple", "regex", "template"].includes(
          String(item.serverUrlType),
        )
      )
        return false;
      if (
        item.remoteUrlOptions !== undefined &&
        (!Array.isArray(item.remoteUrlOptions) ||
          !item.remoteUrlOptions.every(
            (option) =>
              record(option) &&
              typeof option.url === "string" &&
              strings(option, ["label"]),
          ))
      )
        return false;
      if (item.remoteUserConfig !== undefined) {
        const config = item.remoteUserConfig;
        if (
          !record(config) ||
          !["title", "description", "placeholder", "pattern"].every(
            (key) => typeof config[key] === "string",
          )
        )
          return false;
      }
      if (item.curation === undefined) return true;
      if (!record(item.curation)) return false;
      const curation = item.curation;
      return (
        strings(curation, [
          "topic",
          "publisherUrl",
          "supportUrl",
          "privacyPolicyUrl",
          "iconUrl",
        ]) &&
        booleans(curation, ["isTrending", "isNew", "inChatUi", "popular"]) &&
        stringList(curation.categories) &&
        stringList(curation.relatedIds) &&
        (curation.featured === undefined ||
          (record(curation.featured) &&
            typeof curation.featured.title === "string" &&
            typeof curation.featured.subtitle === "string" &&
            strings(curation.featured, ["curator"]) &&
            memberIds(curation.featured.memberIds)))
      );
    })
  );
}

/** Resolve only declared public records; matching names or private installs
 * never establish bundle membership. Missing metadata keeps a single record. */
export function featuredConnectorMembers(
  entry: CatalogueConnector,
  catalogue: readonly CatalogueConnector[],
): CatalogueConnector[] {
  const published = catalogue.filter(
    (item) => item.type !== "custom" && !item.id.startsWith("installed:"),
  );
  const find = (id: string) =>
    published.find((item) => item.id === id) ??
    published.find((item) => item.directoryId === id);
  const declared = entry.featured?.memberIds;
  const ids = declared ?? [
    entry.id,
    ...(entry.directoryId ? [entry.directoryId] : []),
  ];
  const members: CatalogueConnector[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const member = find(id);
    if (
      !member ||
      seen.has(member.id) ||
      (member.directoryId && seen.has(member.directoryId))
    )
      continue;
    members.push(member);
    seen.add(member.id);
    if (member.directoryId) seen.add(member.directoryId);
    if (members.length === 7 || declared === undefined) break;
  }
  return members;
}

export function directoryConnectors(approved: ApprovedDirectoryEntry[]) {
  const entries = [...connectors];
  for (const item of approved.filter((entry) => entry.kind === "mcp")) {
    const index = entries.findIndex(
      (entry) =>
        entry.id === item.id ||
        (entry.name.toLowerCase() === item.name.toLowerCase() &&
          entry.url === item.url),
    );
    const previous = index < 0 ? undefined : entries[index];
    const inherited = previous?.url === item.url ? previous : undefined;
    const entry: CatalogueConnector = {
      ...inherited,
      ...item,
      ...item.curation,
      id: previous?.id ?? item.id,
      directoryId: item.id,
      byline: item.author ? `by ${item.author}` : "",
      type:
        previous?.url && previous.url === item.url
          ? previous.type
          : "community",
      topic: item.curation?.topic ?? inherited?.topic ?? "",
      icon: inherited?.icon ?? "server",
    };
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
  }
  return entries;
}

export function connectorServer(
  entry: CatalogueConnector,
  servers: McpServerState[],
) {
  const exact = servers.find(
    (server) =>
      server.connectorId === entry.id ||
      (!!entry.directoryId && server.connectorId === entry.directoryId),
  );
  if (exact) return exact;
  return servers.find((server) =>
    entry.url
      ? server.url === entry.url
      : entry.installed
        ? entry.id === `installed:${server.name}`
        : server.connectorId === entry.id ||
          (entry.id === "linear" && server.url === linearMcpUrl),
  );
}

/** Topic submenu entries, in the original's order. */
export const connectorTopics = [
  "AI models & agents",
  "APIs",
  "Automation & workflows",
  "Code",
  "Contacts & leads",
  "Databases",
  "Designs & media",
  "Email & messages",
  "Events & tickets",
  "Files & documents",
  "Tasks & projects",
];

const entry = (
  id: string,
  name: string,
  description: string,
  byline: string,
  topic: string,
  icon: DirectoryIcon,
  type: ConnectorType = "verified",
  isNew = false,
): CatalogueConnector => ({
  id,
  name,
  description,
  byline,
  topic,
  icon,
  type,
  isNew,
});

/** In the directory's "Top connectors" order. */
export const connectors: CatalogueConnector[] = [
  entry(
    "google-drive",
    "Google Drive",
    "Search, read, and upload files instantly",
    "by Google",
    "Files & documents",
    "file",
  ),
  entry(
    "gmail",
    "Gmail",
    "Draft replies, summarize threads, & search your inbox",
    "by Google",
    "Email & messages",
    "megaphone",
  ),
  entry(
    "google-calendar",
    "Google Calendar",
    "Manage your schedule and coordinate meetings effortlessly",
    "by Google",
    "Events & tickets",
    "history",
  ),
  entry(
    "canva",
    "Canva",
    "Search, create, autofill, and export Canva designs",
    "by Canva",
    "Designs & media",
    "palette",
  ),
  entry(
    "microsoft-365",
    "Microsoft 365",
    "Access your company's SharePoint, OneDrive, Outlook, and Teams directly in chats",
    "Community",
    "Files & documents",
    "briefcase",
  ),
  {
    ...entry(
      "notion",
      "Notion",
      "Connect your Notion workspace to search, update, and power workflows across tools",
      "by Notion",
      "Files & documents",
      "book",
    ),
    // This record only: current signed-in Notion detail, 2026-10-17.
    url: "https://mcp.notion.com/mcp",
    iconUrl: "https://www.notion.so/images/notion-logo-block-main.svg",
    longDescription:
      "Notion MCP helps you plug tools into your Notion workspace, allowing you to create, edit, search and organize content directly from Claudex. Get contextual and relevant assistance from Claudex, while keeping knowledge organized in Notion.",
    publisherUrl: "https://notion.com/",
    categories: ["Files & documents", "Notes & memory", "Databases"],
    relatedIds: [
      "zoom-for-claude",
      "33b42d5b-de4e-43c6-ae45-135b15ec1791",
      "goodnotes",
      "sigma",
      "google-drive-drivemcp",
      "microsoft-365",
    ],
    isAuthless: false,
    added: "2025-11",
    tools: [
      "create-comment",
      "create-database",
      "create-pages",
      "duplicate-page",
      "fetch",
      "get-comments",
      "get-self",
      "get-user",
      "get-users",
      "move-pages",
      "search",
      "update-database",
      "update-page",
    ],
    documentationUrl: "https://developers.notion.com/docs/mcp",
    supportUrl: "mailto:developers@makenotion.com",
    privacyPolicyUrl:
      "https://www.notion.so/notion/Privacy-Policy-3468d120cf614d4c9014c09f6adc9091",
  },
  entry(
    "figma",
    "Figma",
    "Generate diagrams and better code from Figma context",
    "by Figma",
    "Designs & media",
    "layout",
  ),
  entry(
    "slack",
    "Slack",
    "Send messages, create canvases, and fetch Slack data",
    "by Slack",
    "Email & messages",
    "users",
  ),
  entry(
    "atlassian",
    "Atlassian MCP",
    "Search, read and update Jira, Confluence, Bitbucket, Loom and other Atlassian apps",
    "by Atlassian",
    "Tasks & projects",
    "zap",
  ),
  entry(
    "hubspot",
    "HubSpot",
    "CRM context for every answer, insight, and action",
    "by HubSpot",
    "Contacts & leads",
    "users",
  ),
  entry(
    "asana",
    "Asana",
    "Connect to Asana to coordinate tasks, projects, and goals",
    "by Asana",
    "Tasks & projects",
    "briefcase",
  ),
  entry(
    "linear",
    "Linear",
    "Manage issues, projects & team workflows in Linear",
    "by Linear",
    "Tasks & projects",
    "zap",
  ),
  entry(
    "gamma",
    "Gamma",
    "Create presentations, docs, and websites with AI",
    "by Gamma",
    "Designs & media",
    "layout",
  ),
  entry(
    "vercel",
    "Vercel",
    "Analyze, debug, and manage projects and deployments",
    "by Vercel",
    "Code",
    "rocket",
  ),
  entry(
    "granola",
    "Granola",
    "The AI notepad for meetings",
    "by Granola",
    "AI models & agents",
    "book",
  ),
  entry(
    "shopify",
    "Shopify",
    "Build, manage, and grow your Shopify store",
    "by Shopify",
    "APIs",
    "cart",
  ),
  entry(
    "microsoft-learn",
    "Microsoft Learn",
    "Search trusted Microsoft docs to power your development",
    "by Microsoft",
    "Code",
    "code",
  ),
  entry(
    "zapier",
    "Zapier",
    "Automate workflows across thousands of apps via conversation",
    "by Zapier",
    "Automation & workflows",
    "zap",
  ),
  entry(
    "whalesync",
    "Whalesync",
    "Two-way sync between your favorite business apps",
    "by Whalesync",
    "Databases",
    "database",
    "community",
  ),
  entry(
    "gosearch",
    "GoSearch MCP",
    "Search your company knowledge",
    "by GoSearch",
    "AI models & agents",
    "globe",
    "community",
  ),
  entry(
    "thor",
    "Thor.ai",
    "The context layer that keeps your agents up to date on your team's decisions and scope changes",
    "by Zenhub",
    "AI models & agents",
    "server",
    "community",
    true,
  ),
  entry(
    "transformpipe",
    "TransformPipe",
    "Convert documents to Markdown or HTML and back, keep, search and share them on your own TransformPipe account.",
    "by Raudar labs",
    "Files & documents",
    "file",
    "community",
    true,
  ),
];

export interface ConnectorFilter {
  topic?: string;
  type:
    | "all"
    | "new"
    | "trending"
    | "inChatUi"
    | "desktopExtension"
    | ConnectorType;
  query: string;
}

export const defaultConnectorFilter: ConnectorFilter = {
  type: "all",
  query: "",
};

/** The entries a filter and search leave, in directory order. */
export function findConnectors(filter: ConnectorFilter, entries = connectors) {
  const words = filter.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter(
    (connector) =>
      (!filter.topic || connector.topic === filter.topic) &&
      (filter.type === "all" ||
        (filter.type === "new"
          ? connector.isNew
          : filter.type === "trending"
            ? connector.isTrending
            : filter.type === "inChatUi"
              ? connector.inChatUi
              : filter.type === "desktopExtension"
                ? connector.desktopExtension
                : connector.type === filter.type)) &&
      words.every((word) =>
        `${connector.name} ${connector.description} ${connector.byline}`
          .toLowerCase()
          .includes(word),
      ),
  );
}
