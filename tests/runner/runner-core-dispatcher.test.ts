/**
 * The dispatcher's allow-list, capacity, idle reclaim, cancels and drain
 * (runner/src/dispatcher.ts), with stand-in contexts.
 */
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { useElectronShim } from "./runner-core-support.test.ts";
import type { RunnerFrame } from "../../shared/web-runner-frames";
import {
  webAbsentMethods,
  webRemoteRunnerMethods,
} from "../../shared/web-bridge-methods";

useElectronShim();
const { Dispatcher, webRegisteredNames, callError } =
  await import("../../runner/src/dispatcher");
const { webCallScope } = await import("../../runner/src/electron-shim");

test("every remote-runner method has a handler; nothing else is served", () => {
  const registered = webRegisteredNames();
  const missing = webRemoteRunnerMethods.filter((m) => !registered.includes(m));
  assert.deepEqual(missing, [], "remote-runner methods no domain registers");
  const d = new Dispatcher(options());
  assert.deepEqual(d.methods, [...webRemoteRunnerMethods]);
  assert.deepEqual(d.missing, []);
  // Desktop-only handlers the domains register are left out.
  for (const name of [
    "chooseFolder",
    "terminalStart",
    "revealSkill",
    "uploadSkill",
  ])
    assert.ok(
      d.dropped.includes(name) && webAbsentMethods.includes(name),
      name,
    );
  assert.equal(d.methods.includes("previewDocument"), false);
});

interface FakeContext {
  userId: number;
  handlers: Map<string, (...args: any[]) => any>;
  lastActive: number;
  tabs: number;
  signedOut: boolean;
  closed: boolean;
  running: boolean;
  isBusy: boolean;
  token: string;
  stops: number;
  artifactPreviews: { document: () => undefined };
  setAccessToken(token: string): void;
  busy(): boolean;
  engineRunning(): boolean;
  stopEngine(): Promise<void>;
  close(): Promise<void>;
  focused(): void;
}

function fakeContext(userId: number): FakeContext {
  const ctx: FakeContext = {
    userId,
    handlers: new Map(),
    lastActive: 0,
    tabs: 1,
    signedOut: false,
    closed: false,
    running: false,
    isBusy: false,
    token: "",
    stops: 0,
    artifactPreviews: { document: () => undefined },
    setAccessToken(token) {
      ctx.token = token;
    },
    busy: () => ctx.isBusy,
    engineRunning: () => ctx.running,
    async stopEngine() {
      ctx.stops++;
      ctx.running = false;
    },
    async close() {
      ctx.closed = true;
    },
    focused() {},
  };
  ctx.handlers.set("snapshot", () => ({ user: userId }));
  ctx.handlers.set("send", async () => {
    ctx.running = true;
    return { id: "c" };
  });
  ctx.handlers.set("startPayment", async () => {
    const { shell } = await import("../../runner/src/electron-shim");
    await shell.openExternal("https://pay.example.com/x");
    return { ok: true, scope: webCallScope.getStore()?.userId };
  });
  return ctx;
}

let now = 1_000_000;
function options(extra: Record<string, unknown> = {}) {
  const frames: RunnerFrame[] = [];
  const contexts = new Map<number, FakeContext>();
  const opened: { userId: number; url: string; tabId?: string }[] = [];
  return {
    frames,
    contexts,
    opened,
    runtime: {
      serviceUrl: "http://127.0.0.1:1",
      stateDir: "/nonexistent",
      providerServiceScript: "/nonexistent",
      version: "0",
      codexBinary: () => "/bin/false",
    },
    link: {
      send: (frame: RunnerFrame) => (frames.push(frame), true),
      request: async () => ({}),
    },
    publish: () => {},
    openUrl: (userId: number, url: string, tabId?: string) =>
      opened.push({ userId, url, tabId }),
    openContext: async (_runtime: unknown, input: { userId: number }) => {
      const ctx = fakeContext(input.userId);
      contexts.set(input.userId, ctx);
      return ctx as any;
    },
    now: () => now,
    log: () => {},
    ...extra,
  };
}

