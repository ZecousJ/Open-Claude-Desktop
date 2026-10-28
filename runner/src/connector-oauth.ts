import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { ConnectorTokens } from "./connectors";
import type { ConnectorOAuthClient } from "../../shared/custom-connector";

interface Authorization {
  name: string;
  resource: string;
  clientId: string;
  clientSecret?: string;
  authMethod?: string;
  tokenEndpoint: string;
  redirectUri: string;
  verifier: string;
  expires: number;
}

const failure = "The connector didn't return a sign-in page.";

/** Per-user OAuth with PKCE; the callback returns to the signed-in web page. */
export class ConnectorOAuth {
  private pending = new Map<string, Authorization>();
  private file: string;
  private grants: Record<
    string,
    Authorization & { refreshToken: string; refreshAt: number }
  > = {};
  private timer: NodeJS.Timeout;
  private closed = false;
  constructor(
    profile: string,
    private serviceUrl: string,
    private request: typeof fetch,
    private tokens: ConnectorTokens,
    private changed: () => void,
    private current: (name: string, resource: string) => boolean,
  ) {
    this.file = path.join(profile, "connector-oauth.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved))
        for (const [name, value] of Object.entries(saved)) {
          const grant = value as Authorization & {
            refreshToken: string;
            refreshAt: number;
          };
          if (
            grant &&
            grant.name === name &&
            [
              grant.resource,
              grant.clientId,
              grant.tokenEndpoint,
              grant.redirectUri,
              grant.refreshToken,
            ].every((part) => typeof part === "string") &&
            Number.isFinite(grant.refreshAt)
          )
            this.grants[name] = grant;
        }
    } catch {}
    this.timer = setInterval(() => void this.refresh(), 60_000);
    this.timer.unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.pending.clear();
  }
  private save() {
    fs.writeFileSync(this.file, JSON.stringify(this.grants), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  private async json(address: string, init?: RequestInit) {
    const response = await this.request(address, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(failure);
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
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(failure);
    return value;
  }
  async begin(
    name: string,
    resource: string,
    returnUrl: string,
    supplied?: ConnectorOAuthClient,
  ) {
    if (this.closed) throw new Error(failure);
    const redirect = new URL(returnUrl);
    if (
      redirect.origin !== new URL(this.serviceUrl).origin ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      !["https:", "http:"].includes(redirect.protocol)
    )
      throw new Error(failure);
    const target = new URL(resource);
    let metadata;
    try {
      metadata = await this.json(
        `${target.origin}/.well-known/oauth-protected-resource${target.pathname}`,
      );
    } catch {
      metadata = await this.json(
        `${target.origin}/.well-known/oauth-protected-resource`,
      );
    }
    const issuer = metadata.authorization_servers?.[0];
    if (typeof issuer !== "string") throw new Error(failure);
    const authority = new URL(issuer);
    const server = await this.json(
      `${authority.origin}/.well-known/oauth-authorization-server${authority.pathname.replace(/\/$/, "")}`,
    );
    if (
      server.issuer !== issuer ||
      (metadata.resource && metadata.resource !== resource) ||
      (!supplied?.clientId &&
        typeof server.registration_endpoint !== "string") ||
      typeof server.authorization_endpoint !== "string" ||
      typeof server.token_endpoint !== "string" ||
      !server.code_challenge_methods_supported?.includes("S256")
    )
      throw new Error(failure);
    const client = supplied?.clientId
      ? { client_id: supplied.clientId }
      : await this.json(server.registration_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Claudex",
            redirect_uris: [redirect.href],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          }),
        });
    if (typeof client.client_id !== "string") throw new Error(failure);
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    for (const [key, pending] of this.pending)
      if (pending.expires < Date.now()) this.pending.delete(key);
    if (this.closed || this.pending.size >= 16) throw new Error(failure);
    this.pending.set(state, {
      name,
      resource,
      clientId: client.client_id,
      ...(supplied?.clientSecret
        ? {
            clientSecret: supplied.clientSecret,
            authMethod:
              !server.token_endpoint_auth_methods_supported?.length ||
              server.token_endpoint_auth_methods_supported.includes(
                "client_secret_basic",
              )
                ? "client_secret_basic"
                : server.token_endpoint_auth_methods_supported.includes(
                      "client_secret_post",
                    )
                  ? "client_secret_post"
                  : server.token_endpoint_auth_methods_supported.includes(
                        "none",
                      )
                    ? "none"
                    : "client_secret_post",
          }
        : {}),
      tokenEndpoint: server.token_endpoint,
      redirectUri: redirect.href,
      verifier,
      expires: Date.now() + 10 * 60_000,
    });
    const address = new URL(server.authorization_endpoint);
    if (address.protocol !== "https:") throw new Error(failure);
    address.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirect.href,
      state,
      resource,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      ...(Array.isArray(metadata.scopes_supported)
        ? { scope: metadata.scopes_supported.join(" ") }
        : {}),
    }).toString();
    return address.href;
  }
  async complete(state: string, code: string) {
    const grant = this.pending.get(state);
    this.pending.delete(state);
    if (
      !grant ||
      grant.expires < Date.now() ||
      !code ||
      !this.current(grant.name, grant.resource)
    )
      throw new Error(failure);
    const result = await this.exchange(grant, {
      grant_type: "authorization_code",
      code,
      redirect_uri: grant.redirectUri,
      code_verifier: grant.verifier,
    });
    this.keep(grant, result);
    return grant.name;
  }
  private exchange(grant: Authorization, values: Record<string, string>) {
    const basic =
      grant.clientSecret && grant.authMethod === "client_secret_basic";
    return this.json(grant.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(basic
          ? {
              Authorization: `Basic ${Buffer.from(`${grant.clientId}:${grant.clientSecret!}`).toString("base64")}`,
            }
          : {}),
      },
      body: new URLSearchParams({
        ...values,
        ...(!basic ? { client_id: grant.clientId } : {}),
        ...(grant.clientSecret && grant.authMethod === "client_secret_post"
          ? { client_secret: grant.clientSecret }
          : {}),
        resource: grant.resource,
      }).toString(),
    });
  }
  private keep(grant: Authorization, result: Record<string, any>) {
    if (
      this.closed ||
      typeof result.access_token !== "string" ||
      !/^[\x21-\x7e]{1,8192}$/.test(result.access_token) ||
      result.token_type?.toLowerCase() !== "bearer" ||
      !this.current(grant.name, grant.resource)
    )
      throw new Error(failure);
    this.tokens.set(grant.name, result.access_token);
    if (typeof result.refresh_token === "string") {
      this.grants[grant.name] = {
        ...grant,
        verifier: "",
        refreshToken: result.refresh_token,
        refreshAt:
          Date.now() +
          Math.max(60, (Number(result.expires_in) || 3600) - 120) * 1000,
      };
      this.save();
    } else if (this.grants[grant.name]) {
      delete this.grants[grant.name];
      this.save();
    }
    this.changed();
  }
  private refreshing = false;
  private async refresh() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      for (const grant of Object.values(this.grants)) {
        if (
          !this.tokens.get(grant.name) ||
          !this.current(grant.name, grant.resource)
        ) {
          delete this.grants[grant.name];
          this.save();
          continue;
        }
        if (grant.refreshAt > Date.now()) continue;
        try {
          const result = await this.exchange(grant, {
            grant_type: "refresh_token",
            refresh_token: grant.refreshToken,
          });
          this.keep(grant, {
            ...result,
            refresh_token: result.refresh_token ?? grant.refreshToken,
          });
        } catch {
          grant.refreshAt = Date.now() + 60_000;
        }
      }
    } finally {
      this.refreshing = false;
    }
  }
}
