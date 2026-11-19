import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ConnectorTokens } from "./connectors";
import type { ConnectorOAuthClient } from "../../shared/custom-connector";
import type { ConnectorOAuthOptions } from "../../shared/connector-oauth-options";
import { defaultClaudexServiceUrl } from "../../shared/claudex-service";

const failure = "The connector didn't return a sign-in page.";
const retryDelay = 60_000;

const authMethod = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);
type AuthMethod = z.infer<typeof authMethod>;

type RevocationDetails = {
  revocationEndpoint?: string | null;
  revocationAuthMethod?: AuthMethod | null;
};

const grantIdentity = z.object({
  name: z.string(),
  resource: z.string(),
});
const client = grantIdentity.extend({
  clientId: z.string(),
  issuer: z.string().optional(),
  clientSecret: z.string().optional(),
  authMethod: authMethod.optional(),
  tokenEndpoint: z.string(),
  revocationEndpoint: z.string().nullish(),
  revocationAuthMethod: authMethod.nullish(),
});
type OAuthClient = z.infer<typeof client>;

interface Authorization extends OAuthClient {
  generation: object;
  requireIssuer: boolean;
  redirectUri: string;
  verifier: string;
  expires: number;
}

const activeGrant = client.extend({
  kind: z.literal("active").default("active"),
  refreshToken: z.string().min(1).optional(),
  refreshAt: z.number().optional(),
  accessExpiresAt: z.number().optional(),
});
const grant = z.union([
  activeGrant,
  grantIdentity.extend({ kind: z.enum(["reconnect", "disconnected"]) }),
]);
type ActiveGrant = z.infer<typeof activeGrant>;
type Grant = z.infer<typeof grant>;

const authorizationServer = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().optional(),
  token_endpoint: z.string().optional(),
  registration_endpoint: z.string().nullish(),
  revocation_endpoint: z.string().nullish(),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  client_id_metadata_document_supported: z.boolean().optional(),
});
type AuthorizationServer = z.infer<typeof authorizationServer>;

const protectedResource = z.object({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});
const tokenResponse = z.object({
  access_token: z.string().regex(/^[\x21-\x7e]{1,8192}$/),
  token_type: z.string().refine((type) => type.toLowerCase() === "bearer"),
  refresh_token: z.string().min(1).nullish(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/)]).optional(),
});

class OAuthEndpointError extends Error {
  constructor(
    readonly status: number,
    readonly oauthCode?: string,
  ) {
    super(failure);
  }
}

export class ConnectorOAuthRevocationError extends Error {
  constructor(readonly reason: "unavailable" | "provider" | "retired") {
    super(
      {
        unavailable: "Sign-out is unavailable for this connector.",
        provider:
          "The connector's provider couldn't revoke its authorization. Try again.",
        retired:
          "This connector operation belongs to a retired account or connector. Open it again.",
      }[reason],
    );
  }
}

