/** Pure source/handler mocks, no real cancellation or runner request. */
import test from "node:test";
import assert from "node:assert/strict";
import { interruptExpectedTurn } from "../electron/conversations/interrupt-target";
import { registerConversationHandlers } from "../electron/ipc/conversations";
import { guardCall } from "../runner/src/method-guard";
const target = { turnId: "t", turnCreatedAt: 2, conversationCreatedAt: 1, threadId: "thread" };
function setup() {
  let generation = 1, invoked = 0, operation: any = async () => {};
  const c: any = { id: "c", mode: "chat", createdAt: 1, threadId: "thread", turns: [{ id: "t", createdAt: 2, status: "inProgress" }] };
  let actual: any = c;
  const ctx: any = { store: { conversation: () => { if (!actual) throw Error("missing"); return actual; } },
    accountGeneration: () => generation, engine: { interrupt: (id: string) => { assert.equal(id, "c"); invoked++; return operation(); } } };
  return { c, ctx, call: (expected: any = target) => interruptExpectedTurn(ctx, "c", expected), get invoked() { return invoked; },
    replace: () => actual = structuredClone(c), remove: () => actual = undefined, activate: () => generation++, source: (fn: any) => operation = fn };
}
test("expected interrupt validates exact stable target and dispatches synchronously before yielding", async () => {
  const h = setup(); const pending = h.call(); assert.equal(h.invoked, 1);
  assert.deepEqual(await pending, { status: "accepted" });
});
test("mismatch, unknown, and finished targets never interrupt a newer turn", async () => {
  for (const patch of [{ turnId: "other" }, { turnCreatedAt: 3 }, { conversationCreatedAt: 9 }, { threadId: "other" }, { threadId: undefined }]) {
    const h = setup(); assert.deepEqual(await h.call({ ...target, ...patch }), { status: "mismatch" }); assert.equal(h.invoked, 0);
  }
  const absent = setup(); absent.remove(); assert.deepEqual(await absent.call(), { status: "mismatch" }); assert.equal(absent.invoked, 0);
  for (const state of ["completed", "failed", "interrupted"]) {
    const h = setup(); h.c.turns[0].status = state; assert.deepEqual(await h.call(), { status: "already_finished" }); assert.equal(h.invoked, 0);
  }
  const newer = setup(); newer.c.turns.push({ id: "new", createdAt: 5, status: "inProgress" });
  assert.deepEqual(await newer.call(), { status: "mismatch" }); assert.equal(newer.invoked, 0);
});
test("invalid expected payload rejects before any interrupt and original engine rejection propagates", async () => {
  for (const value of [null, {}, { ...target, turnId: "pending-one" }, { ...target, turnCreatedAt: NaN }, { ...target, cwd: "/host" }]) {
    const h = setup(); assert.throws(() => h.call(value)); assert.equal(h.invoked, 0);
  }
  const h = setup(); h.source(async () => { throw Error("RPC offline"); }); await assert.rejects(h.call(), /RPC offline/);
});
test("replacement and same-account activation while engine awaits cannot return accepted", async () => {
  for (const action of ["replace", "remove", "activate"] as const) {
    const h = setup(); let done!: () => void; h.source(() => new Promise<void>(r => done = r));
    const pending = h.call(); h[action](); done(); assert.deepEqual(await pending, { status: "mismatch" });
  }
});
test("existing handler preserves ordinary interrupt void/error and supports expected runner argument without bypass", async () => {
  const h = setup(), methods = new Map<string, any>();
  Object.assign(h.ctx, { selectedAttachments: new Map(), allowedFolder() {}, noActive() {} });
  registerConversationHandlers((n, fn) => methods.set(n, fn), h.ctx);
  const call = methods.get("interrupt"); assert.equal(await call("c"), undefined);
  assert.deepEqual(await call("c", target), { status: "accepted" });
  h.source(async () => { throw Error("legacy failure"); }); await assert.rejects(call("c"), /legacy failure/);
  assert.doesNotThrow(() => guardCall("interrupt", ["c", target]));
  assert.throws(() => guardCall("officialInterruptTurn", ["c", target]));
  assert.throws(() => guardCall("interrupt", ["c", { ...target, cwd: "/host" }]));
});
test("expected handler requires real activation generation while legacy noargs remains available", async () => {
  const h = setup(), methods = new Map<string, any>(); delete h.ctx.accountGeneration;
  Object.assign(h.ctx, { selectedAttachments: new Map(), allowedFolder() {}, noActive() {} });
  registerConversationHandlers((n, fn) => methods.set(n, fn), h.ctx);
  assert.throws(() => methods.get("interrupt")("c", target), /unavailable/); assert.equal(h.invoked, 0);
  assert.equal(await methods.get("interrupt")("c"), undefined); assert.equal(h.invoked, 1);
});
