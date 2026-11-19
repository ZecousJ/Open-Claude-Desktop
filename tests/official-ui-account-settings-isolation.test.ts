/** Pure mocked adapter calls, self-owned state files; no account/OS operations. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { accountRoute } from "../electron/official-ui/api/account";
import type { AdapterContext } from "../electron/official-ui/api/context";
import { registerPreferences } from "../electron/official-ui/native/preferences";

function response() {
  let status = 0,
    body = "";
  return {
    res: {
      writeHead(n: number) {
        status = n;
      },
      end(s = "") {
        body = s;
      },
    } as unknown as http.ServerResponse,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
  };
}
test("profile body arriving after account reactivation cannot write any field", async () => {
  let identity = {};
  const calls: string[] = [];
  const ctx = {
    account: () => ({ id: "a" }),
    sessionIdentity: () => identity,
    settings: () => ({}),
    call: async (n: string) => {
      calls.push(n);
    },
  } as unknown as AdapterContext;
  const req = Object.assign(new EventEmitter(), { method: "PATCH" });
  const r = response();
  const done = accountRoute(
    req as http.IncomingMessage,
    r.res,
    "/api/account_profile",
    ctx,
  );
  identity = {};
  req.emit(
    "data",
    Buffer.from(JSON.stringify({ display_name: "old", full_name: "old" })),
  );
  req.emit("end");
  await done;
  assert.equal(r.status, 400);
  assert.match(r.body, /account changed/);
  assert.deepEqual(calls, []);
});
test("profile staged write cannot continue to another account or return its profile", async () => {
  let owner = "a",
    identity = {};
  const calls: string[] = [];
  const ctx = {
    account: () => ({ id: owner, name: owner }),
    sessionIdentity: () => identity,
    settings: () => ({}),
    call: async (n: string) => {
      calls.push(n);
      owner = "b";
      identity = {};
    },
  } as unknown as AdapterContext;
  const req = Object.assign(new EventEmitter(), { method: "PATCH" }),
    r = response();
  const done = accountRoute(
    req as http.IncomingMessage,
    r.res,
    "/api/account_profile",
    ctx,
  );
  req.emit(
    "data",
    Buffer.from(JSON.stringify({ display_name: "old", full_name: "old" })),
  );
  req.emit("end");
  await done;
  assert.equal(r.status, 400);
  assert.deepEqual(calls, ["saveSettings"]);
  assert.match(r.body, /account changed/);
});
test("active session list completed after reactivation does not disclose old session data", async () => {
  let identity = {};
  const ctx = {
    account: () => ({ id: "a" }),
    sessionIdentity: () => identity,
    call: async () => {
      identity = {};
      return [{ id: "private-session", createdAt: 1, current: true }];
    },
  } as unknown as AdapterContext;
  const r = response();
  await accountRoute(
    { method: "GET" } as http.IncomingMessage,
    r.res,
    "/api/auth/sessions/list-active",
    ctx,
  );
  assert.equal(r.status, 400);
  assert.ok(!r.body.includes("private-session"));
});
test("native sidebar preference restores Code in the correct account on startup", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preferences-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { newAdapterScope } = await import("../electron/official-ui/api/scope");
  const { officialStartupRoute } = await import("../electron/official-ui/startup-route");
  let owner = "first";
  const handlers = new Map<string, (key: string, value: unknown) => Promise<void>>();
  const host = {
    ctx: {
      account: () => ({ id: owner }),
      stateDirectory: () => root,
      settings: () => ({}),
      onEvent: () => () => {},
    },
    on(name: string, handler: (key: string, value: unknown) => Promise<void>) {
      handlers.set(name, handler);
      return this;
    },
    emit() {},
  };
  registerPreferences(host as unknown as Parameters<typeof registerPreferences>[0], {});
  const route = (account: string) => officialStartupRoute(newAdapterScope(account, root));
  const set = (value: unknown) => handlers.get("AppPreferences.setPreference")!("sidebarMode", value);
  assert.equal(route("first"), "/new");

  await set("code");
  assert.equal(route("first"), "/epitaxy?coldLaunch=1");
  assert.equal(route("second"), "/new");

  owner = "second";
  await set("task");
  assert.equal(route("second"), "/new");
  await set("epitaxy");
  assert.equal(route("second"), "/epitaxy?coldLaunch=1");

  owner = "first";
  await set("chat");
  assert.equal(route("first"), "/new");
  assert.equal(route("second"), "/epitaxy?coldLaunch=1");
});

test("native preference own values and delayed persistence are account-local", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preferences-account-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let owner = "a",
    identity = {},
    events = 0;
  const handlers = new Map<string, any>();
  const host: any = {
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => identity,
      stateDirectory: () => root,
      settings: () => ({}),
      onEvent: () => () => {},
      call: async () => {
        owner = "b";
        identity = {};
      },
    },
    on(n: string, f: any) {
      handlers.set(n, f);
      return this;
    },
    emit() {
      events++;
    },
  };
  const firstRegistry = registerPreferences(host, {});
  const get = () => handlers.get("AppPreferences.getPreferences")();
  const set = (k: string, v: unknown) =>
    handlers.get("AppPreferences.setPreference")(k, v);
  assert.equal(firstRegistry.autoOpenFiles(), true);
  await set("launchAutoOpenFiles", false);
  assert.equal(firstRegistry.autoOpenFiles(), false);
  await set("sidebarMode", "chat");
  owner = "b";
  identity = {};
  assert.equal(firstRegistry.autoOpenFiles(), true);
  assert.equal(get().sidebarMode, undefined);
  await set("sidebarMode", "code");
  owner = "a";
  identity = {};
  assert.equal(get().sidebarMode, "chat");
  await new Promise((r) => setTimeout(r, 600));
  const reopened = registerPreferences(host, {});
  owner = "a";
  identity = {};
  assert.equal(get().sidebarMode, "chat");
  assert.equal(reopened.autoOpenFiles(), false);
  owner = "b";
  identity = {};
  assert.equal(get().sidebarMode, "code");
  owner = "a";
  identity = {};
  const before = events;
  await assert.rejects(set("menuBarEnabled", false), /account changed/);
  assert.equal(events, before);
});

test("unavailable session inventory is not a successful empty list; invalid revocation input never dispatches", async () => {
  const calls: string[] = [];
  const ctx = {
    account: () => ({ id: "a" }),
    call: async (n: string) => {
      calls.push(n);
      return null;
    },
  } as unknown as AdapterContext;
  const r = response();
  await accountRoute(
    { method: "GET" } as http.IncomingMessage,
    r.res,
    "/api/auth/sessions/list-active",
    ctx,
  );
  assert.equal(r.status, 503);
  assert.match(r.body, /unavailable/);
  for (const session_uuid of [{ toString: "web:1" }, "", "unknown:1"]) {
    const req = Object.assign(new EventEmitter(), { method: "POST" }),
      r = response();
    const done = accountRoute(
      req as http.IncomingMessage,
      r.res,
      "/api/auth/logout/session",
      ctx,
    );
    req.emit("data", Buffer.from(JSON.stringify({ session_uuid })));
    req.emit("end");
    await done;
    assert.equal(r.status, 400);
  }
  assert.deepEqual(calls, ["activeSessions"]);
});
test("unknown OS startup state is not off and prototype keys never become settings writes", async () => {
  const handlers = new Map<string, any>();
  let calls = 0,
    state: unknown = null;
  const host: any = {
    ctx: {
      settings: () => ({}),
      onEvent: () => () => {},
      call: async (n: string) => {
        calls++;
        assert.equal(n, "systemState");
        return state;
      },
    },
    on(n: string, f: any) {
      handlers.set(n, f);
      return this;
    },
    emit() {},
  };
  registerPreferences(host, {});
  for (const value of [null, {}, { runOnStartup: null }]) {
    state = value;
    await assert.rejects(
      handlers.get("Startup.isStartupOnLoginEnabled")(),
      /unavailable/,
    );
  }
  for (const value of [false, true]) {
    state = { runOnStartup: value };
    assert.equal(
      await handlers.get("Startup.isStartupOnLoginEnabled")(),
      value,
    );
  }
  for (const key of ["__proto__", "constructor", "prototype", {}])
    await assert.rejects(
      handlers.get("AppPreferences.setPreference")(key, true),
      /valid preference/,
    );
  assert.equal(calls, 5);
});

test("account profile bounded-body errors return 413 before any backend mutation", async () => {
  let calls = 0;
  const ctx = {
    account: () => ({ id: "a" }),
    call: async () => {
      calls++;
    },
  } as unknown as AdapterContext;
  const req = Object.assign(new EventEmitter(), { method: "PATCH" }),
    r = response();
  const pending = accountRoute(
    req as http.IncomingMessage,
    r.res,
    "/api/account_profile",
    ctx,
  );
  req.emit("data", Buffer.alloc(1024 * 1024 + 1));
  await pending;
  assert.equal(r.status, 413);
  assert.equal(calls, 0);
  req.emit("end");
});
