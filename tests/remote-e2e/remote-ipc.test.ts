/**
 * The desktop's remote mode end to end in Node (R13-T, I2): the real
 * IPC handlers of the remote sign-in, policy and usage domains, the real
 * `RemoteHost`, policy host and refusal handling, against the mock Claudex
 * service (`tests/sub2api-mock.ts`) over HTTP. No Electron window: the
 * AppContext below has the members these domains use, with the account
 * lifecycle main.ts runs (prepare the plan and device key, start the
 * policy host) reduced to what matters here.
 *
 * Covered: sign-in → device registration → a policy change pushed as a
 * "policy" event → a usage refusal from the gateway held as the global
 * limit notice → a 426 from the gateway reading the release again once
 * (the update notice follows) → revoke-all elsewhere signing this device
 * out → revoke-all from this device.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import {
  type AccountLifecycle,
  type PolicyHost,
} from "../../electron/remote/host";
import {
  createPolicyHost,
  handleRefusal,
  registerRemoteAccounts,
} from "../../electron/remote/host-wiring";
import { registerPolicyHandlers } from "../../electron/ipc/policy";
import { registerUsageHandlers } from "../../electron/ipc/usage";
import type { KeyStore } from "../../electron/sub2api/backend";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { defaultSettings } from "../../electron/store/store";
import { describeSub2ApiRefusal } from "../../server/sub2api-errors";
import type { ClientPolicy } from "../../shared/client-policy";
import type { AppEvent, PublicAccount } from "../../shared/types";
import type { WeeklyUsageStatus } from "../../shared/usage-api";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";

const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const pro = {
  id: 4,
  name: "claudex-pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};
const later = (days: number) =>
  new Date(Date.now() + days * 86400_000).toISOString();

/** The device key vault and gateway reads, as the provider child does them. */
function directKeys(): KeyStore & { stored: Record<string, string> } {
  const stored: Record<string, string> = {};
  return {
    stored,
    canPersist: true,
    has: (id) => !!stored[id],
    async setKeys(patch) {
      Object.assign(stored, patch);
      return Object.fromEntries(
        Object.entries(stored).map(([id, key]) => [id, !!key]),
      );
    },
    async remote(provider, route, apiKey) {
      const response = await fetch(`${provider.baseUrl}/${route}`, {
        headers: {
          Authorization: `Bearer ${apiKey || stored[provider.id] || ""}`,
        },
      });
      const body = await response.text();
      if (route === "models" && response.ok)
        return {
          ok: true,
          status: 200,
          models: JSON.parse(body).data.map((item: { id: string }) => item.id),
        };
      return { ok: response.ok, status: response.status, body };
    },
  };
}

type Handler = (...args: unknown[]) => unknown;

/** Waits until `check` returns a value (events arrive asynchronously). */
async function until<T>(
  check: () => T | undefined | false,
  what: string,
  tries = 300,
): Promise<T> {
  // Counted in tries: the test moves the clock (Date) by hand.
  for (let i = 0; i < tries; i++) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error(`timed out waiting for ${what}`);
}

/**
 * The app as main.ts builds it for a Sub2API service, without windows: the
 * IPC domains register on `handlers`, events land in `events`.
 */
