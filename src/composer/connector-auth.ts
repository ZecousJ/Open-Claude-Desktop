import type { McpServerState } from "../../shared/settings-desktop-api";
/** Runtime authentication status is authoritative. A failed process or an
 * unknown auth status never becomes a sign-in failure. Bind it to the same
 * configured server URL so replaced connectors cannot inherit old auth state. */
export function canReconnectConnector(
  server: McpServerState | undefined,
  configured: unknown,
  supportsOAuth: boolean,
) {
  if (
    !supportsOAuth ||
    !server ||
    server.authStatus !== "notLoggedIn" ||
    server.state === "disabled" ||
    !configured ||
    typeof configured !== "object"
  )
    return false;
  const config = configured as { url?: unknown; enabled?: unknown };
  if (
    config.enabled === false ||
    typeof config.url !== "string" ||
    server.url !== config.url
  )
    return false;
  try {
    const url = new URL(server.url);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
