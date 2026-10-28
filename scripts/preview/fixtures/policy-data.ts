/**
 * Policy samples (package C2): the service's `GET /claudex/policy` data as the
 * Claudex service sends it (design 2.3) and the client policies the main
 * process makes of it, for the fixture's policy domain and for tests. Data
 * only: nothing here reads the URL or registers bridge calls. Links point at
 * example.com.
 */
import {
  offlinePolicy,
  openPolicy,
  type ClientPolicy,
} from "../../../shared/client-policy";

/** `GET /api/v1/claudex/policy` data for a Max plan (design 2.3's example, resolved). */
export const servicePolicyWire = {
  revision: 17,
  group_id: 4,
  permission_modes: ["auto", "manual", "acceptEdits", "plan"],
  incognito: true,
  web_search: true,
  web_search_default: false,
  voice: true,
  local_mcp_editing: true,
  remote_images: true,
  remote_image_domains: null,
  external_links: true,
  trusted_link_domains: [],
  connectors: [
    { name: "github", url_prefix: "https://api.githubcopilot.com/mcp" },
    { name: "linear" },
    { name: "docs", command: "docs-mcp" },
  ],
  attachments: {
    max_bytes: 10485760,
    types: ["png", "jpg", "jpeg", "webp", "gif", "txt", "md", "csv", "json", "py", "ts"],
  },
  links: {
    help: "https://docs.example.com",
    plans: null,
    apps: null,
    get_more_usage: "https://claudex.example.com/plans",
    usage_learn_more: null,
    learn_more: [
      { label: "Usage policy", url: "https://claudex.example.com/policy" },
    ],
  },
  usage_banner: { warn_percent: 80 },
  plan_label: "Max",
  scheduled_tasks: { enabled: true, max_tasks: null },
  approvals_always_allow: true,
  memory: {
    enabled: true,
    search_chats: true,
    generate: true,
    default_on: false,
    model: null,
  },
  research: { enabled: true, x_search: true, max_searches_per_turn: 30 },
  browser: {
    enabled: true,
    external_sites: true,
    allow_script: true,
    dev_servers: true,
    blocked_domains: [],
  },
  ssh_remote: true,
  codex_runtime_mirror: null,
  // The service's built-in default: off until an administrator allows it.
  computer_use: {
    enabled: false,
    allow_full_control: true,
    denied_apps: [],
    max_actions_per_turn: null,
  },
};

/** `servicePolicyWire` as the window receives it (what `parsePolicy` makes of it, without the group). */
export const servicePolicy: ClientPolicy = {
  ...openPolicy,
  revision: 17,
  connectors: [
    { name: "github", urlPrefix: "https://api.githubcopilot.com/mcp" },
    { name: "linear" },
    { name: "docs", command: "docs-mcp" },
  ],
  attachments: {
    maxBytes: 10485760,
    // In the client's order of attachment types.
    types: ["png", "jpg", "jpeg", "webp", "gif", "txt", "md", "csv", "ts", "py", "json"],
  },
  links: {
    help: "https://docs.example.com",
    getMoreUsage: "https://claudex.example.com/plans",
    learnMore: [
      { label: "Usage policy", url: "https://claudex.example.com/policy" },
    ],
  },
  planLabel: "Max",
  computerUse: {
    enabled: false,
    allowFullControl: true,
    deniedApps: [],
    maxActionsPerTurn: null,
  },
};

/**
 * Offline with no cached policy: only changing MCP servers waits for the
 * service, and only the servers configured now run. Bypass permissions is
 * not part of any policy (owner decision 3).
 */
export const offlineFixturePolicy: ClientPolicy = offlinePolicy({
  mcpServers: { docs: { command: "docs-mcp" } },
});

export const policyFixtures = {
  service: servicePolicy,
  offline: offlineFixturePolicy,
} as const satisfies Record<string, ClientPolicy>;