const call = (
  userId: number,
  method: string,
  args: unknown[] = [],
  id = `${method}-${userId}-${Math.random()}`,
) => ({
  t: "call" as const,
  id,
  user: { id: userId, accessToken: `token-${userId}`, tabId: "tab-00000001" },
  method,
  args,
  deadlineMs: 1000,
});
const lastResult = (frames: RunnerFrame[]) =>
  frames.filter((f) => f.t === "result").at(-1) as Extract<
    RunnerFrame,
    { t: "result" }
  >;

test("calls run in the user's context with the newest token", async () => {
  const o = options();
  const d = new Dispatcher(o);
  await d.call(call(1, "snapshot"));
  assert.deepEqual(lastResult(o.frames).value, { user: 1 });
  assert.equal(o.contexts.get(1)!.token, "token-1");
  await d.call(call(2, "snapshot"));
  assert.equal(d.users, 2);
  // An unknown or local method never reaches a handler.
  await d.call(call(1, "chooseFolder"));
  assert.equal(
    lastResult(o.frames).error!.code,
    "CLAUDEX_WEB_METHOD_UNAVAILABLE",
  );
  await d.call(call(1, "toString"));
  assert.equal(lastResult(o.frames).ok, false);
});

test("a payment page opens in the calling user's tab", async () => {
  const o = options();
  const d = new Dispatcher(o);
  await d.call(call(4, "startPayment"));
  assert.deepEqual(lastResult(o.frames).value, { ok: true, scope: 4 });
  assert.deepEqual(o.opened, [
    { userId: 4, url: "https://pay.example.com/x", tabId: "tab-00000001" },
  ]);
});

test("a second engine waits for room: an idle one is stopped, a busy one refuses", async () => {
  const o = options({ maxEngines: 1 });
  const d = new Dispatcher(o);
  const send = [
    { text: "x", mode: "chat", attachments: [], providerId: "p", model: "m" },
  ];
  await d.call(call(1, "send", send));
  assert.equal(lastResult(o.frames).ok, true);
  const first = o.contexts.get(1)!;
  assert.equal(first.running, true);
  // User 1's engine is busy: user 2 cannot start one.
  first.isBusy = true;
  await d.call(call(2, "send", send));
  assert.equal(lastResult(o.frames).error!.code, "CLAUDEX_WEB_CAPACITY");
  // Idle now: it is stopped to make room.
  first.isBusy = false;
  await d.call(call(2, "send", send));
  assert.equal(lastResult(o.frames).ok, true);
  assert.equal(first.stops, 1);
  assert.equal(d.engines, 1);
});

test("too many users: the longest-idle one without tabs makes room", async () => {
  const o = options({ maxUsers: 2 });
  const d = new Dispatcher(o);
  await d.call(call(1, "snapshot"));
  await d.call(call(2, "snapshot"));
  o.contexts.get(1)!.tabs = 1;
  o.contexts.get(2)!.tabs = 1;
  await d.call(call(3, "snapshot"));
  assert.equal(lastResult(o.frames).error!.code, "CLAUDEX_WEB_CAPACITY");
  o.contexts.get(1)!.tabs = 0;
  await d.call(call(3, "snapshot"));
  assert.equal(lastResult(o.frames).ok, true);
  assert.equal(o.contexts.get(1)!.closed, true);
  assert.equal(d.users, 2);
});

test("idle reclaim stops engines at 10 minutes and contexts at 15", async () => {
  const o = options();
  const d = new Dispatcher(o);
  const send = [
    { text: "x", mode: "chat", attachments: [], providerId: "p", model: "m" },
  ];
  await d.call(call(1, "send", send));
  const ctx = o.contexts.get(1)!;
  ctx.tabs = 0;
  ctx.lastActive = now;
  now += 9 * 60_000;
  await d.sweep();
  assert.equal(ctx.running, true);
  now += 60_000;
  await d.sweep();
  assert.equal(ctx.running, false);
  // A running turn keeps the context.
  ctx.isBusy = true;
  now += 10 * 60_000;
  await d.sweep();
  assert.equal(ctx.closed, false);
  ctx.isBusy = false;
  await d.sweep();
  assert.equal(ctx.closed, true);
  assert.equal(d.users, 0);
});

