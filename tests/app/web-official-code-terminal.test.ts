import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as nextTask } from "node:timers/promises";
import {
  officialCodeTerminalCommand,
  officialCodeTerminalInputMaxBytes,
  type OfficialCodeTerminalCommand,
} from "../../shared/official-code-terminal";
import type { OfficialUiReadRequest } from "../../shared/official-ui-web";
import { EventHub } from "../../shared/web-client/hub";
import { createOfficialCodeTerminals } from "../../src-web/official/code-terminal";

const key = "a".repeat(32);
const session = `session_${key}`;
const path = `/v1/code/sessions/${session}/terminal`;
const organization = "11111111-1111-4111-8111-111111111111";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(
  onOpen?: (
    command: Extract<OfficialCodeTerminalCommand, { type: "open" }>,
  ) => Promise<void>,
  onWrite?: () => Promise<void>,
) {
  const events = new EventHub();
  const calls: OfficialCodeTerminalCommand[] = [];
  const keepalive: OfficialCodeTerminalCommand[] = [];
  let current = true;
  const commandFrom = (request: OfficialUiReadRequest) => {
    assert.equal(request.method, "POST");
    assert.equal(request.path, path);
    assert.equal(request.codeOrganizationId, organization);
    assert.equal(request.capabilityLease, "captured-lease");
    return officialCodeTerminalCommand.parse(
      JSON.parse(new TextDecoder().decode(request.body)),
    );
  };
  const terminals = createOfficialCodeTerminals({
    current: () => current,
    activationCurrent: () => true,
    connected: () => true,
    lease: async () => "captured-lease",
    events: (listener) => events.subscribe(listener),
    action: async (request) => {
      const command = commandFrom(request);
      calls.push(command);
      if (command.type === "open") await onOpen?.(command);
      if (command.type === "write") await onWrite?.();
      return {
        status: 200,
        contentType: "application/json",
        body: new TextEncoder().encode(
          JSON.stringify(
            command.type === "open" ? { terminalId: command.terminalId } : {},
          ),
        ),
      };
    },
    releaseOnExit: (request) => {
      keepalive.push(commandFrom(request));
    },
  });
  const adapter = terminals.forSession(session, organization);
  assert.ok(adapter);
  return {
    terminals,
    adapter,
    calls,
    keepalive,
    retire() {
      current = false;
      terminals.dispose();
    },
    output(id: string, sequence: number, bytes: Buffer) {
      events.emit({
        type: "terminal-output",
        id,
        sequence,
        conversationId: "owned",
        deltaBase64: bytes.toString("base64"),
      });
    },
    exit(id: string, exitCode: number) {
      events.emit({
        type: "terminal-exit",
        id,
        conversationId: "owned",
        exitCode,
      });
    },
  };
}

test("the original shell contract preserves early output, paste order, and reopened tab identity", async () => {
  const firstOpen = deferred<void>();
  const opened = deferred<string>();
  const run = fixture(async ({ terminalId }) => {
    if (run.calls.length !== 1) return;
    opened.resolve(terminalId);
    await firstOpen.promise;
  });
  const seen: unknown[] = [];
  run.adapter.onShellPtyEvent((event) => seen.push(event));
  const start = run.adapter.startShellPty(session, 80, 24);
  const first = await opened.promise;
  const bytes = Buffer.from("hello 界");
  run.output(first, 1, bytes.subarray(0, -1));
  run.output(first, 1, bytes.subarray(0, -1));
  run.output(first, 2, bytes.subarray(-1));
  firstOpen.resolve();
  assert.deepEqual(await start, { ok: true, buffered: "hello 界" });
  assert.deepEqual(seen, []);

  const paste = "a".repeat(officialCodeTerminalInputMaxBytes - 1) + "界";
  run.adapter.writeShellPty(session, paste);
  run.adapter.resizeShellPty(session, 90, 35);
  run.adapter.writeShellPty(session, "\r");
  await nextTask(0);
  assert.deepEqual(run.calls.slice(1), [
    { type: "write", terminalId: first, data: paste.slice(0, -1) },
    { type: "write", terminalId: first, data: "界" },
    { type: "resize", terminalId: first, cols: 90, rows: 35 },
    { type: "write", terminalId: first, data: "\r" },
  ]);

  run.terminals.stop(`cse_${key}`, session);
  assert.deepEqual(await run.adapter.startShellPty(session, 80, 24), {
    ok: true,
  });
  const second = run.calls.at(-1)?.terminalId;
  assert.ok(second && second !== first);
  assert.deepEqual(run.calls.slice(-2), [
    { type: "close", terminalId: first },
    { type: "open", terminalId: second, cols: 80, rows: 24 },
  ]);
  run.output(first, 3, Buffer.from("old"));
  run.exit(first, 1);
  run.output(second, 1, Buffer.from("new"));
  run.exit(second, 7);
  assert.deepEqual(seen, [
    { type: "shell_pty_close", sessionId: session, reason: undefined },
    { type: "shell_pty_data", sessionId: session, data: "new" },
    { type: "shell_pty_close", sessionId: session, code: 7, reason: undefined },
  ]);
  run.retire();
});

test("document retirement releases an in-flight shell and ignores further input", async () => {
  const reply = deferred<void>();
  const opened = deferred<string>();
  const run = fixture(async ({ terminalId }) => {
    opened.resolve(terminalId);
    await reply.promise;
  });
  const start = run.adapter.startShellPty(session, 80, 24);
  const terminalId = await opened.promise;
  run.retire();
  run.adapter.writeShellPty(session, "ignored");
  reply.resolve();
  assert.equal((await start).ok, false);
  await nextTask(0);
  assert.deepEqual(run.calls, [
    { type: "open", terminalId, cols: 80, rows: 24 },
    { type: "close", terminalId },
  ]);
});

test("a shell that exits before its open reply still prints before closing", async () => {
  const run = fixture(async ({ terminalId }) => {
    run.output(terminalId, 1, Buffer.from("shell output"));
    run.exit(terminalId, 12);
  });
  const exit = deferred<number | undefined>();
  run.adapter.onShellPtyEvent((event) => {
    if (event.type === "shell_pty_close") exit.resolve(event.code);
  });
  assert.deepEqual(await run.adapter.startShellPty(session, 80, 24), {
    ok: true,
    buffered: "shell output",
  });
  assert.equal(await exit.promise, 12);
  assert.equal(run.calls.length, 1);
  run.retire();
});

test("page retirement sends a keepalive close while input is still in flight", async () => {
  const writing = deferred<void>();
  const written = deferred<void>();
  const run = fixture(undefined, async () => {
    writing.resolve();
    await written.promise;
  });
  assert.deepEqual(await run.adapter.startShellPty(session, 80, 24), {
    ok: true,
  });
  const { terminalId } = run.calls[0];
  run.adapter.writeShellPty(session, "echo");
  await writing.promise;
  run.retire();
  assert.deepEqual(run.keepalive, [{ type: "close", terminalId }]);
  written.resolve();
});
