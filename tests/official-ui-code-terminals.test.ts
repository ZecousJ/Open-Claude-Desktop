import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { registerCodeTerminals } from "../electron/official-ui/native/code-terminals";

test("official terminal keys stay in their local session and translate input, output and account resets", async () => {
  const id = "2f3a06f5-a30a-46a0-a914-5021272f6c23";
  const key = `local_${id}:shell-1`;
  const handlers = new Map<string, (...args: any[]) => any>();
  const calls: any[] = [],
    events: any[] = [];
  let listener!: (event: any) => void;
  let identity = {};
  registerCodeTerminals({
    ctx: {
      account: () => ({ id: "a" }),
      sessionIdentity: () => identity,
      localLoadConversation: async (value: string) =>
        value === id ? { id, mode: "code", cwd: "/authorized" } : undefined,
      localCall: async (method: string, ...args: unknown[]) => {
        calls.push([method, ...args]);
        if (method === "terminalStart")
          return {
            id: "terminal",
            shell: "/bin/sh",
            cwd: "/authorized",
            title: "sh",
            size: { rows: 24, cols: 80 },
            outputBase64: Buffer.from("ready").toString("base64"),
          };
        if (method === "terminalBusy") return ["terminal"];
      },
      onEvent(fn: (event: any) => void) {
        listener = fn;
        return () => {};
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _name: string, event: unknown) {
      events.push(event);
    },
  } as never);
  const start = handlers.get("LocalSessions.startShellPty")!;
  assert.equal(
    (await start(`local_${id}`, 80, 24, "test", "/unselected")).ok,
    false,
  );
  assert.equal((await start("local_missing", 80, 24)).ok, false);
  assert.equal(calls.length, 0);
  const launched = await start(key, 80, 24);
  assert.equal(launched.fresh, true);
  assert.equal(launched.buffered, "ready");
  await handlers.get("LocalSessions.writeShellPty")!(key, "printf ok\n");
  assert.deepEqual(calls.at(-1), [
    "terminalWrite",
    id,
    "terminal",
    Buffer.from("printf ok\n").toString("base64"),
  ]);
  listener({
    type: "terminal-output",
    id: "terminal",
    conversationId: id,
    deltaBase64: Buffer.from("ok").toString("base64"),
  });
  assert.deepEqual(events, [
    { type: "shell_pty_data", sessionId: key, data: "ok" },
  ]);
  listener({
    type: "terminal-output",
    id: "terminal",
    conversationId: "other",
    deltaBase64: "bGVhaw==",
  });
  assert.equal(events.length, 1);
  assert.deepEqual(
    (await handlers.get("LocalSessions.getBusyShellPtyKeys")!()).busy,
    [key],
  );
  handlers.get("LocalSessions.setShellPtyTitle")!(key, "Verification shell");
  const beforeRead = calls.length;
  assert.deepEqual(await handlers.get("LocalSessions.getBusyShellPtyKeys")!(`local_${id}`, true), {
    live: [key], busy: [], unknown: [], probed: false,
    tabs: [{ ptyKey: key, tabId: "0", cwd: "/authorized", title: "Verification shell", openedBy: "user" }],
  });
  assert.equal(calls.length, beforeRead);
  assert.deepEqual((await handlers.get("LocalSessions.getBusyShellPtyKeys")!("local_other")).live, []);
  identity = {};
  listener({
    type: "terminal-output",
    id: "terminal",
    conversationId: id,
    deltaBase64: "bGVhaw==",
  });
  assert.equal(events.length, 1);
  assert.equal(handlers.get("LocalSessions.whenShellPtyReads")!(key), false);
});

test("a saved SSH Code terminal uses its conversation's folder and login shell", async () => {
  const id = "2f3a06f5-a30a-46a0-a914-5021272f6c23";
  const key = `local_${id}`;
  const cwd = "/remote/project";
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const started: unknown[][] = [];
  registerCodeTerminals({
    ctx: {
      localLoadConversation: async (value: string) =>
        value === id
          ? {
              id,
              mode: "code",
              cwd,
              environment: { kind: "ssh", hostId: "saved" },
            }
          : undefined,
      localCall: async (method: string, ...args: unknown[]) => {
        if (method === "terminalStart") {
          started.push(args);
          return {
            id: "remote-pty",
            shell: "/usr/local/bin/fish",
            size: { rows: 24, cols: 80 },
            outputBase64: "",
          };
        }
      },
      onEvent: () => () => {},
    },
    on(name: string, fn: (...args: unknown[]) => unknown) {
      handlers.set(name, fn);
    },
  } as never);
  const start = handlers.get("LocalSessions.startShellPty")!;
  assert.deepEqual(await start(key, 80, 24, "test", "/elsewhere"), {
    ok: false,
    error: "Open a saved Code session before starting its terminal.",
  });
  assert.deepEqual(started, []);
  assert.deepEqual(await start(key, 80, 24, "test", cwd), {
    ok: true,
    shell: "/usr/local/bin/fish",
    fresh: true,
    buffered: "",
    cols: 80,
    rows: 24,
  });
  assert.deepEqual(started, [
    [id, undefined, { size: { rows: 24, cols: 80 }, discardOnExit: true }],
  ]);
});

test("landing terminal keys and output are isolated per caller window", async () => {
  const handlers = new Map<string, (...a: any[]) => any>(),
    out: any[] = [],
    calls: any[] = [];
  let listener: any,
    counter = 0,
    exitedBeforeResize: string | undefined;
  const windows = [1, 2].map((id) =>
    Object.assign(new EventEmitter(), { id, isDestroyed: () => false }),
  );
  const host: any = {
    caller: windows[0],
    ctx: {
      account: () => ({ id: "account" }),
      localCall: async (method: string, ...args: any[]) => {
        calls.push([method, ...args]);
        if (method === "officialDraftTerminalStart") {
          counter++;
          const ownerId = "draft-" + counter, id = "term-" + counter;
          if (ownerId === exitedBeforeResize)
            listener({ type: "terminal-exit", conversationId: ownerId, id, exitCode: 0 });
          return {
            ownerId,
            terminal: {
              id,
              shell: "/bin/sh",
              size: { rows: 24, cols: 80 },
              outputBase64: "",
            },
          };
        }
        if (exitedBeforeResize && args[0] === exitedBeforeResize)
          throw Error("Conversation not found.");
      },
      onEvent(fn: any) {
        listener = fn;
        return () => {};
      },
    },
    on(name: string, fn: any) {
      handlers.set(name, fn);
    },
    emit() {
      throw Error("Draft output must be window scoped");
    },
    emitTo(window: any, _d: string, _e: string, event: any) {
      out.push({ window: window.id, event });
    },
  };
  registerCodeTerminals(host);
  const start = handlers.get("LocalSessions.startShellPty")!;
  const [a, b] = await Promise.all([
    start("landing", 80, 24),
    start("landing", 80, 24),
  ]);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(counter, 1);
  host.caller = windows[1];
  assert.equal((await start("landing", 80, 24)).ok, true);
  assert.equal(counter, 2);
  listener({
    type: "terminal-output",
    conversationId: "draft-1",
    id: "term-1",
    deltaBase64: Buffer.from("first only").toString("base64"),
  });
  assert.equal(out[0].window, 1);
  assert.equal(out[0].event.sessionId, "landing");
  await handlers.get("LocalSessions.writeShellPty")!("landing", "second");
  assert.deepEqual(calls.at(-1), [
    "terminalWrite",
    "draft-2",
    "term-2",
    Buffer.from("second").toString("base64"),
  ]);
  await handlers.get("LocalSessions.stopShellPty")!("landing");
  assert.equal(
    handlers.get("LocalSessions.whenShellPtyReads")!("landing"),
    false,
  );
  assert.equal(windows[1].listenerCount("closed"), 0);
  host.caller = windows[0];
  assert.equal(
    handlers.get("LocalSessions.whenShellPtyReads")!("landing"),
    true,
  );
  listener({
    type: "terminal-exit",
    conversationId: "draft-1",
    id: "term-1",
    exitCode: 0,
  });
  assert.deepEqual(out.at(-1), {
    window: 1,
    event: { type: "shell_pty_close", sessionId: "landing", code: 0, error: undefined },
  });
  assert.equal(windows[0].listenerCount("closed"), 0);

  exitedBeforeResize = "draft-3";
  await assert.rejects(start("landing", 80, 24), /Conversation not found/);
  assert.equal(handlers.get("LocalSessions.whenShellPtyReads")!("landing"), false);
  assert.equal(windows[0].listenerCount("closed"), 0);
  assert.equal((await start("landing", 80, 24)).ok, true);
  listener({ type: "terminal-reset" });
  assert.equal(windows[0].listenerCount("closed"), 0);
});
