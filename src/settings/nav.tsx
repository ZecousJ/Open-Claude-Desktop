import { MoonStar, Settings as Gear } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import type { ComponentType } from "react";
import type { HostInfo } from "../../shared/host";
import { usageAvailable } from "./usage-availability";

type IconProps = { size?: number | string; strokeWidth?: number | string };

/** A page's icon (AppIcon). */
function glyphIcon(name: Parameters<typeof AppIcon>[0]["name"]) {
  return function PageGlyph({ size = 20 }: IconProps) {
    return <AppIcon name={name} size={size} />;
  };
}

const AccountIcon = glyphIcon("UserCircle");
const BillingIcon = glyphIcon("CreditCard");
const CapabilitiesIcon = glyphIcon("Tool");
const CodeIcon = glyphIcon("Code");
const ConnectorsIcon = glyphIcon("Connectors");
const DesignIcon = glyphIcon("Palette");
const GaugeIcon = glyphIcon("UsageGaugeMiddle");
const ImportIcon = glyphIcon("Download");
const MemoryIcon = glyphIcon("Memory");
const NetworkIcon = glyphIcon("Globe");
const PluginIcon = glyphIcon("Plugin");
const PrivacyIcon = glyphIcon("LockShield");
const SkillsIcon = glyphIcon("Scroll");
const SystemIcon = glyphIcon("Computer");
const WrenchIcon = glyphIcon("Wrench");

/** Reflect's glyph: a half sun on the horizon. */
function ReflectIcon({ size = 16, strokeWidth = 1.5 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 15a6 6 0 0 1 12 0" />
      <path d="M3 15h18M7 19h10" />
    </svg>
  );
}

export type TabId =
  | "general"
  | "account"
  | "privacy"
  | "billing"
  | "usage"
  | "capabilities"
  | "memory"
  | "design"
  | "reflect"
  | "time"
  | "code"
  | "cowork"
  | "chrome"
  | "import"
  | "system"
  | "network"
  | "extensions"
  | "developer"
  | "skills"
  | "connectors"
  | "plugins";

export type Tab = {
  id: TabId;
  label: string;
  Icon: ComponentType<IconProps>;
};

/**
 * The navigation column, in the original's order and grouping: the Settings
 * modal's four groups Account, Customize, Products and This computer. Customize
 * lists Skills, Connectors and Plugins, then Design systems (d4's order).
 */
export const navGroups: { label: string; tabs: Tab[] }[] = [
  {
    label: "Settings",
    tabs: [
      { id: "general", label: "General", Icon: Gear },
      { id: "account", label: "Account", Icon: AccountIcon },
      { id: "privacy", label: "Privacy", Icon: PrivacyIcon },
      { id: "billing", label: "Billing", Icon: BillingIcon },
      // Service-plan usage, or native local Code statistics.
      { id: "usage", label: "Usage", Icon: GaugeIcon },
      { id: "capabilities", label: "Capabilities", Icon: CapabilitiesIcon },
      { id: "memory", label: "Memory", Icon: MemoryIcon },
      { id: "design", label: "Design systems", Icon: DesignIcon },
      { id: "reflect", label: "Reflect", Icon: ReflectIcon },
      { id: "time", label: "Time and focus", Icon: MoonStar },
      { id: "code", label: "Claudex Code", Icon: CodeIcon },
    ],
  },
  {
    label: "Customize",
    tabs: [
      { id: "skills", label: "Skills", Icon: SkillsIcon },
      { id: "connectors", label: "Connectors", Icon: ConnectorsIcon },
      { id: "plugins", label: "Plugins", Icon: PluginIcon },
    ],
  },
  // The group of pages about this computer: "This computer" in the live
  // claude.ai bundle.
  {
    label: "This computer",
    tabs: [
      { id: "system", label: "System", Icon: SystemIcon },
      { id: "network", label: "Network", Icon: NetworkIcon },
      { id: "extensions", label: "Extensions", Icon: PluginIcon },
      { id: "developer", label: "Developer", Icon: WrenchIcon },
      { id: "import", label: "Import", Icon: ImportIcon },
    ],
  },
];

const ids = new Set(navGroups.flatMap((g) => g.tabs.map((t) => t.id)));
/** Earlier tab names still used by callers. */
const aliases: Record<string, TabId> = {
  "claude-code": "code",
  "claudex-code": "code",
  tools: "capabilities",
  personalization: "memory",
  browser: "chrome",
  desktop: "system",
  connections: "developer",
  cowork: "capabilities",
  // The original's own page names in its addresses, so its links open the same
  // page here.
  "data-privacy-controls": "privacy",
  "design-systems": "design",
  "time-limits": "time",
  "browser-extension": "chrome",
};
export function tabId(value: string): TabId {
  return ids.has(value as TabId)
    ? (value as TabId)
    : (aliases[value] ?? "general");
}

/**
 * Whether a page exists for this account on this host. Usage needs a
 * service plan or this desktop's local Code statistics capability.
 * Pages about this computer need the matching capability
 * (shared/host.ts), so the web app has no System, Extensions, Developer or
 * Claude in Chrome page, and no Claude Code or Cowork page until the
 * service runs them in the cloud.
 */
export function tabAvailable(
  id: TabId,
  host: HostInfo,
  planUsage: boolean,
): boolean {
  const can = host.capabilities;
  switch (id) {
    case "usage":
      return usageAvailable(host, planUsage);
    // Extensions is about this computer too; its page is there on every
    // desktop host (the link to Developer only where local MCP runs).
    case "system":
    case "network":
    case "extensions":
      return can.systemIntegration;
    // Claude in Chrome and Developer come down to MCP servers this
    // computer runs.
    case "developer":
      return can.localMcp;
    case "chrome":
      return false;
    case "code":
      return true;
    case "cowork":
      return false;
    default:
      return true;
  }
}

/** The navigation column on this host; a group left empty is dropped. */
export function availableNavGroups(
  host: HostInfo,
  planUsage: boolean,
): { label: string; tabs: Tab[] }[] {
  return navGroups
    .map((group) => ({
      ...group,
      tabs: group.tabs.filter(
        (tab) =>
          tabAvailable(tab.id, host, planUsage) &&
          (host.kind !== "web" || tab.id !== "import"),
      ),
    }))
    .filter((group) => group.tabs.length > 0);
}

/**
 * The page a name opens (a caller's tab name, or /settings/<tab> on the
 * web): General when the name is unknown or the page does not exist here.
 */
export function openableTab(
  value: string,
  host: HostInfo,
  planUsage: boolean,
): TabId {
  const id = tabId(value);
  return tabAvailable(id, host, planUsage) ? id : "general";
}
