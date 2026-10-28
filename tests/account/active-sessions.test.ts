import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AppContext } from "../../electron/app/app-context";
import { registerSettingsAccountHandlers } from "../../electron/ipc/settings-account";
import { Sub2ApiError } from "../../electron/sub2api/http";
import {
  activeSessionsFrom,
  browserFamily,
  osFamily,
  parseSessionId,
  sessionDeviceLabel,
  sessionLocation,
} from "../../shared/active-sessions";
import {
  parseDeviceList,
  parseWebSessionList,
  parseNativeSessionList,
  type ClaudexDeviceList,
  type ClaudexWebSessionList,
} from "../../shared/claudex-contract";
import type { ActiveSession } from "../../shared/settings-api";
import {
  ActiveSessionsTable,
  sessionsPerPage,
} from "../../src/settings/ActiveSessions";

const chromeOnMac =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const safariOnIphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const edgeOnWindows =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0";
const firefoxOnLinux =
  "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";

const device = (
  id: number,
  extra: Partial<ClaudexDeviceList["items"][number]> = {},
): ClaudexDeviceList["items"][number] => ({
  id,
  deviceName: "Ada's MacBook Pro",
  platform: "darwin",
  arch: "arm64",
  appVersion: "1.3.2",
  groupId: 4,
  current: false,
  revoked: false,
  lastSeenAt: 3_000,
  createdAt: 1_000,
  signedInAt: 2_000,
  ...extra,
});

const webSession = (
  id: number,
  extra: Partial<ClaudexWebSessionList["items"][number]> = {},
): ClaudexWebSessionList["items"][number] => ({
  id,
  userAgent: chromeOnMac,
  current: false,
  createdAt: 1_500,
  lastSeenAt: 4_000,
  expiresAt: 9_000,
  ...extra,
});

test("the list merges signed-in devices and browser sessions, most recently used first", () => {
  const sessions = activeSessionsFrom(
    {
      items: [
        device(51, { current: true }),
        device(52, { revoked: true, lastSeenAt: 8_000 }),
        device(53, { lastSeenAt: null, signedInAt: 2_500 }),
      ],
      limit: 5,
    },
    { items: [webSession(12)] },
  );
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["web:12", "device:51", "device:53"],
    "a signed-out device is not a session",
  );
  const mac = sessions[1]!;
  assert.equal(mac.kind, "desktop");
  assert.equal(mac.current, true);
  assert.equal(mac.createdAt, 2_000, "Created is when this sign-in began");
  assert.equal(mac.updatedAt, 3_000);
  assert.equal(sessions[2]!.updatedAt, 2_500, "never used: its sign-in");
  assert.equal(sessions[0]!.kind, "web");
  assert.equal(sessions[0]!.userAgent, chromeOnMac);
  // The web app turned off on the service: the devices alone.
  assert.deepEqual(
    activeSessionsFrom({ items: [device(51)], limit: 5 }, null).map(
      (session) => session.id,
    ),
    ["device:51"],
  );
});

test("a row names its device as the original does: app (OS)", () => {
  const desktop = activeSessionsFrom(
    { items: [device(1)], limit: 5 },
    null,
  )[0]!;
  assert.equal(sessionDeviceLabel(desktop), "Ada's MacBook Pro (Mac OS X)");
  assert.equal(
    sessionDeviceLabel({ ...desktop, deviceName: "", platform: "win32" }),
    "Claudex Desktop (Windows)",
  );
  assert.equal(
    sessionDeviceLabel({ ...desktop, platform: "" }),
    "Ada's MacBook Pro",
  );
  const web = (userAgent: string): ActiveSession => ({
    ...desktop,
    kind: "web",
    deviceName: "",
    platform: "",
    userAgent,
  });
  assert.equal(sessionDeviceLabel(web(chromeOnMac)), "Chrome (Mac OS X)");
  assert.equal(sessionDeviceLabel(web(safariOnIphone)), "Safari (iOS)");
  assert.equal(sessionDeviceLabel(web(edgeOnWindows)), "Edge (Windows)");
  assert.equal(sessionDeviceLabel(web(firefoxOnLinux)), "Firefox (Linux)");
  assert.equal(sessionDeviceLabel(web("curl/8.0")), null, "Unknown device");
  assert.equal(browserFamily("Mozilla/5.0 Electron/38.0.0"), "Claudex Desktop");
  assert.equal(osFamily("Mozilla/5.0 (Linux; Android 15)"), "Android");
});

