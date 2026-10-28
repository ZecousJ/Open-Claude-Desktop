import fs from "node:fs";
import path from "node:path";
import type {
  McpServerState,
  McpToolState,
} from "../../shared/settings-desktop-api";
import { starterConnectorId } from "../../shared/starter-integrations";
import { computerUseServerName } from "../../shared/computer-use";
import {
  alwaysAllowedTools,
  toolApprovalMode,
} from "../../shared/mcp-tool-approval";

export {
  withToolApproval,
  alwaysAllowedTools,
  withoutAlwaysAllowed,
} from "../../shared/mcp-tool-approval";

export const mcpConfigName = "mcp-config.json";

/**
 * Server names Claudex gives its own built-in servers (the engine adds them
 * per conversation). A configured server can't take one: it would never
 * start, and the model would mistake it for the built-in one.
 */
export const reservedMcpServerNames: readonly string[] = Object.freeze([
  computerUseServerName,
]);

/** The reserved name `name` matches (ignoring case), if any. */
export function reservedMcpServerName(name: string): string | undefined {
  const lower = name.toLowerCase();
  return reservedMcpServerNames.find(
    (reserved) => reserved.toLowerCase() === lower,
  );
}

const reservedNameMessage = (name: string) =>
  `The name "${name}" is reserved by Claudex. Choose another name.`;

/** Checks the configuration file's text; returns the server map or throws a readable error. */
export function parseMcpConfig(text: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw Error(
      `The configuration is not valid JSON: ${(error as Error).message}`,
    );
  }
  const servers =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>).mcpServers
      : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers))
    throw Error('The configuration needs an "mcpServers" object.');
  for (const [name, value] of Object.entries(servers)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
      throw Error(
        `"${name.slice(0, 64)}" is not a valid server name. Use letters, numbers, - and _.`,
      );
    if (reservedMcpServerName(name)) throw Error(reservedNameMessage(name));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error(`The server "${name}" must be an object.`);
    const server = value as Record<string, unknown>;
    if (typeof server.command !== "string" && typeof server.url !== "string")
      throw Error(`The server "${name}" needs a "command" or a "url".`);
  }
  return servers as Record<string, unknown>;
}

export const mcpConfigText = (servers: Record<string, unknown>) =>
  JSON.stringify({ mcpServers: servers }, null, 2) + "\n";

/** A remote connector as Settings → Connectors → Add custom connector submits it. */
/** A bearer token as the Authorization header takes it. */
export function validBearerToken(value: unknown) {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (!token) return undefined;
  if (token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token))
    throw new Error("That token isn't valid.");
  return token;
}

export interface CustomConnectorInput {
  replaceName?: string;
  name: string;
  displayName?: string;
  clientId?: string;
  clientSecret?: string;
  transport?: "sse" | "streamable-http";
  connectorId?: import("../../shared/starter-integrations").StarterConnectorId;
  url: string;
  /** The environment variable holding a bearer token; never the token. */
  bearerTokenEnvVar?: string;
  /** The web: the token itself, kept on the runner (never written to settings). */
  bearerToken?: string;
}

/**
 * Checks a custom remote connector and returns its configuration entry
 * (Codex's `url` and `bearer_token_env_var`). The address must be https,
 * or http on this computer; the token variable must not be one Claudex
 * keeps for itself (the gateway token), so a server cannot be handed it.
 */