test("presence keeps a context; sign-out closes it once no turn runs", async () => {
  const o = options();
  const d = new Dispatcher(o);
  await d.call(call(1, "snapshot"));
  const ctx = o.contexts.get(1)!;
  d.presence({ t: "presence", userId: 1, tabs: 2, focused: true });
  assert.equal(ctx.tabs, 2);
  ctx.isBusy = true;
  await d.signedOut({ t: "user-signed-out", userId: 1, reason: "revoked" });
  assert.equal(ctx.token, "");
  assert.equal(ctx.closed, false, "a running turn is not stopped");
  ctx.isBusy = false;
  await d.sweep();
  assert.equal(ctx.closed, true);
});

test("a cancelled call sends no result; drain refuses new users and ends", async () => {
  const o = options();
  const d = new Dispatcher(o);
  const frame = call(1, "snapshot", [], "cancel-me");
  d.cancel("cancel-me");
  await d.call(frame);
  assert.equal(o.frames.length, 0);
  let drained = false;
  d.drain(() => (drained = true));
  await d.call(call(9, "snapshot"));
  assert.equal(
    lastResult(o.frames).error!.code,
    "CLAUDEX_WEB_RUNNER_UNAVAILABLE",
  );
  await d.sweep();
  assert.equal(drained, true);
});

test("errors keep their message and CLAUDEX code only", () => {
  assert.deepEqual(
    callError(
      Object.assign(new Error("Balance too low."), {
        code: "CLAUDEX_USAGE_LIMIT",
        details: { a: 1 },
      }),
    ),
    {
      message: "Balance too low.",
      code: "CLAUDEX_USAGE_LIMIT",
      details: { a: 1 },
    },
  );
  assert.deepEqual(
    callError(Object.assign(new Error("x"), { code: "ENOENT" })),
    {
      message: "x",
    },
  );
  // A system error names the runner's files: only a plain message leaves.
  let system: unknown;
  try {
    fs.readFileSync("/nonexistent/claudex-runner/secret");
  } catch (error) {
    system = error;
  }
  assert.deepEqual(callError(system), {
    message: "Something went wrong. Try again.",
  });
  assert.deepEqual(callError(undefined), {
    message: "Something went wrong. Try again.",
  });
});

test("a due scheduled task wakes its user: a token from Go, a context, one tick", async () => {
  const asked: { op: string; userId: number }[] = [];
  const o = options({
    link: {
      send: () => true,
      request: async (op: string, userId: number) => {
        asked.push({ op, userId });
        return { accessToken: "tok-wake" };
      },
    },
  });
  const d = new Dispatcher(o as any);
  let ticks = 0;
  const original = o.openContext;
  o.openContext = async (runtime: unknown, input: { userId: number }) => {
    const ctx: any = await original(runtime, input);
    ctx.scheduler = { tick: async () => void ticks++ };
    return ctx;
  };
  await d.wakeUser(701);
  assert.deepEqual(asked, [{ op: "routine.token", userId: 701 }]);
  assert.equal(o.contexts.get(701)!.token, "tok-wake");
  assert.equal(ticks, 1);
  // The user's context is reused, not opened again.
  await d.wakeUser(701);
  assert.equal(o.contexts.size, 1);
  assert.equal(ticks, 2);
});

test("waking a user without a token from Go fails and opens nothing", async () => {
  const o = options({
    link: { send: () => true, request: async () => ({}) },
  });
  const d = new Dispatcher(o as any);
  await assert.rejects(() => d.wakeUser(702), /no token/);
  assert.equal(o.contexts.size, 0);
});
