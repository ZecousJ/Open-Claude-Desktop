import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConnectorOAuth } from "../../runner/src/connector-oauth";
import { ConnectorTokens } from "../../runner/src/connectors";

const resource = "https://mcp.example.com/mcp";
const issuer = "https://auth.example.com";
const callback = "https://claudex.example.com/task/one?cowork_connector=1";

function setup(context: TestContext) {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-connector-oauth-"),
  );
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const tokens = new ConnectorTokens(profile);
  const calls: { address: string; init?: RequestInit }[] = [];
  let current = true;
  let changed = 0;
  let advertisedIssuer = issuer;
  let huge = false;
  const request = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const address = String(input);
    calls.push({ address, init });
    if (huge) return new Response("x".repeat(1024 * 1024 + 1));
    if (address.includes("oauth-protected-resource"))
      return Response.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ["read", "write"],
      });
    if (address.includes("oauth-authorization-server"))
      return Response.json({
        issuer: advertisedIssuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        code_challenge_methods_supported: ["S256"],
      });
    if (address.endsWith("/register"))
      return Response.json({ client_id: "public-client" });
    if (address.endsWith("/token"))
      return Response.json({
        access_token: "private-bearer",
        refresh_token: "private-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
    throw new Error(`Unexpected request: ${address}`);
  }) as typeof fetch;
  const oauth = new ConnectorOAuth(
    profile,
    "https://claudex.example.com",
    request,
    tokens,
    () => {
      changed++;
    },
    () => current,
  );
  context.after(() => oauth.close());
  return {
    oauth,
    tokens,
    profile,
    calls,
    changed: () => changed,
    disconnect: () => {
      current = false;
    },
    mismatchIssuer: () => {
      advertisedIssuer = "https://wrong.test";
    },
    oversized: () => {
      huge = true;
    },
  };
}

test("custom OAuth credentials skip registration and authenticate the token exchange", async (context) => {
  const { oauth, calls, tokens } = setup(context);
  const address = new URL(
    await oauth.begin("Example", resource, callback, {
      clientId: "custom-client",
      clientSecret: "private-secret",
    }),
  );
  assert.equal(address.searchParams.get("client_id"), "custom-client");
  assert.equal(
    calls.some((call) => call.address.endsWith("/register")),
    false,
  );
  await oauth.complete(address.searchParams.get("state")!, "code");
  const exchange = calls.find((call) => call.address.endsWith("/token"))!;
  assert.equal(
    new Headers(exchange.init?.headers).get("Authorization"),
    `Basic ${Buffer.from("custom-client:private-secret").toString("base64")}`,
  );
  assert.equal(String(exchange.init?.body).includes("private-secret"), false);
  assert.equal(tokens.get("Example"), "private-bearer");
});

test("web connector sign-in discovers metadata, registers a public client and binds PKCE to the signed-in page", async (context) => {
  const { oauth, tokens, calls, changed, profile } = setup(context);
  const address = new URL(await oauth.begin("Notion", resource, callback));
  assert.equal(address.origin, issuer);
  assert.equal(address.searchParams.get("redirect_uri"), callback);
  assert.equal(address.searchParams.get("resource"), resource);
  assert.equal(address.searchParams.get("code_challenge_method"), "S256");
  assert.equal(address.searchParams.get("scope"), "read write");
  const registration = JSON.parse(
    String(
      calls.find((call) => call.address.endsWith("/register"))!.init!.body,
    ),
  );
  assert.deepEqual(registration.redirect_uris, [callback]);
  assert.equal(registration.token_endpoint_auth_method, "none");
  assert.equal(tokens.get("Notion"), undefined);
  const state = address.searchParams.get("state")!;
  assert.equal(await oauth.complete(state, "one-time-code"), "Notion");
  const exchange = new URLSearchParams(String(calls.at(-1)!.init!.body));
  const challenge = createHash("sha256")
    .update(exchange.get("code_verifier")!)
    .digest("base64url");
  assert.equal(challenge, address.searchParams.get("code_challenge"));
  assert.equal(exchange.get("code"), "one-time-code");
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(tokens.get("Notion"), "private-bearer");
  assert.equal(changed(), 1);
  assert.equal(
    fs.statSync(path.join(profile, "connector-oauth.json")).mode & 0o777,
    0o600,
  );
  assert.ok(
    !fs
      .readFileSync(path.join(profile, "connector-oauth.json"), "utf8")
      .includes(exchange.get("code_verifier")!),
  );
  await assert.rejects(oauth.complete(state, "again"));
});

test("OAuth state is per-user, expires, and cannot complete after connector removal or context shutdown", async (context) => {
  const first = setup(context);
  const other = setup(context);
  const address = new URL(
    await first.oauth.begin("Notion", resource, callback),
  );
  const state = address.searchParams.get("state")!;
  await assert.rejects(other.oauth.complete(state, "code"));
  first.disconnect();
  await assert.rejects(first.oauth.complete(state, "code"));
  assert.equal(first.tokens.get("Notion"), undefined);
  const expiring = new URL(
    await other.oauth.begin("Notion", resource, callback),
  );
  context.mock.method(Date, "now", () => 1_000_000_000_000_000);
  await assert.rejects(
    other.oauth.complete(expiring.searchParams.get("state")!, "code"),
  );
  other.oauth.close();
  await assert.rejects(other.oauth.begin("Notion", resource, callback));
});

test("OAuth rejects external callbacks, issuer mismatches and oversized metadata", async (context) => {
  const client = setup(context);
  for (const address of [
    "https://evil.test/callback",
    "https://user@claudex.example.com/callback",
    `${callback}#fragment`,
    "javascript:alert(1)",
  ])
    await assert.rejects(client.oauth.begin("Notion", resource, address));
  assert.equal(client.calls.length, 0);
  client.mismatchIssuer();
  await assert.rejects(client.oauth.begin("Notion", resource, callback));
  const oversized = setup(context);
  oversized.oversized();
  await assert.rejects(oversized.oauth.begin("Notion", resource, callback));
});

test("closing a context while token exchange is pending cannot persist credentials", async (context) => {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-connector-closing-"),
  );
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const tokens = new ConnectorTokens(profile);
  let release!: (response: Response) => void;
  const request = (async (input: string | URL | Request) => {
    const address = String(input);
    if (address.includes("protected-resource"))
      return Response.json({ authorization_servers: [issuer] });
    if (address.includes("authorization-server"))
      return Response.json({
        issuer,
        registration_endpoint: `${issuer}/register`,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        code_challenge_methods_supported: ["S256"],
      });
    if (address.endsWith("register"))
      return Response.json({ client_id: "client" });
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch;
  const oauth = new ConnectorOAuth(
    profile,
    "https://claudex.example.com",
    request,
    tokens,
    () => {},
    () => true,
  );
  context.after(() => oauth.close());
  const address = new URL(await oauth.begin("Notion", resource, callback));
  const exchange = oauth.complete(address.searchParams.get("state")!, "code");
  oauth.close();
  release(
    Response.json({ access_token: "private-bearer", token_type: "Bearer" }),
  );
  await assert.rejects(exchange);
  assert.equal(tokens.get("Notion"), undefined);
});
