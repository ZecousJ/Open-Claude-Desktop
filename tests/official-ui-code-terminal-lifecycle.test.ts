/** Native terminal adapter only: all terminal service calls are inert mocks. */
import test from "node:test";
import assert from "node:assert/strict";
import { registerCodeTerminals } from "../electron/official-ui/native/code-terminals";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  const id = "2f3a06f5-a30a-46a0-a914-5021272f6c23",
    key = `local_${id}:shell-1`;
  let identity = {},
    listener: (e: any) => void = () => {},
    startGate: Promise<void> | undefined,
    closeGate: Promise<void> | undefined,
    count = 0,
    buffer: Buffer = Buffer.alloc(0),
    resizeFails = false;
  const handlers = new Map<string, any>(),
    calls: any[] = [],
    events: any[] = [],
    terms: any[] = [];
  const host: any = {
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => identity,
      localLoadConversation: async () => ({ id, mode: "code", cwd: "/inert" }),
      onEvent(fn: any) {
        listener = fn;
        return () => {};
      },
      localCall: async (name: string, ...args: any[]) => {
        calls.push([name, ...args]);
        if (name === "terminalStart" || name === "officialDraftTerminalStart") {
          const draft = name === "officialDraftTerminalStart";
          const terminal = {
            id: `term-${++count}`,
            shell: "/inert-shell",
            size: (draft ? args[2] : args[2].size) ?? { rows: 24, cols: 80 },
            outputBase64: buffer.toString("base64"),
          };
          await startGate;
          terms.push(terminal);
          return draft ? { ownerId: id, terminal } : terminal;
        }
        if (name === "terminalResize") {
          if (resizeFails) throw Error("Resize failed");
          const term = terms.find((t) => t.id === args[1]);
          term.size = { rows: args[2], cols: args[3] };
        }
        if (name === "terminalList") return terms.map((term) => ({ ...term }));
        if (name === "terminalClose") {
          await closeGate;
          const index = terms.findIndex((t) => t.id === args[1]);
          if (index >= 0) terms.splice(index, 1);
        }
      },
    },
    on(name: string, fn: any) {
      handlers.set(name, fn);
      return this;
    },
    emit(_d: string, _n: string, event: any) {
      events.push(event);
    },
  };
  registerCodeTerminals(host);
  return {
    id,
    key,
    calls,
    events,
    run: (name: string, ...args: any[]) =>
      handlers.get(`LocalSessions.${name}`)(...args),
    event: (e: any) => listener(e),
    failResize() {
      resizeFails = true;
    },
    reactivate() {
      identity = {};
    },
    startGate(p: Promise<void>) {
      startGate = p;
    },
    closeGate(p: Promise<void>) {
      closeGate = p;
    },
    buffer(b: Buffer) {
      buffer = b;
    },
  };
}
test("session starts coalesce and stop waits for pending start without leaking a second PTY", async () => {
  const f = fixture(),
    gate = deferred();
  f.startGate(gate.promise);
  const a = f.run("startShellPty", f.key, 80, 24),
    b = f.run("startShellPty", f.key, 80, 24),
    stop = f.run("stopShellPty", f.key);
  assert.equal((await f.run("startShellPty", f.key, 80, 24)).ok, false);
  gate.resolve();
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  await stop;
  assert.equal(f.calls.filter((c) => c[0] === "terminalStart").length, 1);
  assert.equal(f.calls.filter((c) => c[0] === "terminalClose").length, 1);
  assert.equal(f.run("whenShellPtyReads", f.key), false);
});

