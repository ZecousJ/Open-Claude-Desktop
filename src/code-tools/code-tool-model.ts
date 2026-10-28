import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import {
  commandDescriptionText,
  type CommandState,
} from "./tool-description-text";
import { formatText, listSeparator, spaced, t, tf } from "../i18n";

/**
 * Code transcript tool rows: consecutive tool calls fold into one summary row.
 * Labels come from what Codex reports (parsed command actions, tool names),
 * never invented prose.
 */
type Action =
  | { type: "read"; name?: string; path?: string }
  | { type: "search"; query?: string | null; path?: string | null }
  | { type: "listFiles"; path?: string | null }
  | { type: "unknown" };

export function commandActions(item: Item): Action[] {
  return Array.isArray(item.commandActions)
    ? (item.commandActions as Action[]).filter(
        (action) => action && typeof action.type === "string",
      )
    : [];
}

export type ToolKind =
  "read" | "search" | "list" | "command" | "tool" | "web" | "edit" | "create";

/** What a command did, when every parsed action is a read, search or listing. */
export function commandKind(item: Item): ToolKind {
  const actions = commandActions(item);
  if (!actions.length) return "command";
  if (actions.every((a) => a.type === "read")) return "read";
  if (actions.every((a) => a.type === "search")) return "search";
  if (actions.every((a) => a.type === "listFiles")) return "list";
  return "command";
}

/**
 * Tool items that fold together; messages, plans and agents stay on their own
 * rows. A file edit joins the run: R-0805's turn is one row, "Read 2 files ›"
 * then "Editing app.js ›".
 */
export function toolKind(item: Item): ToolKind | undefined {
  if (item.type === "commandExecution") return commandKind(item);
  if (item.type === "fileChange") return createsFiles(item) ? "create" : "edit";
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
    return "tool";
  if (item.type === "webSearch") return "web";
}

/**
 * A file change that only adds files: summarised as "created", not "edited".
 */
function createsFiles(item: Item) {
  const changes = item.changes ?? [];
  return (
    changes.length > 0 &&
    changes.every(
      (change) =>
        (typeof change.kind === "string" ? change.kind : change.kind?.type) ===
        "add",
    )
  );
}

export function failed(item: Item) {
  return (
    item.status === "failed" ||
    item.lifecycleStatus === "failed" ||
    (typeof item.exitCode === "number" && item.exitCode !== 0)
  );
}

/**
 * Where a command stands, for its row's wording: stopped with its turn,
 * still running, failed, or done. Shared by the Code rows, the agent tool
 * list and the Chat activity label.
 */
export function commandState(item: Item): CommandState {
  if (item.lifecycleStatus === "interrupted") return "interrupted";
  if (itemIsRunning(item)) return "running";
  return failed(item) ? "failed" : "completed";
}

const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function readNames(items: Item[]) {
  return [
    ...new Set(
      items.flatMap((item) =>
        commandActions(item)
          .filter(
            (a): a is Extract<Action, { type: "read" }> => a.type === "read",
          )
          .map((a) => a.name || (a.path ? basename(a.path) : "")),
      ),
    ),
  ].filter(Boolean);
}

function editedNames(items: Item[]) {
  return [
    ...new Set(
      items.flatMap((item) =>
        (item.changes ?? []).map((change) => basename(change.path)),
      ),
    ),
  ].filter(Boolean);
}

function searchQueries(items: Item[]) {
  return [
    ...new Set(
      items.flatMap((item) =>
        commandActions(item)
          .filter(
            (a): a is Extract<Action, { type: "search" }> =>
              a.type === "search",
          )
          .map((a) => a.query ?? ""),
      ),
    ),
  ].filter(Boolean);
}

function listPaths(items: Item[]) {
  return items
    .flatMap((item) =>
      commandActions(item)
        .filter(
          (a): a is Extract<Action, { type: "listFiles" }> =>
            a.type === "listFiles",
        )
        .map((a) => a.path ?? ""),
    )
    .filter(Boolean);
}

const plural = (count: number, one: string, many = `${one}s`) =>
  count === 1 ? `a ${one}` : `${count} ${many}`;

/** " (1 failed)" after a phrase, in the language's words. */
const failedNote = (phrase: Part, bad: number): Part =>
  bad
    ? { ...phrase, verb: phrase.verb + spaced(tf("({n} failed)", { n: bad })) }
    : phrase;

/** One phrase of a summary; `name` is a trailing file name shown brighter. */
interface Part {
  verb: string;
  name?: string;
}