function app(mock: MockSub2Api, root: string) {
  const events: AppEvent[] = [];
  const handlers = new Map<string, Handler>();
  const keys = directKeys();
  const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
  let policyHost: PolicyHost | undefined;
  let deactivations = 0;
  const members: Record<string, unknown> = {
    remote: undefined,
    activeAccount: undefined,
    dataRoot: root,
    appVersion: "1.3.2",
    store: {
      root: path.join(root, "profile"),
      settings: structuredClone(defaultSettings),
      flush() {},
    },
    engine: {},
    credentials: keys,
    mcpConfig: undefined,
    push: (event: AppEvent) => events.push(event),
    settingsChanged() {},
    onWindowFocus: () => () => {},
    policy: (): ClientPolicy => {
      if (!policyHost) throw Error("no account is signed in");
      return policyHost.current();
    },
    refreshPolicy: () => void policyHost?.source.refresh(),
  };
  fs.mkdirSync(path.join(root, "profile"), { recursive: true });
  const ctx = new Proxy(members, {
    get: (target, key) => {
      if (key in target) return target[key as string];
      throw Error(`AppContext.${String(key)} is not part of this test`);
    },
  }) as unknown as AppContext;
  const lifecycle: AccountLifecycle = {
    async activate(account: PublicAccount, _token, remote) {
      if (!remote) throw Error("expected a remote account");
      members.remote = remote;
      members.activeAccount = account;
      await remote.backend.prepare(keys);
      policyHost = createPolicyHost(ctx, account.id);
      policyHost.start();
    },
    async deactivate() {
      policyHost?.stop();
      policyHost = undefined;
      const remote = members.remote as
        { release(k: unknown): Promise<void> } | undefined;
      await remote?.release(keys);
      members.remote = undefined;
      members.activeAccount = undefined;
      deactivations++;
    },
  };
  members.deactivate = () => lifecycle.deactivate();
  const handle = (name: string, fn: Handler) => {
    assert.ok(!handlers.has(name), `${name} registered twice`);
    handlers.set(name, fn);
  };
  registerRemoteAccounts(handle, ctx, accounts, lifecycle);
  registerPolicyHandlers(handle, ctx);
  registerUsageHandlers(handle, ctx);
  return {
    ctx,
    events,
    keys,
    accounts,
    call: (name: string, ...args: unknown[]) => {
      const fn = handlers.get(name);
      if (!fn) throw Error(`no IPC handler ${name}`);
      return fn(...args);
    },
    get deactivations() {
      return deactivations;
    },
    /** A gateway request with this device's key, as the provider child reports it. */
    async gatewayRefusal() {
      const remote = ctx.remote!;
      const provider = remote.backend.provider!;
      const response = await fetch(`${provider.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${keys.stored[provider.id]}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5.5", input: "hi" }),
      });
      const refusal = describeSub2ApiRefusal(
        response.status,
        await response.text(),
      );
      assert.ok(refusal, `HTTP ${response.status} is a refusal`);
      return refusal;
    },
    async close() {
      if (ctx.activeAccount) await lifecycle.deactivate();
    },
  };
}

test("remote mode over IPC: sign-in, policy, usage refusal, 426, revoke-all", async (t) => {
  // Only the clock: the window's policy reads are spaced 30 s apart.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const mock = new MockSub2Api({
    users: [user],
    userApiKeys: false,
    settings: { site_name: "Acme Claudex" },
    groups: [pro],
    subscriptions: [
      { id: 77, group_id: 4, status: "active", expires_at: later(30) },
    ],
    models: { status: 200, body: { data: [{ id: "gpt-5.5" }] } },
    policy: { plan_label: "Pro" },
    registrationThrottle: false,
  });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-remote-ipc-"));
  const desktop = app(mock, root);
  try {
    // Sign-in over IPC: bootstrap, then the device registers (never /keys).
    const account = (await desktop.call(
      "loginAccount",
      user.email,
      user.password,
    )) as PublicAccount;
    assert.equal(account.email, user.email);
    const remote = desktop.ctx.remote!;
    assert.ok(remote.ready && remote.claudex);
    assert.equal(mock.devices.length, 1);
    assert.equal(
      mock.calls.filter((call) => call === "POST /api/v1/claudex/devices")
        .length,
      1,
    );
    assert.ok(!mock.calls.some((call) => call.startsWith("POST /api/v1/keys")));
    const provider = remote.backend.provider!;
    assert.ok(desktop.keys.stored[provider.id]?.startsWith("sk-"));
    assert.equal(
      (desktop.call("clientPolicy") as ClientPolicy).planLabel,
      "Pro",
    );

    // The administrator changes the policy: the window hears it at its
    // next read (reads from the window are at least 30 s apart).
    mock.options.policy = { plan_label: "Max" };
    t.mock.timers.tick(31_000);
    desktop.call("clientPolicy");
    await until(
      () =>
        desktop.events.find(
          (event) =>
            event.type === "policy" && event.policy.planLabel === "Max",
        ),
      "the policy event",
    );

    // A 5-hour session rule refuses the device key: the banner status carries
    // the global limit notice.
    const resetsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    mock.options.refusal = {
      status: 429,
      code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
      message: "You've reached your session limit.",
      claudex: {
        v: 1,
        reason: "RULE_LIMIT",
        kind: "rule_limit",
        rule_kind: "session",
        window: "5h",
        resets_at: resetsAt,
        retry_after_seconds: 3 * 3600,
        reprovision: false,
        action: "wait",
        message: "You've reached your session limit.",
      },
    };
    const limited = await desktop.gatewayRefusal();
    assert.equal(limited.status, 429);
    const before = desktop.events.length;
    handleRefusal(desktop.ctx, limited);
    const usage = await until(
      () =>
        desktop.events
          .slice(before)
          .find((event) => event.type === "weekly-usage"),
      "the usage banner event",
    );
    const status = (usage as { status: WeeklyUsageStatus | null }).status;
    assert.equal(status?.globalLimit?.kind, "session");
    assert.equal(status?.globalLimit?.resetsAt, Date.parse(resetsAt));
    const viaIpc = (await desktop.call(
      "weeklyUsageStatus",
    )) as WeeklyUsageStatus | null;
    assert.equal(viaIpc?.globalLimit?.kind, "session");
    assert.equal(desktop.ctx.remote, remote, "a usage limit keeps the session");

    // 426: the release is read again once however many requests fail, and
    // the enforced update reaches the window through the policy.
    mock.options.release = {
      latest_version: "99.0.0",
      minimum_version: "99.0.0",
      enforce_minimum_on_gateway: true,
      downloads: {
        "darwin-arm64": { url: "https://dl.example.com/Claudex-99.zip" },
        "darwin-x64": { url: "https://dl.example.com/Claudex-99-x64.zip" },
        "win32-x64": { url: "https://dl.example.com/Claudex-99.exe" },
        "linux-x64": { url: "https://dl.example.com/Claudex-99.AppImage" },
      },
    };
    mock.options.refusal = {
      status: 426,
      code: "CLAUDEX_UPGRADE_REQUIRED",
      message: "This version of Claudex is no longer supported.",
      claudex: {
        v: 1,
        reason: "UPGRADE_REQUIRED",
        kind: "upgrade",
        reprovision: false,
        action: "update",
        minimum_version: "99.0.0",
        latest_version: "99.0.0",
        message: "This version of Claudex is no longer supported.",
      },
    };
    const bootstraps = () =>
      mock.calls.filter((call) => call === "GET /api/v1/claudex/bootstrap")
        .length;
    const readsBefore = bootstraps();
    const upgrade = await desktop.gatewayRefusal();
    assert.equal(upgrade.status, 426);
    for (let i = 0; i < 3; i++) handleRefusal(desktop.ctx, upgrade);
    const updated = await until(
      () =>
        desktop.events.find(
          (event) =>
            event.type === "policy" &&
            event.policy.update?.state === "required",
        ),
      "the update in the policy",
    );
    assert.equal(
      bootstraps(),
      readsBefore + 1,
      "one release read for three refusals",
    );
    assert.equal(
      updated.type === "policy" && updated.policy.update?.latestVersion,
      "99.0.0",
    );
    assert.ok(desktop.events.some((event) => event.type === "service-changed"));
    assert.equal(desktop.ctx.remote, remote, "an update keeps the session");
    mock.options.refusal = undefined;

    // Revoke-all on another device: the next service call signs this one out.
    mock.sessionsRevokedAt.set(user.id, Date.now() + 1);
    const deactivatedBefore = desktop.deactivations;
    t.mock.timers.tick(31_000);
    desktop.call("clientPolicy");
    const signedOut = await until(
      () => desktop.events.find((event) => event.type === "signed-out"),
      "the signed-out event",
    );
    assert.equal(
      signedOut.type === "signed-out" && signedOut.reason,
      "revoked",
    );
    assert.equal(desktop.deactivations, deactivatedBefore + 1);
    assert.equal(desktop.ctx.remote, undefined);
    assert.equal(
      await desktop.accounts.restore(),
      undefined,
      "session forgotten",
    );
    assert.equal(
      desktop.keys.stored[provider.id],
      "",
      "device key left the vault",
    );
    mock.sessionsRevokedAt.clear();

    // Sign in again, then "Log out of all devices" from here.
    await desktop.call("loginAccount", user.email, user.password);
    const current = (): AppContext["remote"] => desktop.ctx.remote;
    assert.ok(current()?.ready);
    const result = (await desktop.call("revokeAllSessions")) as {
      hasAccounts: boolean;
    };
    assert.equal(typeof result.hasAccounts, "boolean");
    assert.equal(desktop.ctx.activeAccount, undefined);
    assert.ok(mock.calls.includes("POST /api/v1/auth/revoke-all-sessions"));
    assert.ok(
      mock.devices.every((device) => device.revokedReason === "revoke_all"),
      "every device of the account is signed out",
    );
    assert.equal(await desktop.accounts.restore(), undefined);
  } finally {
    await desktop.close();
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
