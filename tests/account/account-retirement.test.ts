import test from "node:test";
import assert from "node:assert/strict";
import { AccountRetirement } from "../../electron/account/account-retirement";
import { profileReadLease } from "../../electron/account/profile-read-lease";
import { Listeners } from "../../electron/app/app-context";
import { readSpendLimitSource } from "../../electron/account/spend-limit-read";

test("initial/failed activation stays retired; stale activation cannot undo newer teardown or activation", () => {
  const state = new AccountRetirement();
  assert.equal(state.accountRetiring, true);
  const first = state.beginActivation();
  state.beginDeactivation();
  state.finishActivation(first);
  assert.equal(state.accountRetiring, true);
  const second = state.beginActivation(),
    third = state.beginActivation();
  state.finishActivation(second);
  assert.equal(state.accountRetiring, true);
  state.finishActivation(third);
  assert.equal(state.accountRetiring, false);
  state.beginDeactivation();
  state.finishActivation(third);
  assert.equal(state.accountRetiring, true);
});

test("spend source lease retires before async listeners complete and rejects late registration", async () => {
  const state = new AccountRetirement();
  state.finishActivation(state.beginActivation());
  const deactivating = new Listeners<void>(),
    activated = new Listeners<any>();
  const ctx: any = {
    store: {},
    remote: {},
    activeAccount: { id: "fixture" },
    get accountActivationIdentity() {
      return state.accountActivationIdentity;
    },
    get accountRetiring() {
      return state.accountRetiring;
    },
    onAccountDeactivating: (cb: () => void) => deactivating.add(cb),
    onAccountActivated: (cb: (account: any) => void) => activated.add(cb),
  };
  const capture = profileReadLease(ctx),
    lease = capture();
  let release!: () => void,
    calls = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  deactivating.add(() => wait);
  const pending = readSpendLimitSource(async (check) => {
    await wait;
    check();
    calls++;
    return { limit_usd: null, used_usd: 0, resets_at: "2026-12-01T00:00:00Z" };
  }, lease.current);
  const rejected = assert.rejects(pending, /account changed/);
  state.beginDeactivation();
  const teardown = deactivating.emitAsync();
  assert.equal(capture().current(), false);
  const lateCapture = profileReadLease(ctx);
  assert.equal(lateCapture().current(), false);
  activated.emit(ctx.activeAccount); // cannot revive an unfinished teardown
  assert.equal(lateCapture().current(), false);
  release();
  await rejected;
  await teardown;
  assert.equal(calls, 0);
  const next = state.beginActivation();
  ctx.store = {};
  state.finishActivation(next);
  activated.emit(ctx.activeAccount);
  assert.equal(lease.current(), false);
  assert.equal(lateCapture().current(), true);
  const value = await readSpendLimitSource(async (check) => {
    check();
    calls++;
    return { limit_usd: null, used_usd: 0, resets_at: "2026-12-01T00:00:00Z" };
  }, lateCapture().current);
  assert.equal(value?.usedUsd, 0);
  assert.equal(calls, 1);
});

test("registration during activation stays blocked until its real successful completion", () => {
  const state = new AccountRetirement(),
    generation = state.beginActivation();
  const activated = new Listeners<any>();
  const ctx: any = {
    store: {},
    remote: {},
    activeAccount: { id: "fixture" },
    get accountActivationIdentity() {
      return state.accountActivationIdentity;
    },
    get accountRetiring() {
      return state.accountRetiring;
    },
    onAccountDeactivating: () => () => {},
    onAccountActivated: (cb: (account: any) => void) => activated.add(cb),
  };
  const capture = profileReadLease(ctx);
  activated.emit(ctx.activeAccount);
  assert.equal(capture().current(), false);
  state.finishActivation(generation);
  activated.emit(ctx.activeAccount);
  assert.equal(capture().current(), true);
});
