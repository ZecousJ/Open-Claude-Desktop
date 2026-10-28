import { researchPolicyOf, type ClientPolicy } from "./client-policy";
import { connectorAllowed } from "./client-policy-rules";
import type { Project } from "./types";

/** A project's recommended tools (checked by shared/project-tools-input.ts). */
export interface ProjectTools {
  webSearch?: boolean;
  research?: boolean;
  connectors?: string[];
}
export interface ProjectTool {
  id: string;
  name: string;
  connector?: string;
  url?: string;
}

/** Recommendations, not connections. */
export function availableProjectTools(
  policy: ClientPolicy,
  servers: Record<string, unknown>,
): ProjectTool[] {
  const tools: ProjectTool[] = [];
  if (policy.webSearch)
    tools.push({ id: "builtin:web-search", name: "Web search" });
  if (policy.webSearch && researchPolicyOf(policy).enabled)
    tools.push({ id: "builtin:research", name: "Research" });
  return tools.concat(
    Object.entries(servers)
      .filter(
        ([name, server]) =>
          server &&
          typeof server === "object" &&
          !Array.isArray(server) &&
          connectorAllowed(policy, name, server),
      )
      .map(([name, server]) => ({
        id: `mcp:${name}`,
        name,
        connector: name,
        url:
          typeof (server as { url?: unknown }).url === "string"
            ? (server as { url: string }).url
            : undefined,
      }))
      .sort((first, second) => first.name.localeCompare(second.name)),
  );
}

export function recommendedProjectTools(settings?: ProjectTools): string[] {
  return [
    ...(settings?.webSearch ? ["builtin:web-search"] : []),
    ...(settings?.research ? ["builtin:research"] : []),
    ...(settings?.connectors ?? []).map((name) => `mcp:${name}`),
  ];
}

export function updateProjectTools(
  settings: ProjectTools | undefined,
  tools: ProjectTool[],
  selected: string[],
  removed: Set<string>,
): ProjectTools {
  const next = { ...settings };
  const connectors = new Set(settings?.connectors ?? []);
  for (const tool of tools) {
    const enabled = selected.includes(tool.id);
    if (!enabled && !removed.has(tool.id)) continue;
    if (tool.connector) {
      if (enabled) connectors.add(tool.connector);
      else connectors.delete(tool.connector);
    } else if (tool.id === "builtin:web-search") next.webSearch = enabled;
    else if (tool.id === "builtin:research") next.research = enabled;
  }
  return { ...next, connectors: [...connectors] };
}

export function projectConnectorOverrides(
  project?: Project,
): Record<string, boolean> {
  return Object.fromEntries(
    (project?.tools?.connectors ?? []).map((name) => [name, true]),
  );
}

export function connectorThreadConfig(
  servers: Record<string, unknown>,
  overrides?: Record<string, boolean>,
  tools?: import("./conversation-tools").ConversationToolOverrides,
) {
  const entries: [string, unknown][] = Object.entries(overrides ?? {}).flatMap(
    ([name, enabled]) =>
      Object.hasOwn(servers, name)
        ? [[`mcp_servers.${name}.enabled`, enabled]]
        : [],
  );
  for (const [name, switches] of Object.entries(tools ?? {})) {
    const raw = servers[name];
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const baseline = Array.isArray(entry.disabled_tools)
      ? entry.disabled_tools.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const disabled = new Set([
      ...baseline,
      ...Object.entries(switches)
        .filter(([, enabled]) => enabled === false)
        .map(([tool]) => tool),
    ]);
    entries.push([`mcp_servers.${name}.disabled_tools`, [...disabled].sort()]);
  }
  return Object.fromEntries(entries);
}
