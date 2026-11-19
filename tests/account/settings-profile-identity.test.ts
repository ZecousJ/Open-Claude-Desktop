/** Actual registered settings handlers with a fake client transport; no real account mutations. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerSettingsAccountHandlers } from "../../electron/ipc/settings-account";
import { Listeners } from "../../electron/app/app-context";
import { Sub2ApiClient } from "../../electron/sub2api/client";
function fixture() {
  let name = "Before";
  const calls: { path: string; method: string; body: unknown }[] = [];
  const client = new Sub2ApiClient(
    "https://fixture.invalid",
    async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://fixture.invalid");
      const method = init?.method ?? "GET";
      calls.push({ path: url.pathname, method, body: init?.body });
      if (url.pathname === "/api/v1/user") {
        assert.equal(method, "PUT");
        assert.equal(typeof init?.body, "string");
        name = JSON.parse(String(init!.body)).username;
      } else {
        assert.equal(url.pathname, "/api/v1/user/profile");
        assert.equal(method, "GET");
      }
      // Both documented identity responses deliberately omit financial balance.
      return new Response(
        JSON.stringify({
          code: 0,
          data: { id: 1, email: "fixture@example.invalid", username: name },
        }),
        { status: 200 },
      );
    },
  );
  const ctx: any = {
    accountRetiring: false,
    accountActivationIdentity: {},
    onAccountDeactivating: () => () => {},
    onAccountActivated: () => () => {},
    store: {},
    activeAccount: {
      id: "fixture",
      name: "Before",
      email: "fixture@example.invalid",
    },
    remote: {
      backend: {
        client,
        session: {
          authorized: (read: (token: string) => unknown) =>
            read("fixture-token"),
        },
      },
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSettingsAccountHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx,
  );
  return { calls, handlers, client };
}
test("accountProfile consumes identity from exactly one original profile GET without balance", async () => {
  const f = fixture();
  assert.deepEqual(await f.handlers.get("accountProfile")!(), {
    kind: "remote",
    fullName: "Before",
    email: "fixture@example.invalid",
    canDelete: true,
  });
  assert.deepEqual(f.calls, [
    { path: "/api/v1/user/profile", method: "GET", body: undefined },
  ]);
});
test("setFullName keeps one original PUT followed by one profile GET and does not invent financial success", async () => {
  const f = fixture();
  assert.deepEqual(await f.handlers.get("setFullName")!("  After  "), {
    kind: "remote",
    fullName: "After",
    email: "fixture@example.invalid",
    canDelete: true,
  });
  assert.deepEqual(f.calls, [
    {
      path: "/api/v1/user",
      method: "PUT",
      body: JSON.stringify({ username: "After" }),
    },
    { path: "/api/v1/user/profile", method: "GET", body: undefined },
  ]);
  await assert.rejects(
    f.client.profile("fixture-token"),
    /unexpected response/,
  );
  assert.equal(f.calls.length, 3); // explicit financial read only, no automatic mutation retry
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function leasedFixture(stage: "token" | "put" | "get" | "retry") {
  const deactivating = new Listeners<void>();
  const activated = new Listeners<any>();
  let initialActivation: (() => void) | undefined;
  const entered = deferred(),
    release = deferred(),
    calls: string[] = [];
  const pause = async () => {
    entered.resolve();
    await release.promise;
  };
  let authorizedCount = 0;
  const client = new Sub2ApiClient(
    "https://fixture.invalid",
    async (input, init) => {
      const method = init?.method ?? "GET";
      const pathname = new URL(String(input)).pathname;
      assert.equal(new URL(String(input)).origin, "https://fixture.invalid");
      assert.ok(["/api/v1/user", "/api/v1/user/profile"].includes(pathname));
      calls.push(method);
      if (
        (stage === "put" && method === "PUT") ||
        (stage === "get" && method === "GET")
      )
        await pause();
      if (stage === "retry" && method === "PUT")
        return new Response(
          JSON.stringify({ code: "TOKEN_EXPIRED", message: "Expired fixture" }),
          { status: 401 },
        );
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            id: 1,
            username: "Original account",
            email: "owner@example.invalid",
          },
        }),
        { status: 200 },
      );
    },
  );
  const host = {
    backend: {
      client,
      session: {
        authorized: async (read: (token: string) => Promise<unknown>) => {
          authorizedCount++;
          if (stage === "token" && authorizedCount === 1) await pause();
          try {
            return await read("fixture-token");
          } catch (error) {
            if (stage !== "retry") throw error;
            await pause();
            return read("refreshed-fixture-token");
          }
        },
      },
    },
  };
  const ctx: any = {
    accountRetiring: false,
    accountActivationIdentity: {},
    store: {},
    activeAccount: { id: "a", name: "A", email: "a@example.invalid" },
    remote: host,
    onAccountDeactivating: (cb: () => void) => deactivating.add(cb),
    onAccountActivated: (cb: (account: any) => void) => {
      const initial = ctx.activeAccount;
      initialActivation = () => cb(initial);
      return activated.add(cb);
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSettingsAccountHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx,
  );
  return {
    entered,
    release,
    calls,
    handlers,
    ctx,
    deactivating,
    activated,
    initialActivation: () => initialActivation?.(),
    switchAccount(returnToA = false) {
      ctx.activeAccount = { id: "b", name: "B", email: "b@example.invalid" };
      ctx.store = {};
      ctx.remote = {
        backend: {
          client: {
            readProfileIdentity() {
              throw Error("Must not access replacement account");
            },
          },
        },
      };
      if (returnToA) {
        ctx.activeAccount = {
          id: "a",
          name: "A again",
          email: "a@example.invalid",
        };
        ctx.remote = host; // account ID and host can match, store activation must not.
        ctx.store = {};
      }
    },
  };
}
test("identity GET checks before delayed token dispatch and after delayed response", async () => {
  for (const stage of ["token", "get"] as const)
    for (const reenter of [false, true]) {
      const f = leasedFixture(stage),
        result = f.handlers.get("accountProfile")!();
      const rejected = assert.rejects(result, /account changed/);
      await f.entered.promise;
      f.switchAccount(reenter);
      f.release.resolve();
      await rejected;
      assert.deepEqual(f.calls, stage === "token" ? [] : ["GET"]);
    }
});
test("name change cannot dispatch after token retirement or read replacement profile after submitted PUT", async () => {
  for (const stage of ["token", "put", "get", "retry"] as const)
    for (const reenter of [false, true]) {
      const f = leasedFixture(stage),
        result = f.handlers.get("setFullName")!("New name");
      const rejected = assert.rejects(
        result,
        stage === "token" ? /account changed/ : /may have taken effect/,
      );
      await f.entered.promise;
      f.switchAccount(reenter);
      f.release.resolve();
      await rejected;
      assert.deepEqual(
        f.calls,
        stage === "token" ? [] : stage === "get" ? ["PUT", "GET"] : ["PUT"],
      );
    }
});
test("local rename uses only a valid captured account and returns its refreshed identity", async () => {
  const names: string[] = [];
  const ctx: any = {
    accountRetiring: false,
    accountActivationIdentity: {},
    onAccountDeactivating: () => () => {},
    onAccountActivated: () => () => {},
    store: {},
    activeAccount: {
      id: "local",
      name: "Before",
      email: "local@example.invalid",
    },
    remote: undefined,
    accounts: {
      rename(id: string, name: string) {
        assert.equal(id, "local");
        names.push(name);
        ctx.activeAccount = { ...ctx.activeAccount, name };
      },
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  registerSettingsAccountHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx,
  );
  assert.equal((await handlers.get("setFullName")!("After")).fullName, "After");
  ctx.activeAccount = undefined;
  await assert.rejects(handlers.get("setFullName")!("Never"), /Sign in/);
  assert.deepEqual(names, ["After"]);
});

test("deactivation synchronously retires pending and new profile requests before async teardown finishes", async () => {
  for (const method of ["accountProfile", "setFullName"]) {
    const f = leasedFixture("token"),
      teardown = deferred();
    f.deactivating.add(() => teardown.promise);
    const pending = f.handlers.get(method)!("Never dispatched");
    const rejected = assert.rejects(pending, /account changed/);
    await f.entered.promise;
    f.ctx.accountRetiring = true;
    const retiring = f.deactivating.emitAsync();
    f.initialActivation(); // queued initial callback must not undo retirement
    await assert.rejects(f.handlers.get("accountProfile")!(), /signing out/);
    await assert.rejects(
      f.handlers.get("setFullName")!("Never"),
      /signing out/,
    );
    f.release.resolve();
    await rejected;
    assert.deepEqual(f.calls, []);
    teardown.resolve();
    await retiring;
    f.ctx.store = {}; // only a genuine new activation can reopen this scope
    f.ctx.accountRetiring = false;
    f.activated.emit(f.ctx.activeAccount);
    assert.equal(
      (await f.handlers.get("accountProfile")!()).fullName,
      "Original account",
    );
    assert.deepEqual(f.calls, ["GET"]);
  }
});

test("late registration cannot read or rename an already-retiring account even with retained identity", async () => {
  for (const state of [true, undefined]) {
    const f = leasedFixture("token");
    f.ctx.accountRetiring = state;
    const handlers = new Map<string, (...args: any[]) => any>();
    registerSettingsAccountHandlers(
      (name, handler) => handlers.set(name, handler),
      f.ctx,
    );
    f.initialActivation();
    await assert.rejects(handlers.get("accountProfile")!(), /signing out/);
    await assert.rejects(handlers.get("setFullName")!("Never"), /signing out/);
    assert.deepEqual(f.calls, []);
  }
});
