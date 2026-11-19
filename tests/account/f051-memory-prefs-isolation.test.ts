/** Real IPC registration, controlled service await points and synthetic account identities. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerMemoryHandlers } from "../../electron/ipc/memory";
function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>((r) => (resolve = r)), resolve };
}
const changeKeys = [
  "owner",
  "generation",
  "store",
  "remote",
  "session",
  "service",
  "retiring",
] as const;
type Change = (typeof changeKeys)[number];
function fixture(phase: "ready" | "write") {
  const wait = deferred(),
    entered = deferred();
  let writes = 0;
  const service = {
    async ready() {
      if (phase === "ready") {
        entered.resolve();
        await wait.promise;
      }
    },
    async setPrefs() {
      writes++;
      if (phase === "write") {
        entered.resolve();
        await wait.promise;
      }
      return { private: "A" };
    },
  };
  const ctx: any = {
    store: { projects: [], settings: {}, root: "/inert-f051" },
    services: { memory: { service } },
    activeAccount: { id: "A" },
    accountActivationIdentity: 1,
    remote: { session: {} },
    accountRetiring: false,
    onAccountActivated() {},
    onAccountDeactivating() {},
    onEvent() {},
  };
  const methods = new Map<string, (...args: any[]) => any>();
  registerMemoryHandlers((name, fn) => methods.set(name, fn), ctx);
  return {
    wait,
    entered,
    service,
    writes: () => writes,
    call: (raw: unknown = { searchChats: false }, mode?: unknown) =>
      methods.get("setMemoryPrefs")!(raw, mode),
    change(key: Change) {
      if (key === "owner") ctx.activeAccount = { id: "B" };
      if (key === "generation") ctx.accountActivationIdentity++;
      if (key === "store") ctx.store = { ...ctx.store };
      if (key === "remote") ctx.remote = { session: {} };
      if (key === "session") ctx.remote.session = {};
      if (key === "service") ctx.services.memory = { service: {} };
      if (key === "retiring") ctx.accountRetiring = true;
    },
  };
}
for (const phase of ["ready", "write"] as const)
  for (const key of changeKeys)
    test(`general prefs reject ${key} replacement during ${phase}`, async () => {
      const f = fixture(phase),
        run = f.call();
      await f.entered.promise;
      f.change(key);
      f.wait.resolve();
      await assert.rejects(run, /account changed/);
      assert.equal(f.writes(), phase === "ready" ? 0 : 1);
    });
for (const key of changeKeys)
  test(`disable-only rejects ${key} replacement while writing without readiness`, async () => {
    const f = fixture("write");
    f.service.ready = async () => {
      throw Error("unexpected ready");
    };
    const run = f.call({ generate: false }, { disableOnly: true });
    await f.entered.promise;
    f.change(key);
    f.wait.resolve();
    await assert.rejects(run, /account changed/);
    assert.equal(f.writes(), 1);
  });
test("retiring settings refuse both mutation modes before dispatch", async () => {
  const f = fixture("write");
  f.change("retiring");
  await assert.rejects(f.call(), /account changed/);
  await assert.rejects(
    f.call({ generate: false }, { disableOnly: true }),
    /account changed/,
  );
  assert.equal(f.writes(), 0);
});
test("invalid prefs never reach the service", async () => {
  const f = fixture("write");
  for (const raw of [
    null,
    [],
    { generate: "true" },
    { searchChats: 1 },
    { generate: false, reset: true },
  ])
    await assert.rejects(f.call(raw));
  assert.equal(f.writes(), 0);
});
test("unchanged activation preserves the original source failure", async () => {
  const f = fixture("ready"),
    error = Error("policy refused");
  f.service.setPrefs = async () => {
    throw error;
  };
  const run = f.call();
  f.wait.resolve();
  await assert.rejects(run, (e) => e === error);
});
