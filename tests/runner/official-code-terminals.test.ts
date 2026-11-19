import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { CallFrame, Dispatcher } from "../../runner/src/dispatcher";
import {
  officialCodeTerminalPath,
  officialCodeTerminalInputMaxBytes,
  type OfficialCodeTerminalCommand,
} from "../../shared/official-code-terminal";
import {
  officialUiCapabilitiesPath,
  type OfficialUiReadRequest,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import type { AppEvent, Conversation } from "../../shared/types";
import { encodeWireValue } from "../../shared/web-wire";
import { memoryWebstore, useElectronShim } from "./runner-core-support.test";

class Pty extends EventEmitter {
  private processes = new Map<string, (exit: { exitCode: number }) => void>();
  private pid = 1000;
  readonly calls: { method: string; args: Record<string, unknown> }[] = [];

  async call(
    method: string,
    args: { processId?: string; deltaBase64?: string; tty?: boolean },
  ) {
    this.calls.push({ method, args });
    const { processId } = args;
    if (method === "command/exec" && args.tty && processId) {
      this.emit("notification", {
        method: "command/exec/outputDelta",
        params: {
          processId,
          deltaBase64: Buffer.from(
            `\u001b]777;claudex-pty:${processId}:${++this.pid}\u0007`,
          ).toString("base64"),
        },
      });
      return new Promise<{ exitCode: number }>((resolve) => {
        this.processes.set(processId, resolve);
      });
    }
    if (method === "command/exec/write") {
      this.emit("notification", {
        method: "command/exec/outputDelta",
        params: args,
      });
    } else if (method === "command/exec/terminate" && processId) {
      this.exit(processId, 143);
    }
    return {};
  }

  exit(processId: string, exitCode: number) {
    this.processes.get(processId)?.({ exitCode });
    this.processes.delete(processId);
  }
}

async function fixture(t: TestContext) {
  useElectronShim();
  const [
    { CloudStore },
    { officialUiRead },
    { cloudCodeSessionKey },
    { organizationUuid },
    { Dispatcher },
  ] = await Promise.all([
    import("../../runner/src/cloud-store"),
    import("../../runner/src/official-ui-read"),
    import("../../electron/official-ui/api/cloud-code-history"),
    import("../../electron/official-ui/api/context"),
    import("../../runner/src/dispatcher"),
  ]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "official-code-pty-"));
  const store = await CloudStore.open({
    root,
    userId: 1,
    log() {},
    transport: memoryWebstore(),
  });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const tabId = "test-tab-1";
  const user = { id: 1, accessToken: "fixture-token", tabId };
  const account = { id: "fixture-owner" };
  const spaceId = "terminal-space";
  const spaceRoot = (id: string) => path.join(root, "spaces", id);
  const cwd = path.join(
    spaceRoot(spaceId),
    "workspace",
    "code",
    "code-session",
  );
  fs.mkdirSync(cwd, { recursive: true });
  const session: Conversation = {
    id: "code",
    mode: "code",
    title: "Cloud Code",
    cwd,
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 1,
    environment: { kind: "space", spaceId },
    pinned: false,
    archived: false,
    turns: [],
  };
  const foreign: Conversation = {
    ...structuredClone(session),
    id: "foreign",
    sessionAuthors: {
      ownerAccountUuid: "different-account",
      viewerAccountUuid: account.id,
    },
  };
  const local: Conversation = {
    ...structuredClone(session),
    id: "local",
    environment: { kind: "local" },
  };
  const other: Conversation = {
    ...structuredClone(session),
    id: "other",
    environment: { kind: "space", spaceId: "other-space" },
  };
  store.conversations.push(session, foreign, local, other);
  await store.sync();
  const pty = new Pty();
  const engine = {
    environment: session.environment,
    rpc: pty,
    state: { state: "ready" },
  };
  const runtime: { sandboxDriver?: "bwrap" } = { sandboxDriver: "bwrap" };
  const events: AppEvent[] = [];
  const activation = {};
  const ctx = {
    runtime,
    userId: user.id,
    activeAccount: account,
    store,
    spaceRoot,
    selectedAttachments: new Map(),
    replyFeedback: { deleteConversation() {} },
    officialSessionIdentity: () => activation,
    setAccessToken() {},
    push(event: AppEvent) {
      events.push(event);
    },
    engineRunning: () => true,
    engineFor(id: string) {
      assert.equal(id, session.id);
      return engine;
    },
    signedOut: false,
    get accountRetiring() {
      return this.signedOut;
    },
    busy: () => true,
    log() {},
  };
  const dispatcher = {
    options: { officialUiRoot: "/fixture", officialUiActions: true },
    guard: { modes: ["chat", "code"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: () => 1,
    isCallCancelled: () => false,
    contexts: new Map([[user.id, ctx]]),
  } as unknown as Dispatcher;
  const call = (
    method: string,
    request: OfficialUiReadRequest,
    frameTabId = tabId,
  ) =>
    officialUiRead(dispatcher, {
      id: randomUUID(),
      method,
      user: { ...user, tabId: frameTabId },
      args: encodeWireValue([request]),
    } as CallFrame) as Promise<OfficialUiReadResponse>;
  const capability = await call("officialUiRead", {
    method: "GET",
    path: officialUiCapabilitiesPath,
  });
  assert.equal(capability.status, 200);
  const { activationLease } = JSON.parse(
    new TextDecoder().decode(capability.body),
  );
  const sessionPath = (row: Conversation) =>
    `/v1/code/sessions/session_${cloudCodeSessionKey(row, account.id)}`;
  const action = (
    method: "POST" | "DELETE",
    route: string,
    body: object,
    options?: {
      tab?: string;
      lease?: string;
      organization?: string;
    },
  ) =>
    call(
      "officialUiAction",
      {
        method,
        path: route,
        contentType: "application/json",
        body: new TextEncoder().encode(JSON.stringify(body)),
        capabilityLease: options?.lease ?? activationLease,
        codeOrganizationId:
          options?.organization ?? organizationUuid(account.id),
      },
      options?.tab,
    );
  const send = (
    command: OfficialCodeTerminalCommand,
    options?: {
      tab?: string;
      lease?: string;
      organization?: string;
      session?: Conversation;
    },
  ) =>
    action(
      "POST",
      officialCodeTerminalPath(
        sessionPath(options?.session ?? session)
          .split("/")
          .at(-1)!,
      ),
      command,
      options,
    );
  const open = (terminalId = randomUUID()) =>
    ({ type: "open", terminalId, rows: 32, cols: 118 }) as const;
  return {
    action,
    open,
    send,
    session,
    sessionPath,
    foreign,
    local,
    other,
    pty,
    cwd,
    runtime,
    events,
    tabId,
    closeBrowserTerminals: () => Dispatcher.prototype.closeBrowserTerminals.call(dispatcher),
    presence: (tabs: number, detachedTabId?: string) =>
      Dispatcher.prototype.presence.call(dispatcher, {
        t: "presence",
        userId: user.id,
        tabs,
        focused: false,
        detachedTabId,
      }),
    signOut: () =>
      Dispatcher.prototype.signedOut.call(dispatcher, {
        t: "user-signed-out",
        userId: user.id,
        reason: "revoked",
      }),
  };
}

test("official Cloud Code terminal streams the scoped space PTY and closes it on archive and delete", async (t) => {
  const f = await fixture(t);
  const open = f.open();
  const { terminalId } = open;
  const answer = await f.send(open);
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(answer.body)), {
    terminalId,
  });
  const [exec] = f.pty.calls;
  assert.equal(exec.method, "command/exec");
  assert.equal(exec.args.cwd, f.cwd);
  assert.ok(Array.isArray(exec.args.command));
  assert.deepEqual(exec.args.command.slice(-2), ["/bin/sh", "-i"]);
  assert.deepEqual(exec.args.size, { rows: 32, cols: 118 });
  assert.equal(exec.args.tty, true);
  assert.notEqual(exec.args.processId, terminalId);

  const write = { type: "write", terminalId, data: "你好\u0003" } as const;
  assert.equal((await f.send(write, { tab: "test-tab-2" })).status, 404);
  assert.equal((await f.send(write, { lease: randomUUID() })).status, 409);
  assert.equal(
    (
      await f.send({
        ...write,
        data: "界".repeat(officialCodeTerminalInputMaxBytes / 2),
      })
    ).status,
    413,
  );
  assert.equal(f.pty.calls.length, 1);
  assert.equal((await f.send(write)).status, 200);
  assert.deepEqual(f.events.at(-1), {
    type: "terminal-output",
    id: terminalId,
    conversationId: f.session.id,
    sequence: 1,
    deltaBase64: Buffer.from(write.data).toString("base64"),
  });
  assert.equal(
    (await f.send({ type: "resize", terminalId, rows: 40, cols: 100 })).status,
    200,
  );
  assert.deepEqual(f.pty.calls.at(-1), {
    method: "command/exec/resize",
    args: { processId: exec.args.processId, size: { rows: 40, cols: 100 } },
  });

  const route = f.sessionPath(f.session);
  assert.equal((await f.action("POST", `${route}/archive`, {})).status, 200);
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec/terminate");
  assert.ok(
    f.events.some(
      (event) => event.type === "terminal-exit" && event.id === terminalId,
    ),
  );
  assert.equal((await f.send(f.open())).status, 409);
  assert.equal((await f.action("POST", `${route}/unarchive`, {})).status, 200);
  const natural = f.open();
  assert.equal((await f.send(natural)).status, 200);
  f.pty.exit(String(f.pty.calls.at(-1)?.args.processId), 7);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(f.events.at(-1), {
    type: "terminal-exit",
    id: natural.terminalId,
    conversationId: f.session.id,
    exitCode: 7,
  });
  const closed = f.open();
  assert.equal((await f.send(closed)).status, 200);
  assert.equal(
    (await f.send({ type: "close", terminalId: closed.terminalId })).status,
    200,
  );
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec/terminate");
  assert.equal((await f.send(f.open())).status, 200);
  assert.equal((await f.action("DELETE", route, {})).status, 200);
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec/terminate");
  assert.equal((await f.send(f.open())).status, 404);

  assert.equal(f.pty.listenerCount("notification"), 0);
});