function oauthRequest(
  request: typeof fetch,
  address: string,
  init?: RequestInit,
) {
  return request(address, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
}

async function readJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(failure);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1024 * 1024) {
      await reader.cancel();
      throw new Error(failure);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function oauthJson(
  request: typeof fetch,
  address: string,
  init?: RequestInit,
) {
  const response = await oauthRequest(request, address, init);
  if (!response.ok) {
    const body = await readJson(response).catch(() => undefined);
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new OAuthEndpointError(response.status, parsed.data?.error);
  }
  return readJson(response);
}

async function discoverAuthorizationServer(
  issuer: string,
  request: typeof fetch,
) {
  const authority = new URL(issuer);
  const server = authorizationServer.parse(
    await oauthJson(
      request,
      `${authority.origin}/.well-known/oauth-authorization-server${authority.pathname.replace(/\/$/, "")}`,
    ),
  );
  if (server.issuer !== issuer) throw new Error(failure);
  return server;
}

export async function discoverConnectorOAuth(
  resource: string,
  request: typeof fetch,
) {
  const target = new URL(resource);
  const address = `${target.origin}/.well-known/oauth-protected-resource`;
  const metadata = protectedResource.parse(
    await oauthJson(request, address + target.pathname).catch(() =>
      oauthJson(request, address),
    ),
  );
  if (metadata.resource && metadata.resource !== resource)
    throw new Error(failure);
  const server = await discoverAuthorizationServer(
    metadata.authorization_servers[0],
    request,
  );
  return { metadata, server };
}

function formComponent(value: string) {
  return new URLSearchParams([["", value]]).toString().slice(1);
}

function clientForm(
  client: OAuthClient,
  method: AuthMethod | undefined,
  values: Record<string, string>,
): RequestInit {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  const body = new URLSearchParams(values);
  if (client.clientSecret && method === "client_secret_basic") {
    const credentials = `${formComponent(client.clientId)}:${formComponent(client.clientSecret)}`;
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(credentials).toString("base64")}`,
    );
  } else {
    body.set("client_id", client.clientId);
    if (client.clientSecret && method === "client_secret_post")
      body.set("client_secret", client.clientSecret);
  }
  return { method: "POST", headers, body: body.toString() };
}

function revocationDetails(server: AuthorizationServer, hasSecret: boolean) {
  const methods = server.revocation_endpoint_auth_methods_supported ?? [
    "client_secret_basic",
  ];
  const method = hasSecret
    ? ((["client_secret_basic", "client_secret_post", "none"] as const).find(
        (method) => methods.includes(method),
      ) ?? null)
    : "none";
  return {
    revocationEndpoint: server.revocation_endpoint ?? null,
    revocationAuthMethod: method,
  };
}

export class ConnectorOAuth {
  private pending = new Map<string, Authorization>();
  private grants = new Map<string, Grant>();
  private generations = new Map<string, Map<string, object>>();
  private operations = new Map<string, Promise<unknown>>();
  private file: string;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(
    profile: string,
    private serviceUrl: string,
    private request: typeof fetch,
    private tokens: ConnectorTokens,
    private changed: (name: string) => void,
    private current: (name: string, resource: string) => boolean,
  ) {
    this.file = path.join(profile, "connector-oauth.json");
    const saved = z.record(z.string(), z.unknown()).safeParse(this.readSaved());
    let expired = false;
    for (const [name, value] of Object.entries(saved.data ?? {})) {
      const parsed = grant.safeParse(value);
      if (!parsed.success || parsed.data.name !== name) continue;
      const legacy = value && typeof value === "object" && !("kind" in value);
      if (legacy && !this.tokens.get(name)) continue;
      const entry = parsed.data;
      if (entry.kind !== "active") {
        this.tokens.set(name, undefined);
      } else if (
        entry.accessExpiresAt !== undefined &&
        entry.accessExpiresAt <= Date.now()
      ) {
        this.tokens.set(name, undefined);
        if (!entry.refreshToken) {
          this.grants.set(name, {
            kind: "reconnect",
            name,
            resource: entry.resource,
          });
          expired = true;
          continue;
        }
      }
      this.grants.set(name, entry);
    }
    if (expired) this.save();
    this.schedule();
  }

  private readSaved(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      return undefined;
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.pending.clear();
    this.generations.clear();
  }

  resume() {
    this.advance();
  }

  private save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(
      temporary,
      JSON.stringify(Object.fromEntries(this.grants)),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, this.file);
  }

  private generation(name: string, resource: string) {
    let resources = this.generations.get(name);
    if (!resources) this.generations.set(name, (resources = new Map()));
    let generation = resources.get(resource);
    if (!generation) resources.set(resource, (generation = {}));
    return generation;
  }

  private invalidate(name: string, resource: string) {
    const resources = this.generations.get(name);
    resources?.delete(resource);
    if (!resources?.size) this.generations.delete(name);
    for (const [state, attempt] of this.pending)
      if (attempt.name === name && attempt.resource === resource)
        this.pending.delete(state);
  }

  private isCurrent(name: string, resource: string, generation: object) {
    return (
      !this.closed &&
      this.generations.get(name)?.get(resource) === generation &&
      this.current(name, resource)
    );
  }

  private serialize<T>(name: string, run: () => Promise<T>) {
    const previous = this.operations.get(name);
    const operation = previous ? previous.then(run, run) : run();
    this.operations.set(name, operation);
    const settled = () => {
      if (this.operations.get(name) === operation) this.operations.delete(name);
      this.schedule();
    };
    void operation.then(settled, settled);
    return operation;
  }

  status(
    name: string,
    resource: string,
  ): "connected" | "reconnect" | "disconnected" | undefined {
    const entry = this.grants.get(name);
    if (entry?.resource !== resource) return undefined;
    if (entry.kind !== "active") return entry.kind;
    return this.tokens.get(name) &&
      (entry.accessExpiresAt === undefined ||
        entry.accessExpiresAt > Date.now())
      ? "connected"
      : "reconnect";
  }

  forget(name: string, resource: string) {
    if (this.closed) return;
    this.invalidate(name, resource);
    const entry = this.grants.get(name);
    if (entry && entry.resource !== resource) return;
    if (this.grants.delete(name)) this.save();
    this.tokens.set(name, undefined);
    this.schedule();
  }

  rejectAccess(name: string, resource: string, bearer: string) {
    const entry = this.grants.get(name);
    if (
      this.closed ||
      entry?.kind !== "active" ||
      entry.resource !== resource ||
      this.tokens.get(name) !== bearer ||
      !this.current(name, resource)
    )
      return;
    if (entry.refreshToken) {
      entry.refreshAt = Date.now();
      entry.accessExpiresAt = entry.refreshAt;
      this.save();
      this.tokens.set(name, undefined);
      this.schedule();
      this.changed(name);
    } else {
      this.disconnect(name, resource, "reconnect");
    }
  }

  async begin(
    name: string,
    resource: string,
    returnUrl: string,
    supplied?: ConnectorOAuthClient & { oauth?: ConnectorOAuthOptions },
  ) {
    if (this.closed || !this.current(name, resource)) throw new Error(failure);
    const redirect = new URL(returnUrl);
    if (
      redirect.origin !== new URL(this.serviceUrl).origin ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      !["https:", "http:"].includes(redirect.protocol)
    )
      throw new Error(failure);
    const generation = this.generation(name, resource);
    const override = supplied?.oauth?.overrides;
    const discovered = override?.discovery
      ? undefined
      : await discoverConnectorOAuth(resource, this.request);
    const server: AuthorizationServer | undefined =
      override?.discovery ?? discovered?.server;
    const native =
      redirect.protocol === "http:" && redirect.hostname === "127.0.0.1";
    const registration = supplied?.oauth?.registration;
    const scopes =
      override?.request_parameters?.scopes ??
      discovered?.metadata.scopes_supported;
    if (
      !server?.authorization_endpoint ||
      !server.token_endpoint ||
      (discovered &&
        !discovered.server.code_challenge_methods_supported?.includes(
          "S256",
        )) ||
      (registration === "cimd" &&
        discovered &&
        discovered.server.client_id_metadata_document_supported !== true)
    )
      throw new Error(failure);
    const address = new URL(server.authorization_endpoint);
    if (address.protocol !== "https:") throw new Error(failure);
    let clientId: string;
    if (registration === "cimd") {
      const identityOrigin = native
        ? defaultClaudexServiceUrl
        : redirect.origin;
      if (!identityOrigin.startsWith("https://")) throw new Error(failure);
      clientId = new URL(
        native ? "/mcp/desktop-client.json" : "/mcp/web-client.json",
        identityOrigin,
      ).href;
    } else if (supplied?.clientId) {
      clientId = supplied.clientId;
    } else {
      if (!server.registration_endpoint) throw new Error(failure);
      const result = await oauthJson(
        this.request,
        server.registration_endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Claudex",
            application_type: native ? "native" : "web",
            redirect_uris: [redirect.href],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        },
      );
      clientId = z.object({ client_id: z.string() }).parse(result).client_id;
    }
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    for (const [key, pending] of this.pending)
      if (pending.expires <= Date.now()) this.pending.delete(key);
    if (!this.isCurrent(name, resource, generation) || this.pending.size >= 16)
      throw new Error(failure);
    const methods = server.token_endpoint_auth_methods_supported;
    this.pending.set(state, {
      name,
      resource,
      generation,
      clientId,
      issuer: server.issuer,
      requireIssuer: registration === "cimd",
      ...(supplied?.clientSecret
        ? {
            clientSecret: supplied.clientSecret,
            authMethod:
              !methods?.length || methods.includes("client_secret_basic")
                ? "client_secret_basic"
                : methods.includes("client_secret_post")
                  ? "client_secret_post"
                  : methods.includes("none")
                    ? "none"
                    : "client_secret_post",
          }
        : {}),
      ...(discovered || server.revocation_endpoint !== undefined
        ? revocationDetails(server, !!supplied?.clientSecret)
        : {}),
      tokenEndpoint: server.token_endpoint,
      redirectUri: redirect.href,
      verifier,
      expires: Date.now() + 10 * 60_000,
    });
    const parameters = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect.href,
      state,
      resource,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(scopes ? { scope: scopes.join(" ") } : {}),
    });
    for (const [key, value] of parameters) address.searchParams.set(key, value);
    return address.href;
  }

  pendingName(state: string) {
    const attempt = this.pending.get(state);
    if (
      attempt &&
      attempt.expires > Date.now() &&
      this.isCurrent(attempt.name, attempt.resource, attempt.generation)
    )
      return attempt.name;
  }

  cancel(state: string, expectedName?: string) {
    const name = this.pendingName(state);
    if (
      name === undefined ||
      (expectedName !== undefined && name !== expectedName)
    )
      return;
    this.pending.delete(state);
    return name;
  }

  async complete(
    state: string,
    code: string,
    issuer?: string,
    expectedName?: string,
  ) {
    const attempt = this.pending.get(state);
    if (
      !attempt ||
      (expectedName !== undefined && expectedName !== attempt.name)
    )
      throw new Error(failure);
    this.pending.delete(state);
    const {
      generation,
      requireIssuer,
      redirectUri,
      verifier,
      expires,
      ...client
    } = attempt;
    const { name, resource } = client;
    if (
      !code ||
      ((issuer !== undefined || requireIssuer) && issuer !== client.issuer)
    )
      throw new Error(failure);
    return this.serialize(name, async () => {
      if (expires <= Date.now() || !this.isCurrent(name, resource, generation))
        throw new Error(failure);
      const result = await this.exchange(client, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      if (!this.isCurrent(name, resource, generation)) throw new Error(failure);
      this.keep(client, result);
      return name;
    });
  }

  private async exchange(client: OAuthClient, values: Record<string, string>) {
    return tokenResponse.parse(
      await oauthJson(
        this.request,
        client.tokenEndpoint,
        clientForm(client, client.authMethod, {
          ...values,
          resource: client.resource,
        }),
      ),
    );
  }

  private keep(
    client: OAuthClient,
    result: z.infer<typeof tokenResponse>,
    previousRefresh?: string,
  ) {
    const now = Date.now();
    const seconds = Number(result.expires_in);
    const lifetime =
      Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
    const refreshToken = result.refresh_token ?? previousRefresh;
    const accessExpiresAt = lifetime === undefined ? undefined : now + lifetime;
    const refreshInterval = lifetime ?? 3600_000;
    const refreshAt = refreshToken
      ? now +
        (refreshInterval === 0
          ? retryDelay
          : refreshInterval - Math.min(120_000, refreshInterval / 10))
      : undefined;
    const entry: Grant =
      lifetime === 0 && !refreshToken
        ? { kind: "reconnect", name: client.name, resource: client.resource }
        : {
            ...client,
            kind: "active",
            refreshToken,
            refreshAt,
            accessExpiresAt,
          };
    this.grants.set(client.name, entry);
    this.save();
    this.tokens.set(
      client.name,
      lifetime === 0 ? undefined : result.access_token,
    );
    this.changed(client.name);
  }

  async revoke(
    name: string,
    resource: string,
    options?: { legacyOAuth?: boolean },
  ): Promise<"revoked" | "disconnected"> {
    if (this.closed) throw new ConnectorOAuthRevocationError("retired");
    const generation = this.generation(name, resource);
    const assertCurrent = () => {
      if (!this.isCurrent(name, resource, generation))
        throw new ConnectorOAuthRevocationError("retired");
    };
    return this.serialize(name, async () => {
      const entry = this.grants.get(name);
      if (
        entry?.kind === "disconnected" &&
        entry.resource === resource &&
        !this.closed &&
        this.current(name, resource)
      )
        return "disconnected";
      assertCurrent();
      const accessToken = this.tokens.get(name);
      if (!entry) {
        if (!options?.legacyOAuth || !accessToken)
          throw new ConnectorOAuthRevocationError("unavailable");
        this.disconnect(name, resource, "disconnected");
        return "disconnected";
      }
      if (entry.resource !== resource)
        throw new ConnectorOAuthRevocationError("unavailable");
      let outcome: "revoked" | "disconnected" = "disconnected";
      if (entry.kind === "active") {
        const token = entry.refreshToken ?? accessToken;
        if (token) {
          const { revocationEndpoint, revocationAuthMethod } =
            await this.revocation(entry);
          assertCurrent();
          if (revocationEndpoint) {
            if (revocationAuthMethod === null)
              throw new ConnectorOAuthRevocationError("unavailable");
            const address = URL.parse(revocationEndpoint);
            if (
              address?.protocol !== "https:" ||
              address.username ||
              address.password
            )
              throw new ConnectorOAuthRevocationError("unavailable");
            const response = await oauthRequest(
              this.request,
              address.href,
              clientForm(entry, revocationAuthMethod, {
                token,
                token_type_hint: entry.refreshToken
                  ? "refresh_token"
                  : "access_token",
              }),
            ).catch(() => {
              assertCurrent();
              throw new ConnectorOAuthRevocationError("provider");
            });
            void response.body?.cancel().catch(() => {});
            assertCurrent();
            if (response.status !== 200 && response.status !== 204)
              throw new ConnectorOAuthRevocationError("provider");
            outcome = "revoked";
          }
        }
      }
      assertCurrent();
      this.disconnect(name, resource, "disconnected");
      return outcome;
    });
  }

  private async revocation(entry: ActiveGrant): Promise<RevocationDetails> {
    if (entry.revocationEndpoint !== undefined) return entry;
    try {
      const server = entry.issuer
        ? await discoverAuthorizationServer(entry.issuer, this.request)
        : (await discoverConnectorOAuth(entry.resource, this.request)).server;
      if (!entry.issuer && server.token_endpoint !== entry.tokenEndpoint)
        throw new ConnectorOAuthRevocationError("unavailable");
      return revocationDetails(server, !!entry.clientSecret);
    } catch (error) {
      if (error instanceof OAuthEndpointError && error.status === 404)
        return { revocationEndpoint: null };
      if (error instanceof ConnectorOAuthRevocationError) throw error;
      throw new ConnectorOAuthRevocationError("provider");
    }
  }

  private disconnect(
    name: string,
    resource: string,
    kind: "reconnect" | "disconnected",
  ) {
    if (kind === "disconnected") this.invalidate(name, resource);
    this.grants.set(name, { kind, name, resource });
    this.save();
    this.tokens.set(name, undefined);
    this.changed(name);
  }

  private schedule() {
    clearTimeout(this.timer);
    if (this.closed) return;
    let next = Infinity;
    const now = Date.now();
    for (const entry of this.grants.values()) {
      if (entry.kind !== "active") continue;
      const accessExpiry = this.tokens.get(entry.name)
        ? entry.accessExpiresAt
        : undefined;
      const refreshAt =
        entry.refreshToken && !this.operations.has(entry.name)
          ? entry.refreshAt
          : undefined;
      const due = Math.min(accessExpiry ?? Infinity, refreshAt ?? Infinity);
      next = Math.min(
        next,
        due <= now && !this.current(entry.name, entry.resource)
          ? now + retryDelay
          : due,
      );
    }
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(
      () => this.advance(),
      Math.min(2_147_483_647, Math.max(1, next - now)),
    );
    this.timer.unref?.();
  }

  private advance() {
    if (this.closed) return;
    const now = Date.now();
    for (const entry of this.grants.values()) {
      if (entry.kind !== "active") continue;
      const { name, resource, accessExpiresAt, refreshAt, refreshToken } =
        entry;
      if (!this.current(name, resource)) continue;
      if (
        this.tokens.get(name) &&
        accessExpiresAt !== undefined &&
        accessExpiresAt <= now
      ) {
        if (!refreshToken) {
          this.disconnect(name, resource, "reconnect");
          continue;
        }
        this.tokens.set(name, undefined);
        this.changed(name);
      }
      if (
        !refreshToken ||
        refreshAt === undefined ||
        refreshAt > now ||
        this.operations.has(name)
      )
        continue;
      const generation = this.generation(name, resource);
      void this.serialize(name, () =>
        this.refresh(entry, refreshToken, generation),
      ).catch(() => {});
    }
    this.schedule();
  }

  private async refresh(
    entry: ActiveGrant,
    refreshToken: string,
    generation: object,
  ) {
    const stillCurrent = () =>
      this.grants.get(entry.name) === entry &&
      this.isCurrent(entry.name, entry.resource, generation);
    let result;
    try {
      result = await this.exchange(entry, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
    } catch (error) {
      if (!stillCurrent()) return;
      if (
        error instanceof OAuthEndpointError &&
        (error.status === 400 || error.status === 401) &&
        error.oauthCode &&
        ["invalid_grant", "invalid_client", "unauthorized_client"].includes(
          error.oauthCode,
        )
      ) {
        this.disconnect(entry.name, entry.resource, "reconnect");
      } else {
        entry.refreshAt = Date.now() + retryDelay;
      }
      return;
    }
    if (stillCurrent()) this.keep(entry, result, refreshToken);
  }
}