function part(
  kind: ToolKind,
  items: Item[],
  running: boolean,
  /** Only a lone call, or the call running now, names its file. */
  named: boolean,
): Part {
  // Each phrase is the catalog's ("read {n} files" → "读取了 {n} 个文件").
  const text = (verb: string): Part => ({ verb: t(verb) });
  const withName = (verb: string, name: string): Part => ({
    verb: t(verb),
    name,
  });
  const n = items.length;
  if (kind === "read") {
    // Reads count files, not calls: "read 3 files".
    const names = readNames(items);
    const count = Math.max(names.length, n);
    return names.length === 1 && count === 1
      ? withName(running ? "reading" : "read", names[0])
      : text(`${running ? "reading" : "read"} ${count} files`);
  }
  if (kind === "edit") {
    const names = editedNames(items);
    if (names.length === 1 && named)
      return withName(running ? "editing" : "edited", names[0]);
    return running
      ? text("editing")
      : text(
          (names.length || n) === 1
            ? "edited a file"
            : `edited ${names.length || n} files`,
        );
  }
  if (kind === "create") {
    const names = editedNames(items);
    if (names.length === 1 && named)
      return withName(running ? "creating" : "created", names[0]);
    return running
      ? text("creating")
      : text(
          (names.length || n) === 1
            ? "created a file"
            : `created ${names.length || n} files`,
        );
  }
  // A lone search, listing or web search names its subject as the original's
  // row does.
  if (named && n === 1 && kind === "search") {
    const query = searchQueries(items)[0];
    if (query)
      return {
        verb: formatText(running ? "Searching {query}" : "Searched {query}", {
          query,
        }),
      };
  }
  if (named && n === 1 && kind === "list") {
    const path = listPaths(items)[0];
    if (path)
      return {
        verb: formatText(running ? "Listing {path}" : "Listed {path}", {
          path,
        }),
      };
  }
  if (named && n === 1 && kind === "web") {
    const query =
      typeof items[0].query === "string" ? items[0].query.trim() : "";
    if (query)
      return {
        verb: formatText(
          running ? "Searching web {query}" : "Searched web {query}",
          { query },
        ),
      };
  }
  if (kind === "search") {
    const queries = searchQueries(items);
    return text(
      queries.length === 1
        ? `${running ? "searching" : "searched"} for ${queries[0]}`
        : `${running ? "searching" : "searched"} ${n === 1 ? "files" : `${n} times`}`,
    );
  }
  if (kind === "list")
    return text(
      `${running ? "listing" : "listed"} ${n === 1 ? "files" : `files ${n} times`}`,
    );
  if (kind === "tool") {
    // "Used 2 tools (1 failed)".
    const bad = items.filter(failed).length;
    const label = `${running ? "using" : "used"} ${plural(n, "tool")}`;
    return failedNote(text(label), bad && !running ? bad : 0);
  }
  if (kind === "web")
    return text(
      `${running ? "searching" : "searched"} the web${n > 1 ? ` ${n} times` : ""}`,
    );
  const bad = items.filter(failed).length;
  const label = `${running ? "running" : "ran"} ${plural(n, "command")}`;
  return failedNote(text(label), bad && !running ? bad : 0);
}

/*
 * In a summary a listing counts as a command: "Ran 3 commands (1 failed), read
 * 3 files" covers ls and git diff. A single listing row still says "Listed
 * files".
 */
const summaryKind = (item: Item) => {
  const kind = toolKind(item);
  return kind === "list" ? "command" : kind;
};

/**
 * Summary of one or more folded tool calls. Kinds appear in the order they
 * first ran.
 */
export function toolSummaryParts(items: Item[]): Part[] {
  const running = items.some(itemIsRunning);
  const byKind = new Map<ToolKind, Item[]>();
  for (const item of items) {
    const kind =
      running || items.length === 1 ? toolKind(item) : summaryKind(item);
    if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), item]);
  }
  // While running, the row names what is happening now: the running command's
  // own description when the model wrote one, else its kind.
  const latest = running ? items.filter(itemIsRunning).at(-1)! : undefined;
  const described = latest && commandDescriptionText(latest, "running", true);
  if (described) return [{ verb: described }];
  const current = latest ? toolKind(latest) : undefined;
  const kinds = current ? [current] : [...byKind.keys()];
  const parts = kinds.map((kind) =>
    part(
      kind,
      current
        ? items.filter((i) => itemIsRunning(i) && toolKind(i) === kind)
        : byKind.get(kind)!,
      Boolean(current),
      Boolean(current) || items.length === 1,
    ),
  );
  if (parts[0])
    parts[0] = {
      ...parts[0],
      verb: parts[0].verb.charAt(0).toUpperCase() + parts[0].verb.slice(1),
    };
  return parts;
}

export function toolSummary(items: Item[]): string {
  return toolSummaryParts(items)
    .map((p) => (p.name ? `${p.verb} ${p.name}` : p.verb))
    .join(listSeparator());
}

export type CodeSegment =
  { type: "item"; item: Item } | { type: "tools"; id: string; items: Item[] };

/**
 * Folds consecutive tool calls. Reasoning between them does not split a run;
 * messages, file edits, plans and agents do. The Thinking and Verbose
 * transcript views (`fold: false`) fold nothing: every tool call is its own row
 * and the reasoning between them stays, in order.
 */
export function codeSegments(
  items: Item[],
  { fold = true }: { fold?: boolean } = {},
): CodeSegment[] {
  if (!fold)
    return items.map((item) =>
      toolKind(item)
        ? { type: "tools", id: item.id, items: [item] }
        : { type: "item", item },
    );
  const out: CodeSegment[] = [];
  let run: Item[] = [];
  const flush = () => {
    if (run.length) out.push({ type: "tools", id: run[0].id, items: run });
    run = [];
  };
  for (const item of items) {
    if (toolKind(item)) run.push(item);
    else if (item.type === "reasoning" && run.length) continue;
    else {
      flush();
      out.push({ type: "item", item });
    }
  }
  flush();
  return out;
}

/** Status-line elapsed time: "9s", "4m 53s", "1h 2m". */
export function formatElapsed(seconds: number) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Status-line tokens: "46 tokens", "4.0k tokens". */
export function formatTokens(tokens: number) {
  if (tokens < 1000) return `${tokens} ${tokens === 1 ? "token" : "tokens"}`;
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
}
