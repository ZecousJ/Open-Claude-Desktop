import type { DynamicToolSpec } from "./engine-extensions";

export interface ThreadOptions {
  config: Record<string, unknown>;
  developerInstructions: string;
  dynamicTools?: DynamicToolSpec[];
  [key: string]: unknown;
}

/**
 * What a loaded thread keeps until it is loaded again, as a comparable key:
 * its cwd, context limits (E0), per-thread MCP servers (S1), web search and Code environment.
 * Codex applies these settings at start, resume or fork. Developer
 * instructions are supplied to each turn; child-agent policy remains thread-scoped.
 */
export function limitsKey(options?: ThreadOptions) {
  const mcp = Object.entries(options?.config ?? {})
    .filter(([key]) => key.startsWith("mcp_servers."))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    options?.cwd ?? null,
    options?.config.model_context_window ?? null,
    options?.config.model_auto_compact_token_limit ?? null,
    ...(mcp.length ? [mcp] : []),
    options?.config["features.multi_agent"] ?? null,
    options?.config["shell_environment_policy.set"] ?? null,
    options?.config.web_search ?? "disabled",
  ]);
}

/** Whether a thread's options carry per-thread MCP servers. */
export function hasThreadMcp(options: ThreadOptions) {
  return Object.keys(options.config).some((key) => {
    if (!key.startsWith("mcp_servers.")) return false;
    const server = key.slice(0, key.lastIndexOf("."));
    return options.config[`${server}.enabled`] !== false;
  });
}

/**
 * Options for thread/resume and thread/fork: Codex fixes dynamic tools at
 * thread/start and ignores them later (SP-2), so they are not sent again.
 */
export function reloadOptions(options: ThreadOptions): ThreadOptions {
  const { dynamicTools: _ignored, ...rest } = options;
  return rest as ThreadOptions;
}
