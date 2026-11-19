/** All model/attachment/interrupt calls are inert mocks; no model invocation. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { CodeSendCancelled, officialCodeSendStart } from "../electron/engine/code-send-start";
import type { Conversation } from "../shared/types";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
function fixture(running = false) {
  const c: Conversation = {
    id: "code-stop",
    mode: "code",
    title: "Code",
    pinned: false,
    archived: false,
    cwd: "/inert",
    providerId: "p",
    model: "m",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 1,
    turns: running
      ? [
          {
            id: "t",
            prompt: "prior",
            status: "inProgress",
            attachments: [],
            items: [],
            createdAt: 1,
          },
        ]
      : [],
  };
  const logs: unknown[][] = [];
  const handlers = new Map<string, any>(),
    calls: string[] = [];
  const events: unknown[] = [];
  let event: (e: any) => void = () => {},
    storeGate: Promise<void> | undefined,
    restoreGate: Promise<void> | undefined,
    loadGate: Promise<void> | undefined,
    sendGate: Promise<void> | undefined,
    failInterrupt = false;
  const stored = deferred(),
    restored = deferred(),
    sendEntered = deferred();
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      settings: () => ({ activeProviderId: "p", providers: [{ id: "p", model: "m" }], mcpServers: {} }),
      localLoadConversation: async (id: string) => {
        const snapshot = id === c.id ? structuredClone(c) : undefined;
        await loadGate;
        return snapshot;
      },
      onEvent(fn: any) {
        event = fn;
        return () => {};
      },
      log(...args: unknown[]) {
        logs.push(args);
      },
      localCall: async (name: string, ...args: any[]) => {
        calls.push(name);
        if (name === "snapshot") return { approvals: [] };
        if (name === "officialStoreCodeAttachments") {
          stored.resolve();
          await storeGate;
          return [
            { id: "attachment", name: "note.txt", kind: "file", size: 1 },
          ];
        }
        if (name === "officialRestoreCodeAttachments") {
          restored.resolve();
          await restoreGate;
          return [
            { id: "attachment", name: "note.txt", kind: "file", size: 1 },
          ];
        }
        if (name === "interrupt" && failInterrupt)
          throw Error("interrupt failed");
        if (name === "interrupt") return {status:"accepted"};
        if (name === "send") {
          sendEntered.resolve();
          await sendGate;
          if (args[1]?.[officialCodeSendStart]?.cancelledBeforeDispatch)
            throw new CodeSendCancelled();
          return structuredClone(c);
        }
      },
    },
    on(n: string, f: any) {
      handlers.set(n, f);
      return this;
    },
    emit(_domain: string, _channel: string, value: unknown) { events.push(value); },
  } as never);
  return {
    c,
    calls,
    logs,
    events,
    stored,
    restored,
    sendEntered,
    run: (n: string, ...args: any[]) =>
      handlers.get("LocalSessions." + n)(...args),
    event: (e: any) => event(e),
    storeGate(p: Promise<void>) {
      storeGate = p;
    },
    restoreGate(p: Promise<void>) {
      restoreGate = p;
    },
    loadGate(p: Promise<void>) {
      loadGate = p;
    },
    sendGate(p: Promise<void>) {
      sendGate = p;
    },
    failInterrupt() {
      failInterrupt = true;
    },
  };
}
const files = [{ name: "note.txt", base64: "eA==" }];
test("Stop retires owned attachment staging before a delayed history read can race dispatch", async () => {
  const f = fixture(), store = deferred(), load = deferred();
  f.storeGate(store.promise);
  const send = f.run("sendMessage", "local_code-stop", "new message", undefined, undefined, files);
  const rejected = assert.rejects(send, /cancelled before dispatch/);
  await f.stored.promise;
  f.loadGate(load.promise);
  const stopped = f.run("stop", "local_code-stop");
  store.resolve();
  await rejected;
  assert.equal(f.calls.includes("send"), false);
  load.resolve();
  await stopped;
  assert.equal(f.calls.includes("interrupt"), false);
});

test("Stop of an owned requested session cancels its attachment preparation without sending", async () => {
  const f = fixture(), gate = deferred();
  f.storeGate(gate.promise);
  const id = "local_601d2288-b823-4f74-8556-b271d36bc85e";
  const start = f.run("start", { sessionId: id, cwd: "/inert", message: "unsent", attachments: files });
  const cancelled = assert.rejects(start, /\[spawn-cancelled\].*cancelled during setup/);
  await f.stored.promise;
  await f.run("stop", id);
  gate.resolve();
  await cancelled;
  assert.equal(f.calls.includes("send"), false);
  assert.deepEqual(f.events, []);
});

test("Stop during a submitted follow-up holds the known-unsent input under the same UUID", async () => {
  const f = fixture(), gate = deferred();
  f.sendGate(gate.promise);
  const send = f.run("sendMessage", "local_code-stop", "save me", undefined, undefined, undefined, "later", undefined, "held-id");
  const cancelled = assert.rejects(send, /cancelled before dispatch/);
  await f.sendEntered.promise;
  await f.run("stop", "local_code-stop");
  gate.resolve();
  await cancelled;
  const view = await f.run("getSession", "local_code-stop");
  assert.deepEqual(view.sendsHeldAfterError, ["held-id"]);
  assert.equal(f.calls.filter((call) => call === "send").length, 1);
  assert.equal(f.calls.includes("interrupt"), false);
});
test("Stop cancels preparation; refused Delete preserves input until explicit Stop", async () => {
  for (const operation of ["interrupt", "delete"]) {
    const f = fixture(),
      gate = deferred();
    f.storeGate(gate.promise);
    const send = f.run(
        "sendMessage",
        "local_code-stop",
        "new message",
        undefined,
        undefined,
        files,
      ),
      rejected = assert.rejects(send, /cancelled before dispatch/);
    await f.stored.promise;
    if (operation === "delete") {
      await assert.rejects(f.run(operation, "local_code-stop"), /running or saved/);
      assert.equal(f.calls.includes("deleteConversation"), false);
      await f.run("stop", "local_code-stop");
    } else await f.run(operation, "local_code-stop");
    gate.resolve();
    await rejected;
    assert.equal(f.calls.includes("send"), false);
    assert.equal(f.calls.includes("steerTurn"), false);
  }
});
test("idle preparation cancellation never calls an unbound engine interrupt", async () => {
  const f = fixture(),
    gate = deferred();
  f.storeGate(gate.promise);
  f.failInterrupt();
  const send = f.run(
      "sendMessage",
      "local_code-stop",
      "new message",
      undefined,
      undefined,
      files,
    ),
    rejected = assert.rejects(send, /cancelled before dispatch/);
  await f.stored.promise;
  await f.run("stop", "local_code-stop");
  gate.resolve();
  await rejected;
  assert.equal(f.calls.includes("send"), false);
  assert.equal(f.calls.includes("interrupt"), false);
});
test("Stop while queued attachments restore preserves held queue and prevents auto model launch", async () => {
  const f = fixture(true);
  await f.run(
    "sendMessage",
    "local_code-stop",
    "queued",
    undefined,
    undefined,
    files,
    "later",
    undefined,
    "queued-id",
  );
  const gate = deferred();
  f.restoreGate(gate.promise);
  f.c.turns[0].status = "completed";
  f.event({ type: "conversation", conversation: f.c });
  await new Promise((r) => setImmediate(r));
  assert.ok(
    f.calls.includes("officialRestoreCodeAttachments"),
    JSON.stringify(f.logs),
  );
  await f.restored.promise;
  await f.run("stop", "local_code-stop");
  gate.resolve();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.calls.includes("send"), false);
  const view = await f.run("getSession", "local_code-stop");
  assert.ok(view.sendsHeldAfterError.includes("queued-id"));
  f.event({ type: "conversation", conversation: f.c });
  await new Promise((r) => setImmediate(r));
  assert.equal(
    f.calls.includes("send"),
    false,
    "reconnect/update must not auto replay held input",
  );
});

test("refused Delete alone does not cancel the user's already-requested attachment send", async () => {
  const f = fixture(), gate = deferred();
  f.storeGate(gate.promise);
  const send = f.run("sendMessage", "local_code-stop", "original input", undefined, undefined, files);
  await f.stored.promise;
  await assert.rejects(f.run("delete", "local_code-stop"), /running or saved/);
  assert.equal(f.calls.includes("deleteConversation"), false);
  gate.resolve();
  await send;
  assert.equal(f.calls.filter(name => name === "send").length, 1);
});