test("a session location joins the available city, region and country parts", () => {
  const sessions = activeSessionsFrom(
    {
      items: [
        device(1, {
          location: { city: "Seattle", region: "WA", country: "US" },
        }),
      ],
      limit: 5,
    },
    {
      items: [
        webSession(2, {
          location: { city: "Tokyo", region: "", country: "JP" },
        }),
      ],
    },
  );
  assert.equal(sessionLocation(sessions[0]!), "Tokyo, JP");
  assert.equal(sessionLocation(sessions[1]!), "Seattle, WA, US");
  assert.equal(sessionLocation({ location: null }), null);
});

test("service location_info reaches the desktop, browser and phone session table", () => {
  const location = {
    city: "Brisbane",
    region: "Queensland",
    country: "Australia",
  };
  const devices = parseDeviceList({
    limit: 5,
    items: [
      {
        id: 1,
        device_name: "Mac",
        platform: "darwin",
        arch: "arm64",
        app_version: "1.0.0",
        group_id: null,
        current: true,
        revoked: false,
        last_seen_at: null,
        created_at: "2026-10-16T00:00:00Z",
        location_info: location,
      },
    ],
  });
  const wire = {
    items: [
      {
        id: 2,
        user_agent: chromeOnMac,
        current: false,
        created_at: "2026-10-16T00:00:00Z",
        last_seen_at: "2026-10-16T00:00:00Z",
        expires_at: "2026-11-16T00:00:00Z",
        location_info: location,
      },
    ],
  };
  const sessions = activeSessionsFrom(
    devices,
    parseWebSessionList(wire),
    parseNativeSessionList(wire),
  );
  assert.equal(sessions.length, 3);
  assert.ok(
    sessions.every(
      (session) =>
        sessionLocation(session) === "Brisbane, Queensland, Australia",
    ),
  );
  const markup = render({ state: "ready", sessions });
  assert.equal(
    (markup.match(/Brisbane, Queensland, Australia/g) ?? []).length,
    3,
  );
});

test("session ids name a device or a browser session, nothing else", () => {
  assert.deepEqual(parseSessionId("device:51"), { kind: "desktop", id: 51 });
  assert.deepEqual(parseSessionId("web:12"), { kind: "web", id: 12 });
  for (const bad of ["device:0", "web:-1", "web:1.5", "key:3", "device:", ""])
    assert.equal(parseSessionId(bad), null, bad);
});

test("a service before claudex_0141 reads a device's sign-in as its first registration", () => {
  const list = parseDeviceList({
    items: [
      {
        id: 51,
        device_name: "Mac",
        platform: "darwin",
        arch: "arm64",
        app_version: "1.3.2",
        group_id: 4,
        current: true,
        revoked: false,
        last_seen_at: "2026-09-26T02:10:00Z",
        created_at: "2026-09-20T09:00:00Z",
      },
    ],
    limit: 5,
  });
  assert.equal(list.items[0]!.signedInAt, Date.parse("2026-09-20T09:00:00Z"));
});

