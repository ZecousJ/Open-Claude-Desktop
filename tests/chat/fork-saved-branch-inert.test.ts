/** Calls the exported history function on inert objects, not Engine/SDK constructors. */
import test from "node:test";
import assert from "node:assert/strict";
import { forkConversation } from "../../electron/engine/engine-history";
function fixture() {
  const turn = (id: string) => ({
    id,
    prompt: id,
    items: [],
    attachments: [],
    status: "completed",
    createdAt: 1,
  });
  const branch = {
    id: "saved",
    threadId: "saved-thread",
    providerId: "p2",
    model: "m2",
    turns: [turn("old")],
    visited: 1,
  };
  const source: any = {
    id: "c",
    title: "Source",
    mode: "chat",
    providerId: "p1",
    model: "m1",
    threadId: "live-thread",
    turns: [turn("live")],
    savedBranches: [branch],
    activeBranchId: "active",
  };
  const calls: any[] = [];
  let active = true;
  const store: any = {
    conversation: (id: string) => (id === "c" ? source : undefined),
    settings: { providers: [{ id: "p1" }, { id: "p2" }] },
    projects: [],
    conversations: [source],
    flush() {
      calls.push(["flush"]);
    },
  };
  const engine: any = {
    store,
    pendingSend: false,
    intentionalStop: false,
    elsewhereFor: () => undefined,
    assertModel: (p: any, m: string) => calls.push(["model", p.id, m]),
    policy: () => ({}),
    ensure: async () => {},
    ensureThread: async () => {},
    threadOptions: () => ({ config: {}, developerInstructions: "" }),
    rpc: {
      call: async (name: string, args: any) => {
        calls.push([name, args]);
        return { thread: { id: "fork-thread" } };
      },
    },
    loaded: new Set(),
    threadLimits: new Map(),
    routes: new Map(),
    changed: () => {},
    send: async () => {
      throw Error("Unexpected send");
    },
  };
  return {
    engine,
    source,
    branch,
    calls,
    lease: () => active,
    retire: () => {
      active = false;
    },
    run: (branchId?: string, turnId = "old") =>
      forkConversation.call(
        engine,
        "c",
        turnId,
        undefined,
        branchId,
        () => active,
      ),
  };
}
test("saved branch snapshot uses its exact provider/model/thread and leaves active path intact", async () => {
  const f = fixture();
  const before = structuredClone(f.source);
  const result = await f.run("saved");
  assert.equal(result.providerId, "p2");
  assert.equal(result.model, "m2");
  assert.deepEqual(
    result.turns.map((t) => t.id),
    ["old"],
  );
  assert.deepEqual(
    f.calls.find((c) => c[0] === "model"),
    ["model", "p2", "m2"],
  );
  assert.equal(
    f.calls.find((c) => c[0] === "thread/fork")[1].threadId,
    "saved-thread",
  );
  assert.deepEqual(
    { ...f.source, forks: undefined },
    { ...before, forks: undefined },
  );
  assert.equal(f.source.forks.length, 1);
});
test("unknown branch, foreign turn, duplicate branch and missing thread refuse before RPC", async () => {
  for (const mode of ["unknown", "foreign", "duplicate", "thread"]) {
    const f = fixture();
    if (mode === "duplicate")
      f.source.savedBranches.push(structuredClone(f.branch));
    if (mode === "thread") f.branch.threadId = undefined as any;
    await assert.rejects(
      f.run(
        mode === "unknown" ? "absent" : "saved",
        mode === "foreign" ? "live" : "old",
      ),
    );
    assert.equal(
      f.calls.some((c) => c[0] === "thread/fork"),
      false,
    );
    assert.equal(f.source.forks, undefined);
  }
});
test("retirement or saved-branch replacement during ensure prevents dispatch", async () => {
  for (const mode of ["account", "branch"]) {
    const f = fixture();
    f.engine.ensure = async () => {
      if (mode === "account") f.retire();
      else f.source.savedBranches = [];
    };
    await assert.rejects(f.run("saved"));
    assert.equal(
      f.calls.some((c) => c[0] === "thread/fork"),
      false,
    );
    assert.equal(f.source.forks, undefined);
  }
});
test("retirement or thread/model mutation after dispatched fork never publishes or retries it", async () => {
  for (const mode of ["account", "thread", "model"]) {
    const f = fixture();
    let count = 0;
    f.engine.rpc.call = async () => {
      count++;
      if (mode === "account") f.retire();
      else if (mode === "thread") f.branch.threadId = "changed";
      else f.branch.model = "changed";
      return { thread: { id: "already-created" } };
    };
    await assert.rejects(f.run("saved"), /changed/);
    assert.equal(count, 1);
    assert.equal(f.source.forks, undefined);
    assert.equal(f.engine.store.conversations.length, 1);
    assert.equal(f.engine.pendingSend, false);
  }
});
test("default active path and elsewhere forwarding preserve explicit arguments and host lease", async () => {
  const f = fixture();
  await f.run(undefined, "live");
  assert.equal(
    f.calls.find((c) => c[0] === "thread/fork")[1].threadId,
    "live-thread",
  );
  const g = fixture();
  let args: any[] = [];
  g.engine.elsewhereFor = () => ({
    forkConversation: async (...a: any[]) => {
      args = a;
      return {};
    },
  });
  await g.run("saved");
  assert.deepEqual(args.slice(0, 4), ["c", "old", undefined, "saved"]);
  assert.equal(typeof args[4], "function");
});
test('stopped engine may recover through ensure, but a stop after preparation rejects',async()=>{
 const f=fixture();f.engine.intentionalStop=true;f.engine.ensure=async()=>{f.engine.intentionalStop=false;};await f.run('saved');assert.equal(f.source.forks.length,1);
 const g=fixture();g.engine.ensureThread=async()=>{g.engine.intentionalStop=true;};await assert.rejects(g.run('saved'),/changed/);assert.equal(g.calls.some(c=>c[0]==='thread/fork'),false);
});
test('active provider/model/thread changes before dispatch reject and late changes never publish',async()=>{
 for(const key of ['providerId','model','threadId'])for(const late of [false,true]){
  const f=fixture();let calls=0;const mutate=()=>{f.source[key]='changed';};
  if(late)f.engine.rpc.call=async()=>{calls++;mutate();return {thread:{id:'already-created'}};};else f.engine.ensure=async()=>{mutate();};
  await assert.rejects(f.run(undefined,'live'),/changed/);assert.equal(calls,late?1:0);assert.equal(f.source.forks,undefined);assert.equal(f.engine.store.conversations.length,1);
 }
});
