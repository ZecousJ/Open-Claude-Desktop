/**
 * Search labels and pure helpers of the desktop and developer Settings pages.
 * Kept apart from the page components, which import their stylesheets, so
 * Settings search (`search/pages.ts`) and tests can load them without CSS. Each
 * page re-exports its `searchLabels`.
 */
import type { Settings } from "../../../shared/types";
import type { McpServerState } from "../../../shared/settings-desktop-api";

export const capabilitiesLabels = [
  "Tool access mode",
  "Connector search",
  "Switch models when a message is flagged",
  "Visuals",
  "Artifacts",
  "AI-powered artifacts",
  "Inline visualizations",
  "Code execution and file creation",
  "Run code in the cloud",
  "Allow network egress",
  "Domain allowlist",
];
export const memoryLabels = [
  "Memory",
  "Search and reference chats",
  "Generate memory from chats",
  "Import memory",
];
export const designLabels = ["Design systems", "New design system"];
export const reflectLabels = ["Reflect"];
export const timeLabels = ["Time and focus", "Break reminders", "Quiet hours"];
export const codeLabels = [
  "Code defaults",
  "Default permissions",
  "Thinking effort",
  "Code appearance",
  "Code font",
  "Local sessions",
  "Allow bypass permissions mode",
  "Trusted folders",
  "Draw attention on notifications",
  "Keep computer awake while Claudex works",
  "Keep awake on battery power",
  "Classify session states",
  "Switch models when a message is flagged",
  "Interface font",
  "Default transcript view",
  "Dynamic workflows",
  "Prompt suggestions",
  "Archive inactive sessions",
  "Worktree location",
  "When you ask for an unrelated task",
  "Output style",
  "Remote Control",
  "Connect new sessions to Remote Control",
  "Pull requests",
  "Branch prefix",
  "Create pull requests automatically",
  "Create as draft",
  "Auto-fix pull requests",
  "Auto-archive after PR merge or close",
  "Open pull requests in browser",
  "Windows sandbox",
  "Set up the sandbox",
  "Delete sessions stored by your Claudex service",
  "Sharing settings",
];
export const coworkLabels = [
  "Computer access",
  "Thinking effort",
  "Global instructions",
  "Cowork files",
  "Open links in built-in browser",
  "Allowed sites",
];
export const chromeLabels = [
  "Claudex in Chrome settings",
  "Enable Claudex in Chrome",
  "Site permissions",
  "Default for all sites",
];
export const systemLabels = [
  "Voice shortcut",
  "System",
  "Desktop app version",
  "Run on startup",
  "Quick access shortcut",
  "Quick Entry keyboard shortcut",
  "Dictation shortcut",
  "Browser use",
  "Open links in built-in browser",
  "Allowed sites",
  "Allow all browser actions",
  "Menu bar",
  "System tray",
  "Keep computer awake",
  "Storage",
  "Agent runtime",
  "About Claudex",
];
export const importLabels = [
  "Import local MCP servers",
  "Import",
  "Export",
  "Import history",
  "Remove all",
];
export const extensionsLabels = [
  "Extensions",
  "Browse extensions",
  "Advanced settings",
];
export const developerLabels = [
  "Local MCP servers",
  "Edit config",
  "Developer docs",
  "Model access",
];
export const skillsLabels = ["Skills", "Create a skill", "Upload skill"];
export const connectorsLabels = ["Connectors"];
export const pluginsLabels = ["Plugins", "Discover plugins"];

/**
 * Turning "Allow bypass permissions mode" off also moves a Bypass default
 * back to workspace write, so new Code sessions are not left on a mode that
 * is now off. The switch is the user's own (owner decision 3).
 */
export function bypassPatch(
  settings: Pick<Settings, "codeSandbox">,
  allow: boolean,
): Partial<Settings> {
  return allow || settings.codeSandbox !== "danger-full-access"
    ? { allowBypassPermissions: allow }
    : { allowBypassPermissions: false, codeSandbox: "workspace-write" };
}

/** The Quick access choices: none, then the accelerators the platform offers. */
export function shortcutOptions(accelerators: readonly string[]) {
  return [
    { value: "", label: "No shortcut" },
    ...accelerators.map((value) => ({ value, label: value })),
  ];
}

/** The badge a server's state shows. */
export const mcpStateLabels: Record<McpServerState["state"], string> = {
  ready: "Running",
  starting: "Starting",
  failed: "Failed",
  cancelled: "Cancelled",
  stopped: "Stopped",
  disabled: "Off",
};

/** A skill as the runtime lists it (`skills/list`). */
export interface ListedSkill {
  name: string;
  description?: string;
  shortDescription?: string;
  path: string;
  scope?: "user" | "repo" | "system" | "admin";
  enabled?: boolean;
}

/** The Created by choice a skill belongs to (Customize's filter). */
export function skillOrigin(
  scope: ListedSkill["scope"],
): "you" | "organization" | "builtin" {
  return (scope ?? "user") === "user"
    ? "you"
    : scope === "admin"
      ? "organization"
      : "builtin";
}

const groupTitles: Record<NonNullable<ListedSkill["scope"]>, string> = {
  user: "Yours",
  admin: "From your administrator",
  repo: "In this project",
  system: "Built in",
};
const groupOrder = ["user", "admin", "repo", "system"] as const;

/** The runtime's skill lists, once per SKILL.md, grouped by where they come from and filtered by `query`. */
export function groupSkills(
  groups: readonly { skills?: readonly ListedSkill[] }[],
  query = "",
) {
  const seen = new Set<string>();
  const wanted = query.trim().toLowerCase();
  const skills = groups
    .flatMap((group) => group.skills ?? [])
    .filter((skill) => {
      if (seen.has(skill.path)) return false;
      seen.add(skill.path);
      return `${skill.name} ${skill.description ?? ""}`
        .toLowerCase()
        .includes(wanted);
    });
  return groupOrder
    .map((scope) => ({
      scope,
      title: groupTitles[scope],
      skills: skills
        .filter((skill) => (skill.scope ?? "user") === scope)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .filter((group) => group.skills.length);
}

/** Lowercase letters, numbers and hyphens, starting with a letter (as SKILL.md requires). */
export const skillNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