test("resize is ignored before a PTY exists and after it closes", async () => {
  const f = fixture();
  const gate = deferred();
  f.startGate(gate.promise);
  const start = f.run("startShellPty", f.key, 80, 24);
  await f.run("resizeShellPty", f.key, 122, 37);
  await assert.rejects(
    async () => f.run("writeShellPty", f.key, "input"),
    /no longer connected/,
  );
  gate.resolve();
  const opened = await start;
  assert.deepEqual(
    { ok: opened.ok, cols: opened.cols, rows: opened.rows },
    { ok: true, cols: 80, rows: 24 },
  );
  await f.run("stopShellPty", f.key);
  await f.run("resizeShellPty", f.key, 94, 29);
});
test("late close after reactivation cannot remove new activation terminal; repeated close coalesces", async () => {
  const f = fixture();
  await f.run("startShellPty", f.key, 80, 24);
  const gate = deferred();
  f.closeGate(gate.promise);
  const old = f.run("stopShellPty", f.key),
    again = f.run("stopShellPty", f.key);
  const rejected = assert.rejects(old, /account changed/),
    rejectedAgain = assert.rejects(again, /account changed/);
  f.reactivate();
  assert.equal((await f.run("startShellPty", f.key, 80, 24)).ok, true);
  gate.resolve();
  await Promise.all([rejected, rejectedAgain]);
  assert.equal(f.run("whenShellPtyReads", f.key), true);
  assert.equal(f.calls.filter((c) => c[0] === "terminalClose").length, 1);
});
test("service reset during startup cannot resurrect a stale terminal mapping", async () => {
  const f = fixture(),
    gate = deferred();
  f.startGate(gate.promise);
  const start = f.run("startShellPty", f.key, 80, 24);
  await Promise.resolve();
  f.event({ type: "terminal-reset" });
  gate.resolve();
  assert.equal((await start).ok, false);
  assert.equal(f.run("whenShellPtyReads", f.key), false);
});

for (const kind of ["saved Code", "landing"]) {
  test(`${kind} reattach reports the buffered output's size before resizing the PTY`, async () => {
    const f = fixture();
    const key = kind === "landing" ? "landing" : f.key;
    f.buffer(Buffer.from("buffered output"));
    await f.run("startShellPty", key, 80, 24);
    await f.run("resizeShellPty", key, 122, 37);

    assert.deepEqual(await f.run("startShellPty", key, 94, 29), {
      ok: true,
      shell: "/inert-shell",
      buffered: "buffered output",
      cols: 122,
      rows: 37,
    });
    assert.deepEqual(f.calls.at(-1), ["terminalResize", f.id, "term-1", 29, 94]);

    const wide = await f.run("startShellPty", key, 600, 2);
    assert.equal(wide.ok, true);
    assert.deepEqual(
      { cols: wide.cols, rows: wide.rows },
      { cols: 94, rows: 29 },
    );
    assert.deepEqual(f.calls.at(-1), ["terminalResize", f.id, "term-1", 2, 600]);
  });
}

test("buffered and live UTF-8 frames preserve split Chinese and emoji bytes", async () => {
  const f = fixture(),
    bytes = Buffer.from("中文🙂");
  f.buffer(bytes.subarray(0, 2));
  const start = await f.run("startShellPty", f.key, 80, 24);
  assert.equal(start.buffered, "");
  for (const chunk of [
    bytes.subarray(2, 4),
    bytes.subarray(4, 8),
    bytes.subarray(8),
  ])
    f.event({
      type: "terminal-output",
      id: "term-1",
      conversationId: f.id,
      deltaBase64: chunk.toString("base64"),
    });
  assert.equal(f.events.map((e) => e.data).join(""), "中文🙂");
  const before = f.calls.length;
  await assert.rejects(
    Promise.resolve().then(() => f.run("resizeShellPty", f.key, "80", 24)),
    /dimensions/,
  );
  assert.equal(f.calls.length, before);
  await f.run("resizeShellPty", f.key, 120, 40);
  assert.deepEqual(f.calls.at(-1), ["terminalResize", f.id, "term-1", 40, 120]);
});

test("stop still closes a PTY if its pending initial resize fails", async () => {
  const f = fixture(),
    gate = deferred();
  f.startGate(gate.promise);
  f.failResize();
  const start = f.run("startShellPty", f.key, 80, 24),
    rejected = assert.rejects(start, /Resize failed/);
  const stop = f.run("stopShellPty", f.key);
  gate.resolve();
  await rejected;
  await stop;
  assert.equal(f.calls.filter((c) => c[0] === "terminalClose").length, 1);
  assert.equal(f.run("whenShellPtyReads", f.key), false);
});
