import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppContext } from "../app/app-context";
import { ConnectorClients } from "./connector-clients";
import { ConnectorOAuth } from "../../runner/src/connector-oauth";
import { ConnectorTokens, connectorFetch } from "../../runner/src/connectors";
import { connectorAllowed } from "../../shared/client-policy-rules";

const tokens = new Map<string, ConnectorTokens>();
interface DesktopAuthSession {
  oauth: ConnectorOAuth;
  callback: string;
  server: http.Server;
}
const runtimeUpdates = new WeakMap<AppContext["engine"], Set<string>>();

function syncConnectorRuntime(ctx: AppContext, current: () => boolean, name: string) {
  const { engine, store } = ctx;
  const pending = runtimeUpdates.get(engine);
  if (pending) {
    pending.add(name);
    return;
  }
  const names = new Set([name]);
  const promise = Promise.resolve().then(async () => {
    while (current() && names.size) {
      while (current() && engine.isBusy())
        await new Promise(resolve => setTimeout(resolve, 1000));
      if (!current()) return;
      const changed = [...names];
      names.clear();
      const provider = store.settings.providers.find(
        (entry) => entry.id === store.settings.activeProviderId,
      );
      if (provider)
        await engine.ensure(provider, { current, interactive: false }).catch(() => {});
      if (current()) for (const name of changed) ctx.refreshOfficialConnector?.(name);
    }
  }).finally(() => runtimeUpdates.delete(engine));
  runtimeUpdates.set(engine, names);
  void promise.catch(() => {});
}
interface PendingDesktopAuthSession {
  current(): boolean;
  promise: Promise<DesktopAuthSession>;
  session?: DesktopAuthSession;
}
interface DesktopAuthState {
  generation: number;
  sessions: Map<string, PendingDesktopAuthSession>;
  servers: Set<http.Server>;
}
const contexts = new WeakMap<AppContext, DesktopAuthState>();
function authState(ctx: AppContext) {
  let state = contexts.get(ctx);
  if (state) return state;
  state = {
    generation: 0,
    sessions: new Map(),
    servers: new Set(),
  };
  const owned = state;
  contexts.set(ctx, state);
  ctx.onAccountDeactivating?.(async () => {
    owned.generation++;
    for (const entry of owned.sessions.values()) entry.session?.oauth.close();
    owned.sessions.clear();
    await Promise.all(
      [...owned.servers].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    owned.servers.clear();
  });
  return state;
}
function desktopAuthLease(ctx: AppContext) {
  const state = authState(ctx),
    generation = state.generation;
  const store = ctx.store,
    engine = ctx.engine,
    remote = ctx.remote,
    accountId = ctx.activeAccount?.id,
    activation = ctx.accountActivationIdentity;
  const origin = remote?.accounts.baseUrl ?? "local";
  const current = () =>
    (ctx.remote?.accounts.baseUrl ?? "local") === origin &&
    !!accountId &&
    ctx.accountActivationIdentity === activation &&
    state.generation === generation &&
    ctx.activeAccount?.id === accountId &&
    ctx.store === store &&
    ctx.engine === engine &&
    ctx.remote === remote;
  const assertCurrent = () => {
    if (!current())
      throw Error(
        "This connector operation belongs to a retired account or connector. Open it again.",
      );
  };
  assertCurrent();
  return { state, store, current, assertCurrent };
}

function authProfile(profile: string, resource: string) {
  return path.join(
    profile,
    "connector-auth",
    createHash("sha256").update(resource).digest("hex"),
  );
}

function profileTokens(profile: string) {
  let saved = tokens.get(profile);
  if (!saved) {
    saved = new ConnectorTokens(profile);
    tokens.set(profile, saved);
  }
  return saved;
}

export function desktopConnectorHeaders(
  profile: string,
  name: string,
  resource?: string,
) {
  if (!resource) return undefined;
  const root = authProfile(profile, resource);
  if (!fs.existsSync(root)) return undefined;
  const token = profileTokens(root).get(name);
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export async function forgetDesktopConnectorToken(
  ctx: AppContext,
  name: string,
  resource?: string,
  assertOperation: () => void = () => {},
) {
  if (!resource || !fs.existsSync(authProfile(ctx.store.root, resource))) return;
  const { oauth } = await desktopConnectorSession(ctx, resource);
  assertOperation();
  oauth.forget(name, resource);
}

async function desktopConnectorSession(ctx: AppContext, resource: string) {
  const lease = desktopAuthLease(ctx);
  const profile = lease.store.root;
  const root = authProfile(profile, resource);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let entry = lease.state.sessions.get(resource);
  if (entry && !entry.current()) {
    entry.session?.oauth.close();
    void entry.promise
      .then(({ oauth, server }) => {
        oauth.close();
        server.close(() => {});
        server.closeAllConnections();
      })
      .catch(() => {});
    entry = undefined;
  }
  if (!entry) {
    const pending = new Promise<DesktopAuthSession>((resolve, reject) => {
      let oauth: ConnectorOAuth;
      const server = http.createServer((request, response) => {
        let url: URL;
        try {
          url = new URL(request.url ?? "/", "http://127.0.0.1");
        } catch {
          response.writeHead(400).end();
          return;
        }
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        if (
          request.method !== "GET" ||
          url.pathname !== "/callback" ||
          !state ||
          (!code && !error) ||
          !lease.current()
        ) {
          response.writeHead(400).end();
          return;
        }
        const name = oauth.pendingName(state);
        if (name === undefined) {
          response.writeHead(400).end();
          return;
        }
        const finish = (error?: "access_denied" | "callback_failed") => {
          if (response.destroyed) return;
          if (!lease.current()) {
            response.writeHead(400).end();
            return;
          }
          if (ctx.notifyOfficialConnectorAuthentication?.(name, state, error) || error) {
            const message = error === "access_denied"
              ? "Connector sign-in canceled. You can close this window."
              : error
                ? "Connector sign-in failed. Return to Claudex to try again."
                : "Connector sign-in complete. You can close this window.";
            response.writeHead(200, {
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "no-store",
            }).end(message);
            return;
          }
          response.writeHead(302, {
            Location: `claudex://settings/connectors?connector=${encodeURIComponent(`installed:${name}`)}`,
            "Cache-Control": "no-store",
          }).end();
        };
        if (error) {
          if (!oauth.cancel(state, name)) response.writeHead(400).end();
          else finish(error === "access_denied" ? error : "callback_failed");
          return;
        }
        void oauth
          .complete(state, code ?? "", url.searchParams.get("iss") ?? undefined, name)
          .then(() => finish(), () => finish("callback_failed"));
      });
      lease.state.servers.add(server);
      server.once("close", () => {
        lease.state.servers.delete(server);
        reject(
          Error(
            "This connector operation belongs to a retired account or connector. Open it again.",
          ),
        );
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        if (!lease.current()) {
          server.close(() => {});
          reject(
            Error(
              "This connector operation belongs to a retired account or connector. Open it again.",
            ),
          );
          return;
        }
        const address = server.address();
        if (!address || typeof address === "string")
          return reject(Error("The request failed."));
        const origin = `http://127.0.0.1:${address.port}`;
        oauth = new ConnectorOAuth(
          root,
          origin,
          connectorFetch({ level: "full" }),
          profileTokens(root),
          (name) => {
            if (lease.current()) syncConnectorRuntime(ctx, lease.current, name);
          },
          (serverName, url) => {
            if (!lease.current()) return false;
            const server = ctx.store.settings.mcpServers[serverName] as
              { url?: string } | undefined;
            return (
              server?.url === url &&
              connectorAllowed(ctx.policy(), serverName, server)
            );
          },
        );
        resolve({ oauth, callback: `${origin}/callback`, server });
      });
    });
    entry = { current: lease.current, promise: pending };
    lease.state.sessions.set(resource, entry);
    const ownedEntry = entry;
    void pending.then(
      (session) => {
        if (ownedEntry.current()) ownedEntry.session = session;
        else session.oauth.close();
      },
      () => {
        if (lease.state.sessions.get(resource) === ownedEntry)
          lease.state.sessions.delete(resource);
      },
    );
  }
  try {
    const result = await entry.promise;
    lease.assertCurrent();
    return result;
  } catch (error) {
    lease.assertCurrent();
    throw error;
  }
}

export async function resumeDesktopConnectorAuth(ctx: AppContext) {
  const lease = desktopAuthLease(ctx);
  const clients = new ConnectorClients(lease.store.root);
  await Promise.allSettled(
    Object.entries(lease.store.settings.mcpServers).map(async ([name, raw]) => {
      const server = raw as { display_name?: string; url?: string } | undefined;
      if (
        server?.url &&
        (server.display_name || clients.get(name, server.url) ||
          fs.existsSync(authProfile(lease.store.root, server.url)))
      ) {
        await desktopConnectorSession(ctx, server.url);
        lease.assertCurrent();
      }
    }),
  );
  lease.assertCurrent();
}

export function desktopConnectorAuthStatus(
  ctx: AppContext,
  name: string,
  resource: string,
) {
  const state = contexts.get(ctx);
  const entry = state?.sessions.get(resource);
  if (!entry?.current() || !entry.session) return;
  return entry.session.oauth.status(name, resource) ??
    (desktopConnectorHeaders(ctx.store.root, name, resource) ? "connected" : undefined);
}

export async function revokeDesktopConnectorAuth(
  ctx: AppContext,
  name: string,
  resource: string,
  assertTarget: () => void,
) {
  assertTarget();
  if (!fs.existsSync(authProfile(ctx.store.root, resource))) return false;
  const { oauth } = await desktopConnectorSession(ctx, resource);
  assertTarget();
  await oauth.revoke(name, resource, { legacyOAuth: true });
  return true;
}

export function desktopConnectorAuthRejected(
  ctx: AppContext,
  name: string,
  resource: string,
  bearer: string,
) {
  if (ctx.accountRetiring) return;
  const entry = contexts.get(ctx)?.sessions.get(resource);
  if (entry?.current()) entry.session?.oauth.rejectAccess(name, resource, bearer);
}

export async function desktopConnectorLogin(
  ctx: AppContext,
  name: string,
  resource: string,
  assertOperation: () => void = () => {},
) {
  const lease = desktopAuthLease(ctx);
  assertOperation();
  try {
    const { oauth, callback } = await desktopConnectorSession(ctx, resource);
    lease.assertCurrent();
    assertOperation();
    const result = await oauth.begin(
      name,
      resource,
      callback,
      new ConnectorClients(lease.store.root).get(name, resource),
    );
    lease.assertCurrent();
    assertOperation();
    return result;
  } catch (error) {
    lease.assertCurrent();
    assertOperation();
    throw error;
  }
}
