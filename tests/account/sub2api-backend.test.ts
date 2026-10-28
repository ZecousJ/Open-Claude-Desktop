import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import {
  choosePlan,
  deviceId,
  deviceKeyName,
  provisionDeviceKey,
} from "../../electron/sub2api/provision";
import { RemoteBackend, type KeyStore } from "../../electron/sub2api/backend";
import { ProviderServiceClient } from "../../electron/engine/provider-service-client";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { Provider } from "../../shared/types";
import { MockSub2Api, fakeCipher } from "../support/sub2api-mock";

const user = { id: 3, email: "bob@example.test", password: "bob-password" };
const standard = {
  id: 1,
  name: "default",
  platform: "anthropic",
  subscription_type: "standard",
  status: "active",
};
const pro = {
  id: 4,
  name: "Claudex Pro",
  platform: "openai",
  subscription_type: "subscription",
  status: "active",
};
const later = (days: number) =>
  new Date(Date.now() + days * 86400_000).toISOString();

async function signedIn(mock: MockSub2Api, root: string) {
  const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
  const result = await accounts.login(user.email, user.password);
  if (result.kind !== "signedIn") throw Error("expected sign-in");
  return { accounts, session: result.session };
}
/**
 * These tests cover the legacy flow of an older Sub2API without the Claudex
 * module (every Claudex route 404); a Claudex service's flow is in
 * claudex-devices.test.ts.
 */
