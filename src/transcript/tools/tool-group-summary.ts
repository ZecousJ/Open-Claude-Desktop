import type { Item } from "../../../shared/types";
import { toolKind } from "../../code-tools/code-tool-model";
import { currentLocale, formatText, listSeparator, t } from "../../i18n";
import { isMemoryTool } from "./memory-tool-kind";

const categories: Record<string, string> = {
  Read: "read",
  Write: "create",
  Edit: "edit",
  MultiEdit: "edit",
  Glob: "glob",
  Grep: "search",
  Bash: "command",
  PowerShell: "command",
  WebSearch: "web",
  WebFetch: "page",
  Agent: "agent",
  Task: "agent",
  spawn_agent: "agent",
  spawnAgent: "agent",
  resumeAgent: "agent",
  REPL: "code",
  JavaScript: "code",
  AppifactRepl: "code",
  js: "code",
  exec_command: "command",
  write_stdin: "command",
  TodoWrite: "plan",
  update_plan: "plan",
};

export function integrationName(item: Item) {
  if (item.type !== "mcpToolCall") return undefined;
  return item.server?.trim() || item.tool?.match(/^mcp__(.+?)__/)?.[1];
}

/** Group counts, stable ordering and compact overflow. */
export function toolGroupSummary(items: Item[], compact = true, steps = false) {
  const memory = items.filter(isMemoryTool);
  if (
    memory.length &&
    memory.length === items.length &&
    memory.every((item) => item.tool === "memory_edits")
  ) {
    const commands = new Set(memory.map((item) => item.arguments?.command));
    const verbs = [
      commands.has("view") && t("read"),
      commands.has("add") && t("added to"),
      (commands.has("replace") || commands.has("remove")) && t("updated"),
    ].filter((verb): verb is string => Boolean(verb));
    if (verbs.length > 1) {
      const text = formatText("{verbs} memory", {
        verbs: new Intl.ListFormat(currentLocale(), {
          type: "conjunction",
        }).format(verbs),
      });
      return text.charAt(0).toUpperCase() + text.slice(1);
    }
    if (verbs.length === 1)
      return commands.has("view")
        ? t("Read memory")
        : commands.has("add")
          ? t("Added to memory")
          : t("Updated memory");
  }
  const groups = new Map<string, { label: string; items: Item[] }>();
  const connectors = new Set<string>();
  for (const item of items) {
    const name = item.tool?.trim();
    const connector = integrationName(item);
    const category =
      item.type === "imageView"
        ? "read"
        : item.type === "imageGeneration"
          ? "create"
          : item.type === "outputFiles"
            ? "share"
            : (categories[name?.split(/__|\./).at(-1) ?? ""] ??
              (connector ? "connectors" : toolKind(item)));
    if (!category) continue;
    if (connector && category === "connectors") connectors.add(connector);
    const key =
      category === "list"
        ? "command"
        : category === "tool" && name
          ? `named:${name}`
          : category;
    const group = groups.get(key) ?? {
      label: key === "command" ? "command" : category,
      items: [],
    };
    group.items.push(item);
    groups.set(key, group);
  }
  const labels = [...groups]
    .map(([key, group]) => {
      const count = group.items.length;
      const paths = new Set<string>();
      let pathless = 0;
      for (const item of group.items) {
        const input = item.arguments ?? item.input;
        const filePath =
          input && typeof input === "object" && "file_path" in input
            ? input.file_path
            : undefined;
        const itemPaths = [
          ...(item.changes ?? []).map((change) => change.path),
          ...(Array.isArray(item.commandActions)
            ? item.commandActions.flatMap((action) =>
                typeof action.path === "string" ? [action.path] : [],
              )
            : []),
          ...(typeof filePath === "string" ? [filePath] : []),
          ...(typeof item.path === "string" ? [item.path] : []),
        ];
        if (!itemPaths.length) pathless++;
        for (const path of itemPaths) paths.add(path);
      }
      const fileCount = paths.size + pathless;
      const counted = (one: string, many: string, total = count) =>
        formatText(total === 1 ? one : many, { count: total });
      let label: string;
      switch (group.label) {
        case "connectors":
          label =
            connectors.size === 1
              ? formatText("Used {name} integration", {
                  name: [...connectors][0],
                })
              : formatText("Used {count} integrations", {
                  count: connectors.size,
                });
          break;
        case "read":
          label = counted("Read a file", "Read {count} files", fileCount);
          break;
        case "create":
          label = counted("Created a file", "Created {count} files", fileCount);
          break;
        case "edit":
          label = counted("Edited a file", "Edited {count} files", fileCount);
          break;
        case "search":
          label = t("Searched files");
          break;
        case "glob":
          label = t("Looked for files");
          break;
        case "web":
          label = t("Searched the web");
          break;
        case "page":
          label = counted("Read a page", "Read {count} pages");
          break;
        case "agent":
          label = counted("Ran an agent", "Ran {count} agents");
          break;
        case "code":
          label = counted("Ran code", "Ran code {count} times");
          break;
        case "plan":
          label = t("Updated the plan");
          break;
        case "share":
          label = t("Shared files");
          break;
        case "tool":
          label = key.startsWith("named:")
            ? formatText("Used {name}", { name: key.slice(6) })
            : counted("Used a tool", "Used {count} tools");
          break;
        default:
          label = counted("Ran a command", "Ran {count} commands");
      }
      return { label, count };
    })
    .sort((first, second) => second.count - first.count);
  const limit = compact && labels.length > 3 ? 2 : 3;
  const visible = labels
    .slice(0, limit)
    .map(({ label }, index) =>
      index ? label.charAt(0).toLocaleLowerCase() + label.slice(1) : label,
    );
  const remaining = labels
    .slice(limit)
    .reduce((total, group) => total + group.count, 0);
  const summary = visible.join(listSeparator());
  if (!summary) return undefined;
  return remaining && compact
    ? formatText(
        steps
          ? remaining === 1
            ? "{groups}, and 1 more step"
            : "{groups}, and {count} more steps"
          : remaining === 1
            ? "{groups}, and 1 more tool"
            : "{groups}, and {count} more tools",
        { groups: summary, count: remaining },
      )
    : summary;
}
