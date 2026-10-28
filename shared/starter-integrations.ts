import type { McpServerState } from "./settings-desktop-api";

export const starterConnectorIds = [
  "google-drive",
  "google-calendar",
  "gmail",
] as const;
export type StarterConnectorId = (typeof starterConnectorIds)[number];
export type StarterIntegration = "drive" | "calendar" | "gmail" | "compass";

export function starterConnectorId(
  value: unknown,
): StarterConnectorId | undefined {
  return starterConnectorIds.find((id) => id === value);
}

// Authenticated integrations gate prompts. Match connector identity, never a
// name substring.
export function starterIntegrations(
  servers: readonly McpServerState[],
): StarterIntegration[] {
  const integrations: StarterIntegration[] = [];
  for (const server of servers) {
    if (server.state !== "ready" || server.authStatus === "notLoggedIn")
      continue;
    const identity = server.connectorId;
    if (identity === "google-drive") integrations.push("drive");
    if (identity === "google-calendar") integrations.push("calendar");
    if (identity === "gmail") integrations.push("gmail");
  }
  return [...new Set(integrations)];
}
