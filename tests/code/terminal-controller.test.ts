import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Store } from "../../electron/store/store";
import { TerminalController } from "../../electron/terminal/terminal-controller";
import { registerTerminalHandlers } from "../../electron/ipc/terminal";
import type { Engine } from "../../electron/engine/engine";
import type { CodexRPC } from "../../electron/engine/rpc";
import type { AppEvent, Conversation } from "../../shared/types";

class FakeRPC extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  private exits = new Map<string, (result: number | Error) => void>();
  call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "command/exec")
      return new Promise<{ exitCode: number }>((resolve, reject) => {
        this.exits.set(params.processId, (result) => {
          if (result instanceof Error) reject(result);
          else resolve({ exitCode: result });
        });
      });
    if (method === "command/exec/terminate" && this.exits.has(params.processId))
      this.exit(params.processId, 0);
    return Promise.resolve({});
  }
  exit(id: string, result: number | Error) {
    const finish = this.exits.get(id);
    assert.ok(finish, "terminal is still running");
    this.exits.delete(id);
    finish(result);
  }
}
function fixture(root: string) {
  const store = new Store(root);
  const conversation: Conversation = {
    id: "chat",
    title: "Fixture",
    mode: "code",
    providerId: "default",
    model: "fixture",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  store.conversations.push(conversation);
  const rpc = new FakeRPC();
  const engine = {
    rpc: rpc as unknown as CodexRPC,
    state: { state: "ready" },
  } as Engine;
  return { store, conversation, rpc, engine };
}
test("terminal IPC stays within the active account and shares one initial tab", async () => {
  const rootA = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-terminal-account-a-"),
  );
  const rootB = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-terminal-account-b-"),
  );
  try {
    const a = fixture(rootA),
      b = fixture(rootB);
    const controllerA = new TerminalController(
      a.store,
      a.engine,
      () => {},
      "darwin",
    );
    const controllerB = new TerminalController(
      b.store,
      b.engine,
      () => {},
      "darwin",
    );
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    registerTerminalHandlers(
      (name, fn) => handlers.set(name, fn),
      () => controllerA,
    );
    const [first, concurrent] = (await Promise.all([
      handlers.get("terminalEnsure")!("chat"),
      handlers.get("terminalEnsure")!("chat"),
    ])) as Array<Array<{ id: string }>>;
    assert.equal(first.length, 1);
    assert.equal(first[0].id, concurrent[0].id);
    assert.equal(
      a.rpc.calls.filter((call) => call.method === "command/exec").length,
      1,
    );
    assert.equal(path.dirname(a.rpc.calls[0].params.cwd), rootA);
    assert.equal(a.rpc.calls[0].params.sandboxPolicy.type, "workspaceWrite");
    await controllerB.ensure("chat");
    await assert.rejects(
      controllerB.write(
        "chat",
        first[0].id,
        Buffer.from("hello").toString("base64"),
      ),
      /not found/,
    );
    assert.throws(
      () =>
        handlers.get("terminalWrite")!(
          "unknown",
          first[0].id,
          Buffer.from("hello").toString("base64"),
        ),
      /Conversation not found/,
    );
    const resize = handlers.get("terminalResize")!;
    assert.throws(() => resize("chat", first[0].id, "2", 600));
    await resize("chat", first[0].id, 2, 600);
    assert.deepEqual((await controllerA.list("chat"))[0].size, {
      rows: 2,
      cols: 600,
    });
    controllerA.reset();
    controllerB.reset();
    assert.equal(a.rpc.listenerCount("notification"), 0);
    assert.equal(b.rpc.listenerCount("notification"), 0);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("account retirement cancels a terminal still waiting for its engine", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-terminal-retirement-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { store, rpc, engine } = fixture(root);
  store.settings.providers = [{
    id: "default", name: "Fixture", model: "fixture", models: [],
    protocol: "responses", baseUrl: "http://127.0.0.1:1/v1",
  }];
  let entered!: () => void;
  let ready!: () => void;
  const waitingForEngine = new Promise<void>((resolve) => { entered = resolve; });
  const engineReady = new Promise<void>((resolve) => { ready = resolve; });
  Object.assign(engine, {
    state: { state: "starting" },
    async ensure() {
      entered();
      await engineReady;
    },
  });
  const controller = new TerminalController(store, engine, () => {}, "darwin");
  const opening = controller.start("chat");
  await waitingForEngine;
  await controller.reset();
  ready();
  await assert.rejects(opening, /terminal account changed/);
  assert.equal(rpc.calls.length, 0);
});

test("archive and reconnect invalidate old terminal sessions", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-terminal-restart-"),
  );
  try {
    const { store, conversation, rpc, engine } = fixture(root);
    const events: AppEvent[] = [];
    const controller = new TerminalController(
      store,
      engine,
      (event) => events.push(event),
      "win32",
    );
    const first = await controller.start("chat");
    // A Windows own shell runs outside the sandbox (terminal-sessions.ts).
    assert.equal(rpc.calls[0].params.sandboxPolicy.type, "dangerFullAccess");
    conversation.archived = true;
    await assert.rejects(controller.start("chat"), /Archived/);
    conversation.archived = false;
    engine.rpc = new FakeRPC() as unknown as CodexRPC;
    assert.throws(
      () =>
        controller.write("chat", first.id, Buffer.from("x").toString("base64")),
      /no longer available/,
    );
    const second = await controller.ensure("chat");
    assert.notEqual(second[0].id, first.id);
    assert.deepEqual(events, [
      {
        type: "terminal-exit",
        id: first.id,
        conversationId: "chat",
        error: "The terminal connection was closed.",
      },
    ]);
    controller.reset();
    assert.deepEqual(events.at(-1), { type: "terminal-reset" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("landing terminals require an authorized folder and never persist a conversation", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"claudex-draft-terminal-"));
  try {
    const f=fixture(root), controller=new TerminalController(f.store,f.engine,()=>{},"darwin");
    const calls=new Map<string,(...args:any[])=>any>();
    const cwd=path.join(root,"selected");fs.mkdirSync(cwd);
    registerTerminalHandlers((name,fn)=>calls.set(name,fn),()=>controller,{engine:{defaultWorkspace:path.join(root,"workspace")},allowedFolder(folder:string){if(folder!==cwd)throw Error("not selected");}} as never);
    const start=calls.get("officialDraftTerminalStart")!;
    assert.throws(()=>start("/unselected"),/folder picker/);
    const before=f.store.conversations.length;
    const first=await start(cwd, undefined, { rows: 2, cols: 600 }),second=await start(undefined);
    assert.notEqual(first.ownerId,second.ownerId);
    assert.equal(f.store.conversations.length,before);
    assert.equal(f.rpc.calls.filter(c=>c.method==="command/exec").length,2);
    assert.deepEqual(f.rpc.calls[0].params.size, { rows: 2, cols: 600 });
    await controller.write(first.ownerId,first.terminal.id,Buffer.from("pwd").toString("base64"));
    await assert.rejects(controller.write(second.ownerId,first.terminal.id,"eA=="),/not found/);
    await controller.close(first.ownerId,first.terminal.id);
    assert.throws(()=>controller.write(first.ownerId,first.terminal.id,"eA=="),/Conversation not found/);
    await controller.reset();
    assert.throws(()=>controller.write(second.ownerId,second.terminal.id,"eA=="),/terminal account changed/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("exiting landing terminals free their tabs and draft owners", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-draft-exit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { store, rpc, engine } = fixture(root);
  const events: AppEvent[] = [];
  const controller = new TerminalController(store, engine, (event) => events.push(event), "darwin");
  t.after(() => controller.reset());
  const drafts = [];
  const expected: AppEvent[] = [];
  for (let attempt = 0; attempt < 13; attempt++) {
    const draft = await controller.startDraft(root);
    drafts.push(draft);
    const result = attempt % 2 === 0 ? 0 : new Error("The shell connection failed.");
    rpc.exit(draft.terminal.id, result);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expected.push({
      type: "terminal-exit",
      id: draft.terminal.id,
      conversationId: draft.ownerId,
      ...(result instanceof Error ? { error: result.message } : { exitCode: result }),
    });
  }
  assert.deepEqual(events, expected);
  for (const { ownerId } of drafts)
    await assert.rejects(controller.list(ownerId), /Conversation not found/);
});

test("closing or resetting a landing terminal does not deliver a late shell exit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-draft-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { store, rpc, engine } = fixture(root);
  const events: AppEvent[] = [];
  const controller = new TerminalController(store, engine, (event) => events.push(event), "darwin");
  const closed = await controller.startDraft(root);
  await controller.close(closed.ownerId, closed.terminal.id);
  const reset = await controller.startDraft(root);
  const retirement = controller.reset();
  rpc.exit(reset.terminal.id, new Error("The shell connection failed."));
  await retirement;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [
    { type: "terminal-exit", id: closed.terminal.id, conversationId: closed.ownerId },
    { type: "terminal-reset" },
  ]);
});
