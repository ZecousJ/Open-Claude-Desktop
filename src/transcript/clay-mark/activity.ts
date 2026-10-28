import type { Item, Turn } from "../../../shared/types";
import { itemIsRunning } from "../../../shared/activity";

/** What the working mark can show. */
export type MarkBody =
  | "default"
  | "think"
  | "search"
  | "read"
  | "code"
  | "write"
  | "compose"
  | "blocked";

// The words the original reads a tool's activity from.
const readWords = new Set([
  "read",
  "view",
  "get",
  "list",
  "fetch",
  "search",
  "find",
  "query",
  "retrieve",
  "lookup",
  "load",
  "open",
  "ls",
]);
const writeWords = new Set([
  "write",
  "edit",
  "create",
  "update",
  "delete",
  "remove",
  "append",
  "insert",
  "replace",
  "patch",
  "send",
  "post",
  "add",
  "save",
  "upload",
  "comment",
  "artifacts",
]);
const runWords = new Set([
  "bash",
  "exec",
  "execute",
  "run",
  "shell",
  "python",
  "repl",
  "script",
  "eval",
  "javascript",
]);
const searchTools = new Set([
  "web",
  "web_fetch",
  "web_search",
  "image_search",
  "launch_extended_search_task",
]);
// Writing a document rather than code is "compose" (the original's quill).
const documentFile = /\.(md|mdx|txt|rst|docx|pdf)$/i;

/** The forms of a sentence's first word ("Listing" → list, lists → list). */
function firstWordForms(text: string) {
  const word = /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase();
  if (!word) return [];
  if (word.endsWith("ing") && word.length > 5) {
    const stem = word.slice(0, -3);
    return [
      word,
      stem,
      `${stem}e`,
      stem.replace(/([b-df-hj-np-tv-z])\1$/, "$1"),
    ];
  }
  if (word.endsWith("ies")) return [word, `${word.slice(0, -3)}y`];
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 3)
    return [word, word.slice(0, -1), word.slice(0, -2)];
  return [word];
}

/** A command reads or writes when its first word says so; else it runs code. */
function commandBody(text: string): MarkBody {
  for (const form of firstWordForms(text)) {
    if (writeWords.has(form)) return "write";
    if (readWords.has(form)) return "read";
  }
  return "code";
}

/** A tool by its name's words (the original's `ut` for unknown tools). */
function toolBody(name: string): MarkBody {
  const tool = name.toLowerCase().replace(/^mcp__[^_]+__/, "");
  if (searchTools.has(tool)) return "search";
  for (const word of tool.split(/[\s:_-]+/)) {
    if (writeWords.has(word)) return "write";
    if (runWords.has(word)) return "code";
    if (readWords.has(word)) return "read";
  }
  return "default";
}

function itemBody(item: Item): MarkBody {
  switch (item.type) {
    case "reasoning":
      return "think";
    case "webSearch":
      return "search";
    case "commandExecution": {
      const shown =
        (item as { description?: string }).description ??
        (item as { command?: string }).command ??
        "";
      return commandBody(shown.replace(/^.*?(?:-lc|-c)\s+['"]?/, ""));
    }
    case "fileChange": {
      const changes = (item as { changes?: { path?: string }[] }).changes;
      return changes?.length &&
        changes.every((change) => documentFile.test(change.path ?? ""))
        ? "compose"
        : "write";
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      const name =
        (item as { tool?: string; name?: string }).tool ??
        (item as { name?: string }).name ??
        "";
      return toolBody(name);
    }
    default:
      return "default";
  }
}

/**
 * What the mark shows for a turn (the original's `ft`): waiting on the
 * person is "blocked"; the newest running tool decides; reasoning thinks;
 * with nothing yet it thinks; otherwise the plain body.
 */
export function markBody(turn: Turn, awaitingApproval = false): MarkBody {
  if (awaitingApproval) return "blocked";
  if (!turn.items.length) return "think";
  for (let index = turn.items.length - 1; index >= 0; index--) {
    const item = turn.items[index];
    if (item.type !== "agentMessage" && itemIsRunning(item))
      return itemBody(item);
  }
  const last = turn.items.at(-1)!;
  return last.type === "reasoning" ? "think" : "default";
}
