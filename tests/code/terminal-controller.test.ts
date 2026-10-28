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
import type { Conversation } from "../../shared/types";

class FakeRPC extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  call(method: string, params: any) {
    this.calls.push({ method, params });
    return method === "command/exec"
      ? new Promise(() => {})
      : Promise.resolve({});
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
    assert.throws(
      () => handlers.get("terminalResize")!("chat", first[0].id, 2, 600),
      /too_small|too_big/i,
    );
    controllerA.reset();
    controllerB.reset();
    assert.equal(a.rpc.listenerCount("notification"), 0);
    assert.equal(b.rpc.listenerCount("notification"), 0);
  } finally {
    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  }
});

test("archive and reconnect invalidate old terminal sessions", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-terminal-restart-"),
  );
  try {
    const { store, conversation, rpc, engine } = fixture(root);
    const controller = new TerminalController(store, engine, () => {}, "win32");
    const first = await controller.start("chat");
    assert.equal(rpc.calls[0].params.sandboxPolicy.type, "readOnly");
    conversation.archived = true;
    await assert.rejects(controller.start("chat"), /Archived/);
    conversation.archived = false;
    controller.reset();
    assert.throws(
      () =>
        controller.write("chat", first.id, Buffer.from("x").toString("base64")),
      /no longer available/,
    );
    const second = await controller.ensure("chat");
    assert.notEqual(second[0].id, first.id);
    controller.reset();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