async function setup(options: ConstructorParameters<typeof MockSub2Api>[0]) {
  const mock = new MockSub2Api({ users: [user], claudex: false, ...options });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-sub2api-"));
  return {
    mock,
    root,
    async done() {
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the plan is the longest active subscription, else the first usable group", async () => {
  const env = await setup({
    groups: [standard, pro],
    subscriptions: [
      { id: 9, group_id: 1, status: "active", expires_at: later(3) },
      {
        id: 10,
        group_id: 4,
        status: "active",
        expires_at: later(30),
        group: pro,
      },
    ],
  });
  try {
    const { accounts, session } = await signedIn(env.mock, env.root);
    const plan = await choosePlan(accounts.client, session);
    assert.deepEqual(
      [plan.groupId, plan.name, plan.platform, plan.subscribed],
      [4, "Claudex Pro", "openai", true],
    );
    env.mock.options.subscriptions = [];
    const fallback = await choosePlan(accounts.client, session);
    assert.deepEqual([fallback.groupId, fallback.subscribed], [1, false]);
    env.mock.options.groups = [];
    await assert.rejects(choosePlan(accounts.client, session), /no plan/);
  } finally {
    await env.done();
  }
});

test("device key provisioning is idempotent and follows plan changes", async () => {
  const env = await setup({ groups: [standard, pro] });
  try {
    const { accounts, session } = await signedIn(env.mock, env.root);
    const device = deviceId(env.root);
    assert.equal(device, deviceId(env.root));
    // Keys with other names, including a longer one containing ours, are ignored.
    env.mock.keys.push(
      {
        id: 50,
        user_id: 3,
        name: `${deviceKeyName(device)}-old`,
        key: `sk-${"1".repeat(64)}`,
        group_id: 4,
        status: "active",
      },
      ...Array.from({ length: 130 }, (_, i) => ({
        id: 100 + i,
        user_id: 3,
        name: `other ${i} ${deviceKeyName(device)}`,
        key: `sk-${String(i).padStart(64, "0")}`,
        group_id: 4,
        status: "active",
      })),
    );
    const plan = {
      groupId: 4,
      name: "Claudex Pro",
      platform: "openai",
      subscribed: true,
      expiresAt: null,
    };
    const first = await provisionDeviceKey(
      accounts.client,
      session,
      device,
      plan,
    );
    assert.equal(first.name, `claudex-desktop:${device}`);
    assert.equal(first.groupId, 4);
    const creates = () =>
      env.mock.calls.filter((call) => call === "POST /api/v1/keys").length;
    assert.equal(creates(), 1);
    const again = await provisionDeviceKey(
      accounts.client,
      session,
      device,
      plan,
    );
    assert.equal(again.key, first.key);
    assert.equal(creates(), 1);
    // Reading past the first page of search results found it (131 matches > 100 per page).
    assert.ok(
      env.mock.calls.filter((call) => call === "GET /api/v1/keys").length >= 4,
    );
    // A new plan moves the same key instead of creating another.
    const moved = await provisionDeviceKey(accounts.client, session, device, {
      ...plan,
      groupId: 1,
    });
    assert.equal(moved.key, first.key);
    assert.equal(moved.groupId, 1);
    assert.equal(creates(), 1);
  } finally {
    await env.done();
  }
});

/** A key store that talks to the mock gateway directly, as the provider child would. */
function directKeys(
  canPersist = true,
): KeyStore & { stored: Record<string, string> } {
  const stored: Record<string, string> = {};
  return {
    stored,
    canPersist,
    async setKeys(patch) {
      Object.assign(stored, patch);
      return Object.fromEntries(Object.keys(stored).map((id) => [id, true]));
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

test("the plan's gateway models replace the operator list; a zero balance is explained", async () => {
  const env = await setup({
    groups: [pro],
    subscriptions: [{ id: 10, group_id: 4, status: "active", group: pro }],
    models: {
      status: 200,
      body: { data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }] },
    },
  });
  try {
    const { accounts, session } = await signedIn(env.mock, env.root);
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys();
    const provider = await backend.prepare(keys);
    assert.deepEqual(
      {
        id: provider.id,
        backend: provider.backend,
        protocol: provider.protocol,
        model: provider.model,
        models: provider.models,
        baseUrl: provider.baseUrl,
      },
      {
        id: "sub2api",
        backend: "sub2api",
        protocol: "responses",
        model: "model-b",
        models: ["model-b", "model-a"],
        baseUrl: `${env.mock.url}/v1`,
      },
    );
    assert.equal(backend.planName, "Claudex Pro");
    assert.match(keys.stored.sub2api, /^sk-[0-9a-f]{64}$/);
    assert.equal(backend.problem, undefined);

    env.mock.options.models = {
      status: 403,
      body: {
        code: "INSUFFICIENT_BALANCE",
        message: "Insufficient account balance",
      },
    };
    const empty = await backend.prepare(keys);
    assert.deepEqual([empty.model, empty.models], ["", []]);
    const problem = backend.problem as GatewayRefusal | undefined;
    assert.equal(problem?.reason, "balance");
    assert.equal(
      problem?.message,
      "Your Claudex balance is used up. Add funds to keep going.",
    );
    // The same key was found again rather than duplicated.
    assert.equal(
      env.mock.calls.filter((call) => call === "POST /api/v1/keys").length,
      1,
    );
    // The balance refusal holds the exceeded banner until the list is read again.
    assert.equal(backend.refusal?.reason, "balance");
    env.mock.options.models = {
      status: 200,
      body: { data: [{ id: "model-a" }] },
    };
    const recovered = await backend.prepare(keys);
    assert.deepEqual(
      [recovered.model, backend.problem],
      ["model-a", undefined],
    );
    assert.equal(backend.refusal, undefined);
  } finally {
    await env.done();
  }
});

test("concurrent provisioning creates the device key once and re-provisioning follows a new plan", async () => {
  const env = await setup({
    groups: [standard, pro],
    subscriptions: [{ id: 10, group_id: 4, status: "active", group: pro }],
    models: { status: 200, body: { data: [{ id: "model-a" }] } },
  });
  try {
    const { accounts, session } = await signedIn(env.mock, env.root);
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys();
    await Promise.all([
      backend.prepare(keys),
      backend.prepare(keys),
      backend.reprovision(async () => {}),
    ]);
    assert.equal(
      env.mock.calls.filter((call) => call === "POST /api/v1/keys").length,
      1,
    );
    // The subscription ended; the gateway refuses the key's group.
    env.mock.options.subscriptions = [];
    let applied = "";
    await backend.reprovision(async (key) => {
      applied = key;
    });
    assert.equal(backend.plan?.groupId, 1);
    assert.equal(env.mock.keys.length, 1);
    assert.equal(env.mock.keys[0].group_id, 1);
    assert.equal(applied, env.mock.keys[0].key);
  } finally {
    await env.done();
  }
});

test("without OS encryption the device key stays in memory for this run", async () => {
  const env = await setup({
    groups: [pro],
    models: { status: 200, body: { data: [{ id: "model-a" }] } },
  });
  try {
    const { accounts, session } = await signedIn(env.mock, env.root);
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys(false);
    const provider = await backend.prepare(keys);
    assert.deepEqual(keys.stored, {});
    assert.equal(backend.keyInVault, false);
    assert.match(backend.sessionKey(provider.id), /^sk-/);
    assert.equal(backend.sessionKey("other"), "");
    assert.deepEqual(provider.models, ["model-a"]);
    let applied = "";
    env.mock.keys = [];
    await backend.reprovision(async (key) => {
      applied = key;
    });
    assert.equal(backend.sessionKey(provider.id), applied);
  } finally {
    await env.done();
  }
});

test("weekly banner comes from subscription progress, then the key's 7d cap, and holds exceeded refusals", async () => {
  const resets = later(2);
  const env = await setup({
    groups: [pro],
    subscriptions: [{ id: 10, group_id: 4, status: "active", group: pro }],
    models: { status: 200, body: { data: [{ id: "model-a" }] } },
    progress: [
      {
        subscription: { id: 10, group_id: 4, group: pro },
        progress: {
          id: 10,
          group_name: "Claudex Pro",
          expires_at: later(20),
          daily: {
            limit_usd: 2,
            used_usd: 0.5,
            percentage: 25,
            resets_at: later(0.5),
          },
          weekly: {
            limit_usd: 10,
            used_usd: 8.5,
            percentage: 85,
            resets_at: resets,
          },
        },
      },
    ],
  });
  try {
    const { accounts, session } = await signedIn(env.mock, env.root);
    const backend = new RemoteBackend(accounts, session, env.root);
    const keys = directKeys();
    await backend.prepare(keys);
    const policy = { warnPercent: 80, moreUsageUrl: null };
    const weekly = await backend.weeklyStatus(policy, undefined, keys);
    assert.deepEqual(
      {
        used: weekly?.used,
        limit: weekly?.limit,
        percent: weekly?.percent,
        state: weekly?.state,
        unit: weekly?.unit,
        resetsAt: weekly?.resetsAt,
      },
      {
        used: 8.5,
        limit: 10,
        percent: 85,
        state: "warning",
        unit: "usd",
        resetsAt: Date.parse(resets),
      },
    );
    const plan = await backend.planUsage(80, true);
    assert.equal(plan?.plan, "Claudex Pro");
    assert.deepEqual(
      plan?.windows.map((item) => [item.kind, item.percent]),
      [
        ["all_models", 85],
        ["daily", 25],
      ],
    );

    // A daily refusal turns the banner exceeded until the daily window resets.
    const refusal: GatewayRefusal = {
      status: 429,
      code: "USAGE_LIMIT_EXCEEDED",
      reason: "daily",
      exceeded: true,
      invalidKey: false,
      message: "daily",
    };
    await backend.progress();
    backend.recordRefusal(refusal);
    const blocked = await backend.weeklyStatus(policy, undefined, keys);
    assert.deepEqual([blocked?.state, blocked?.reason], ["exceeded", "daily"]);
    backend.clearRefusal();
    assert.equal(
      (await backend.weeklyStatus(policy, undefined, keys))?.state,
      "warning",
    );

    // Without plan windows, the key's own 7-day cap is used.
    env.mock.options.progress = [];
    env.mock.options.keyUsage = {
      rate_limits: [
        {
          window: "7d",
          limit: 5,
          used: 5,
          window_start: new Date().toISOString(),
        },
      ],
    };
    backend.clearRefusal();
    const fresh = await backend.weeklyStatus(policy, undefined, keys);
    assert.deepEqual([fresh?.state, fresh?.limit], ["exceeded", 5]);
  } finally {
    await env.done();
  }
});

test("the provider child forwards to the Sub2API gateway with the device key and maps refusals", async () => {
  const env = await setup({
    groups: [pro],
    models: { status: 200, body: { data: [{ id: "model-a" }] } },
    gateway: {
      status: 429,
      body: {
        code: "USAGE_LIMIT_EXCEEDED",
        message: "WEEKLY_LIMIT_EXCEEDED: weekly usage limit exceeded",
      },
    },
  });
  const script = path.join(env.root, "provider-service.cjs");
  await build({
    entryPoints: ["server/provider-service.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: script,
    logLevel: "silent",
  });
  const refusals: GatewayRefusal[] = [];
  const provider: Provider = {
    id: "sub2api",
    name: "Sub2API",
    baseUrl: `${env.mock.url}/v1`,
    protocol: "responses",
    model: "model-a",
    models: ["model-a"],
    backend: "sub2api",
  };
  const vaultKey = "ab".repeat(32);
  const client = new ProviderServiceClient(
    script,
    env.root,
    provider,
    "",
    vaultKey,
    env.root,
    undefined,
    undefined,
    (refusal) => refusals.push(refusal),
  );
  try {
    env.mock.keys.push({
      id: 1,
      user_id: 3,
      name: "claudex-desktop:x",
      key: `sk-${"a".repeat(64)}`,
      group_id: 4,
      status: "active",
    });
    await client.setKeys({ sub2api: `sk-${"a".repeat(64)}` }, ["sub2api"]);
    const models = await client.remoteModels(provider);
    assert.deepEqual(models, { ok: true, status: 200, models: ["model-a"] });
    await client.start();
    const response = await fetch(`${client.url}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "model-a", input: "hi", stream: true }),
    });
    assert.equal(response.status, 429);
    const body = await response.json();
    assert.equal(
      body.error.message,
      "You’ve reached your plan’s weekly usage limit. Requests resume when the weekly window resets.",
    );
    assert.equal(env.mock.gatewayAuth.at(-1), `sk-${"a".repeat(64)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(
      refusals.map((item) => [item.reason, item.exceeded]),
      [["weekly", true]],
    );
    // The key never appears in the usage log.
    const usage = fs
      .readdirSync(env.root, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith(".jsonl"));
    for (const name of usage)
      assert.doesNotMatch(
        fs.readFileSync(path.join(env.root, name), "utf8"),
        /sk-/,
      );
    // A revoked key is reported for re-provisioning.
    env.mock.keys = [];
    const again = await fetch(`${client.url}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${client.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "model-a", input: "hi", stream: true }),
    });
    assert.equal(again.status, 401);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(refusals.at(-1)?.invalidKey, true);
  } finally {
    await client.close();
    await env.done();
  }
});
