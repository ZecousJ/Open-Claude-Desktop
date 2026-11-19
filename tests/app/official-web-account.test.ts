import assert from "node:assert/strict";
import test from "node:test";
import { createWebBridge } from "../../src-web/bridge";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import {
  officialAccountActivation,
  officialBrowserAccounts,
} from "../../shared/official-account-menu";
import { fakeTab, json } from "./web-bridge-fakes.test";

const service = "/api/v1/claudex";
const active = "/api/auth/sessions/list-active";
const end = "/api/auth/logout/session";
const date = "2026-11-13T12:00:00Z";
const browser = (id: number, current: boolean, agent: string) => ({
  id,
  user_agent: agent,
  current,
  created_at: date,
  last_seen_at: date,
  expires_at: date,
});
const login = (id: string, token: string) => ({
  access_token: token,
  account: { id, email: `${id}@example.test`, name: id },
});

test("official Active sessions marks the requesting browser, and revokes the selected session through Go", async (t) => {
  const seen: [string, string, string | null][] = [];
  function open(token: string) {
    const tab = fakeTab();
    tab.routes.push((request) => {
      const { pathname } = new URL(request.url, tab.env.origin);
      if (!pathname.startsWith(service)) return;
      const authorization = request.headers.get("authorization");
      if (pathname === service + "/devices") {
        seen.push([request.method, pathname, authorization]);
        return json({
          code: 0,
          data: {
            limit: 10,
            items: [
              {
                id: 17,
                device_name: "Workstation",
                platform: "linux",
                current: false,
                revoked: false,
                created_at: date,
                signed_in_at: date,
              },
            ],
          },
        });
      }
      if (pathname === service + "/web/sessions") {
        seen.push([request.method, pathname, authorization]);
        return json({
          code: 0,
          data: {
            items: [
              browser(
                42,
                authorization === "Bearer browser-a",
                "Chrome/141.0 (Linux)",
              ),
              browser(
                43,
                authorization === "Bearer browser-b",
                "Firefox/142.0 (Windows NT)",
              ),
            ],
          },
        });
      }
      if (pathname === service + "/native-sessions") {
        seen.push([request.method, pathname, authorization]);
        return json({
          code: 0,
          data: { items: [browser(8, false, "Claudex-Android/3.0")] },
        });
      }
      if (request.method === "DELETE" && /\/(?:17|43|8|999)$/.test(pathname)) {
        seen.push([request.method, pathname, authorization]);
        const id = Number(pathname.split("/").at(-1));
        return id === 999
          ? json({ message: "Not found" }, 404)
          : json({ code: 0, data: { id, revoked: true } });
      }
    });
    const bridge = createWebBridge(tab.env);
    t.after(() => bridge.dispose());
    const fetch = createOfficialReadFetch(
      tab.env.origin,
      async () => {
        throw Error("Runner must not handle session requests");
      },
      async () => {
        throw Error("No native fetch for official account paths");
      },
      undefined,
      undefined,
      {
        ...bridge.activeSessions,
        browserAccounts: async () =>
          officialBrowserAccounts(await bridge.api.browserAccounts()),
        switchAccount: async (id) =>
          officialAccountActivation(await bridge.api.switchAccount(id)),
        addAccount: async () => { throw Error("Unexpected add-account request"); },
        signOut: async () => {},
      },
    );
    return { fetch, ready: bridge.auth.adopt(login("7", token)) };
  }

  const a = open("browser-a"),
    b = open("browser-b");
  await Promise.all([a.ready, b.ready]);
  const [first, second] = await Promise.all([
    a.fetch(active + "?page=1&per_page=10&application_slug=claude-ai"),
    b.fetch(active + "?page=1&per_page=10&application_slug=claude-ai"),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const x = await first.json(),
    y = await second.json();
  assert.deepEqual(x.pagination, {
    page: 1,
    per_page: 10,
    total: 4,
    has_more: false,
  });
  assert.deepEqual(
    x.data
      .filter((row: { is_current: boolean }) => row.is_current)
      .map((row: { session_uuid: string }) => row.session_uuid),
    ["web:42"],
  );
  assert.deepEqual(
    y.data
      .filter((row: { is_current: boolean }) => row.is_current)
      .map((row: { session_uuid: string }) => row.session_uuid),
    ["web:43"],
  );
  assert.deepEqual(
    x.data.find(
      (row: { session_uuid: string }) => row.session_uuid === "web:42",
    ).user_agent,
    { browser_family: "Chrome", os_family: "Linux" },
  );

  const before = seen.length;
  assert.equal((await a.fetch(active + "?account=other")).status, 400);
  assert.equal(seen.length, before);
  for (const id of [
    "device:17",
    "web:43",
    "app:8",
    "app:999",
    "not-a-session",
  ]) {
    const response = await a.fetch(end, {
      method: "POST",
      body: JSON.stringify({ session_uuid: id }),
    });
    assert.equal(
      response.status,
      id === "app:999" ? 404 : id === "not-a-session" ? 400 : 204,
    );
  }
  assert.deepEqual(
    seen.filter(([method]) => method === "DELETE"),
    [
      ["DELETE", service + "/devices/17", "Bearer browser-a"],
      ["DELETE", service + "/web/sessions/43", "Bearer browser-a"],
      ["DELETE", service + "/native-sessions/8", "Bearer browser-a"],
      ["DELETE", service + "/native-sessions/999", "Bearer browser-a"],
    ],
  );
});

test("official logout chooses the requested scope and reports revoke-all failure", async () => {
  const scopes: string[] = [];
  const fetch = createOfficialReadFetch(
    "https://claudex.example",
    async () => {
      throw Error("Runner must not handle logout");
    },
    async () => {
      throw Error("No native fetch for official account paths");
    },
    undefined,
    undefined,
    {
      activeSessions: async () => [],
      endActiveSession: async () => ({ ended: true }),
      browserAccounts: async () => ({ accounts: [], max_accounts: 3 }),
      switchAccount: async () => ({ account: { uuid: "other" } }),
      addAccount: async () => {},
      async signOut(scope) {
        scopes.push(scope);
        if (scope === "all") throw Error("Service unavailable");
      },
    },
  );
  assert.equal(
    (await fetch("/api/auth/logout", { method: "POST" })).status,
    204,
  );
  assert.equal(
    (await fetch("/api/auth/logout/all-sessions", { method: "POST" })).status,
    503,
  );
  assert.deepEqual(scopes, ["current", "all"]);
});
