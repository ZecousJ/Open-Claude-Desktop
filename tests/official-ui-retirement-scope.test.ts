/** Actual scoped wrapper, deferred inert calls; no account or network operations. */
import test from "node:test";
import assert from "node:assert/strict";
import { guardAdapterContext } from "../electron/official-ui/api/scoped-context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
function fixture() {
  const store = {},
    scope = newAdapterScope("owner", undefined, store);
  let retiring = false,
    calls = 0,
    listener: (e: any) => void = () => {};
  let resolve!: (v: unknown) => void;
  const pending = new Promise((r) => {
    resolve = r;
  });
  const ctx = guardAdapterContext({
    account: () => ({ id: "owner" }),
    sessionIdentity: () => store,
    isCurrent: () => !retiring,
    call: async () => {
      calls++;
      return pending;
    },
    onEvent: (fn: any) => {
      listener = fn;
      return () => {};
    },
  } as never);
  return {
    ctx,
    scope,
    retire() {
      retiring = true;
    },
    resolve,
    emit(e: any) {
      listener(e);
    },
    calls: () => calls,
  };
}
test("retirement veto blocks new operations while account and store still match", () => {
  const f = fixture();
  f.retire();
  inAdapterScope(f.scope, () => {
    assert.equal(f.ctx.isCurrent!(), false);
    assert.throws(() => f.ctx.call("snapshot"));
  });
  assert.equal(f.calls(), 0);
});
test("deferred result and bound events cannot escape during retirement", async () => {
  const f = fixture(),
    events: any[] = [];
  const answer = inAdapterScope(f.scope, () => {
    f.ctx.onEvent((e) => events.push(e));
    return f.ctx.call("snapshot");
  });
  f.retire();
  f.emit({ type: "fixture" });
  f.resolve({ private: "inert" });
  await assert.rejects(answer, /account changed/i);
  assert.deepEqual(events, [
    {
      type: "signed-out",
      reason: "session-expired",
      message: "The account session changed. Reopen the conversation.",
    },
  ]);
  assert.equal(f.calls(), 1);
});
test("host veto lookup failure or nonboolean result fails closed; absent hook retains scoped compatibility", () => {
  const store = {},
    scope = newAdapterScope("owner", undefined, store);
  for (const hook of [
    () => undefined,
    () => {
      throw Error("retiring");
    },
  ]) {
    const ctx = guardAdapterContext({
      account: () => ({ id: "owner" }),
      sessionIdentity: () => store,
      isCurrent: hook,
    } as never);
    inAdapterScope(scope, () => assert.equal(ctx.isCurrent!(), false));
  }
  const ctx = guardAdapterContext({
    account: () => ({ id: "owner" }),
    sessionIdentity: () => store,
  } as never);
  inAdapterScope(scope, () => assert.equal(ctx.isCurrent!(), true));
});
