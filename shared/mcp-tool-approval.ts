import type { Approval } from "./types";

/**
 * A connector tool's approval, as Codex 0.144 asks it: an MCP elicitation
 * (`mcpServer/elicitation/request`) whose `_meta` carries
 * `codex_approval_kind: "mcp_tool_call"`, the tool's title and parameters,
 * the connector's name and `persist`, the choices that outlive the request
 * ("session" and/or "always"). The answer is `action: "accept"` with
 * `_meta: { persist: "session" | "always" }`; Codex remembers a "session"
 * choice in memory and writes an "always" one to its config.toml
 * (`mcp_servers.<server>.tools.<tool>.approval_mode = "approve"`), which
 * Claudex also keeps in its own connector settings (see
 * `withToolApproval`), because it writes that file anew at every start.
 * Verified against the strings of the pinned codex-cli 0.144.1 and its
 * generated app-server schema (the schema leaves `_meta` open).
 */
export const mcpToolApprovalKind = "mcp_tool_call";

export type McpPersist = "session" | "always";

export interface McpToolApproval {
  /** The configured server's name (`serverName`). */
  server: string;
  /** The tool's own name, when the request names it. */
  tool?: string;
  /** What the sentence calls the tool: its title, else its name. */
  title?: string;
  /** The connector's own name, when it differs from the server's key. */
  connector?: string;
  /** The parameters the call passes, as readable lines (never raw JSON). */
  rows: { label: string; value: string }[];
  /** Which choices outlive this request. */
  persist: Record<McpPersist, boolean>;
}

const text = (value: unknown, limit = 200) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;

function persistOptions(meta: Record<string, unknown>) {
  const raw = meta.persist;
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return {
    session: values.includes("session"),
    always: values.includes("always"),
  };
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

const rowValue = (value: unknown) => {
  const shown = display(value).replace(/\s+/g, " ").trim();
  return shown.length > 400 ? `${shown.slice(0, 400)}…` : shown;
};

/** The parameter lines: `tool_params_display` when Codex sends it, else the raw `tool_params`. */
function paramRows(meta: Record<string, unknown>) {
  const rows: McpToolApproval["rows"] = [];
  const shown = meta.tool_params_display;
  if (Array.isArray(shown)) {
    for (const entry of shown.slice(0, 40)) {
      const item = (entry ?? {}) as Record<string, unknown>;
      const label = text(item.display_name) ?? text(item.name);
      if (label) rows.push({ label, value: rowValue(item.value) });
    }
    if (rows.length) return rows;
  }
  const params = meta.tool_params;
  if (params && typeof params === "object" && !Array.isArray(params))
    for (const [key, value] of Object.entries(params).slice(0, 40))
      rows.push({ label: key.slice(0, 80), value: rowValue(value) });
  return rows;
}

/** The request as a connector tool approval; undefined for any other elicitation. */
export function mcpToolApproval(
  approval: Pick<Approval, "method" | "params">,
): McpToolApproval | undefined {
  if (approval.method !== "mcpServer/elicitation/request") return undefined;
  const params = (approval.params ?? {}) as Record<string, unknown>;
  const meta = params._meta;
  if (
    params.mode === "url" ||
    !meta ||
    typeof meta !== "object" ||
    Array.isArray(meta)
  )
    return undefined;
  const fields = meta as Record<string, unknown>;
  if (fields.codex_approval_kind !== mcpToolApprovalKind) return undefined;
  const server = text(params.serverName, 100) ?? "";
  const message = typeof params.message === "string" ? params.message : "";
  const named = /to run tool "([^"]{1,200})"/.exec(message)?.[1];
  const tool = text(fields.tool_name) ?? named;
  const title = text(fields.tool_title) ?? tool;
  const connector = text(fields.connector_name, 100);
  return {
    server,
    ...(tool ? { tool } : {}),
    ...(title ? { title } : {}),
    ...(connector && connector !== server ? { connector } : {}),
    rows: paramRows(fields),
    persist: persistOptions(fields),
  };
}

/** The choice "Always allow" stands for: the persistent one when offered, else this session's. */
export function alwaysScope(info: McpToolApproval): McpPersist | undefined {
  return info.persist.always
    ? "always"
    : info.persist.session
      ? "session"
      : undefined;
}