export function customConnectorEntry(
  input: CustomConnectorInput,
  existing: Record<string, unknown>,
): [string, Record<string, unknown>] {
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    throw Error("Use letters, numbers, - and _ for the name (up to 64).");
  if (reservedMcpServerName(name)) throw Error(reservedNameMessage(name));
  const replacing = input.replaceName;
  const previous = existing[name] as Record<string, unknown> | undefined;
  if (
    replacing !== undefined &&
    (replacing !== name || !previous || typeof previous.url !== "string")
  )
    throw Error("This connector no longer exists.");
  if (name in existing && replacing !== name)
    throw Error(`A connector named “${name}” exists.`);
  let url: URL;
  try {
    url = new URL(String(input?.url ?? "").trim());
  } catch {
    throw Error("Enter the server's full address, starting with https://.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.username ||
    url.password
  )
    throw Error(
      "The address must start with https:// (http:// only for this computer).",
    );
  const entry: Record<string, unknown> = {
    ...(replacing ? previous : {}),
    url: url.href,
  };
  if (replacing && previous?.url !== url.href) {
    delete entry.bearer_token_env_var;
    delete entry.http_headers;
    delete entry.env_http_headers;
  }
  if (input.transport !== undefined) {
    if (input.transport !== "sse" && input.transport !== "streamable-http")
      throw Error("The request failed.");
    entry.claudex_transport = input.transport;
  }
  if (input.displayName !== undefined) {
    if (
      typeof input.displayName !== "string" ||
      !input.displayName.trim() ||
      input.displayName.trim().length > 128
    )
      throw Error("Enter a connector name.");
    const displayName = input.displayName.trim();
    if (
      Object.entries(existing).some(([key, raw]) => {
        if (key === replacing) return false;
        const server = raw as { display_name?: string } | undefined;
        return (
          (server?.display_name ?? key).toLowerCase() ===
          displayName.toLowerCase()
        );
      })
    )
      throw Error(`A connector named ‘${displayName}’ already exists`);
    entry.display_name = displayName;
  }
  if (input.connectorId !== undefined) {
    const identity = starterConnectorId(input.connectorId);
    if (!identity) throw Error("Choose a valid connector.");
    entry.connector_id = identity;
  }
  const variable =
    typeof input.bearerTokenEnvVar === "string"
      ? input.bearerTokenEnvVar.trim()
      : "";
  if (variable) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(variable))
      throw Error("Enter an environment variable name, like MY_SERVER_TOKEN.");
    if (/^CLAUDEX_/i.test(variable) || /^OPENAI_API_KEY$/i.test(variable))
      throw Error("This environment variable is reserved by Claudex.");
    entry.bearer_token_env_var = variable;
  }
  return [name, entry];
}

/**
 * The server's configuration with one tool turned on or off: Codex skips
 * the tools listed in `disabled_tools`.
 */
export function withToolEnabled(
  server: Record<string, unknown>,
  tool: string,
  enabled: boolean,
): Record<string, unknown> {
  const current = Array.isArray(server.disabled_tools)
    ? server.disabled_tools.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  const next = enabled
    ? current.filter((value) => value !== tool)
    : [...new Set([...current, tool])];
  const { disabled_tools: _old, ...rest } = server;
  return next.length ? { ...rest, disabled_tools: next } : rest;
}

/**
 * The MCP configuration as a file the person edits in their own editor
 * (Developer → Edit config). Saving the file applies it.
 */
export class McpConfigFile {
  readonly path: string;
  error?: string;
  private watcher?: fs.FSWatcher;
  private timer?: NodeJS.Timeout;
  constructor(
    root: string,
    private current: () => Record<string, unknown>,
    private apply: (servers: Record<string, unknown>) => void,
    private beforeRead?: () => void,
  ) {
    this.path = path.join(root, mcpConfigName);
  }
  /** Writes the current servers when the file is missing, then watches it. */
  ensure() {
    if (!fs.existsSync(this.path))
      fs.writeFileSync(this.path, mcpConfigText(this.current()), {
        mode: 0o600,
      });
    this.watcher ??= fs.watch(path.dirname(this.path), (_event, name) => {
      if (name !== mcpConfigName) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.reload(), 300);
    });
  }
  reload() {
    let servers: Record<string, unknown>;
    try {
      this.beforeRead?.();
      servers = parseMcpConfig(fs.readFileSync(this.path, "utf8"));
    } catch (error) {
      this.error = (error as Error).message;
      return;
    }
    this.error = undefined;
    if (JSON.stringify(servers) !== JSON.stringify(this.current()))
      this.apply(servers);
  }
  /**
   * Saves servers changed in Settings → Connectors the same way as an edit
   * of the file: the file is rewritten, the policy is checked and the
   * runtime restarts once idle. Throws the reason when it was refused;
   * nothing changes then.
   */
  update(servers: Record<string, unknown>) {
    parseMcpConfig(mcpConfigText(servers));
    this.error = undefined;
    this.apply(servers);
    const refusal = this.error;
    if (refusal) {
      this.error = undefined;
      throw Error(refusal);
    }
    const text = mcpConfigText(this.current());
    try {
      fs.writeFileSync(this.path, text, { mode: 0o600 });
    } catch {
      // The servers are saved in Settings; the file catches up on the next edit.
    }
  }
  close() {
    clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
  }
}

