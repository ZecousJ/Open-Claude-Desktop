import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { registerApiKeyHandlers } from "../../electron/ipc/api-keys";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import {
  WebTransport,
  type TransportAuth,
} from "../../shared/web-client/transport";
import type { ApiKeysAPI } from "../../shared/api-keys-api";
import { createApiKeyMethods } from "../../src-web/bridge/api-keys";
import { fail, fakeCipher, MockSub2Api, ok } from "../support/sub2api-mock";

const account = {
  id: 1,
  email: "test@example.invalid",
  password: "test-password",
};
const group = {
  id: 2,
  name: "Test group",
  platform: "openai",
  status: "active",
};
const owned = {
  id: 7,
  name: "My key",
  key: "sk-test-personal-key",
  group_id: group.id,
  status: "active",
};
const device = { ...owned, id: 8, name: "claudex-device:fixture" };

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture(t: TestContext, surface: "desktop" | "browser") {
  const service = new MockSub2Api({ users: [account], groups: [group] });
  await service.start();
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-api-key-operations-"),
  );
  t.after(async () => {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const accounts = new RemoteAccounts(root, service.url, fakeCipher);
  const login = await accounts.login(account.email, account.password);
  assert.equal(login.kind, "signedIn");
  if (login.kind !== "signedIn")
    throw new Error("Expected a signed-in account.");
  const { session } = login;

  let activation = {};
  const retire = () => {
    activation = {};
  };
  if (surface === "browser") {
    const auth: TransportAuth = {
      get activationIdentity() {
        return activation;
      },
      accessToken: () => session.currentToken(),
      refresh: async (stale) => ({
        accessToken: await session.renewed(stale ?? ""),
      }),
      expire: () => {},
    };
    const transport = new WebTransport(
      {
        fetch: (url, init) => fetch(new URL(String(url), service.url), init),
        timers: { setTimeout, clearTimeout, setInterval, clearInterval },
      },
      auth,
      "test-tab",
    );
    return { api: createApiKeyMethods(transport), service, retire };
  }

  const handlers = new Map<string, Parameters<IpcHandle>[1]>();
  const remote = {
    ready: true,
    backend: {
      accounts,
      client: accounts.client,
      session,
      serviceGroups: () => [group],
    },
  };
  const context = {
    remote,
    activeAccount: login.account,
    accountRetiring: false,
    get accountActivationIdentity() {
      return activation;
    },
    onAccountActivated: () => () => {},
  } as unknown as AppContext;
  registerApiKeyHandlers((name, fn) => {
    handlers.set(name, fn);
  }, context);
  const invoke = async (name: string, ...args: unknown[]) =>
    handlers.get(name)!(...args);
  const api: Pick<ApiKeysAPI, "apiKeys" | "createApiKey" | "deleteApiKey"> = {
    apiKeys: () => invoke("apiKeys"),
    createApiKey: (input) => invoke("createApiKey", input),
    deleteApiKey: (id) => invoke("deleteApiKey", id),
  };
  return { api, service, retire };
}

for (const surface of ["desktop", "browser"] as const) {
  test(`${surface} returns the POST result when the key list is unavailable`, async (t) => {
    const { api, service } = await fixture(t, surface);
    service.route("GET", "/api/v1/keys", () =>
      fail(503, "List unavailable", "LIST_UNAVAILABLE"),
    );
    service.route("POST", "/api/v1/keys", ({ body, headers }) => {
      assert.deepEqual(body, { name: owned.name, group_id: group.id });
      assert.match(String(headers["idempotency-key"]), /^[\da-f-]{36}$/);
      return ok(owned);
    });
    const created = await api.createApiKey({
      name: " My key ",
      groupId: group.id,
    });
    assert.deepEqual(
      [created.id, created.name, created.key, created.groupId, created.status],
      [owned.id, owned.name, owned.key, group.id, "active"],
    );
    assert.equal(
      service.calls.filter((call) => call === "POST /api/v1/keys").length,
      1,
    );
  });

  test(`${surface} cannot delete a key after the original activation retires`, async (t) => {
    const { api, service, retire } = await fixture(t, surface);
    const paused = latch();
    const requested = latch();
    service.route("GET", "/api/v1/keys", async () => {
      requested.release();
      await paused.promise;
      return ok({ items: [owned], pages: 1 });
    });
    const deleting = api.deleteApiKey(owned.id);
    await requested.promise;
    retire();
    paused.release();
    await assert.rejects(deleting, /account changed/i);
    assert.ok(!service.calls.includes(`DELETE /api/v1/keys/${owned.id}`));
  });

  test(`${surface} cannot start an inventory read after group names finish for a retired activation`, async (t) => {
    const { api, service, retire } = await fixture(t, surface);
    const paused = latch();
    const requested = latch();
    service.route("GET", "/api/v1/groups/available", async () => {
      requested.release();
      await paused.promise;
      return ok([group]);
    });
    const listing = api.apiKeys();
    await requested.promise;
    retire();
    paused.release();
    await assert.rejects(listing, /account changed/i);
    assert.ok(!service.calls.includes("GET /api/v1/keys"));
  });

  test(`${surface} retains one idempotency key when authorization renews`, async (t) => {
    const { api, service } = await fixture(t, surface);
    const headers: string[] = [];
    service.route("POST", "/api/v1/keys", (request) => {
      headers.push(String(request.headers["idempotency-key"]));
      return headers.length === 1
        ? fail(401, "Expired token", "TOKEN_EXPIRED")
        : ok(owned);
    });
    await api.createApiKey({ name: owned.name, groupId: group.id });
    assert.equal(headers.length, 2);
    assert.match(headers[0], /^[\da-f-]{36}$/);
    assert.equal(headers[1], headers[0]);
  });

  test(`${surface} returns the service's verification challenge`, async (t) => {
    const { api, service } = await fixture(t, surface);
    const metadata = { challenge_id: "test-challenge" };
    service.route("POST", "/api/v1/keys", () =>
      fail(
        403,
        "Verification required",
        "action_verification_required",
        metadata,
      ),
    );
    await assert.rejects(
      api.createApiKey({ name: owned.name, groupId: group.id }),
      {
        code: "action_verification_required",
        ...(surface === "desktop" ? { metadata } : { details: metadata }),
      },
    );
  });

  test(`${surface} lists only personal keys and refuses to delete the device key`, async (t) => {
    const { api, service } = await fixture(t, surface);
    service.route("GET", "/api/v1/keys", () =>
      ok({ items: [owned, device], pages: 1 }),
    );
    service.route(
      "POST",
      "/api/v1/usage/dashboard/api-keys-usage",
      ({ body }) => {
        assert.deepEqual(body, { api_key_ids: [owned.id] });
        return ok({ stats: { [owned.id]: { total_actual_cost: 3.5 } } });
      },
    );
    const keys = await api.apiKeys();
    assert.deepEqual(
      keys.map((key) => key.id),
      [owned.id],
    );
    assert.equal(keys[0].totalCost, 3.5);
    await assert.rejects(api.deleteApiKey(device.id), /isn't in your list/);
    assert.ok(!service.calls.includes(`DELETE /api/v1/keys/${device.id}`));
  });
}
