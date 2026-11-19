/** Calls only the exported method with mocked store/RPC; no engine process or terminal runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { interrupt } from "../../electron/engine/engine-handoff";
function setup() {
  const turn: any = { id: "t", status: "inProgress", items: [{ type: "commandExecution", id: "cmd" }] };
  const c: any = { id: "c", threadId: "thread", turns: [turn] };
  let actual: any = c, call: any = async (name: string) => name === "thread/backgroundTerminals/list" ? { data: [{ itemId: "cmd", processId: "p" }] } : {};
  const calls: any[] = [], notifications: any[] = []; let aborted = 0, flushed = 0;
  const store = { conversation: () => { if (!actual) throw Error("missing"); return actual; }, flush: () => flushed++ };
  const engine: any = { store, elsewhereFor: () => undefined, rpc: { call: async (...args: any[]) => { calls.push(args); return call(...args); } },
    gateway: { abortThread: () => aborted++ }, notification: (n: any) => notifications.push(n) };
  return { engine, c, turn, calls, notifications, invoke: () => interrupt.call(engine, "c"), source: (fn: any) => call = fn,
    replace: () => actual = structuredClone(c), remove: () => actual = undefined, switchStore: () => engine.store = { ...store },
    nextTurn: () => c.turns.push({ ...turn, id: "new" }), get aborted() { return aborted; }, get flushed() { return flushed; } };
}
test("valid stop still interrupts exact turn, cleans its background terminal and aborts its stream", async () => {
  const h = setup(); await h.invoke();
  assert.deepEqual(h.calls.map(c => c[0]), ["turn/interrupt", "thread/backgroundTerminals/list", "thread/backgroundTerminals/terminate"]);
  assert.deepEqual(h.calls[0][1], { threadId: "thread", turnId: "t" }); assert.equal(h.aborted, 1);
});
test("same-ID replacement/deletion/account-store/newturn during interrupt response cannot receive old cleanup", async () => {
  for (const change of ["replace", "remove", "switchStore", "nextTurn"] as const) {
    const h = setup(); h.source(async () => { h[change](); return {}; });
    await h.invoke(); assert.deepEqual(h.calls.map(c => c[0]), ["turn/interrupt"]);
    assert.equal(h.aborted, 0); assert.equal(h.flushed, 0); assert.equal(h.notifications.length, 0);
  }
});
test("replacement while background-terminal listing awaits prevents stale terminate and stream abort", async () => {
  const h = setup(); h.source(async (name: string) => {
    if (name === "thread/backgroundTerminals/list") { h.replace(); return { data: [{ itemId: "cmd", processId: "p" }] }; }
    return {};
  });
  await h.invoke(); assert.deepEqual(h.calls.map(c => c[0]), ["turn/interrupt", "thread/backgroundTerminals/list"]);
  assert.equal(h.aborted, 0);
});
test("late history cannot reconcile a replaced session; original no-active-turn error remains", async () => {
  const h = setup(); h.source(async (name: string) => {
    if (name === "turn/interrupt") throw Error("no active turn to interrupt");
    if (name === "thread/read") { h.replace(); return { thread: { id: "thread", turns: [{ id: "t", status: "completed", items: [] }] } }; }
    throw Error("Unexpected RPC");
  });
  await assert.rejects(h.invoke(), /no active turn to interrupt/);
  assert.equal(h.aborted, 0); assert.equal(h.notifications.length, 0); assert.equal(h.flushed, 0);
});
test("ordinary RPC failure still propagates, cleans only its owned stream and never invents terminal success", async () => {
  const h = setup(); h.source(async () => { throw Error("RPC offline"); });
  await assert.rejects(h.invoke(), /RPC offline/); assert.equal(h.aborted, 1);
  assert.deepEqual(h.calls.map(c => c[0]), ["turn/interrupt"]);
});
test("owned no-active-turn reconciliation still accepts verified terminal history", async () => {
  const h = setup(); h.source(async (name: string) => {
    if (name === "turn/interrupt") throw Error("no active turn to interrupt");
    if (name === "thread/read") return { thread: { id: "thread", turns: [{ id: "t", status: "completed", items: [] }] } };
    if (name === "thread/backgroundTerminals/list") return { data: [] };
    throw Error("Unexpected RPC");
  });
  await h.invoke(); assert.equal(h.notifications.length, 1); assert.equal(h.flushed, 1); assert.equal(h.aborted, 1);
});
test("ownership loss with no-active-turn response does not read replacement history", async () => {
  const h = setup(); h.source(async () => { h.replace(); throw Error("no active turn to interrupt"); });
  await assert.rejects(h.invoke(), /no active turn to interrupt/);
  assert.deepEqual(h.calls.map(c => c[0]), ["turn/interrupt"]); assert.equal(h.aborted, 0);
});
