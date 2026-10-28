import type { Approval, Conversation, Item } from "./types";
import { mcpToolApproval, mcpToolApprovalResponse } from "./mcp-tool-approval";
import type { RoutineAllowed } from "./routines";

/**
 * Codex server requests the approval card answers, and the exact responses
 * each button sends (app-server v2 protocol).
 */
export type ApprovalKind =
  "command" | "fileChange" | "permissions" | "elicitation" | "questions";
export type ApprovalChoice = "deny" | "always" | "once";

export function approvalKind(approval: Approval): ApprovalKind {
  const method = approval.method;
  if (method === "item/commandExecution/requestApproval") return "command";
  if (method === "item/fileChange/requestApproval") return "fileChange";
  if (method === "item/permissions/requestApproval") return "permissions";
  if (method === "mcpServer/elicitation/request") return "elicitation";
  return "questions";
}

type Profile = {
  network?: { enabled: boolean | null } | null;
  fileSystem?: {
    read?: string[] | null;
    write?: string[] | null;
    globScanMaxDepth?: number;
    entries?: unknown[];
  } | null;
};

/** The requested permission profile as a grant: Codex rejects null members in responses. */
export function grantedPermissions(requested: Profile | undefined) {
  const granted: Record<string, unknown> = {};
  if (requested?.network) granted.network = requested.network;
  if (requested?.fileSystem) {
    const fs = Object.fromEntries(
      Object.entries(requested.fileSystem).filter(([, v]) => v != null),
    );
    granted.fileSystem = { read: null, write: null, ...fs };
  }
  return granted;
}

/** The JSON-RPC result for a Deny / Always allow / Allow once choice. */
export function approvalResponse(
  approval: Approval,
  choice: ApprovalChoice,
): unknown {
  const kind = approvalKind(approval);
  if (kind === "command" || kind === "fileChange")
    return {
      decision:
        choice === "deny"
          ? "decline"
          : choice === "always"
            ? "acceptForSession"
            : "accept",
    };
  if (kind === "permissions")
    return choice === "deny"
      ? { permissions: {}, scope: "turn" }
      : {
          permissions: grantedPermissions(approval.params?.permissions),
          scope: choice === "always" ? "session" : "turn",
        };
  if (kind === "elicitation") {
    // A connector tool's approval keeps the choice past this request.
    const tool = mcpToolApproval(approval);
    if (tool) return mcpToolApprovalResponse(tool, choice);
    return {
      action: choice === "deny" ? "decline" : "accept",
      content: null,
      _meta: null,
    };
  }
  throw new Error("Questions are answered with their own response.");
}

export interface PermissionRow {
  label: string;
  value: string;
}

function entryPath(entry: any): string {
  const path = entry?.path;
  if (path?.type === "path") return String(path.path);
  if (path?.type === "glob_pattern") return String(path.pattern);
  if (path?.type === "special") {
    const value = path.value ?? {};
    const names: Record<string, string> = {
      root: "The whole file system",
      minimal: "System files",
      tmpdir: "The temporary folder",
      slash_tmp: "/tmp",
      project_roots: "Project folders",
    };
    const base = names[value.kind] ?? String(value.path ?? value.kind ?? "");
    return value.subpath ? `${base}/${value.subpath}` : base;
  }
  return String(path ?? "");
}

/** Human-readable lines for an additional-permissions request. */
export function permissionRows(
  requested: Profile | undefined,
): PermissionRow[] {
  const rows: PermissionRow[] = [];
  if (requested?.network?.enabled)
    rows.push({ label: "Network", value: "Access the internet" });
  const fs = requested?.fileSystem;
  for (const path of fs?.read ?? []) rows.push({ label: "Read", value: path });
  for (const path of fs?.write ?? [])
    rows.push({ label: "Write", value: path });
  for (const entry of (fs?.entries ?? []) as any[]) {
    const access = entry?.access;
    rows.push({
      label:
        access === "write" ? "Write" : access === "deny" ? "Block" : "Read",
      value: entryPath(entry),
    });
  }
  return rows;
}

export function permissionTitle(requested: Profile | undefined) {
  const rows = permissionRows(requested);
  const network = rows.some((row) => row.label === "Network");
  const files = rows.some((row) => row.label !== "Network");
  return network && !files
    ? "Allow Claudex to access the network?"
    : files && !network
      ? "Allow Claudex to access files outside this folder?"
      : "Allow Claudex to use additional permissions?";
}

export const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The file-change item an edit approval refers to, from the conversation's latest turns. */
export function approvalItem(
  approval: Approval,
  conversation?: Conversation,
): Item | undefined {
  const id = approval.params?.itemId;
  if (!id || !conversation) return;
  for (const turn of [...conversation.turns].reverse()) {
    const item = turn.items.find((value) => value.id === id);
    if (item) return item;
  }
}

