import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { AppContext, IpcHandle } from "../../electron/app/app-context";
import { registerZecousMigrationHandlers } from "../../electron/ipc/zecous-migration";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { RemoteSession, SessionFile } from "../../electron/sub2api/session";
import { zecousMigrationPath } from "../../shared/zecous-migration-api";
import { webPaths } from "../../shared/web-protocol";
import { createWebBridge } from "../../src-web/bridge";
import {
  fakeTab,
  flush,
  json,
  type Route,
} from "../app/web-bridge-fakes.test.ts";

const origin = "https://fixture.invalid";
const users = [
  { id: 1, email: "one@fixture.invalid", username: "One" },
  { id: 2, email: "two@fixture.invalid", username: "Two" },
];
const amounts = { amount_usd: 12.5, balance_usd: 7.5, subscription_usd: 5 };
const pending = {
  state: "pending",
  amountUsd: 12.5,
  balanceUsd: 7.5,
  subscriptionUsd: 5,
};
const done = {
  state: "done",
  amountUsd: 12.5,
  balanceUsd: 0,
  subscriptionUsd: 0,
};

function latch() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(t: TestContext) {
  const credited = new Set<number>();
  const requests: { method: string; user: number; path: string }[] = [];
  const refreshes: string[] = [];
  const events: string[] = [];
  const tab = fakeTab();
  let failRefresh = false;
  let transferReply:
    | ((
        method: string,
        path: string,
      ) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  let holdRefresh: (() => Promise<void>) | undefined;
  const success = (data: unknown) => json({ code: 0, data });
  const refresh = async (owner: string) => {
    refreshes.push(owner);
    await holdRefresh?.();
    if (failRefresh) throw Error("Refresh failed");
  };
  const route: Route = async (request) => {
    const path = new URL(request.url, origin).pathname;
    if (
      path === `${webPaths.auth}login` ||
      path === `${webPaths.auth}refresh`
    ) {
      const body = request.body as { email?: string; account?: string };
      const user = users.find(
        ({ email, id }) => email === body.email || String(id) === body.account,
      );
      assert.ok(user);
      return success({
        user,
        access_token: `token-${user.id}`,
        expires_in: 3600,
      });
    }
    if (path === `${webPaths.rpc}refreshModels`) {
      const token = request.headers.get("authorization");
      const user = users.find(({ id }) => token === `Bearer token-${id}`);
      assert.ok(user);
      try {
        await refresh(`web:${user.id}`);
        return json({ ok: true, value: null });
      } catch {
        return json({ ok: false, error: { message: "Refresh failed" } }, 503);
      }
    }
    if (path.startsWith(webPaths.rpc)) return json({ ok: true, value: null });
    if (
      path !== zecousMigrationPath &&
      path !== `${zecousMigrationPath}/confirm` &&
      path !== `${zecousMigrationPath}/confirm-v1`
    )
      return;
    const user = users.find(
      ({ id }) => request.headers.get("authorization") === `Bearer token-${id}`,
    );
    assert.ok(user);
    requests.push({ method: request.method, user: user.id, path });
    const override = await transferReply?.(request.method, path);
    if (override) return override;
    if (path !== zecousMigrationPath) {
      assert.equal(request.method, "POST");
      assert.deepEqual(request.body, {});
      credited.add(user.id);
      return success({
        state: "done",
        amount_usd: amounts.amount_usd,
        migration_protocol: 1,
      });
    }
    assert.equal(request.method, "GET");
    return credited.has(user.id)
      ? success({
          state: "done",
          amount_usd: amounts.amount_usd,
          balance_usd: 0,
          subscription_usd: 0,
          migration_protocol: 1,
        })
      : success({ state: "pending", ...amounts, migration_protocol: 1 });
  };
  tab.routes.push(route);
  const bridge = createWebBridge(tab.env);
  t.after(() => bridge.dispose());
  const client = new Sub2ApiClient(origin, async (input, init) => {
    const request = new Request(input, init);
    return (
      (await route({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.body ? await request.json() : undefined,
      })) ?? json({}, 404)
    );
  });
  const file = new SessionFile("unused", {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw Error("Unexpected file write");
    },
    decryptString: () => {
      throw Error("Unexpected file read");
    },
  });
  const nativeAccounts = users.map((user) => ({
    ready: true,
    accounts: { client },
    session: new RemoteSession(
      client,
      file,
      {
        version: 1,
        baseUrl: origin,
        accountId: String(user.id),
        userId: user.id,
        email: user.email,
        refreshToken: "fixture-refresh",
      },
      {
        accessToken: `token-${user.id}`,
        refreshToken: "fixture-refresh",
        expiresIn: 3600,
      },
    ),
    clearRefusal() {},
    refreshPlan: () => refresh(`native:${user.id}`),
  }));
  const ctx = {
    remote: undefined as (typeof nativeAccounts)[number] | undefined,
    accountRetiring: true,
    accountActivationIdentity: 0,
    push: ({ type }: { type: string }) => events.push(type),
  };
  const handlers = new Map<string, Parameters<IpcHandle>[1]>();
  registerZecousMigrationHandlers(
    (name, fn) => handlers.set(name, fn),
    ctx as unknown as AppContext,
  );
  const native = async (name: string, ...args: unknown[]) =>
    handlers.get(name)!(...args);
  const select = (index: number) => {
    ctx.accountActivationIdentity++;
    ctx.remote = nativeAccounts[index];
    ctx.accountRetiring = false;
  };
  return {
    bridge,
    native,
    select,
    requests,
    refreshes,
    events,
    credited,
    failRefresh: () => {
      failRefresh = true;
    },
    intercept: (reply: typeof transferReply) => {
      transferReply = reply;
    },
    holdRefresh: (hold: typeof holdRefresh) => {
      holdRefresh = hold;
    },
  };
}

