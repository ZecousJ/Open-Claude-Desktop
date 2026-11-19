import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ConnectorOAuth,
  ConnectorOAuthRevocationError,
} from "../../runner/src/connector-oauth";
import { ConnectorTokens } from "../../runner/src/connectors";

const resource = "https://mcp.example.com/mcp";
const issuer = "https://auth.example.com";
const callback = "https://claudex.example.com/task/one?cowork_connector=1";

type Provider = {
  respond?: (form: URLSearchParams) => Response | Promise<Response>;
  revoke?: () => Response | Promise<Response>;
  revocationMethods?: string[];
};

function setup(context: TestContext, provider: Provider = {}) {
  const profile = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-connector-oauth-"),
  );
  context.after(() => fs.rmSync(profile, { recursive: true, force: true }));
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
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        ...(provider.revoke && { revocation_endpoint: `${issuer}/revoke` }),
        revocation_endpoint_auth_methods_supported: provider.revocationMethods,
      });
    if (address.endsWith("/register"))
      return Response.json({ client_id: "public-client" });
    if (address.endsWith("/token"))
      return (
        provider.respond?.(new URLSearchParams(String(init?.body))) ??
        issued("private-bearer", "private-refresh", 3600)
      );
    if (address.endsWith("/revoke") && provider.revoke)
      return provider.revoke();
    throw new Error(`Unexpected request: ${address}`);
  }) as typeof fetch;
  const open = () => {
    const tokens = new ConnectorTokens(profile);
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
    return { oauth, tokens };
  };
  return {
    ...open(),
    open,
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

function issued(access: string, refresh?: string, seconds?: number) {
  return Response.json({
    access_token: access,
    refresh_token: refresh,
    token_type: "Bearer",
    expires_in: seconds,
  });
}

async function stateFor(oauth: ConnectorOAuth, name = "Example") {
  return new URL(await oauth.begin(name, resource, callback)).searchParams.get(
    "state",
  )!;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

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

test("CIMD uses the hosted client identifier and skips dynamic registration", async (context) => {
  const { oauth, calls, tokens } = setup(context);
  const returnUrl = "https://claudex.example.com/mcp/oauth/callback";
  const address = new URL(
    await oauth.begin("CIMD", resource, returnUrl, {
      oauth: { registration: "cimd" },
    }),
  );
  assert.equal(
    address.searchParams.get("client_id"),
    "https://claudex.example.com/mcp/web-client.json",
  );
  assert.equal(address.searchParams.get("redirect_uri"), returnUrl);
  assert.equal(
    calls.some((call) => call.address.endsWith("/register")),
    false,
  );
  await oauth.complete(address.searchParams.get("state")!, "code", issuer);
  assert.equal(tokens.get("CIMD"), "private-bearer");
});

test("explicit discovery and scopes use the provisioned endpoints and keep provider parameters", async (context) => {
  const { oauth, calls } = setup(context);
  const address = new URL(
    await oauth.begin("Provisioned", resource, callback, {
      clientId: "provisioned",
      oauth: {
        registration: "static_per_installation",
        overrides: {
          discovery: {
            issuer,
            authorization_endpoint: issuer + "/authorize?tenant=test",
            token_endpoint: issuer + "/token",
          },
          request_parameters: { scopes: ["one", "two"] },
        },
      },
    }),
  );
  assert.equal(calls.length, 0);
  assert.equal(address.searchParams.get("tenant"), "test");
  assert.equal(address.searchParams.get("scope"), "one two");
  await oauth.complete(address.searchParams.get("state")!, "code");
  assert.equal(calls[0]?.address, issuer + "/token");
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
        client_id_metadata_document_supported: true,
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

test("OAuth refreshes a short grant before expiration and restores the rotated refresh token", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const refreshes: string[] = [];
  const f = setup(context, {
    respond(form) {
      if (form.get("grant_type") === "authorization_code")
        return issued("first", "original", 10);
      refreshes.push(form.get("refresh_token")!);
      return refreshes.length === 1
        ? issued("second", "rotated", 10)
        : issued("third", undefined, 60);
    },
  });
  await f.oauth.complete(await stateFor(f.oauth), "code");
  context.mock.timers.tick(9_000);
  await settle();
  assert.deepEqual(refreshes, ["original"]);
  assert.equal(f.tokens.get("Example"), "second");
  f.oauth.close();
  context.mock.timers.setTime(Date.now() + 15_000);
  const restored = f.open();
  assert.equal(restored.oauth.status("Example", resource), "reconnect");
  assert.equal(restored.tokens.get("Example"), undefined);
  context.mock.timers.tick(1);
  await settle();
  assert.deepEqual(refreshes, ["original", "rotated"]);
  assert.equal(restored.tokens.get("Example"), "third");
  assert.equal(restored.oauth.status("Example", resource), "connected");
});

test("OAuth retains refresh recovery through a temporary outage, then stops on invalid_grant", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let refreshes = 0;
  const f = setup(context, {
    respond(form) {
      if (form.get("grant_type") === "authorization_code")
        return issued("initial", "refresh", 10);
      refreshes++;
      if (refreshes === 1)
        return Response.json(
          { error: "temporarily_unavailable" },
          { status: 503 },
        );
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    },
  });
  await f.oauth.complete(await stateFor(f.oauth), "code");
  context.mock.timers.tick(9_000);
  await settle();
  assert.equal(refreshes, 1);
  assert.equal(f.tokens.get("Example"), "initial");
  context.mock.timers.tick(1_000);
  await settle();
  assert.equal(f.tokens.get("Example"), undefined);
  assert.equal(f.oauth.status("Example", resource), "reconnect");
  context.mock.timers.tick(59_000);
  await settle();
  assert.equal(refreshes, 2);
  f.oauth.close();
  const restored = f.open();
  context.mock.timers.tick(120_000);
  await settle();
  assert.equal(refreshes, 2);
  assert.equal(restored.oauth.status("Example", resource), "reconnect");
  assert.equal(restored.tokens.get("Example"), undefined);
});

test("An access-only OAuth grant loses its bearer on expiration and recovers through a new sign-in", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let logins = 0;
  const f = setup(context, {
    respond() {
      return issued(`access-${++logins}`, undefined, 3);
    },
  });
  await f.oauth.complete(await stateFor(f.oauth), "code");
  assert.equal(f.oauth.status("Example", resource), "connected");
  context.mock.timers.tick(3_000);
  assert.equal(f.tokens.get("Example"), undefined);
  assert.equal(f.oauth.status("Example", resource), "reconnect");
  f.oauth.close();
  const restored = f.open();
  assert.equal(restored.oauth.status("Example", resource), "reconnect");
  await restored.oauth.complete(await stateFor(restored.oauth), "new-code");
  assert.equal(restored.tokens.get("Example"), "access-2");
});

test("OAuth revocation uses the issuer's separate auth method and preserves credentials on refusal", async (context) => {
  let accepts = false;
  const f = setup(context, {
    revoke: () => new Response(null, { status: accepts ? 200 : 503 }),
    revocationMethods: ["client_secret_post"],
  });
  const url = new URL(
    await f.oauth.begin("Example", resource, callback, {
      clientId: "custom-client",
      clientSecret: "private-secret",
    }),
  );
  await f.oauth.complete(url.searchParams.get("state")!, "code");
  const pending = await stateFor(f.oauth);
  await assert.rejects(
    f.oauth.revoke("Example", resource),
    (error) =>
      error instanceof ConnectorOAuthRevocationError &&
      error.reason === "provider",
  );
  assert.equal(f.tokens.get("Example"), "private-bearer");
  assert.equal(f.oauth.pendingName(pending), "Example");
  accepts = true;
  assert.equal(await f.oauth.revoke("Example", resource), "revoked");
  const request = f.calls.at(-1)!;
  assert.equal(request.address, issuer + "/revoke");
  assert.equal(new Headers(request.init?.headers).get("Authorization"), null);
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(String(request.init?.body))),
    {
      token: "private-refresh",
      token_type_hint: "refresh_token",
      client_id: "custom-client",
      client_secret: "private-secret",
    },
  );
  await assert.rejects(f.oauth.complete(pending, "late-code"));
  assert.equal(f.tokens.get("Example"), undefined);
  assert.equal(f.oauth.status("Example", resource), "disconnected");
  const numberOfRequests = f.calls.length;
  assert.equal(await f.oauth.revoke("Example", resource), "disconnected");
  assert.equal(f.calls.length, numberOfRequests);
  f.oauth.close();
  assert.equal(f.open().oauth.status("Example", resource), "disconnected");
});