/** Settings → Account handlers over a fake Claudex service. */
function handlers(service?: {
  devices?: () => Promise<ClaudexDeviceList>;
  webSessions?: () => Promise<ClaudexWebSessionList>;
  revokeDevice?: (id: number) => Promise<unknown>;
  revokeWebSession?: (id: number) => Promise<unknown>;
  nativeSessions?: () => Promise<ClaudexWebSessionList>;
  revokeNativeSession?: (id: number) => Promise<unknown>;
}) {
  const calls: string[] = [];
  const ctx = {
    activeAccount: { id: "a", email: "z@example.com", name: "Z" },
    remote: service && {
      backend: {
        deviceId: "6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11",
        session: {
          authorized: async (fn: (token: string) => unknown) => fn("token"),
        },
        client: {
          devices: async (token: string, deviceId: string) => {
            calls.push(`devices ${token} ${deviceId}`);
            return service.devices!();
          },
          webSessions: async () => {
            calls.push("webSessions");
            return service.webSessions!();
          },
          revokeDevice: async (_token: string, _device: string, id: number) => {
            calls.push(`revokeDevice ${id}`);
            return service.revokeDevice!(id);
          },
          revokeWebSession: async (_token: string, id: number) => {
            calls.push(`revokeWebSession ${id}`);
            return service.revokeWebSession!(id);
          },
          nativeSessions: async () => {
            calls.push("nativeSessions");
            // A service from before the phone apps were recorded.
            if (!service.nativeSessions)
              throw new Sub2ApiError(404, "NOT_FOUND", "Not found.");
            return service.nativeSessions();
          },
          revokeNativeSession: async (_token: string, id: number) => {
            calls.push(`revokeNativeSession ${id}`);
            return service.revokeNativeSession!(id);
          },
        },
      },
    },
  } as unknown as AppContext;
  const found = new Map<string, (...args: any[]) => any>();
  registerSettingsAccountHandlers((name, fn) => found.set(name, fn), ctx);
  return { handle: found, calls };
}

test("activeSessions asks the service for both lists with this device's id", async () => {
  const { handle, calls } = handlers({
    devices: async () => ({ items: [device(51, { current: true })], limit: 5 }),
    webSessions: async () => ({ items: [webSession(12)] }),
  });
  const sessions: ActiveSession[] = await handle.get("activeSessions")!();
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["web:12", "device:51"],
  );
  assert.deepEqual(calls.sort(), [
    "devices token 6f1c2a4e-9b0d-4c1e-8a57-2f3b9d0c7e11",
    "nativeSessions",
    "webSessions",
  ]);
});

const iosApp = "Claudex/12 CFNetwork/3826.400.120 Darwin/25.0.0";
const androidApp = "Claudex-Android/0.1";

test("the phone apps' sign-ins join the list as app rows named after the app", async () => {
  const { handle } = handlers({
    devices: async () => ({ items: [device(51, { current: true })], limit: 5 }),
    webSessions: async () => ({ items: [] }),
    nativeSessions: async () => ({
      items: [
        webSession(3, { userAgent: iosApp, lastSeenAt: 7_000 }),
        webSession(4, { userAgent: androidApp, lastSeenAt: 1_000 }),
      ],
    }),
  });
  const sessions: ActiveSession[] = await handle.get("activeSessions")!();
  assert.deepEqual(
    sessions.map((session) => session.id),
    ["app:3", "device:51", "app:4"],
  );
  assert.deepEqual(sessions.map(sessionDeviceLabel), [
    "Claudex (iOS)",
    "Ada's MacBook Pro (Mac OS X)",
    "Claudex (Android)",
  ]);
  assert.equal(
    sessionDeviceLabel({ ...sessions[0]!, userAgent: chromeOnMac }),
    "Chrome (Mac OS X)",
    "a console sign-in in a browser reads as that browser",
  );
  assert.equal(
    sessionDeviceLabel({ ...sessions[0]!, userAgent: "okhttp/4.12.0" }),
    "Android",
  );
});

test("a phone app session is ended through the service's own list", async () => {
  const { handle, calls } = handlers({
    revokeNativeSession: async (id) => {
      if (id === 9)
        throw new Sub2ApiError(
          404,
          "CLAUDEX_NATIVE_SESSION_NOT_FOUND",
          "Session not found.",
        );
      return { id, revoked: true };
    },
  });
  assert.deepEqual(await handle.get("endActiveSession")!("app:3"), {
    ended: true,
  });
  assert.deepEqual(await handle.get("endActiveSession")!("app:9"), {
    ended: false,
  });
  assert.deepEqual(calls, ["revokeNativeSession 3", "revokeNativeSession 9"]);
  assert.deepEqual(parseSessionId("app:3"), { kind: "app", id: 3 });
});

test("the web app turned off means no browser sessions; other failures are errors", async () => {
  const off = handlers({
    devices: async () => ({ items: [device(51)], limit: 5 }),
    webSessions: async () => {
      throw new Sub2ApiError(
        403,
        "CLAUDEX_WEB_DISABLED",
        "The web app is turned off.",
      );
    },
  });
  assert.equal((await off.handle.get("activeSessions")!()).length, 1);
  const down = handlers({
    devices: async () => ({ items: [device(51)], limit: 5 }),
    webSessions: async () => {
      throw new Sub2ApiError(
        503,
        "CLAUDEX_WEB_SESSIONS_UNAVAILABLE",
        "Try again.",
      );
    },
  });
  await assert.rejects(down.handle.get("activeSessions")!(), /Try again/);
});

