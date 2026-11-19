/** Source-level lifecycle tests with recording transports only. No Engine startup,
 * provider, tools, files, account, browser or network. Policy/effort predicates
 * below are explicit inert dependencies; this is not full Engine integration. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function sourceModule(
  file: string,
  dependencies: Record<string, unknown> = {},
) {
  const exports: any = {};
  const source = fs.readFileSync(
    new URL(`../../${file}`, import.meta.url),
    "utf8",
  );
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics?.length ?? 0, 0);
  vm.runInNewContext(result.outputText, {
    exports,
    Buffer,
    URL,
    Date,
    Map,
    Promise,
    Error,
    require: (name: string) => {
      assert.ok(name in dependencies, `Unexpected runtime dependency: ${name}`);
      return dependencies[name];
    },
  });
  return exports;
}
const model = sourceModule("electron/engine/side-chat-model.ts");
const options = sourceModule("electron/engine/thread-options.ts");
const { SideChats } = sourceModule("electron/engine/side-chats.ts", {
  "../../shared/client-policy-rules": {
    updateRefusal: () => "update required",
  },
  "../../shared/code-effort": { effortForMode: () => "medium" },
  "../../shared/turn-errors": {
    isContextLimitError: (text: string) => text === "context limit",
    isLengthLimitError: (text: string) => text === "length limit",
  },
  "../ssh/outbox": {
    isOutboxTurn: (turn: any) => turn.id.startsWith("outbox-"),
  },
  "./side-chat-model": model,
  "./thread-options": options,
});
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  return {
    promise: new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    }),
    resolve: (value: T) => resolve(value),
    reject: (error: Error) => reject(error),
  };
}
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function setup(override?: (method: string, params: any, count: number) => any) {
  const calls: any[] = [],
    events: any[] = [],
    aborts: string[] = [],
    openedPaths: string[] = [],
    closedPaths: string[] = [];
  let forks = 0,
    starts = 0;
  const conversation: any = {
    id: "c",
    threadId: "main",
    providerId: "provider",
    model: "m",
    mode: "chat",
    turns: [
      { id: "a", status: "completed" },
      { id: "b", status: "inProgress" },
    ],
  };
  const store = {
    conversation: () => conversation,
    settings: { providers: [{ id: "provider" }] },
    projects: [],
  };
  const rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params: plain(params) });
      const count =
        method === "thread/fork"
          ? ++forks
          : method === "turn/start"
            ? ++starts
            : 0;
      const custom = override?.(method, params, count);
      if (custom !== undefined) return custom;
      if (method === "config/read")
        return { config: { model_providers: { claudex: { base_url: "http://127.0.0.1:1234/v1" } } } };
      if (method === "thread/fork") return { thread: { id: `side-${forks}` } };
      if (method === "turn/start") return { turn: { id: `turn-${starts}` } };
      return {};
    },
  };
  const gateway = {
    url: "http://127.0.0.1:1234/v1",
    openSidePath: async () => {
      const token = (openedPaths.length + 1).toString(16).padStart(64, "0");
      openedPaths.push(token);
      return token;
    },
    closeSidePath: async (token: string) => { closedPaths.push(token); },
    abortThread: (threadId: string) => aborts.push(threadId),
  };
  const current = { store, rpc, gateway };
  let ensure = async () => {};
  const sides = new SideChats({
    rpc: () => current.rpc,
    gateway: () => current.gateway,
    store: () => current.store,
    policy: () => ({}),
    lastRefusal: () => undefined,
    emit: (event: any) => events.push(plain(event)),
    assertModel: () => {},
    ensure: () => ensure(),
    mcpServerNames: () => ["baseline"],
    threadOptions: () => ({
      config: { web_search: "live", "mcp_servers.reference.url": "https://example.test/mcp" },
      developerInstructions: "base",
      dynamicTools: [{ name: "test" }],
    }),
    loaded: () => true,
    ensureThread: async () => {},
  });
  return {
    sides,
    calls,
    events,
    aborts,
    openedPaths,
    closedPaths,
    current,
    conversation,
    rpc,
    gateway,
    setEnsure: (fn: () => Promise<void>) => {
      ensure = fn;
    },
    ask: (id = "s", stream = true) =>
      sides.ask("c", id, "Question?", "Side instructions", stream),
    notify: (threadId: string, method: string, params: any, id = "s") =>
      sides.notification(id, method, { threadId, ...params }),
    delta: (text: string, turnId = "turn-1", threadId = "side-1", id = "s") =>
      sides.notification(id, "item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: "message",
        delta: text,
      }),
    finish: (
      turnId = "turn-1",
      status = "completed",
      threadId = "side-1",
      id = "s",
      error?: string,
    ) =>
      sides.notification(id, "turn/completed", {
        threadId,
        turn: { id: turnId, status, error: { message: error } },
      }),
  };
}
const callsOf = (env: ReturnType<typeof setup>, method: string) =>
  env.calls.filter((call) => call.method === method);

test("a late gateway capability after Clear is released before any fork", async () => {
  const capability = deferred<string>();
  const env = setup();
  env.gateway.openSidePath = () => capability.promise;
  const answer = env.ask();
  const rejected = assert.rejects(answer, /closed/);
  await tick();
  env.sides.end("c", "s");
  await rejected;
  const token = "a".repeat(64);
  capability.resolve(token);
  await tick();
  assert.deepEqual(env.closedPaths, [token]);
  assert.equal(callsOf(env, "thread/fork").length, 0);
});

test("a failed gateway configuration read revokes its capability", async () => {
  const env = setup((method) =>
    method === "config/read" ? Promise.reject(Error("configuration unavailable")) : undefined,
  );
  await assert.rejects(env.ask(), /configuration unavailable/);
  await tick();
  assert.deepEqual(env.closedPaths, [env.openedPaths[0]]);
  assert.equal(callsOf(env, "thread/fork").length, 0);
});

test("Clear revokes the gateway path while thread unsubscribe is still pending", async () => {
  const unsubscribe = deferred();
  const env = setup((method) =>
    method === "thread/unsubscribe" ? unsubscribe.promise : undefined,
  );
  const answer = env.ask();
  const rejected = assert.rejects(answer, /closed/);
  await tick();
  env.sides.end("c", "s");
  await rejected;
  await tick();
  assert.deepEqual(env.closedPaths, [env.openedPaths[0]]);
  unsubscribe.resolve({});
});

test("Clear settles immediately; late fork is released without registration or start", async () => {
  const fork = deferred(),
    env = setup((method) =>
      method === "thread/fork" ? fork.promise : undefined,
    );
  const answer = env.ask(),
    rejected = assert.rejects(answer, /closed/);
  await tick();
  env.sides.end("c", "s");
  await rejected;
  fork.resolve({ thread: { id: "late-fork" } });
  await tick();
  assert.equal(env.sides.chatOfThread("late-fork"), undefined);
  assert.deepEqual(
    callsOf(env, "thread/unsubscribe").map((x) => x.params),
    [{ threadId: "late-fork" }],
  );
  assert.equal(callsOf(env, "turn/start").length, 0);
  assert.deepEqual(env.closedPaths, [env.openedPaths[0]]);
});

test("Clear during start waits for exact late turn ID; no undefined interrupt", async () => {
  const start = deferred(),
    env = setup((method) =>
      method === "turn/start" ? start.promise : undefined,
    );
  const answer = env.ask(),
    rejected = assert.rejects(answer, /closed/);
  await tick();
  env.sides.end("c", "s");
  await rejected;
  assert.equal(callsOf(env, "turn/interrupt").length, 0);
  start.resolve({ turn: { id: "late-turn" } });
  await tick();
  assert.deepEqual(
    callsOf(env, "turn/interrupt").map((x) => x.params),
    [{ threadId: "side-1", turnId: "late-turn" }],
  );
  assert.equal(callsOf(env, "thread/unsubscribe").length, 1);
  assert.equal(env.sides.chatOfThread("side-1"), undefined);
});

for (const pending of ["fork", "start"] as const)
  test(`Clear/reopen ABA during ${pending} never affects replacement`, async () => {
    const old = deferred();
    const env = setup((method, _params, count) =>
      method === `thread/${pending}` && count === 1
        ? old.promise
        : pending === "start" && method === "turn/start" && count === 1
          ? old.promise
          : undefined,
    );
    const first = env.ask(),
      rejected = assert.rejects(first, /closed/);
    await tick();
    env.sides.end("c", "s");
    await rejected;
    const second = env.ask();
    await tick();
    const secondThread = pending === "fork" ? "side-2" : "side-2";
    const secondTurn = pending === "fork" ? "turn-1" : "turn-2";
    old.resolve(
      pending === "fork"
        ? { thread: { id: "late-old" } }
        : { turn: { id: "old-turn" } },
    );
    await tick();
    assert.equal(env.sides.chatOfThread(secondThread), "s");
    assert.equal(env.aborts.includes(secondThread), false);
    assert.deepEqual(env.closedPaths, [env.openedPaths[0]]);
    assert.ok(!env.closedPaths.includes(env.openedPaths[1]));
    env.delta("new", secondTurn, secondThread);
    env.finish(secondTurn, "completed", secondThread);
    assert.equal(await second, "new");
  });

test("a late reused thread ID revokes only the retired side's gateway path", async () => {
  const oldFork = deferred();
  const env = setup((method, _params, count) =>
    method === "thread/fork" && count === 1 ? oldFork.promise : undefined,
  );
  const oldAnswer = env.ask();
  const rejected = assert.rejects(oldAnswer, /closed/);
  await tick();
  env.sides.end("c", "s");
  await rejected;
  const nextAnswer = env.ask();
  await tick();
  oldFork.resolve({ thread: { id: "side-2" } });
  await tick();
  assert.deepEqual(env.closedPaths, [env.openedPaths[0]]);
  assert.ok(!env.closedPaths.includes(env.openedPaths[1]));
  assert.equal(env.aborts.includes("side-2"), false);
  env.delta("new", "turn-1", "side-2");
  env.finish("turn-1", "completed", "side-2");
  assert.equal(await nextAnswer, "new");
});

test("late old delta, item and completion do not modify or settle the next question", async () => {
  const env = setup();
  const first = env.ask();
  await tick();
  env.delta("first");
  env.finish();
  assert.equal(await first, "first");
  const second = env.ask();
  let settled = false;
  void second.then(() => (settled = true));
  await tick();
  env.delta("stale", "turn-1");
  env.notify("side-1", "item/completed", {
    turnId: "turn-1",
    item: { id: "message", type: "agentMessage", text: "old" },
  });
  env.finish("turn-1");
  await tick();
  assert.equal(settled, false);
  env.delta("second", "turn-2");
  env.finish("turn-2");
  assert.equal(await second, "second");
  assert.deepEqual(
    env.events.map((x) => x.text),
    ["first", "second"],
  );
});

test("legitimate early text and terminal are replayed only after authoritative start ID", async () => {
  const start = deferred(),
    env = setup((method) =>
      method === "turn/start" ? start.promise : undefined,
    );
  const answer = env.ask();
  await tick();
  env.delta("stale", "old-turn");
  env.finish("old-turn");
  env.delta("early", "new-turn");
  env.finish("new-turn");
  assert.equal(env.events.length, 0);
  start.resolve({ turn: { id: "new-turn" } });
  assert.equal(await answer, "early");
  assert.deepEqual(
    env.events.map((x) => x.text),
    ["early"],
  );
});

test("missing and mismatched event IDs fail closed", async () => {
  const env = setup();
  const answer = env.ask();
  await tick();
  env.notify("side-1", "item/agentMessage/delta", {
    itemId: "x",
    delta: "missing turn",
  });
  env.notify("wrong-thread", "item/agentMessage/delta", {
    turnId: "turn-1",
    itemId: "x",
    delta: "wrong thread",
  });
  env.notify("side-1", "turn/completed", { turn: { status: "completed" } });
  env.delta("wrong turn", "wrong-turn");
  env.finish("wrong-turn");
  assert.equal(env.events.length, 0);
  env.delta("valid");
  env.finish();
  assert.equal(await answer, "valid");
});

test("completed items without a usable string ID do not corrupt cumulative text", async () => {
  const env = setup();
  const answer = env.ask();
  await tick();
  env.delta("valid");
  for (const id of [undefined, null, 123, "", "   "])
    env.notify("side-1", "item/completed", {
      turnId: "turn-1",
      item: { id, type: "agentMessage", text: "invalid replacement" },
    });
  env.finish();
  assert.equal(await answer, "valid");
  assert.deepEqual(
    env.events.map((event) => event.text),
    ["valid"],
  );
});

for (const invalid of [undefined, "", "   ", 123])
  test(`invalid start ID ${String(invalid)} rejects and releases`, async () => {
    const env = setup((method) =>
      method === "turn/start" ? { turn: { id: invalid } } : undefined,
    );
    await assert.rejects(env.ask(), /did not return a side chat turn/);
    await tick();
    assert.equal(callsOf(env, "thread/unsubscribe").length, 1);
    assert.equal(callsOf(env, "turn/interrupt").length, 0);
  });

for (const bound of ["count", "bytes"])
  test(`early buffer ${bound} limit closes and releases late start`, async () => {
    const start = deferred(),
      env = setup((method) =>
        method === "turn/start" ? start.promise : undefined,
      );
    const answer = env.ask(),
      rejected = assert.rejects(answer, /Too much side chat output/);
    await tick();
    if (bound === "count")
      for (let i = 0; i <= model.maxSideStartEvents; i++) env.delta("x");
    else env.delta("é".repeat(model.maxSideStartEventBytes / 2));
    await rejected;
    assert.equal(env.events.length, 0);
    start.resolve({ turn: { id: "turn-1" } });
    await tick();
    assert.equal(callsOf(env, "turn/interrupt").length, 1);
    assert.equal(callsOf(env, "thread/unsubscribe").length, 1);
  });

test("text replacements remain cumulative; main turns and fork policy remain unchanged", async () => {
  const env = setup(),
    before = plain(env.conversation);
  const answer = env.ask();
  await tick();
  env.delta("draft");
  env.notify("side-1", "item/completed", {
    turnId: "turn-1",
    item: { id: "message", type: "agentMessage", text: "corrected" },
  });
  env.finish();
  assert.equal(await answer, "corrected");
  assert.deepEqual(
    env.events.map((x) => x.text),
    ["draft", "corrected"],
  );
  assert.deepEqual(env.conversation, before);
  const fork = callsOf(env, "thread/fork")[0].params;
  assert.equal(fork.lastTurnId, "a");
  assert.equal(fork.sandbox, "read-only");
  assert.equal(fork.ephemeral, true);
  assert.equal(fork.approvalPolicy, "never");
  assert.equal("dynamicTools" in fork, false);
  assert.equal(fork.config.web_search, "disabled");
  assert.equal(fork.config["mcp_servers.reference.enabled"], false);
  assert.equal(fork.config["mcp_servers.baseline.enabled"], false);
});

test("Stop keeps partial text and the fork; Clear rejects and releases", async () => {
  const env = setup();
  const first = env.ask();
  await tick();
  env.delta("partial ");
  await env.sides.interrupt("c", "s");
  env.finish("turn-1", "interrupted");
  assert.equal(await first, "partial");
  assert.equal(env.sides.chatOfThread("side-1"), "s");
  const second = env.ask(),
    rejected = assert.rejects(second, /closed/);
  await tick();
  env.delta("discard", "turn-2");
  env.sides.end("c", "s");
  await rejected;
  await tick();
  assert.equal(callsOf(env, "thread/fork").length, 1);
  assert.equal(env.sides.chatOfThread("side-1"), undefined);
});

test("Stop while start pending interrupts returned turn and preserves buffered partial", async () => {
  const start = deferred(),
    env = setup((method) =>
      method === "turn/start" ? start.promise : undefined,
    );
  const answer = env.ask();
  await tick();
  env.delta("partial");
  await env.sides.interrupt("c", "s");
  assert.equal(callsOf(env, "turn/interrupt").length, 0);
  start.resolve({ turn: { id: "turn-1" } });
  await tick();
  assert.deepEqual(callsOf(env, "turn/interrupt")[0].params, {
    threadId: "side-1",
    turnId: "turn-1",
  });
  env.finish("turn-1", "interrupted");
  assert.equal(await answer, "partial");
});

test("Stop before start sends no turn and keeps the finished fork available", async () => {
  const fork = deferred(),
    env = setup((method, _p, n) =>
      method === "thread/fork" && n === 1 ? fork.promise : undefined,
    );
  const first = env.ask(),
    rejected = assert.rejects(first, /stopped/);
  await tick();
  await env.sides.interrupt("c", "s");
  fork.resolve({ thread: { id: "side-1" } });
  await rejected;
  assert.equal(callsOf(env, "turn/start").length, 0);
  const next = env.ask();
  await tick();
  env.delta("next");
  env.finish();
  assert.equal(await next, "next");
  assert.equal(callsOf(env, "thread/fork").length, 1);
});

test("Clear and late cleanup use captured RPC and gateway after host replacement", async () => {
  const start = deferred(),
    env = setup((method) =>
      method === "turn/start" ? start.promise : undefined,
    );
  const answer = env.ask(),
    rejected = assert.rejects(answer, /closed/);
  await tick();
  const replacementCalls: any[] = [];
  env.current.rpc = {
    call: async (...args: any[]) => {
      replacementCalls.push(args);
      return {};
    },
  };
  env.current.gateway = {
    url: "http://127.0.0.1:1234/v1",
    openSidePath: async () => "b".repeat(64),
    closeSidePath: async (_token: string) => {},
    abortThread: (id: string) => replacementCalls.push(id) as any,
  };
  env.sides.end("c", "s");
  await rejected;
  start.resolve({ turn: { id: "turn-1" } });
  await tick();
  assert.deepEqual(replacementCalls, []);
  assert.equal(callsOf(env, "turn/interrupt").length, 1);
  assert.equal(callsOf(env, "thread/unsubscribe").length, 1);
});

test("account replacement during ensure does not fork or start", async () => {
  const ensure = deferred<void>(),
    env = setup();
  env.setEnsure(() => ensure.promise);
  const answer = env.ask(),
    rejected = assert.rejects(answer, /account or agent changed/);
  env.current.store = { ...env.current.store };
  ensure.resolve();
  await rejected;
  assert.equal(env.calls.length, 0);
});

test("dropAll during pending start releases after response and ignores old output", async () => {
  const start = deferred(),
    env = setup((method) =>
      method === "turn/start" ? start.promise : undefined,
    );
  const answer = env.ask(),
    rejected = assert.rejects(answer, /agent stopped/);
  await tick();
  env.sides.dropAll(new Error("agent stopped"));
  await rejected;
  env.delta("stale");
  start.resolve({ turn: { id: "turn-1" } });
  await tick();
  assert.equal(env.events.length, 0);
  assert.equal(callsOf(env, "turn/interrupt").length, 1);
});

test("unknown start failure rejects once, releases, and never retries the model", async () => {
  const start = deferred(),
    env = setup((method) =>
      method === "turn/start" ? start.promise : undefined,
    );
  const answer = env.ask(),
    rejected = assert.rejects(answer, /unknown outcome/);
  await tick();
  start.reject(new Error("unknown outcome"));
  await rejected;
  await tick();
  assert.equal(callsOf(env, "turn/start").length, 1);
  assert.equal(callsOf(env, "thread/unsubscribe").length, 1);
  assert.equal(callsOf(env, "turn/interrupt").length, 0);
});

test("late interrupt acknowledgement never aborts a newer turn", async () => {
  const interrupted = deferred(),
    env = setup((method) =>
      method === "turn/interrupt" ? interrupted.promise : undefined,
    );
  const first = env.ask();
  await tick();
  env.delta("partial");
  const stop = env.sides.interrupt("c", "s");
  env.finish("turn-1", "interrupted");
  await first;
  const next = env.ask();
  await tick();
  const abortedBefore = env.aborts.length;
  interrupted.resolve({});
  await stop;
  assert.equal(env.aborts.length, abortedBefore);
  env.delta("next", "turn-2");
  env.finish("turn-2");
  assert.equal(await next, "next");
});

test("handoff non-streaming and service errors retain their prior public behavior", async () => {
  const env = setup();
  const note = env.ask("s", false);
  await tick();
  env.delta("note");
  env.finish();
  assert.equal(await note, "note");
  assert.deepEqual(env.events, []);
  const failed = env.ask(),
    rejected = assert.rejects(failed, /maximum length/);
  await tick();
  env.finish("turn-2", "failed", "side-1", "s", "length limit");
  await rejected;
});
