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
interface DesktopAuthState {
  generation: number;
  sessions: Map<
    string,
    {
      current(): boolean;
      promise: Promise<{
        oauth: ConnectorOAuth;
        callback: string;
        server: http.Server;
      }>;
    }
  >;
  servers: Set<http.Server>;
  oauth: Set<ConnectorOAuth>;
}
const contexts = new WeakMap<AppContext, DesktopAuthState>();
function authState(ctx: AppContext) {
  let state = contexts.get(ctx);
  if (state) return state;
  state = {
    generation: 0,
    sessions: new Map(),
    servers: new Set(),
    oauth: new Set(),
  };
  const owned = state;
  contexts.set(ctx, state);
  ctx.onAccountDeactivating?.(async () => {
    owned.generation++;
    owned.sessions.clear();
    for (const oauth of owned.oauth) oauth.close();
    owned.oauth.clear();
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
    accountId = ctx.activeAccount?.id;
  const origin = remote?.accounts.baseUrl ?? "local";
  const current = () =>
    (ctx.remote?.accounts.baseUrl ?? "local") === origin &&
    !!accountId &&
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

export function forgetDesktopConnectorToken(
  profile: string,
  name: string,
  resource?: string,
) {
  if (resource && fs.existsSync(authProfile(profile, resource)))
    profileTokens(authProfile(profile, resource)).set(name, undefined);
}

async function desktopConnectorSession(ctx: AppContext, resource: string) {
  const lease = desktopAuthLease(ctx);
  const profile = lease.store.root;
  const root = authProfile(profile, resource);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  let entry = lease.state.sessions.get(root);
  if (entry && !entry.current()) {
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
    const pending = new Promise<{
      oauth: ConnectorOAuth;
      callback: string;
      server: http.Server;
    }>((resolve, reject) => {
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
        if (
          request.method !== "GET" ||
          url.pathname !== "/callback" ||
          !state ||
          !code
        ) {
          response.writeHead(400).end();
          return;
        }
        if (!lease.current()) {
          response.writeHead(400).end();
          return;
        }
        void oauth
          .complete(state, code)
          .then((connected) => {
            if (!lease.current()) {
              if (!response.destroyed) response.writeHead(400).end();
              return;
            }
            response
              .writeHead(302, {
                Location: `claudex://settings/connectors?connector=${encodeURIComponent(`installed:${connected}`)}`,
                "Cache-Control": "no-store",
              })
              .end();
          })
          .catch(() => {
            if (!response.destroyed) response.writeHead(400).end();
          });
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
          () => {
            if (lease.current())
              ctx.mcpConfig?.update(lease.store.settings.mcpServers);
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
        lease.state.oauth.add(oauth);
        resolve({ oauth, callback: `${origin}/callback`, server });
      });
    });
    entry = { current: lease.current, promise: pending };
    lease.state.sessions.set(root, entry);
    const ownedEntry = entry;
    void pending.catch(() => {
      if (lease.state.sessions.get(root) === ownedEntry)
        lease.state.sessions.delete(root);
    });
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
  await Promise.all(
    Object.entries(lease.store.settings.mcpServers).map(async ([name, raw]) => {
      const server = raw as { display_name?: string; url?: string } | undefined;
      if (
        server?.url &&
        (server.display_name || clients.get(name, server.url))
      ) {
        await desktopConnectorSession(ctx, server.url);
        lease.assertCurrent();
      }
    }),
  );
  lease.assertCurrent();
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
