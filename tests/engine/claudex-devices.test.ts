/**
 * Package C2 on a Claudex service: bootstrap, device registration through
 * `POST /claudex/devices` (never `/api/v1/keys`), the provider and model
 * catalog, sign-in errors, reprovisioning and the ways the service ends a
 * session on this device.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { signInError } from "../../electron/sub2api/identity-support";
import { RemoteBackend, type KeyStore } from "../../electron/sub2api/backend";
import { reconnectMessage } from "../../electron/sub2api/backend-support";
import { deviceId } from "../../electron/sub2api/provision";
import { registerRemoteAuthHandlers } from "../../electron/ipc/remote-auth";
import { RemoteHost } from "../../electron/remote/host";
import { handleRefusal } from "../../electron/remote/host-wiring";
import type { AppContext } from "../../electron/app/app-context";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { AppEvent } from "../../shared/types";
import {
  MockSub2Api,
  fakeCipher,
  type MockOptions,
} from "../support/sub2api-mock";

const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const pro = {
  id: 4,
  name: "claudex-pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};
const standard = {
  id: 1,
  name: "default",
  platform: "anthropic",
  subscription_type: "standard",
  status: "active",
};
const later = (days: number) =>
  new Date(Date.now() + days * 86400_000).toISOString();

/** A fresh fork: users cannot write /api/v1/keys (owner decision 17). */
async function setup(options: MockOptions = {}) {
  const mock = new MockSub2Api({
    users: [user],
    userApiKeys: false,
    settings: { site_name: "Acme Claudex" },
    groups: [pro],
    subscriptions: [
      { id: 77, group_id: 4, status: "active", expires_at: later(30) },
    ],
    models: {
      status: 200,
      body: { data: [{ id: "gpt-5.5-mini" }, { id: "gpt-5.5" }] },
    },
    ...options,
  });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-devices-"));
  return {
    mock,
    root,
    async signIn() {
      const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
      const result = await accounts.login(user.email, user.password);
      if (result.kind !== "signedIn") throw Error("expected sign-in");
      return { accounts, session: result.session };
    },
    async done() {
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The vault and the gateway reads, as the provider child would do them. */
function directKeys(
  canPersist = true,
): KeyStore & { stored: Record<string, string> } {
  const stored: Record<string, string> = {};
  return {
    stored,
    canPersist,
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

const claudexCalls = (mock: MockSub2Api) =>
  mock.calls.filter((call) => call.includes("/claudex/"));

test("sign-in reads the bootstrap, registers the device and builds the provider from the plan", async () => {
  const env = await setup({
    catalog: {
      default_model: "gpt-5.5",
      items: [
        {
          id: "gpt-5.5",
          display_name: "GPT-5.5",
          description: "Our smartest model for complex work",
          badges: ["new"],
          sort: 10,
          hidden: false,
          default: true,
          efforts: ["low", "medium", "high", "xhigh"],
          default_effort: "medium",
          context_window: 400000,
          auto_compact_tokens: 320000,
          fast: true,
          usage_hint: "1.5× usage",
        },
        {
          id: "gpt-5.5-mini",
          display_name: "GPT-5.5 mini",
          description: "Fast for everyday tasks",
          badges: [],
          sort: 20,
          hidden: true,
          default: false,
          context_window: 200000,
          fast: false,
          usage_hint: "",
        },
        { id: "retired", display_name: "Retired", sort: 1 },
      ],
    },
    voice: { transcription: { enabled: true, model: "gpt-4o-transcribe" } },
  });
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys();
    const provider = await backend.prepare(keys);
    assert.deepEqual(claudexCalls(env.mock), [
      "GET /api/v1/claudex/release",
      "GET /api/v1/claudex/bootstrap",
      "POST /api/v1/claudex/devices",
    ]);
    assert.equal(env.mock.keyWrites, 0);
    assert.equal(backend.kind, "claudex");
    assert.deepEqual(
      {
        name: provider.name,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        models: provider.models,
        model: provider.model,
        transcriptionModel: provider.transcriptionModel,
      },
      {
        name: "Acme Claudex",
        protocol: "responses",
        baseUrl: `${env.mock.url}/v1`,
        // Catalog order; the hidden model stays (More models).
        models: ["gpt-5.5", "gpt-5.5-mini"],
        model: "gpt-5.5",
        transcriptionModel: "gpt-4o-transcribe",
      },
    );
    assert.deepEqual(
      backend.catalog?.items.map((item) => [
        item.id,
        item.hidden,
        item.isDefault,
      ]),
      [
        ["gpt-5.5", false, true],
        ["gpt-5.5-mini", true, false],
      ],
    );
    assert.equal(backend.plan?.groupId, 4);
    assert.equal(backend.planName, "claudex-pro");
    // The device key is the service's, in the vault only.
    const device = env.mock.devices[0];
    const key = env.mock.keys.find((item) => item.id === device.keyId)!;
    assert.equal(keys.stored.sub2api, key.key);
    assert.match(key.name, /^claudex-device:[0-9a-f]{12}$/);
    assert.equal(device.deviceId, deviceId(env.root));
    assert.equal(device.platform, process.platform);
    // The device id went in the header of panel requests only, never in a URL or body.
    const registration = env.mock.requests.find(
      (item) => item.path === "/api/v1/claudex/devices",
    )!;
    assert.equal(registration.headers["x-claudex-device-id"], device.deviceId);
    assert.ok(env.mock.calls.every((call) => !call.includes(device.deviceId)));
    const gateway = env.mock.requests.find(
      (item) => item.path === "/v1/models",
    );
    assert.equal(gateway?.headers["x-claudex-device-id"], undefined);

    // The next read in this sign-in reuses the key when the service says it is fine.
    await backend.prepare(keys);
    assert.equal(
      env.mock.calls.filter((call) => call === "POST /api/v1/claudex/devices")
        .length,
      1,
    );
    // A new plan: the bootstrap asks for registration again; the key moves.
    env.mock.options.groups = [pro, standard];
    env.mock.options.subscriptions = [];
    env.mock.options.defaultGroupId = 1;
    const moved = await backend.prepare(keys);
    assert.equal(moved.protocol, "chat");
    assert.equal(backend.plan?.groupId, 1);
    assert.equal(env.mock.keys.length, 1);
    assert.equal(env.mock.keys[0].group_id, 1);
    assert.equal(env.mock.keyWrites, 0);
  } finally {
    await env.done();
  }
});

test("only a 404 from /claudex/release falls back to the legacy key flow", async () => {
  const legacy = await setup({ claudex: false, userApiKeys: true });
  try {
    const { accounts, session } = await legacy.signIn();
    const backend = new RemoteBackend(accounts, session, legacy.root);
    await backend.prepare(directKeys());
    assert.equal(backend.kind, "legacy");
    assert.ok(legacy.mock.keyWrites > 0);
    assert.equal(
      legacy.mock.keys[0].name,
      `claudex-desktop:${deviceId(legacy.root)}`,
    );
  } finally {
    await legacy.done();
  }
  // A release endpoint in trouble and a bootstrap answering 503 are an
  // outage, not an older service: no key is written through /api/v1/keys.
  const outage = await setup();
  try {
    outage.mock.route(
      "GET",
      "/api/v1/claudex/release",
      () => ({ status: 503, body: { code: 503, message: "busy" } }),
      { auth: "none" },
    );
    outage.mock.route("GET", "/api/v1/claudex/bootstrap", () => ({
      status: 503,
      body: { code: 503, message: "busy" },
    }));
    const { accounts, session } = await outage.signIn();
    const backend = new RemoteBackend(accounts, session, outage.root);
    const keys = directKeys();
    const provider = await backend.prepare(keys);
    assert.equal(backend.kind, "claudex");
    assert.equal(outage.mock.keyWrites, 0);
    // The registration still issued the key and named the plan.
    assert.equal(provider.protocol, "responses");
    assert.match(keys.stored.sub2api, /^sk-/);
    assert.deepEqual(backend.catalog, null);
  } finally {
    await outage.done();
  }
});

test("device keys turned off: sign-in stops with the administrator's reason and writes no key", async () => {
  const env = await setup({ deviceKeys: false });
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    await assert.rejects(
      backend.prepare(directKeys()),
      /Your administrator has turned off Claudex sign-in for this service\./,
    );
    assert.equal(env.mock.keyWrites, 0);
    assert.equal(env.mock.devices.length, 0);
    assert.ok(!env.mock.calls.includes("POST /api/v1/claudex/devices"));
  } finally {
    await env.done();
  }
});

test("sign-in errors from the registration are explained and create no key", async () => {
  const env = await setup({ deviceLimit: 1 });
  try {
    env.mock.devices.push({
      id: 90,
      userId: 3,
      deviceId: "00000000-0000-4000-8000-000000000001",
      keyId: null,
      groupId: 4,
      deviceName: "Other",
      platform: "win32",
      arch: "x64",
      appVersion: "1.0.0",
      createdAt: later(-1),
      lastSeenAt: later(-1),
      revokedAt: null,
      revokedReason: "",
      registrations: [],
    });
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    const limit = await backend.prepare(directKeys()).catch((error) => error);
    assert.equal(
      signInError(limit).message,
      "You're signed in to Claudex on 1 devices, the most your account allows. Sign out on one of them, then sign in again.",
    );
    assert.equal(env.mock.keys.length, 0);

    // Balance only: an account without a plan group signs in with no key and no
    // models, and the composer says why.
    env.mock.devices = [];
    env.mock.options.groups = [];
    env.mock.options.subscriptions = [];
    const planless = new RemoteBackend(accounts, session, env.root);
    const vault = directKeys();
    vault.stored.sub2api = "sk-a-key-of-a-lost-group";
    const provider = await planless.prepare(vault);
    assert.deepEqual(provider.models, []);
    assert.equal(planless.plan, undefined);
    assert.deepEqual(planless.serviceGroups(), []);
    assert.equal(planless.problem?.code, "NO_MODELS");
    assert.equal(
      planless.problem?.message,
      "Your account does not include any models yet. Ask your administrator.",
    );
    assert.equal(
      vault.stored.sub2api,
      "",
      "the lost group's key leaves the vault",
    );
    assert.equal(env.mock.devices.length, 1);
    assert.equal(env.mock.devices[0].keyId, null);
    assert.equal(env.mock.keys.length, 0);
    assert.equal(env.mock.keyWrites, 0);
    // The next read finds the device registered: no second registration.
    await planless.prepare(vault);
    assert.equal(env.mock.devices[0].registrations.length, 1);
    // A refused key cannot be issued again without a group.
    await assert.rejects(
      planless.reprovision(async () => {}),
      /does not include any models yet/,
    );
    // An older service that still refuses the sign-in says the same.
    const { Sub2ApiError: RefusedError } =
      await import("../../electron/sub2api/http");
    assert.equal(
      signInError(new RefusedError(403, "CLAUDEX_NO_PLAN", "no plan")).message,
      "Your account does not include any models yet. Ask your administrator.",
    );
  } finally {
    await env.done();
  }
  const { Sub2ApiError } = await import("../../electron/sub2api/http");
  assert.equal(
    signInError(
      new Sub2ApiError(
        429,
        "CLAUDEX_DEVICE_REGISTRATION_THROTTLED",
        "slow down",
      ),
    ).message,
    "Too many sign-in attempts from this device. Try again in a minute.",
  );
  assert.equal(
    signInError(new Sub2ApiError(403, "CLAUDEX_DEVICE_KEYS_DISABLED", "off"))
      .message,
    "Your administrator has turned off Claudex sign-in for this service.",
  );
});

test("a refused key is issued again by the service, at most twice a minute", async () => {
  const env = await setup({ registrationThrottle: false });
  let now = Date.now();
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root, () => now);
    const keys = directKeys(false);
    const provider = await backend.prepare(keys);
    const first = backend.sessionKey(provider.id);
    assert.match(first, /^sk-/);
    // The administrator disabled the key: registering again rotates it.
    env.mock.keys[0].status = "disabled";
    let applied = "";
    await backend.reprovision(async (key) => {
      applied = key;
    });
    assert.notEqual(applied, first);
    assert.equal(backend.sessionKey(provider.id), applied);
    // Third registration within a minute: refused here, before the service.
    const posts = () =>
      env.mock.calls.filter((call) => call === "POST /api/v1/claudex/devices")
        .length;
    const before = posts();
    await assert.rejects(
      backend.reprovision(async () => {}),
      {
        message: reconnectMessage,
      },
    );
    assert.equal(posts(), before);
    now += 61_000;
    await backend.reprovision(async () => {});
    assert.equal(posts(), before + 1);
    assert.equal(env.mock.keyWrites, 0);
  } finally {
    await env.done();
  }
});

/** An AppContext for the host that only has what these tests use. */
function hostContext(members: Record<string, unknown>) {
  return new Proxy(members, {
    get: (target, key) =>
      key in target
        ? target[key as string]
        : () => {
            throw Error(`AppContext.${String(key)} is not faked`);
          },
  }) as unknown as AppContext;
}

test("the service ending the session signs this device out: revoke-all, a removed device, a refused refresh", async () => {
  // Three sign-ins of one device within a minute.
  const env = await setup({ registrationThrottle: false });
  try {
    for (const reason of [
      "revoked",
      "device-revoked",
      "session-expired",
    ] as const) {
      const { accounts, session } = await env.signIn();
      const backend = new RemoteBackend(accounts, session, env.root);
      const events: AppEvent[] = [];
      let deactivated = 0;
      const members: Record<string, unknown> = {
        push: (event: AppEvent) => events.push(event),
        deactivate: async () => {
          deactivated++;
          members.remote = undefined;
        },
      };
      const host = new RemoteHost(hostContext(members), backend);
      members.remote = host;
      host.watch();
      await backend.prepare(directKeys());
      host.ready = true;
      if (reason === "revoked") {
        // "Log out of all devices" on another device (H9b).
        env.mock.sessionsRevokedAt.set(3, Date.now() + 1);
        await assert.rejects(
          session.authorized((token) => accounts.client.me(token)),
          /signed out/,
        );
      } else if (reason === "device-revoked")
        // The gateway said so (package C3 forwards the service's detail).
        handleRefusal(hostContext({ ...members, remote: host }), {
          status: 401,
          code: "API_KEY_DISABLED",
          exceeded: false,
          invalidKey: true,
          message: "API key is disabled",
          claudex: {
            v: 1,
            reason: "DEVICE_REVOKED",
            kind: "key",
            reprovision: false,
            action: "sign_in",
            message:
              "This device was signed out. Sign in again to keep working.",
          },
        } as GatewayRefusal);
      else {
        // The refresh token was revoked elsewhere.
        env.mock.refreshTokens.clear();
        env.mock.expireAccessTokens();
        await assert.rejects(
          session.authorized((token) => accounts.client.me(token)),
        );
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(deactivated, 1, reason);
      const signedOut = events.filter((event) => event.type === "signed-out");
      assert.deepEqual(
        signedOut.map((event) => event.type === "signed-out" && event.reason),
        [reason],
      );
      // The saved session is gone; a second report changes nothing.
      assert.equal(await accounts.restore(), undefined);
      void host.signOut(reason);
      assert.equal(deactivated, 1);
      env.mock.sessionsRevokedAt.clear();
    }
  } finally {
    await env.done();
  }
});

test("on an older service a relay's refusal details do not sign the device out", async () => {
  const calls: string[] = [];
  const remote = {
    claudex: false,
    signOut: async () => void calls.push("signOut"),
    recordRefusal: () => calls.push("record"),
    reprovision: async () => void calls.push("reprovision"),
  };
  handleRefusal(
    hostContext({ remote, activeAccount: undefined, push: () => {} }),
    {
      status: 401,
      code: "API_KEY_DISABLED",
      exceeded: false,
      invalidKey: true,
      message: "x",
      signedOut: true,
    } as GatewayRefusal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["record", "reprovision"]);
});

test("Log out lets the device go first, then ends the session; a slow service does not hold it", async () => {
  const env = await setup();
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    await backend.prepare(directKeys());
    const host = new RemoteHost(hostContext({}), backend);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let deactivated = false;
    registerRemoteAuthHandlers((name, fn) => handlers.set(name, fn), {
      accounts,
      activeAccount: undefined,
      session,
      activate: async () => {
        throw Error("unused");
      },
      deactivate: async () => {
        deactivated = true;
      },
      leaveDevice: () => host.leaveDevice(),
    });
    await handlers.get("logoutAccount")!();
    const order = env.mock.calls.filter(
      (call) =>
        call === "DELETE /api/v1/claudex/devices/current" ||
        call === "POST /api/v1/auth/logout",
    );
    assert.deepEqual(order, [
      "DELETE /api/v1/claudex/devices/current",
      "POST /api/v1/auth/logout",
    ]);
    assert.equal(env.mock.devices[0].revokedReason, "user");
    assert.equal(env.mock.keys[0].status, "disabled");
    assert.ok(deactivated);
    // A device slot is free again: signing in once more registers the device anew.
    const again = await env.signIn();
    await new RemoteBackend(again.accounts, again.session, env.root).prepare(
      directKeys(),
    );
    assert.equal(env.mock.devices[0].revokedAt, null);

    // A service that does not answer: the leave gives up after its timeout.
    env.mock.route(
      "DELETE",
      "/api/v1/claudex/devices/current",
      () => new Promise(() => {}),
    );
    const started = Date.now();
    await assert.rejects(
      again.session.authorized((token) =>
        again.accounts.client.revokeCurrentDevice(
          token,
          deviceId(env.root),
          150,
        ),
      ),
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await env.done();
  }
});

test("the plan label comes from the policy on a Claudex service", async () => {
  const env = await setup({ policy: { plan_label: "Max" } });
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    await backend.prepare(directKeys());
    const policy = () => ({ planLabel: "Max" });
    const host = new RemoteHost(hostContext({ policy }), backend);
    assert.equal(
      host.account({ id: "a", email: "bob@example.test", name: "Bob" }).plan,
      "Max",
    );
    const unlabelled = new RemoteHost(
      hostContext({ policy: () => ({ planLabel: null }) }),
      backend,
    );
    assert.equal(
      unlabelled.account({ id: "a", email: "bob@example.test", name: "Bob" })
        .plan,
      "claudex-pro",
    );
    // The catalog's limits reach the engine for this account's models only.
    assert.equal(host.modelLimits("sub2api", "gpt-5.5"), undefined);
  } finally {
    await env.done();
  }
});

const grokGroup = {
  id: 11,
  name: "claudex-grok",
  platform: "grok",
  subscription_type: "standard",
  status: "active",
};

test("MG: every group's key is stored and each model routes to its group", async () => {
  const env = await setup({
    keyGroups: [grokGroup],
    modelsByGroup: { 4: ["gpt-5.5", "shared"], 11: ["grok-4", "shared"] },
    catalog: {
      default_model: "gpt-5.5",
      items: [
        { id: "gpt-5.5", display_name: "GPT-5.5", sort: 10, group_id: 4 },
        { id: "grok-4", display_name: "Grok 4", sort: 20, group_id: 11 },
        // The catalog names the grok group for a model both groups serve.
        { id: "shared", display_name: "Shared", sort: 30, group_id: 11 },
      ],
    },
  });
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys();
    const provider = await backend.prepare(keys);
    const device = env.mock.devices[0];
    const grokKey = env.mock.keys.find(
      (item) => item.id === device.groupKeys![11],
    )!;
    assert.equal(grokKey.group_id, 11);
    assert.equal(
      keys.stored.sub2api,
      env.mock.keys.find((item) => item.id === device.keyId)!.key,
    );
    assert.equal(keys.stored["sub2api:g11"], grokKey.key);
    assert.deepEqual(provider.models, ["gpt-5.5", "grok-4", "shared"]);
    assert.equal(provider.model, "gpt-5.5");
    assert.equal(provider.protocol, "responses");
    assert.deepEqual(
      provider.routes?.map((route) => [
        route.groupId,
        route.keyId,
        route.protocol,
        route.primary,
        route.models,
      ]),
      [
        [4, "sub2api", "responses", true, ["gpt-5.5"]],
        [11, "sub2api:g11", "chat", false, ["shared", "grok-4"]],
      ],
    );
    assert.deepEqual(
      backend.catalog?.items.map((item) => [item.id, item.groupId]),
      [
        ["gpt-5.5", 4],
        ["grok-4", 11],
        ["shared", 11],
      ],
    );
    // The gateway was asked with each group's own key.
    const reads = env.mock.requests
      .filter((item) => item.path === "/v1/models")
      .map((item) => item.headers.authorization);
    assert.deepEqual(reads, [
      `Bearer ${keys.stored.sub2api}`,
      `Bearer ${grokKey.key}`,
    ]);

    // Nothing changed: no new registration.
    await backend.prepare(keys);
    assert.equal(
      env.mock.calls.filter((call) => call === "POST /api/v1/claudex/devices")
        .length,
      1,
    );
    // The grok key was turned off: the bootstrap asks for registration and
    // the service issues a new grok key; the plan key stays.
    grokKey.status = "disabled";
    const planKey = keys.stored.sub2api;
    await backend.prepare(keys);
    assert.notEqual(keys.stored["sub2api:g11"], grokKey.key);
    assert.equal(keys.stored.sub2api, planKey);

    // Re-provisioning after a refusal hands every group's key over.
    let applied: [string, Record<string, string>] | undefined;
    env.mock.keys.find((item) => item.id === device.keyId)!.status = "disabled";
    // A minute later (two registrations a minute from one device).
    (backend as unknown as { registrations: number[] }).registrations = [];
    device.registrations = [];
    await backend.reprovision(async (key, groupKeys) => {
      applied = [key, groupKeys];
    });
    assert.equal(
      applied?.[0],
      env.mock.keys.find((item) => item.id === device.keyId)!.key,
    );
    assert.deepEqual(Object.keys(applied?.[1] ?? {}), ["sub2api:g11"]);
  } finally {
    await env.done();
  }
});

test("MG: without OS encryption the group keys stay in memory; one group keeps the old provider", async () => {
  const env = await setup({
    keyGroups: [grokGroup],
    modelsByGroup: { 4: ["gpt-5.5"], 11: ["grok-4"] },
  });
  try {
    const { accounts, session } = await env.signIn();
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys(false);
    const provider = await backend.prepare(keys);
    assert.deepEqual(keys.stored, {});
    const memory = backend.groupSessionKeys(provider.id);
    assert.deepEqual(Object.keys(memory), ["sub2api:g11"]);
    assert.match(memory["sub2api:g11"], /^sk-/);
    assert.deepEqual(backend.groupSessionKeys("other"), {});
    assert.deepEqual(provider.models, ["gpt-5.5", "grok-4"]);

    // The account loses the grok group: the routes go, the plan stays as before.
    env.mock.options.keyGroups = [];
    env.mock.devices[0].registrations = [];
    await backend.reprovision(async () => {});
    const single = await backend.prepare(keys);
    assert.equal(single.routes, undefined);
    assert.deepEqual(single.models, ["gpt-5.5"]);
    assert.deepEqual(backend.groupSessionKeys(provider.id), {});
  } finally {
    await env.done();
  }
});