test("OAuth revokes access-only grants and reloads the bound issuer for legacy refresh grants", async (context) => {
  const provider = {
    respond: () => issued("only-access"),
    revoke: () => new Response(null),
  };
  const f = setup(context, provider);
  await f.oauth.complete(await stateFor(f.oauth), "code");
  assert.equal(await f.oauth.revoke("Example", resource), "revoked");
  assert.equal(
    new URLSearchParams(String(f.calls.at(-1)?.init?.body)).get("token"),
    "only-access",
  );
  assert.equal(
    new URLSearchParams(String(f.calls.at(-1)?.init?.body)).get(
      "token_type_hint",
    ),
    "access_token",
  );

  f.oauth.close();
  const storePath = path.join(f.profile, "connector-oauth.json");
  fs.writeFileSync(
    storePath,
    JSON.stringify({
      Example: {
        name: "Example",
        resource,
        issuer,
        clientId: "legacy-client",
        tokenEndpoint: issuer + "/token",
        refreshToken: "legacy-refresh",
        refreshAt: Date.now() + 600_000,
        verifier: "",
        redirectUri: callback,
      },
    }),
  );
  f.tokens.set("Example", "legacy-access");
  const restored = f.open();
  assert.equal(restored.oauth.status("Example", resource), "connected");
  assert.equal(await restored.oauth.revoke("Example", resource), "revoked");
  assert.equal(
    f.calls.at(-2)?.address,
    issuer + "/.well-known/oauth-authorization-server",
  );
  assert.equal(
    new URLSearchParams(String(f.calls.at(-1)?.init?.body)).get("token"),
    "legacy-refresh",
  );
  assert.equal(restored.tokens.get("Example"), undefined);
});

