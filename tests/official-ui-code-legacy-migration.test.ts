import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import type { Conversation } from "../shared/types";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function offer(id = "old", text = "original saved input") {
  return { id, text, attachments: [], providerId: "p", model: "m" };
}
function fixture() {
  const c: Conversation = {
    id: "legacy",
    mode: "code",
    cwd: "/fixture",
    title: "Code",
    pinned: false,
    archived: false,
    providerId: "p",
    model: "m",
    updatedAt: 1,
    createdAt: 1,
    turns: [],
    codeNewTask: offer(),
  };
  let owner = "a",
    activation = 1,
    releases = 0;
  let release: (_id: string, text: string) => Promise<unknown> = async (
    _id,
    text,
  ) => {
    assert.equal(text, c.codeNewTask!.text);
    delete c.codeNewTask;
    return true;
  };
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => activation,
      localLoadConversation: async () => c, // Deliberately shared live object: never delete a post-await replacement offer.
      localCall: async (method: string, ...args: any[]) => {
        if (method === "snapshot") return { approvals: [] };
        if (method === "officialReleaseCodeNewTask") {
          releases++;
          assert.equal(args[0], c.id);
          return release(args[1], args[2]);
        }
        throw Error(`Unexpected execution: ${method}`);
      },
      onEvent: () => () => {},
    },
    on: (name: string, fn: (...args: any[]) => Promise<any>) =>
      handlers.set(name, fn),
    emit() {},
  } as never);
  return {
    c,
    get releases() {
      return releases;
    },
    release(fn: typeof release) {
      release = fn;
    },
    switch() {
      owner = "b";
      activation++;
    },
    get: () => handlers.get("LocalSessions.getSession")!("local_legacy"),
    transcript: () =>
      handlers.get("LocalSessions.getTranscript")!("local_legacy"),
  };
}

test("failed compare-and-release does not clear a replacement offer or retain newly staged stale input", async () => {
  const f = fixture();
  f.release(async () => {
    f.c.codeNewTask = offer("new", "replacement input");
    return false;
  });
  const view = await f.get();
  assert.equal(f.c.codeNewTask?.id, "new");
  assert.equal(view.sendsHeldAfterError, undefined);
  assert.ok(
    !JSON.stringify(await f.transcript()).includes("original saved input"),
  );
});

test("a successful late release refreshes source and never deletes the newer live offer", async () => {
  const f = fixture();
  f.release(async () => {
    f.c.codeNewTask = offer("new", "replacement input");
    return true;
  });
  const view = await f.get();
  assert.equal(f.c.codeNewTask?.id, "new");
  assert.deepEqual(view.sendsHeldAfterError, ["legacy-task-old"]);
});

test("concurrent reads coalesce release and keep one durable held item", async () => {
  const f = fixture(),
    gate = deferred();
  f.release(async () => {
    await gate.promise;
    delete f.c.codeNewTask;
    return true;
  });
  const a = f.get(),
    b = f.get();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.releases, 1);
  gate.resolve();
  for (const view of await Promise.all([a, b]))
    assert.deepEqual(view.sendsHeldAfterError, ["legacy-task-old"]);
});

test("release failure preserves held input for an explicit retry without duplicating it", async () => {
  const f = fixture();
  f.release(async () => {
    throw Error("flush failed");
  });
  await assert.rejects(f.get(), /flush failed/);
  assert.equal(f.c.codeNewTask?.id, "old");
  f.release(async () => {
    delete f.c.codeNewTask;
    return true;
  });
  assert.deepEqual((await f.get()).sendsHeldAfterError, ["legacy-task-old"]);
});

test("old account release completion cannot discard a new account migration lease or held message", async () => {
  const f = fixture(),
    old = deferred(),
    next = deferred();
  f.release(async () => {
    const gate = f.releases === 1 ? old : next;
    await gate.promise;
    return true;
  });
  const a = f.get();
  await new Promise((done) => setImmediate(done));
  f.switch();
  const b = f.get();
  await new Promise((done) => setImmediate(done));
  old.resolve();
  await assert.rejects(a, /account changed/);
  const another = f.get();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.releases, 2);
  next.resolve();
  for (const view of await Promise.all([b, another]))
    assert.deepEqual(view.sendsHeldAfterError, ["legacy-task-old"]);
});

test("malformed release acknowledgements fail explicitly and never delete the original offer", async () => {
  const f = fixture();
  f.release(async () => undefined);
  await assert.rejects(f.get(), /not confirmed/);
  assert.equal(f.c.codeNewTask?.id, "old");
  f.release(async () => {
    delete f.c.codeNewTask;
    return true;
  });
  assert.deepEqual((await f.get()).sendsHeldAfterError, ["legacy-task-old"]);
});
