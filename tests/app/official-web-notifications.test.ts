import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { defaultSettings } from "../../electron/store/store";
import type { DispatcherOptions } from "../../runner/src/dispatcher";
import type { WebAppContext } from "../../runner/src/web-app-context";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { browserNotificationSettings } from "../../shared/official-notification-preferences";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import type { Settings, Snapshot } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import { createOfficialNotificationPreferences } from "../../src-web/official/notification-preferences";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { useElectronShim } from "../runner/runner-core-support.test";

useElectronShim();
const { Dispatcher } = await import("../../runner/src/dispatcher");
const { officialUiRead } = await import("../../runner/src/official-ui-read");

const origin = "https://claudex.example";
const account = { id: "notification-settings-owner" };
const organization = organizationUuid(account.id);
const path = `/api/organizations/${organization}/notification/preferences`;
const foreign = path.replace(organization, organizationUuid("other-owner"));
const fallback = () => { throw Error("Notification preferences escaped their account."); };
const patch = (feature_preference: object) => ({
  method: "PATCH",
  body: JSON.stringify({ preferences: { feature_preference } }),
});
const snapshot: Snapshot = {
  settings: defaultSettings,
  projects: [],
  conversations: [],
  approvals: [],
  artifactLibrary: { version: 1, copies: [], pinned: [] },
  artifactShares: [],
  dismissedBackgroundTasks: [],
  engine: { state: "stopped" },
  replyFeedback: {},
  platform: "linux",
};

const user = { id: 1, accessToken: "fixture-token" };
const runtime = {
  serviceUrl: origin,
  stateDir: "/nonexistent",
  providerServiceScript: "/nonexistent",
  version: "0",
  codexBinary: () => "/bin/false",
};
const options = {
  officialUiRoot: "/fixture-assets",
  runtime,
  link: { send: () => true, request: async () => ({}) },
  publish() {},
  openUrl() {},
};
const get = { method: "GET", path } satisfies OfficialUiReadRequest;

async function read(
  dispatcher: InstanceType<typeof Dispatcher>,
  request: OfficialUiReadRequest & { bodySegments?: Uint8Array[] } = get,
  signal?: AbortSignal,
) {
  const result = await officialUiRead(dispatcher, {
    t: "call", id: "notification-preferences", deadlineMs: 1000,
    method: "officialUiRead", user, args: [encodeWireValue(request)], signal,
  });
  assert.ok(result && typeof result === "object" && "status" in result && "body" in result && "contentType" in result);
  assert.ok(typeof result.status === "number" && typeof result.contentType === "string");
  assert.ok(result.body instanceof Uint8Array);
  return { status: result.status, contentType: result.contentType, body: Buffer.from(result.body) };
}

function notificationRunner(
  settings: () => Settings,
  open?: (input: Parameters<NonNullable<DispatcherOptions["openContext"]>>[1]) => Promise<void>,
) {
  function makeContext() {
    const identity = {};
    return {
      userId: user.id,
      activeAccount: account,
      accountRetiring: false,
      closed: false,
      officialSessionIdentity: () => identity,
      setAccessToken() {},
      store: { get settings() { return settings(); } },
      async close() { this.closed = true; },
    };
  }
  let ctx = makeContext();
  const dispatcher = new Dispatcher({
    ...options,
    async openContext(_runtime, input) {
      if (ctx.closed) ctx = makeContext();
      await open?.(input);
      return ctx as unknown as WebAppContext;
    },
  });
  return {
    get ctx() { return ctx; },
    dispatcher,
    read: (request: Parameters<typeof read>[1], signal?: AbortSignal) => read(dispatcher, request, signal),
  };
}

function gate() {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  return { held, release };
}