test("Sign-out without a provider revocation endpoint disconnects only the owned OAuth bearer", async (context) => {
  const f = setup(context);
  f.tokens.set("Manual", "user-configured");
  await assert.rejects(
    f.oauth.revoke("Manual", resource),
    (error) =>
      error instanceof ConnectorOAuthRevocationError &&
      error.reason === "unavailable",
  );
  assert.equal(f.tokens.get("Manual"), "user-configured");
  await f.oauth.complete(await stateFor(f.oauth), "code");
  assert.equal(await f.oauth.revoke("Example", resource), "disconnected");
  assert.equal(f.oauth.status("Example", resource), "disconnected");
  assert.equal(f.tokens.get("Example"), undefined);
  assert.equal(
    f.calls.some(({ address }) => address.endsWith("/revoke")),
    false,
  );
});

test("Revocation waits for an in-flight refresh and uses the rotated credential", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let release!: (response: Response) => void;
  const f = setup(context, {
    respond(form) {
      if (form.get("grant_type") === "authorization_code")
        return issued("first", "original", 10);
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
    revoke: () => new Response(null),
  });
  await f.oauth.complete(await stateFor(f.oauth), "code");
  context.mock.timers.tick(9_000);
  const pending = await stateFor(f.oauth);
  const revoke = f.oauth.revoke("Example", resource);
  assert.equal(
    f.calls.some(({ address }) => address.endsWith("/revoke")),
    false,
  );
  release(issued("rotated-access", "rotated-refresh", 90));
  assert.equal(await revoke, "revoked");
  assert.equal(
    new URLSearchParams(String(f.calls.at(-1)?.init?.body)).get("token"),
    "rotated-refresh",
  );
  await assert.rejects(f.oauth.complete(pending, "late-code"));
  assert.equal(f.tokens.get("Example"), undefined);
});

