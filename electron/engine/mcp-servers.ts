/**
 * MCP servers that go to a host: those without secret values in their
 * settings (env, headers, bearer tokens stay on this computer).
 */
export function remoteMcpServers(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const secretKeys = [
    "env",
    "http_headers",
    "env_http_headers",
    "bearer_token",
    "bearer_token_env_var",
    "headers",
  ];
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== "object") continue;
    const fields = value as Record<string, unknown>;
    const secret = secretKeys.some((key) => {
      const field = fields[key];
      if (field === undefined || field === null || field === "") return false;
      if (typeof field === "object") return Object.keys(field).length > 0;
      return true;
    });
    if (!secret) result[name] = value;
  }
  return result;
}

/**
 * The app-server requests the window reaches beyond send, retry and
 * interrupt (E0 engine seams), each through its own Engine method.
 */
export const passthroughMethods: readonly string[] = Object.freeze([
  "thread/compact/start",
  "thread/shellCommand",
  "review/start",
  "turn/steer",
]);
