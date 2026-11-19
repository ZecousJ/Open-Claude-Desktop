import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { TerminalSessions } from "../../electron/terminal/terminal-sessions";
import type { CodexRPC } from "../../electron/engine/rpc";
import type { AppEvent } from "../../shared/types";

class FakeRPC extends EventEmitter {
  calls: Array<{ method: string; params: any }> = [];
  rejectTerminate = false;
  private resolveExec?: (result: any) => void;
  call(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "command/exec/terminate" && this.rejectTerminate)
      return Promise.reject(Error("Terminate not confirmed"));
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

test("original terminals start at the requested size and release their slot on exit", async () => {
  const rpc = new FakeRPC(), events: AppEvent[] = [];
  const manager = new TerminalSessions(rpc as unknown as CodexRPC, event => events.push(event), "darwin");
  for (let attempt = 0; attempt < 13; attempt++) {
    const tab = manager.start("code", "/tmp", false, undefined, {
      size: { rows: 31, cols: 97 },
      discardOnExit: true,
    });
    assert.deepEqual(rpc.calls.at(-1)?.params.size, { rows: 31, cols: 97 });
    rpc.finish(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(manager.list("code"), []);
    assert.deepEqual(events.at(-1), { type: "terminal-exit", id: tab.id, conversationId: "code", exitCode: 0 });
  }
  manager.reset();
});

test("terminal snapshots report normalized dimensions with per-axis fallbacks", async () => {
  const rpc = new FakeRPC();
  const manager = new TerminalSessions(rpc as unknown as CodexRPC, () => {});
  const first = manager.start("code", "/tmp", false, undefined, {
    size: { rows: NaN, cols: 1001.8 },
  });
  assert.deepEqual(first.size, { rows: 24, cols: 1000 });
  assert.deepEqual(rpc.calls.at(-1)?.params.size, first.size);

  await manager.resize("code", first.id, 3.9, Infinity);
  rpc.output(first.id, "resize output");
  const [snapshot] = manager.list("code");
  assert.deepEqual(snapshot.size, { rows: 3, cols: 1000 });
  assert.equal(
    Buffer.from(snapshot.outputBase64, "base64").toString(),
    "resize output",
  );

  await manager.resize("code", first.id, -Infinity, 1);
  assert.deepEqual(manager.list("code")[0].size, { rows: 3, cols: 2 });
  assert.deepEqual(snapshot.size, { rows: 3, cols: 1000 });
  manager.reset();
});

test("terminal cleanup uses only the private startup process marker", async () => {
  const rpc = new FakeRPC(), events: AppEvent[] = [], cleanup: string[][] = [];
  const manager = new TerminalSessions(
    rpc as unknown as CodexRPC,
    event => events.push(event),
    "darwin",
    async argv => { cleanup.push(argv); },
  );
  const tab = manager.start("code", "/tmp", false);
  const marker = `\u001b]777;claudex-pty:${tab.id}:`;
  rpc.output(tab.id, "echo ready\r\n" + marker.slice(0, 12));
  const output = () => Buffer.from(manager.list("code")[0].outputBase64, "base64").toString();
  assert.equal(output(), "echo ready\r\n");
  rpc.output(tab.id, marker.slice(12) + "231");
  assert.equal(output(), "echo ready\r\n");
  rpc.output(tab.id, "23\u0007prompt");
  assert.equal(output(), "echo ready\r\nprompt");
  rpc.output(tab.id, marker + "29876\u0007");
  const closing = manager.close("code", tab.id);
  rpc.finish(0);
  await closing;
  assert.equal(cleanup.length, 1);
  assert.equal(cleanup[0].at(-1), "23123");
  assert.deepEqual(manager.list("code"), []);
  const detached = manager.start("code", "/tmp", false, undefined, { discardOnExit: true });
  rpc.output(detached.id, `\u001b]777;claudex-pty:${detached.id}:23124\u0007`);
  rpc.finish(0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleanup.length, 1, "an ordinary shell exit preserves intentionally detached jobs");
  await manager.reset();
});

test("a Linux terminal runs outside the sandbox, whose new session would end the shell at Ctrl+C", () => {
  const rpc = new FakeRPC(),
    manager = new TerminalSessions(
      rpc as unknown as CodexRPC,
      () => {},
      "linux",
    );
  manager.start("code", "/home/me/work", true, {
    command: ["/bin/bash", "-i"],
    title: "bash",
  });
  // Codex's Linux sandbox starts the command with bubblewrap --new-session:
  // the shell gets no controlling terminal, and Ctrl+C ends the helper and
  // the shell with it (an SSH host's terminal, 2026-10-30).
  assert.deepEqual(rpc.calls[0].params.sandboxPolicy, {
    type: "dangerFullAccess",
  });
  const mac = new FakeRPC(),
    local = new TerminalSessions(
      mac as unknown as CodexRPC,
      () => {},
      "darwin",
    );
  local.start("code", "/Users/me/work", true);
  assert.deepEqual(mac.calls[0].params.sandboxPolicy, {
    type: "readOnly",
    networkAccess: false,
  });
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
  const closing = manager.close("code", session.id);
  assert.equal(manager.list("code").length, 1);
  rpc.finish(0);
  await closing;
  assert.equal(rpc.calls.at(-1)?.method, "command/exec/terminate");
  assert.deepEqual(manager.list("code"), []);
  manager.reset();
});

test("a failed terminal close retains ownership and duplicate closes await actual exit", async () => {
  const rpc = new FakeRPC();
  const manager = new TerminalSessions(rpc as unknown as CodexRPC, () => {});
  const session = manager.start("code", "/tmp", true);
  rpc.rejectTerminate = true;
  await assert.rejects(
    manager.close("code", session.id),
    /Terminate not confirmed/,
  );
  assert.equal(manager.list("code")[0].id, session.id);
  rpc.rejectTerminate = false;
  const first = manager.close("code", session.id);
  const repeated = manager.close("code", session.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.list("code")[0].running, true);
  assert.equal(
    rpc.calls.filter((call) => call.method === "command/exec/terminate").length,
    2,
  );
  rpc.finish(0);
  await Promise.all([first, repeated]);
  assert.deepEqual(manager.list("code"), []);
  manager.reset();
});