test("account retirement terminates the terminal even while a Code turn keeps the context alive", async (t) => {
  const f = await fixture(t);
  const open = f.open();
  assert.equal((await f.send(open)).status, 200);
  await f.signOut();
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec/terminate");
  assert.equal(f.pty.listenerCount("notification"), 0);
  assert.deepEqual(f.events, []);
});

test("Runner presence retires the terminal after the last browser tab disconnects", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(f.open())).status, 200);
  f.presence(1);
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec");
  f.presence(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec/terminate");
});

test("Runner presence retires only the disconnected tab's terminals", async (t) => {
  const f = await fixture(t);
  const otherTab = "test-tab-2";
  const first = f.open();
  const second = f.open();
  assert.equal((await f.send(first)).status, 200);
  assert.equal((await f.send(second, { tab: otherTab })).status, 200);
  const [firstProcess, secondProcess] = f.pty.calls.map(
    ({ args }) => args.processId,
  );

  f.presence(1, f.tabId);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    f.pty.calls
      .filter(({ method }) => method === "command/exec/terminate")
      .map(({ args }) => args.processId),
    [firstProcess],
  );
  assert.equal(
    (
      await f.send({
        type: "write",
        terminalId: first.terminalId,
        data: "retired",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.send(
        { type: "write", terminalId: second.terminalId, data: "still live" },
        { tab: otherTab },
      )
    ).status,
    200,
  );
  assert.equal(f.pty.calls.at(-1)?.args.processId, secondProcess);
  await f.closeBrowserTerminals();
  assert.equal(f.pty.calls.at(-1)?.method, "command/exec/terminate");
  assert.equal(f.pty.calls.at(-1)?.args.processId, secondProcess);
});

test("official Cloud Code terminal refuses missing ownership, workspace, tab or sandbox", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.send(f.open(), { session: f.foreign })).status, 404);
  assert.equal((await f.send(f.open(), { session: f.local })).status, 404);
  assert.equal((await f.send(f.open(), { session: f.other })).status, 404);
  assert.equal(
    (await f.send(f.open(), { organization: randomUUID() })).status,
    404,
  );
  assert.equal((await f.send(f.open(), { tab: "" })).status, 400);
  assert.equal((await f.send({ ...f.open(), rows: 0 })).status, 400);
  f.runtime.sandboxDriver = undefined;
  assert.equal((await f.send(f.open())).status, 501);
  assert.equal(f.pty.calls.length, 0);
});