test("official migration confirms only for the signed-in account, refreshes ready state, and leaves classic status quiet", async (t) => {
  const f = fixture(t);
  const web = f.bridge.officialZecousMigration;
  await assert.rejects(web.status(), /sign in/i);
  await assert.rejects(f.native("officialZecousMigration"), /sign in/i);
  assert.deepEqual(f.requests, []);

  await f.bridge.api.loginAccount(users[0].email, "fixture");
  f.select(0);
  assert.deepEqual(await web.status(), pending);
  assert.deepEqual(await f.native("officialZecousMigration"), pending);
  assert.deepEqual(f.refreshes, []);

  f.intercept(async () =>
    json({ code: 503, message: "Transfer unavailable" }, 503),
  );
  await assert.rejects(web.status(), /Transfer unavailable/);
  await assert.rejects(
    f.native("officialZecousMigration"),
    /Transfer unavailable/,
  );
  assert.equal((await f.bridge.api.zecousMigration()).state, "none");
  assert.equal((await f.native("zecousMigration")).state, "none");

  f.intercept((method) =>
    method === "POST"
      ? json({
          code: 0,
          data: { state: "done", amount_usd: null, migration_protocol: 1 },
        })
      : undefined,
  );
  await assert.rejects(web.confirm(), /did not confirm/);
  await assert.rejects(
    f.native("officialConfirmZecousMigration"),
    /did not confirm/,
  );
  assert.deepEqual(f.refreshes, []);

  f.intercept(undefined);
  assert.deepEqual(await web.confirm(), done);
  assert.deepEqual(f.refreshes, ["web:1"]);
  assert.deepEqual(await f.native("officialZecousMigration"), done);
  assert.deepEqual(f.refreshes, ["web:1"]);

  await f.bridge.api.addAccount();
  await f.bridge.api.loginAccount(users[1].email, "fixture");
  f.select(1);
  assert.deepEqual(await web.status(), pending);
  assert.deepEqual(await f.native("officialConfirmZecousMigration"), done);
  assert.deepEqual(f.refreshes, ["web:1", "native:2"]);
  assert.deepEqual(f.events, ["service-changed", "weekly-usage"]);
});

test("old services can show completed transfers but cannot receive official confirmation writes", async (t) => {
  const f = fixture(t);
  await f.bridge.api.loginAccount(users[0].email, "fixture");
  f.select(1);
  const web = f.bridge.officialZecousMigration;
  const native = {
    status: () => f.native("officialZecousMigration"),
    confirm: () => f.native("officialConfirmZecousMigration"),
  };
  const oldStatus = (data: unknown) => json({ code: 0, data });
  f.intercept(() => oldStatus({ state: "pending", ...amounts }));
  assert.deepEqual(await f.bridge.api.zecousMigration(), pending);
  assert.deepEqual(await f.native("zecousMigration"), pending);
  for (const api of [web, native]) {
    await assert.rejects(api.status(), /does not support/);
    await assert.rejects(api.confirm(), /does not support/);
  }
  assert.ok(f.requests.every(({ method }) => method === "GET"));

  f.intercept(() =>
    oldStatus({
      state: "none",
      amount_usd: 0,
      balance_usd: 0,
      subscription_usd: 0,
    }),
  );
  for (const api of [web, native]) {
    assert.equal((await api.status()).state, "none");
    await assert.rejects(api.confirm(), /no ZecousAI balance/);
  }
  assert.ok(f.requests.every(({ method }) => method === "GET"));

  f.intercept(() =>
    oldStatus({
      state: "done",
      amount_usd: amounts.amount_usd,
      balance_usd: 0,
      subscription_usd: 0,
    }),
  );
  for (const api of [web, native]) {
    assert.deepEqual(await api.status(), done);
    assert.deepEqual(await api.confirm(), done);
  }
  assert.ok(f.requests.every(({ method }) => method === "GET"));
  assert.deepEqual(f.refreshes, ["web:1", "native:2"]);
});