test("an account on this computer only has no sessions to list", async () => {
  const { handle } = handlers();
  assert.equal(await handle.get("activeSessions")!(), null);
  await assert.rejects(handle.get("endActiveSession")!("device:1"), /Sign in/);
});

test("endActiveSession signs the named device or browser out; gone already is not an error", async () => {
  const { handle, calls } = handlers({
    revokeDevice: async () => ({ revoked: true }),
    revokeWebSession: async (id) => {
      if (id === 13)
        throw new Sub2ApiError(
          404,
          "CLAUDEX_WEB_SESSION_NOT_FOUND",
          "Session not found.",
        );
      return { id, revoked: true };
    },
  });
  assert.deepEqual(await handle.get("endActiveSession")!("device:52"), {
    ended: true,
  });
  assert.deepEqual(await handle.get("endActiveSession")!("web:12"), {
    ended: true,
  });
  assert.deepEqual(await handle.get("endActiveSession")!("web:13"), {
    ended: false,
  });
  await assert.rejects(
    handle.get("endActiveSession")!("key:1"),
    /Unknown session/,
  );
  assert.deepEqual(calls, [
    "revokeDevice 52",
    "revokeWebSession 12",
    "revokeWebSession 13",
  ]);
});

const render = (
  initial: Parameters<typeof ActiveSessionsTable>[0]["initial"],
) =>
  renderToStaticMarkup(
    createElement(ActiveSessionsTable, {
      initial,
      onSignOut: async () => {},
      onError: () => {},
    }),
  );

test("the table: the original's columns, Current badge, Unknown location, a ⋮ per row", () => {
  const sessions = activeSessionsFrom(
    {
      items: [device(51, { current: true, lastSeenAt: 9_000 })],
      limit: 5,
    },
    { items: [webSession(12, { userAgent: "curl/8.0" })] },
  );
  const markup = render({ state: "ready", sessions });
  for (const header of ["Device", "Location", "Created", "Updated"])
    assert.match(markup, new RegExp(`<th>(<span[^>]*>)?${header}`));
  assert.match(markup, /Ada&#x27;s MacBook Pro \(Mac OS X\)/);
  assert.match(markup, /class="session-current">Current</);
  assert.match(markup, /<span>Unknown device<\/span>/);
  assert.equal(markup.match(/<td>Unknown<\/td>/g)?.length, 2);
  assert.match(
    markup,
    /aria-label="Session actions for Ada&#x27;s MacBook Pro \(Mac OS X\) \(current session\)"/,
  );
  assert.match(
    markup,
    /aria-label="Session actions for Unknown device created /,
  );
  assert.doesNotMatch(markup, /active-sessions-pager/);
});

test("loading, empty, failed and local states", () => {
  const loading = render({ state: "loading" });
  assert.match(loading, /aria-busy="true"/);
  assert.equal(loading.match(/class="sk"/g)?.length, 12, "three rows of four");
  assert.match(
    render({ state: "ready", sessions: [] }),
    /No active sessions found\./,
  );
  const failed = render({ state: "failed" });
  assert.match(failed, /Unable to load active sessions\. Try again later\./);
  assert.doesNotMatch(failed, /<table/);
  assert.match(render({ state: "local" }), /Not available in Claudex yet/);
});

test("more than ten sessions page ten at a time", () => {
  const sessions = activeSessionsFrom(
    {
      items: Array.from({ length: 14 }, (_, i) =>
        device(i + 1, { lastSeenAt: 100 - i }),
      ),
      limit: 50,
    },
    null,
  );
  const markup = render({ state: "ready", sessions });
  assert.equal(markup.match(/<tr>/g)?.length, 1 + sessionsPerPage);
  assert.match(markup, /Showing 1–10 of 14/);
  assert.match(markup, /Page 1 of 2/);
  assert.match(markup, /aria-label="Previous page" disabled=""/);
});
