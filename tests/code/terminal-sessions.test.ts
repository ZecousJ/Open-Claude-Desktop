import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TerminalSessions } from "../../electron/terminal/terminal-sessions";
import type { CodexRPC } from "../../electron/engine/rpc";
import type { AppEvent } from "../../shared/types";

class FakeRPC extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  private resolveExec?: (result: any) => void;
  call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "command/exec")
      return new Promise<any>((resolve) => {
        this.resolveExec = resolve;
      });
    return Promise.resolve({});
  }
  finish(code: number) {
    this.resolveExec?.({ exitCode: code });
  }
  output(id: string, text: string) {
    this.emit("notification", {
      method: "command/exec/outputDelta",
      params: {
        processId: id,
        deltaBase64: Buffer.from(text).toString("base64"),
      },
    });
  }
}
test("interactive terminal streams per account, validates input and cleans up on reset", async () => {
  const rpc = new FakeRPC(),
    events: AppEvent[] = [];
  const manager = new TerminalSessions(
    rpc as unknown as CodexRPC,
    (event) => events.push(event),
    "darwin",
  );
  const first = manager.start("conversation-a", "/tmp", true);
  assert.equal(rpc.calls[0].params.tty, true);
  assert.deepEqual(rpc.calls[0].params.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
  assert.equal(rpc.calls[0].params.env.CLAUDEX_GATEWAY_TOKEN, null);
  rpc.output(first.id, "hello");
  assert.equal(
    Buffer.from(
      manager.list("conversation-a")[0].outputBase64,
      "base64",
    ).toString(),
    "hello",
  );
  assert.equal(manager.list("conversation-a")[0].sequence, 1);
  assert.deepEqual(manager.list("conversation-b"), []);
  await assert.rejects(
    manager.write(
      "conversation-b",
      first.id,
      Buffer.from("whoami\n").toString("base64"),
    ),
    /not found/,
  );
  await assert.rejects(
    manager.write("conversation-a", first.id, "not base64!"),
    /Invalid terminal input/,
  );
  await manager.write(
    "conversation-a",
    first.id,
    Buffer.from("pwd\n").toString("base64"),
  );
  await manager.resize("conversation-a", first.id, 32, 100);
  assert.equal(rpc.calls.at(-1)?.params.size.cols, 100);
  rpc.finish(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.list("conversation-a")[0].running, false);
  assert(
    events.some(
      (event) => event.type === "terminal-exit" && event.exitCode === 0,
    ),
  );
  manager.reset();
  assert.deepEqual(manager.list("conversation-a"), []);
  assert.equal(rpc.listenerCount("notification"), 0);
  assert(events.some((event) => event.type === "terminal-reset"));
});

test("running terminal is terminated on close, retaining only a bounded snapshot", async () => {
  const rpc = new FakeRPC(),
    manager = new TerminalSessions(
      rpc as unknown as CodexRPC,
      () => {},
      "win32",
    );
  const session = manager.start("code", "C:\\work", false);
  assert.deepEqual(rpc.calls[0].params.command, ["cmd.exe"]);
  // Codex refuses a streamed command inside the Windows sandbox, so this
  // computer's own Windows terminal runs outside it.
  assert.deepEqual(rpc.calls[0].params.sandboxPolicy, {
    type: "dangerFullAccess",
  });
  rpc.output(session.id, "a".repeat(1024 * 1024 + 128));
  assert.equal(
    Buffer.from(manager.list("code")[0].outputBase64, "base64").length,
    1024 * 1024,
  );
  await manager.close("code", session.id);
  assert.equal(rpc.calls.at(-1)?.method, "command/exec/terminate");
  assert.deepEqual(manager.list("code"), []);
  manager.reset();
});
