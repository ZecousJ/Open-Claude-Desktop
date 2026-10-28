import type { Conversation, Item } from "../../shared/types";
import { latestGeneratedFiles } from "../../shared/generated-files";

export interface ContextResource {
  id: string;
  name: string;
  kind:
    | "search"
    | "connector"
    | "command"
    | "skill"
    | "file"
    | "memory"
    | "browser"
    | "instructions";
  count: number;
  path?: string;
  updated?: boolean;
  paths?: string[];
  details?: string[];
}

const normalized = (path: string) => {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return (/^[\\/]/.test(path) ? "/" : "") + parts.join("/");
};
export function resourceLocation(folders: string[], file: string) {
  const target = normalized(file);
  const index = folders.reduce(
    (best, folder, at) =>
      target.startsWith(normalized(folder).replace(/\/$/, "") + "/") &&
      (best < 0 || folder.length > folders[best].length)
        ? at
        : best,
    -1,
  );
  return index < 0
    ? undefined
    : {
        index,
        relative: target.slice(
          normalized(folders[index]).replace(/\/$/, "").length + 1,
        ),
      };
}

function argumentsOf(item: Item): Record<string, any> {
  if (typeof item.arguments === "string") {
    try {
      const parsed = JSON.parse(item.arguments);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : {};
    } catch {
      return {};
    }
  }
  return item.arguments &&
    typeof item.arguments === "object" &&
    !Array.isArray(item.arguments)
    ? item.arguments
    : {};
}

// Resource aggregation and scratchpad exclusions.
export function contextResources(
  conversation: Conversation,
  folders: string[],
) {
  const resources = new Map<string, ContextResource>();
  const scratchpad = new Map<string, ContextResource>();
  const tabs = new Set<string>();
  const pages = new Set<string>();
  const sites = new Set<string>();
  const add = (resource: Omit<ContextResource, "count">, count = 1) => {
    const previous = resources.get(resource.id);
    resources.set(resource.id, {
      ...resource,
      details: [...(previous?.details ?? []), ...(resource.details ?? [])],
      count: (previous?.count ?? 0) + count,
      updated: previous?.updated || resource.updated,
    });
  };
  const read = (path: string) => {
    const file = normalized(path);
    path = file;
    const name = file.split("/").at(-1) ?? file;
    if (/\/skills\/[^/]+\/SKILL\.md$/i.test(file)) {
      const skill = file.split("/").at(-2)!;
      const previous = resources.get(`skill:${skill}`);
      resources.set(`skill:${skill}`, {
        id: `skill:${skill}`,
        name: skill,
        kind: "skill",
        details: previous?.details,
        path,
        count: previous?.count ?? 1,
      });
    } else if (/\/(commands|prompts)\/[^/]+\.md$/i.test(file)) {
      add({
        id: file,
        name: name.replace(/\.md$/i, ""),
        kind: "command",
        path,
      });
    } else if (/^(CLAUDE|AGENTS)\.md$/i.test(name)) {
      add({
        id: file,
        name: resourceLocation(folders, path)
          ? "Folder instructions"
          : "Global instructions",
        kind: "instructions",
        path,
      });
    } else {
      const location = resourceLocation(folders, path);
      if (location) {
        const id = `folder:${location.index}`;
        const previous = resources.get(id);
        const paths = [...new Set([...(previous?.paths ?? []), path])];
        resources.set(id, {
          id,
          name:
            folders[location.index].split(/[\\/]/).at(-1) ??
            folders[location.index],
          kind: "file",
          path: folders[location.index],
          paths,
          count: paths.length,
        });
      } else if (
        /^(?:\/|[a-z]:\/)/i.test(file) &&
        !/\/(?:\.claude|\.codex)\//.test(file)
      ) {
        scratchpad.set(file, { id: file, name, path, kind: "file", count: 1 });
      }
    }
  };
  for (const turn of conversation.turns) {
    const invokedSkill = /^\$([\w-]+)(?:\s|$)/.exec(turn.prompt);
    if (invokedSkill)
      add({
        id: `skill:${invokedSkill[1]}`,
        name: invokedSkill[1],
        kind: "skill",
        details: [turn.prompt],
      });
    for (const [scope, content] of Object.entries(
      turn.coworkInstructions ?? {},
    )) {
      if (content)
        resources.set(`instructions:${scope}`, {
          id: `instructions:${scope}`,
          name:
            scope === "global" ? "Global instructions" : "Folder instructions",
          kind: "instructions",
          count: 1,
          details: [content],
        });
    }
    for (const item of turn.items) {
      if (
        ["failed", "interrupted", "inProgress"].includes(
          item.lifecycleStatus ?? item.status ?? "",
        ) ||
        item.success === false ||
        item.error
      )
        continue;
      const args = argumentsOf(item);
      if (item.type === "webSearch") {
        if (["openPage", "findInPage"].includes(item.action?.type)) {
          try {
            const address = new URL(item.action.url);
            if (["https:", "http:"].includes(address.protocol)) {
              pages.add(address.href);
              sites.add(address.hostname);
            }
          } catch {}
        } else
          add({
            id: "search",
            name: "Web search",
            kind: "search",
            details: [
              item.query ?? item.action?.query ?? "",
              ...(item.sources ?? []).map((source) => source.url),
            ].filter(Boolean),
          });
      }
      if (item.type === "commandExecution") {
        const actions = Array.isArray(item.commandActions)
          ? item.commandActions
          : [];
        for (const action of actions)
          if (action.type === "read" && typeof action.path === "string")
            read(
              /^(?:[\\/]|[a-z]:[\\/])/i.test(action.path)
                ? action.path
                : `${item.cwd ?? conversation.cwd ?? ""}/${action.path}`,
            );
      }
      if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        const server = item.server ?? item.namespace;
        const result =
          (item.contentItems ?? [])
            .filter((content: { type: string }) => content.type === "inputText")
            .map((content: { text: string }) => content.text)
            .join("\n") ||
          (typeof item.result === "string"
            ? item.result
            : JSON.stringify(item.result ?? args));
        if (server === "claudex_memory" && item.tool === "memory_edits") {
          const updated = args.command !== "view";
          add({
            id: updated ? "memory:updated" : "memory:read",
            name: "Memory",
            kind: "memory",
            updated,
            details: [result],
          });
        } else if (server === "claudex_browser") {
          for (const tab of result.match(/\btab-\d+\b/g) ?? []) tabs.add(tab);
          if (typeof args.tabId === "string") tabs.add(args.tabId);
          if (!/tab_close/.test(item.tool ?? "")) {
            for (const address of [
              args.url,
              ...(result.match(/https?:\/\/[^\s)]+(?= \(tab-\d+\))/g) ?? []),
            ]) {
              if (typeof address !== "string") continue;
              try {
                const url = new URL(address);
                if (!["http:", "https:"].includes(url.protocol)) continue;
                pages.add(url.href);
                sites.add(url.hostname);
              } catch {}
            }
          }
        } else if (server)
          add({
            id: `connector:${server}`,
            name: String(server),
            kind: "connector",
            details: [item.tool ?? ""],
          });
      }
    }
  }
  for (const file of latestGeneratedFiles(conversation.turns).values())
    scratchpad.delete(normalized(file.path));
  for (const [category, values] of [
    ["tabs", tabs],
    ["pages", pages],
    ["sites", sites],
  ] as const)
    if (values.size)
      resources.set(`browser:${category}`, {
        id: `browser:${category}`,
        name: "Browser",
        kind: "browser",
        count: values.size,
        details: [...values],
      });
  return {
    resources: [...resources.values()],
    scratchpad: [...scratchpad.values()],
  };
}