/** `{ approval }` for a tool whose approval mode the configuration sets. */
const approvalOf = (config: Record<string, unknown>, tool: string) => {
  const approval = toolApprovalMode(config, tool);
  return approval ? { approval } : {};
};

/** What a tool's annotations say it does (see McpToolState.access). */
function toolAccess(annotations: unknown): Pick<McpToolState, "access"> {
  if (!annotations || typeof annotations !== "object") return {};
  return {
    access:
      (annotations as { readOnlyHint?: unknown }).readOnlyHint === true
        ? "readOnly"
        : "write",
  };
}

/**
 * Each configured server with the runtime's view of it (Settings →
 * Developer and Connectors): its startup report when there is one, else
 * ready once the runtime lists it; servers switched off are `disabled`,
 * and nothing runs while the runtime is not ready.
 */
export function mcpServerStates(
  configured: Record<string, unknown>,
  runtimeReady: boolean,
  startup: ReadonlyMap<string, { status: string; error?: string }>,
  listed: readonly {
    name: string;
    tools?: Record<string, unknown>;
    authStatus?: string;
  }[],
): McpServerState[] {
  const known = ["starting", "ready", "failed", "cancelled"];
  return Object.entries(configured).map(([name, raw]) => {
    const config = (raw ?? {}) as Record<string, unknown>;
    const started = startup.get(name);
    const live = listed.find((item) => item.name === name);
    const state: McpServerState["state"] =
      config.enabled === false
        ? "disabled"
        : !runtimeReady
          ? "stopped"
          : started && known.includes(started.status)
            ? (started.status as McpServerState["state"])
            : live
              ? "ready"
              : "starting";
    const disabled = Array.isArray(config.disabled_tools)
      ? config.disabled_tools.map(String)
      : [];
    const toolList = Object.entries(live?.tools ?? {})
      .map(([key, raw]) => {
        const tool = (raw ?? {}) as Record<string, unknown>;
        const toolName = typeof tool.name === "string" ? tool.name : key;
        return {
          name: toolName,
          description:
            typeof tool.description === "string"
              ? tool.description.slice(0, 500)
              : "",
          enabled: !disabled.includes(toolName),
          ...approvalOf(config, toolName),
          ...toolAccess(tool.annotations),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // Tools switched off are not reported by the runtime; keep them listed.
    for (const toolName of disabled)
      if (!toolList.some((tool) => tool.name === toolName))
        toolList.push({
          name: toolName,
          description: "",
          enabled: false,
          ...approvalOf(config, toolName),
        });
    const auth = live?.authStatus;
    return {
      name,
      ...(config.claudex_transport === "sse" ||
      config.claudex_transport === "streamable-http"
        ? { transport: config.claudex_transport }
        : {}),
      ...(typeof config.display_name === "string"
        ? { displayName: config.display_name }
        : {}),
      state,
      error: state === "failed" ? started?.error : undefined,
      tools: Object.keys(live?.tools ?? {}).length,
      toolList,
      alwaysAllowed: alwaysAllowedTools({ [name]: config }).length,
      ...(auth === "notLoggedIn" ||
      auth === "oAuth" ||
      auth === "bearerToken" ||
      auth === "unsupported"
        ? { authStatus: auth }
        : {}),
      command:
        typeof config.command === "string"
          ? [config.command, ...(Array.isArray(config.args) ? config.args : [])]
              .map(String)
              .join(" ")
          : undefined,
      url: typeof config.url === "string" ? config.url : undefined,
      ...(typeof config.claudex_extension === "string"
        ? { desktopExtension: true }
        : {}),
      ...(starterConnectorId(config.connector_id)
        ? { connectorId: starterConnectorId(config.connector_id) }
        : {}),
    };
  });
}