/** The JSON-RPC result of a connector tool approval's three buttons. */
export function mcpToolApprovalResponse(
  info: McpToolApproval,
  choice: "deny" | "always" | "once",
): unknown {
  if (choice === "deny")
    return { action: "decline", content: null, _meta: null };
  const scope = choice === "always" ? alwaysScope(info) : undefined;
  return {
    action: "accept",
    content: null,
    _meta: scope ? { persist: scope } : null,
  };
}

/**
 * The request as the engine hands it to a window: "always" is dropped from
 * `persist` where it could not be kept (no configured connector of that
 * name, no tool name) or the administrator turned persistent grants off.
 */
export function withOfferedPersist(
  params: Record<string, unknown>,
  options: { configured: boolean; alwaysAllowed: boolean },
): Record<string, unknown> {
  const meta = params._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return params;
  const fields = meta as Record<string, unknown>;
  if (fields.codex_approval_kind !== mcpToolApprovalKind) return params;
  const info = mcpToolApproval({
    method: "mcpServer/elicitation/request",
    params,
  } as Approval);
  if (!info) return params;
  const keep: McpPersist[] = [];
  if (options.alwaysAllowed) {
    if (info.persist.session) keep.push("session");
    if (info.persist.always && options.configured && info.tool)
      keep.push("always");
  }
  return { ...params, _meta: { ...fields, persist: keep } };
}

// ---------------------------------------------------------------------------
// The per-tool approval mode kept in a connector's settings

/** Codex `AppToolApproval`: "approve" never asks, "prompt" always asks. */
export type ToolApprovalMode = "approve" | "prompt";
export const toolApprovalModes: readonly ToolApprovalMode[] = [
  "approve",
  "prompt",
];

type Server = Record<string, unknown>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The approval mode set for one tool of a server, when there is one. */
export function toolApprovalMode(
  server: Server,
  tool: string,
): ToolApprovalMode | undefined {
  const mode = record(record(record(server.tools)[tool])).approval_mode;
  return toolApprovalModes.find((value) => value === mode);
}

/**
 * The server's configuration with one tool's approval mode set (`undefined`
 * clears it): Codex reads `mcp_servers.<name>.tools.<tool>.approval_mode`.
 * Other per-tool keys stay.
 */
export function withToolApproval(
  server: Server,
  tool: string,
  mode: ToolApprovalMode | undefined,
): Server {
  const tools = { ...record(server.tools) };
  const entry = { ...record(tools[tool]) };
  if (mode) entry.approval_mode = mode;
  else delete entry.approval_mode;
  if (Object.keys(entry).length) tools[tool] = entry;
  else delete tools[tool];
  const { tools: _old, ...rest } = server;
  return Object.keys(tools).length ? { ...rest, tools } : rest;
}

/** Every tool a person chose Always allow for, by server. */
export function alwaysAllowedTools(
  servers: Record<string, unknown>,
): { server: string; tool: string }[] {
  const out: { server: string; tool: string }[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const tools = record(record(raw).tools);
    for (const tool of Object.keys(tools))
      if (toolApprovalMode(record(raw), tool) === "approve")
        out.push({ server: name, tool });
  }
  return out;
}

/** The servers with every "approve" mode removed (Forget); one server's only when named. */
export function withoutAlwaysAllowed(
  servers: Record<string, unknown>,
  only?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(servers)) {
    let next = raw;
    if (!only || only === name) {
      const server = record(raw);
      for (const tool of Object.keys(record(server.tools)))
        if (toolApprovalMode(server, tool) === "approve")
          next = withToolApproval(record(next), tool, undefined);
    }
    out[name] = next;
  }
  return out;
}

/** Whether `value` is a well-formed `tools` table: tool names to `{ approval_mode }` only. */
export function validToolsTable(value: unknown): value is Server {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 500) return false;
  return entries.every(([tool, entry]) => {
    if (!tool || tool.length > 200) return false;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return false;
    return Object.entries(entry).every(
      ([key, mode]) =>
        key === "approval_mode" &&
        toolApprovalModes.includes(mode as ToolApprovalMode),
    );
  });
}