test("the original Web notification preferences GET returns current Runner flags without a snapshot", async () => {
  const settings = { ...defaultSettings, notifyResponses: true, notifySchedules: false,
    notifySchedulesEmail: true, notifyCodeUpdates: true, notifyCodeEmail: false, notifyCodePermissions: false };
  const runner = notificationRunner(() => settings);
  const notificationPreferences = createOfficialNotificationPreferences({ snapshot: fallback, saveSettings: fallback }, () => true);
  const fetch = createOfficialReadFetch(origin, runner.read, fallback, undefined, undefined, undefined,
    undefined, { organization }, undefined, { notificationPreferences, current: () => true });

  const result = await fetch(path);
  const feature = {
    compass: { enable_push: true },
    completion: { enable_push: true },
    routines: { enable_push: false, enable_email: true },
    bogosort: { enable_push: true, enable_email: false },
    code_requires_action: { enable_push: false },
  };
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await result.json(), {
    preferences: { feature_preference: feature },
    effective_preferences: feature,
    push_reachability: { platforms: [], has_active_channel: false, most_recent_token_refresh: null },
    admin_spend_alerts_available: false,
    admin_join_request_alerts_available: false,
  });

  assert.equal((await fetch(foreign)).status, 404);
  assert.equal((await fetch(path + "?unexpected=1")).status, 400);
  assert.equal((await fetch(path, { method: "POST" })).status, 405);
  const inactiveSurface = createOfficialReadFetch(origin, fallback, fallback, undefined, undefined, undefined,
    undefined, { organization });
  assert.equal((await inactiveSurface(path)).status, 501);

  assert.equal((await runner.read({ method: "GET", path: foreign })).status, 404);
  assert.equal((await runner.read({ method: "GET", path: path + "?unexpected=1" })).status, 400);
  assert.equal((await runner.read({ method: "GET", path, bodySegments: [new Uint8Array([1])] })).status, 400);
  assert.equal((await runner.read({ method: "PATCH", path })).status, 405);
  assert.equal((await runner.read({ method: "GET", path }, AbortSignal.abort())).status, 409);
  runner.ctx.accountRetiring = true;
  assert.equal((await fetch(path)).status, 409);
});

test("cold notification preferences require the authenticated user and a successful settings read", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "runner-notification-settings-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  let authUser = 2;
  let failSettings = true;
  const requested: string[] = [];
  const history = gate();
  const serviceUrl = origin;
  const accountPath = path.replace(organization, organizationUuid(remoteAccountId(serviceUrl, user.id)));
  const dispatcher = new Dispatcher({
    ...options,
    runtime: {
      ...runtime, serviceUrl, stateDir,
      fetch: async (input) => {
        assert.equal(String(input), origin + "/api/v1/auth/me");
        return Response.json({
          code: 0, data: { id: authUser, email: "owner@example.test", username: "Owner" },
        });
      },
    },
    link: {
      ...options.link,
      async request(op) {
        requested.push(op);
        if (op === "store.settings.get") {
          if (failSettings) throw new Error("settings unavailable");
          return { settings: { notifyResponses: true } };
        }
        if (op === "store.projects.list") {
          await history.held;
          throw new Error("history unavailable");
        }
        throw new Error("Unexpected Runner request " + op);
      },
    },
  });
  const prefs = () => read(dispatcher, { method: "GET", path: accountPath });
  await assert.rejects(prefs(), /session does not belong to this user/i);
  assert.deepEqual(requested, []);
  authUser = user.id;
  await assert.rejects(prefs(), /settings unavailable/);
  failSettings = false;
  const context = dispatcher.contextFor({ user });
  const failedHistory = assert.rejects(context, /history unavailable/);
  try {
    const reply = await prefs();
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(reply.body.toString()).preferences.feature_preference.completion.enable_push, true);
    assert.equal(dispatcher.context(user.id), undefined);
    assert.deepEqual(requested, ["store.settings.get", "store.settings.get", "store.projects.list"]);
  } finally {
    history.release();
    await failedHistory;
  }
});