test("OAuth callback cannot consume a different connector's state and forget invalidates in-flight exchange", async (context) => {
  let release!: (response: Response) => void;
  const f = setup(context, {
    respond(form) {
      return form.get("code") === "old"
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : issued("new-access");
    },
  });
  const canceled = await stateFor(f.oauth);
  assert.equal(f.oauth.cancel(canceled, "Other"), undefined);
  assert.equal(f.oauth.cancel(canceled, "Example"), "Example");
  await assert.rejects(f.oauth.complete(canceled, "canceled-code"));
  const state = await stateFor(f.oauth);
  await assert.rejects(
    f.oauth.complete(state, "wrong-connector", undefined, "Other"),
  );
  assert.equal(f.oauth.pendingName(state), "Example");
  const old = assert.rejects(
    f.oauth.complete(state, "old", undefined, "Example"),
  );
  f.oauth.forget("Example", resource);
  const replacement = f.oauth.complete(await stateFor(f.oauth), "new");
  release(issued("old-access"));
  await old;
  assert.equal(await replacement, "Example");
  assert.equal(f.tokens.get("Example"), "new-access");
});

test("OAuth rejection reconciles the captured access bearer only and wakes refresh", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = setup(context, {
    respond(form) {
      return form.get("grant_type") === "authorization_code"
        ? issued("first", "refresh", 3600)
        : issued("second", undefined, 3600);
    },
  });
  await f.oauth.complete(await stateFor(f.oauth), "code");
  f.oauth.rejectAccess("Example", resource, "stale-access");
  assert.equal(f.tokens.get("Example"), "first");
  f.oauth.rejectAccess("Example", resource, "first");
  assert.equal(f.oauth.status("Example", resource), "reconnect");
  assert.equal(f.tokens.get("Example"), undefined);
  context.mock.timers.tick(1);
  await settle();
  assert.equal(f.tokens.get("Example"), "second");
  f.oauth.rejectAccess("Example", resource, "first");
  assert.equal(f.tokens.get("Example"), "second");
});

test("A refresh rejection from a forgotten grant cannot clear a same-URL replacement", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let release!: (response: Response) => void;
  const f = setup(context, {
    respond(form) {
      if (form.get("grant_type") === "refresh_token")
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return form.get("code") === "old"
        ? issued("original-access", "original-refresh", 10)
        : issued("replacement-access", "replacement-refresh", 3600);
    },
  });
  await f.oauth.complete(await stateFor(f.oauth), "old");
  context.mock.timers.tick(9_000);
  f.oauth.forget("Example", resource);
  const replacement = f.oauth.complete(await stateFor(f.oauth), "new");
  release(Response.json({ error: "invalid_grant" }, { status: 400 }));
  await replacement;
  assert.equal(f.oauth.status("Example", resource), "connected");
  assert.equal(f.tokens.get("Example"), "replacement-access");
});

test("Legacy refresh metadata alone cannot reconnect a previously removed connector", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  const f = setup(context);
  f.oauth.close();
  fs.writeFileSync(
    path.join(f.profile, "connector-oauth.json"),
    JSON.stringify({
      Example: {
        name: "Example",
        resource,
        issuer,
        clientId: "legacy-client",
        tokenEndpoint: issuer + "/token",
        refreshToken: "legacy-refresh",
        refreshAt: Date.now() - 100,
        verifier: "",
        redirectUri: callback,
      },
    }),
  );
  const restored = f.open();
  context.mock.timers.tick(60_000);
  await settle();
  assert.equal(f.calls.length, 0);
  assert.equal(restored.oauth.status("Example", resource), undefined);
  assert.equal(restored.tokens.get("Example"), undefined);
});
