import fs from "node:fs";
import path from "node:path";
import type { ConnectorOAuthClient } from "../../shared/custom-connector";

export class ConnectorClients {
  private file: string;
  private clients: Record<
    string,
    ConnectorOAuthClient & { resource?: string }
  > = Object.create(null);
  constructor(profile: string) {
    this.file = path.join(profile, "connector-clients.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        for (const [name, value] of Object.entries(saved)) {
          const client = value as ConnectorOAuthClient;
          if (typeof client?.clientId === "string") this.clients[name] = client;
        }
    } catch {}
  }
  get(name: string, resource?: string) {
    const client = Object.hasOwn(this.clients, name)
      ? this.clients[name]
      : undefined;
    return !resource || client?.resource === resource ? client : undefined;
  }
  set(name: string, client?: ConnectorOAuthClient, resource?: string) {
    if (client?.clientId)
      this.clients[name] = { ...client, ...(resource ? { resource } : {}) };
    else delete this.clients[name];
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.clients), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
}

export function connectorOAuthClient(
  input: ConnectorOAuthClient,
): ConnectorOAuthClient | undefined {
  const clientId =
    typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret =
    typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  if (
    [clientId, clientSecret].some(
      (value) => value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value),
    )
  )
    throw Error("Enter a valid OAuth client ID and secret.");
  if (clientSecret && !clientId)
    throw Error("Enter an OAuth client ID to use a client secret.");
  return clientId
    ? { clientId, ...(clientSecret ? { clientSecret } : {}) }
    : undefined;
}