test("a notification read waiting for settings ends when its opening account signs out", async () => {
  const started = gate();
  const hydration = gate();
  const settings = { ...defaultSettings, notifyResponses: true };
  const runner = notificationRunner(() => settings, async (input) => {
    started.release();
    await hydration.held;
    input.accountSettingsReady?.({ accountId: account.id, settings: browserNotificationSettings(settings) });
  });
  const prefs = runner.read(get);
  await started.held;
  const context = assert.rejects(runner.dispatcher.contextFor({ user }), /session has ended/i);
  try {
    await runner.dispatcher.signedOut({ t: "user-signed-out", userId: user.id, reason: "revoked" });
    assert.equal((await prefs).status, 409);
  } finally {
    hydration.release();
    await context;
  }
  assert.equal(runner.ctx.closed, true);
  assert.equal(runner.dispatcher.context(user.id), undefined);
});

test("a captured metadata read cannot read a replacement account", async () => {
  const hydration = gate();
  let settings = { ...defaultSettings, notifyResponses: true };
  const runner = notificationRunner(() => settings, async (input) => {
    input.accountSettingsReady?.({ accountId: account.id, settings: browserNotificationSettings(settings) });
    await hydration.held;
  });
  const oldRead = await runner.dispatcher.accountSettingsFor({ user });
  assert.equal(oldRead(user.accessToken)?.settings.notifyResponses, true);
  const context = assert.rejects(runner.dispatcher.contextFor({ user }), /session has ended/i);
  try {
    await runner.dispatcher.signedOut({ t: "user-signed-out", userId: user.id, reason: "revoked" });
  } finally {
    hydration.release();
    await context;
  }
  settings = { ...settings, notifyResponses: false };
  const replacement = await runner.read(get);
  assert.equal(replacement.status, 200);
  assert.equal(JSON.parse(replacement.body.toString()).preferences.feature_preference.completion.enable_push, false);
  assert.equal(oldRead(user.accessToken), undefined);
});

test("the official Web notification settings retain concurrent changes and report delivery while the site is open", async () => {
  let settings = { ...defaultSettings, name: "Keep this setting" };
  const notificationPreferences = createOfficialNotificationPreferences({
    snapshot: async () => ({ ...snapshot, settings }),
    saveSettings: async (value) => (settings = value),
  }, () => true);
  const fetch = createOfficialReadFetch(origin, notificationRunner(() => settings).read, fallback, undefined, undefined, undefined,
    undefined, { organization }, undefined, { notificationPreferences, current: () => true });
  const [response, code] = await Promise.all([
    fetch(path, patch({ completion: { enable_push: true }, compass: { enable_push: true } })),
    fetch(path, patch({ bogosort: { enable_push: true }, code_requires_action: { enable_push: true } })),
  ]);
  assert.equal(response.status, 200);
  assert.equal(code.status, 200);
  const current = await (await fetch(path)).json();
  assert.deepEqual(await code.json(), current);
  const { preferences: { feature_preference }, push_reachability } = current;
  assert.equal(feature_preference.compass.enable_push, true);
  assert.equal(feature_preference.completion.enable_push, true);
  assert.equal(feature_preference.bogosort.enable_push, true);
  assert.equal(feature_preference.code_requires_action.enable_push, true);
  assert.equal(push_reachability.has_active_channel, false);
  assert.equal(settings.name, "Keep this setting");
});

test("the official Web notification settings reject a foreign organization and leave a revoked account's queued write untouched", async () => {
  let active = true;
  let saved = 0;
  let resolveSnapshot: (value: Snapshot) => void = () => {};
  let reading: () => void = () => {};
  const pending = new Promise<Snapshot>(resolve => { resolveSnapshot = resolve; });
  const started = new Promise<void>(resolve => { reading = resolve; });
  const notificationPreferences = createOfficialNotificationPreferences({
    snapshot: () => { reading(); return pending; },
    saveSettings: async value => { saved++; return value; },
  }, () => active);
  const fetch = createOfficialReadFetch(origin, fallback, fallback, undefined, undefined, undefined,
    undefined, { organization }, undefined, { notificationPreferences, current: () => active });
  assert.equal((await fetch(foreign, patch({ routines: { enable_push: true } }))).status, 404);
  const result = fetch(path, patch({ routines: { enable_push: true } }));
  await started;
  active = false;
  resolveSnapshot(snapshot);
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(saved, 0);
});
