/** Production runner prototype only; no constructor/open/engine/network execution. */
import test from "node:test";
import assert from "node:assert/strict";
import { useElectronShim } from "./runner-core-support.test";
import { Listeners } from "../../electron/app/app-context";
import { profileReadLease } from "../../electron/account/profile-read-lease";
import { registerSettingsAccountHandlers } from "../../electron/ipc/settings-account";
useElectronShim();
const { WebAppContext } = await import("../../runner/src/web-app-context");
function fixture() {
  const ctx = Object.create(WebAppContext.prototype);
  ctx.closedFlag = false;
  ctx.signedOutValue = false;
  ctx.officialActivation = {};
  ctx.store = {};
  ctx.activeAccount = {
    id: "fixture",
    name: "Fixture",
    email: "fixture@example.invalid",
  };
  ctx.activatedListeners = new Listeners();
  ctx.deactivatingListeners = new Listeners();
  ctx.remote = { backend: {} };
  return ctx;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test("actual runner getters retire signed-out context before close and change identity on same-store reentry", async () => {
  const ctx = fixture(),
    capture = profileReadLease(ctx),
    old = capture();
  await Promise.resolve(); // production queued initial activation callback
  assert.equal(old.current(), true);
  const identity = ctx.accountActivationIdentity;
  ctx.signedOut = true;
  assert.equal(ctx.closed, false);
  assert.equal(ctx.accountRetiring, true);
  assert.notEqual(ctx.accountActivationIdentity, identity);
  assert.equal(old.current(), false);
  const duringRetirement = profileReadLease(ctx);
  assert.equal(duringRetirement().current(), false);
  ctx.signedOut = false;
  assert.equal(ctx.accountRetiring, false);
  assert.equal(old.current(), false);
  assert.equal(capture().current(), true);
  assert.equal(duringRetirement().current(), true);
  ctx.closedFlag = true;
  assert.equal(ctx.accountRetiring, true);
  assert.equal(capture().current(), false);
});
test("actual runner sign-out/reentry does not revive deferred profile GET/PUT or delayed authorization", async () => {
  for (const method of ["accountProfile", "setFullName"]) {
    for (const boundary of ["token", "response"]) {
      const ctx = fixture(),
        entered = deferred(),
        release = deferred(),
        calls: string[] = [];
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      ctx.remote.backend = {
        session: {
          authorized: async (call: (token: string) => unknown) => {
            if (boundary === "token") await pause();
            return call("inert-token");
          },
        },
        client: {
          readProfileIdentity: async () => {
            calls.push("GET");
            await pause();
            return { username: "Fixture", email: "fixture@example.invalid" };
          },
          updateUsername: async () => {
            calls.push("PUT");
            await pause();
            return { username: "New", email: "fixture@example.invalid" };
          },
        },
      };
      const handlers = new Map<string, (...args: any[]) => any>();
      registerSettingsAccountHandlers(
        (name, handler) => handlers.set(name, handler),
        ctx,
      );
      const pending = handlers.get(method)!("New");
      const rejected = assert.rejects(
        pending,
        method === "setFullName" && boundary === "response"
          ? /may have taken effect/
          : /account changed/,
      );
      await entered.promise;
      ctx.signedOut = true;
      ctx.signedOut = false; // same store/account/host, no activation event
      release.resolve();
      await rejected;
      assert.deepEqual(
        calls,
        boundary === "token"
          ? []
          : [method === "accountProfile" ? "GET" : "PUT"],
      );
    }
  }
});

test("registered readonly spend handler uses real runner retirement identity before transport and after response", async () => {
  const { registerBillingHandlers } =
    await import("../../electron/ipc/billing");
  const originalFetch = globalThis.fetch;
  try {
    for (const boundary of ["token", "response"]) {
      const ctx = fixture(),
        entered = deferred(),
        release = deferred();
      let calls = 0;
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      globalThis.fetch = async (input, init) => {
        assert.equal(
          String(input),
          "https://fixture.invalid/api/v1/claudex/spend-limit",
        );
        assert.equal(init?.method ?? "GET", "GET");
        calls++;
        if (boundary === "response") await pause();
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              limit_usd: null,
              used_usd: 0,
              resets_at: "2026-12-01T00:00:00Z",
            },
          }),
        );
      };
      ctx.remote.backend = {
        accounts: { baseUrl: "https://fixture.invalid" },
        session: {
          authorized: async (call: (token: string) => unknown) => {
            if (boundary === "token") await pause();
            return call("inert-token");
          },
        },
      };
      const handlers = new Map<string, (...args: any[]) => any>();
      registerBillingHandlers(
        (name, handler) => handlers.set(name, handler),
        ctx,
      );
      const pending = handlers.get("spendLimit")!();
      const rejected = assert.rejects(pending, /account changed/);
      await entered.promise;
      ctx.signedOut = true;
      await assert.rejects(handlers.get("spendLimit")!(), /account changed/);
      ctx.signedOut = false;
      release.resolve();
      await rejected;
      assert.equal(calls, boundary === "token" ? 0 : 1);
      assert.equal((await handlers.get("spendLimit")!()).usedUsd, 0);
      assert.equal(calls, boundary === "token" ? 1 : 2);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
