export interface ThreadOptions {
  config: Record<string, unknown>;
  developerInstructions: string;
  [key: string]: unknown;
}

/**
 * What a loaded thread keeps until it is loaded again, as a comparable key:
 * its context limits (E0) and its per-thread MCP servers (S1), which Codex
 * does not persist and applies only at start, resume or fork. Chat also
 * reloads its capability instructions and native child-agent policy.
 */
export function limitsKey(options?: ThreadOptions) {
  const mcp = Object.entries(options?.config ?? {})
    .filter(([key]) => key.startsWith("mcp_servers."))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    options?.config.model_context_window ?? null,
    options?.config.model_auto_compact_token_limit ?? null,
    ...(mcp.length ? [mcp] : []),
    options?.config["features.multi_agent"] ?? null,
    options?.environments ? options.developerInstructions : null,
  ]);
}

/** Whether a thread's options carry per-thread MCP servers. */
export function hasThreadMcp(options: ThreadOptions) {
  return Object.keys(options.config).some((key) =>
    key.startsWith("mcp_servers."),
  );
}

/**
 * Options for thread/resume and thread/fork: Codex fixes dynamic tools at
 * thread/start and ignores them later (SP-2), so they are not sent again.
 */
export function reloadOptions(options: ThreadOptions): ThreadOptions {
  const { dynamicTools: _ignored, ...rest } = options;
  return rest as ThreadOptions;
}