function changeKind(change: { kind?: unknown }) {
  return typeof change.kind === "string"
    ? change.kind
    : (change.kind as { type?: string } | undefined)?.type;
}

/**
 * "Allow Claudex to edit app.js?" — write for new files, delete for removals.
 */
export function fileChangeTitle(item: Item | undefined, grantRoot?: string) {
  const changes = item?.changes ?? [];
  if (!changes.length)
    return grantRoot
      ? `Allow Claudex to write in ${basename(grantRoot)}?`
      : "Allow Claudex to edit files?";
  const kinds = new Set(changes.map(changeKind));
  const verb =
    kinds.size === 1 && kinds.has("add")
      ? "write"
      : kinds.size === 1 && kinds.has("delete")
        ? "delete"
        : "edit";
  const files = new Set(changes.map((change) => change.path));
  return `Allow Claudex to ${verb} ${files.size === 1 ? basename(changes[0].path) : `${files.size} files`}?`;
}

/**
 * "Allow Claudex to run {command}?" with the whole command on one line; the
 * card clamps the title to two lines.
 */
export function commandTitle(params: any) {
  const command =
    typeof params?.command === "string"
      ? params.command.trim().replace(/\s*\n\s*/g, " ")
      : "";
  if (params?.networkApprovalContext?.host)
    return `Allow Claudex to connect to ${params.networkApprovalContext.host}?`;
  return command
    ? `Allow Claudex to run ${command}?`
    : "Allow Claudex to run this command?";
}

// ---------------------------------------------------------------------------
// A routine's "Always allowed" list

/** The directory a path is in. */
function parentDir(path: string) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

function insideDir(path: string, dir: string) {
  return (
    path === dir || path.startsWith(dir + "/") || path.startsWith(dir + "\\")
  );
}

/** The paths an edit approval is about, from its file-change item. */
function changedPaths(approval: Approval, conversation?: Conversation) {
  const item = approvalItem(approval, conversation);
  return (item?.changes ?? [])
    .map((change) => String(change.path ?? ""))
    .filter(Boolean);
}

/**
 * What "Always allow for this task" keeps of an approval: a command by its
 * exact text (or the host it connects to), edits by the folder they are in,
 * extra permissions by the rows asked for. Undefined for a question or a
 * request that cannot be described, which is asked every time.
 */
export function allowedEntryFor(
  approval: Approval,
  conversation?: Conversation,
): RoutineAllowed | undefined {
  const kind = approvalKind(approval);
  const params = approval.params ?? {};
  if (kind === "command") {
    const host = params.networkApprovalContext?.host;
    if (typeof host === "string" && host)
      return { kind: "command", tool: "Network", pattern: host };
    const command =
      typeof params.command === "string" ? params.command.trim() : "";
    return command && command.length <= 2000
      ? { kind: "command", tool: "Run command", pattern: command }
      : undefined;
  }
  if (kind === "fileChange") {
    const root = typeof params.grantRoot === "string" ? params.grantRoot : "";
    if (root) return { kind: "edit", tool: "Edit files", pattern: root };
    const paths = changedPaths(approval, conversation);
    if (!paths.length) return undefined;
    const dirs = [...new Set(paths.map(parentDir))];
    return dirs.length === 1
      ? { kind: "edit", tool: "Edit files", pattern: dirs[0] }
      : undefined;
  }
  if (kind === "permissions") {
    const rows = permissionRows(params.permissions);
    return rows.length
      ? {
          kind: "permission",
          tool: "Extra permissions",
          pattern: rows.map((row) => `${row.label}: ${row.value}`).join("; "),
        }
      : undefined;
  }
  return undefined;
}

/** Whether a routine's "Always allowed" list already covers this request. */
export function allowedByList(
  list: readonly RoutineAllowed[],
  approval: Approval,
  conversation?: Conversation,
): boolean {
  if (!list.length) return false;
  if (approvalKind(approval) === "fileChange") {
    const root =
      typeof approval.params?.grantRoot === "string"
        ? approval.params.grantRoot
        : "";
    const paths = changedPaths(approval, conversation);
    return list.some(
      (entry) =>
        entry.kind === "edit" &&
        entry.pattern !== undefined &&
        (root
          ? entry.pattern === root
          : paths.length > 0 &&
            paths.every((path) => insideDir(path, entry.pattern!))),
    );
  }
  const wanted = allowedEntryFor(approval, conversation);
  return (
    wanted !== undefined &&
    list.some(
      (entry) =>
        entry.kind === wanted.kind &&
        entry.tool === wanted.tool &&
        entry.pattern === wanted.pattern,
    )
  );
}
