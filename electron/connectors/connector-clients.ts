import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { connectorOAuthOptions } from "../../shared/connector-oauth-options";
import type {
  ConnectorCredentials,
  ConnectorOAuthClient,
} from "../../shared/custom-connector";

export const connectorHeaderName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]{1,64}$/)
  .refine((name) => !/(?:^|[^A-Za-z0-9])\.|\.(?:[^A-Za-z0-9]|$)/.test(name))
  .transform((name) => name.toLowerCase());
export const connectorHeaderValue = z
  .string()
  .regex(/^[\t\x20-\x7e\x80-\xff]+$/)
  .trim()
  .min(1);
const headerMap = z
  .custom<Record<string, unknown>>(
    (value) =>
      value !== null && typeof value === "object" && !Array.isArray(value),
  )
  .transform(Object.entries)
  .pipe(
    z
      .array(z.tuple([connectorHeaderName, connectorHeaderValue]))
      .max(4)
      .refine(
        (headers) =>
          new Set(headers.map(([name]) => name)).size === headers.length,
      )
      .transform((headers) => Object.fromEntries(headers)),
  );
const credentials = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  headers: headerMap.optional(),
  staticAuth: z.literal(true).optional(),
  oauth: connectorOAuthOptions.optional(),
  resource: z.string().optional(),
});

function hasCredentials(client: ConnectorCredentials | undefined) {
  return (
    client &&
    (client.clientId ||
      client.oauth ||
      Object.keys(client.headers ?? {}).length)
  );
}

export class ConnectorClients {
  private file: string;
  private clients: Record<
    string,
    ConnectorCredentials & { resource?: string }
  > = Object.create(null);
  constructor(profile: string) {
    this.file = path.join(profile, "connector-clients.json");
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        for (const [name, value] of Object.entries(saved)) {
          const client = credentials.safeParse(value);
          if (client.success && hasCredentials(client.data))
            this.clients[name] = client.data;
        }
    } catch {}
  }
  get(name: string, resource?: string) {
    const client = Object.hasOwn(this.clients, name)
      ? this.clients[name]
      : undefined;
    return !resource || client?.resource === resource ? client : undefined;
  }
  set(name: string, client?: ConnectorCredentials, resource?: string) {
    if (hasCredentials(client))
      this.clients[name] = { ...client, ...(resource ? { resource } : {}) };
    else delete this.clients[name];
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.clients), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, this.file);
  }
}

export function connectorCredentials(
  input: ConnectorCredentials,
): ConnectorCredentials {
  const client = connectorOAuthClient(input);
  const parsed = headerMap.optional().safeParse(input.headers);
  const oauth = connectorOAuthOptions.optional().safeParse(input.oauth);
  const headers = parsed.data;
  if (!oauth.success) throw Error("Enter valid connector OAuth options.");
  if (
    !parsed.success ||
    (input.staticAuth !== undefined && input.staticAuth !== true) ||
    (input.staticAuth &&
      (client || oauth.data || !Object.keys(headers ?? {}).length)) ||
    (!input.staticAuth && headers?.authorization !== undefined)
  )
    throw Error("Enter valid connector request headers.");
  return {
    ...client,
    ...(headers && { headers }),
    ...(input.staticAuth && { staticAuth: true }),
    ...(oauth.data && { oauth: oauth.data }),
  };
}

export function connectorRequestHeaders(
  headers: Record<string, string> | undefined,
  token?: string,
) {
  return token ? { ...headers, Authorization: `Bearer ${token}` } : headers;
}

export function savedConnectorHeaders(
  profile: string,
  name: string,
  resource: unknown,
) {
  return typeof resource === "string"
    ? new ConnectorClients(profile).get(name, resource)?.headers
    : undefined;
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