test("an upgrade or rollback cannot route an official confirmation to the historical POST", async (t) => {
  const f = fixture(t);
  await f.bridge.api.loginAccount(users[0].email, "fixture");
  f.select(1);
  f.intercept((method, path) => {
    if (method === "GET") return;
    assert.equal(path, `${zecousMigrationPath}/confirm-v1`);
    return json({ code: 404, message: "Unknown route" }, 404);
  });
  await assert.rejects(
    f.bridge.officialZecousMigration.confirm(),
    /unknown route/i,
  );
  await assert.rejects(
    f.native("officialConfirmZecousMigration"),
    /unknown route/i,
  );
  assert.deepEqual(
    f.requests.map(({ method, path }) => [method, path]),
    [
      ["GET", zecousMigrationPath],
      ["POST", `${zecousMigrationPath}/confirm-v1`],
      ["GET", zecousMigrationPath],
      ["POST", `${zecousMigrationPath}/confirm-v1`],
    ],
  );
  assert.equal(f.credited.size, 0);
  assert.deepEqual(f.refreshes, []);
});

test("ambiguous confirmations can re-read done and refresh readiness without another POST", async (t) => {
  const f = fixture(t);
  await f.bridge.api.loginAccount(users[0].email, "fixture");
  f.select(1);
  const web = f.bridge.officialZecousMigration;
  let account = 1;
  f.intercept(async (method) => {
    if (method !== "POST") return;
    f.credited.add(account++);
    return json({ code: 503, message: "Confirmation reply was lost" }, 503);
  });
  await assert.rejects(web.confirm(), /Confirmation reply was lost/);
  await assert.rejects(
    f.native("officialConfirmZecousMigration"),
    /Confirmation reply was lost/,
  );
  f.failRefresh();
  assert.deepEqual(await web.status({ refreshOnDone: true }), done);
  assert.deepEqual(await f.native("officialZecousMigration", true), done);
  assert.deepEqual(
    f.requests.map(({ method, user }) => ({ method, user })),
    [
      { method: "GET", user: 1 },
      { method: "POST", user: 1 },
      { method: "GET", user: 2 },
      { method: "POST", user: 2 },
      { method: "GET", user: 1 },
      { method: "GET", user: 2 },
    ],
  );
  assert.deepEqual(f.refreshes, ["web:1", "native:2"]);
});

test("a retired activation cannot deliver a confirmation or emit a late readiness event", async (t) => {
  const f = fixture(t);
  await f.bridge.api.loginAccount(users[0].email, "fixture");
  f.select(0);
  const waiting = latch();
  const release = latch();
  f.intercept(async (method) => {
    if (method === "GET") return undefined;
    if (f.requests.filter(({ method }) => method === "POST").length === 2)
      waiting.release();
    await release.promise;
    return undefined;
  });
  const web = f.bridge.officialZecousMigration;
  const webResult = assert.rejects(web.confirm(), /account changed/i);
  const nativeResult = assert.rejects(
    f.native("officialConfirmZecousMigration"),
    /account changed/i,
  );
  await waiting.promise;
  await f.bridge.api.addAccount();
  await f.bridge.api.loginAccount(users[1].email, "fixture");
  await f.bridge.api.switchAccount("1");
  f.select(0);
  release.release();
  await Promise.all([webResult, nativeResult]);
  assert.deepEqual(f.refreshes, []);

  const refreshing = latch();
  const finishRefresh = latch();
  f.holdRefresh(() => {
    refreshing.release();
    return finishRefresh.promise;
  });
  const late = assert.rejects(
    f.native("officialConfirmZecousMigration"),
    /account changed/i,
  );
  await refreshing.promise;
  f.select(1);
  finishRefresh.release();
  await late;
  assert.deepEqual(f.events, []);
});

test("confirmed transfers return when readiness refresh reaches its deadline", async (t) => {
  const f = fixture(t);
  await f.bridge.api.loginAccount(users[0].email, "fixture");
  f.select(1);
  const timeouts: AbortController[] = [];
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    if (ms !== 5_000) return originalTimeout(ms);
    const controller = new AbortController();
    timeouts.push(controller);
    return controller.signal;
  });
  const refreshing = latch();
  const finishRefresh = latch();
  f.holdRefresh(() => {
    if (f.refreshes.length === 2) refreshing.release();
    return finishRefresh.promise;
  });

  const confirmation = Promise.all([
    f.bridge.officialZecousMigration.confirm(),
    f.native("officialConfirmZecousMigration"),
  ]);
  await refreshing.promise;
  assert.equal(timeouts.length, 2);
  for (const controller of timeouts) controller.abort();
  assert.deepEqual(await confirmation, [done, done]);
  assert.deepEqual(f.events, []);

  finishRefresh.release();
  await flush();
  assert.deepEqual(f.events, ["service-changed", "weekly-usage"]);
});
