import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionLoops } from "../../electron/engine/session-loops";
import { registerSessionLoopHandlers } from "../../electron/ipc/session-loops";
import {
  loopCommand,
  loopNextRun,
  sessionLoopLifetime,
} from "../../shared/session-loops";
import { nextCron } from "../../shared/cron";
import {
  SessionLoopTask,
  loopCountdown,
} from "../../src/transcript/tools/SessionLoopTask";
import type { AppContext } from "../../electron/app/app-context";
import type {
  EngineExtension,
  DynamicToolCall,
} from "../../electron/engine/engine-extensions";
import { webMethodKind } from "../../shared/web-bridge-methods";
import { guardCall } from "../../runner/src/method-guard";
import { executeCodeSlashCommand } from "../../src/composer/code/code-slash-actions";
import { codeSlashCommands } from "../../src/composer/code/code-slash-commands";

const start = new Date(2026, 9, 16, 12, 0, 0).getTime();

test("/loop defaults to ten minutes and accepts minute, hour and day intervals", () => {
  assert.deepEqual(loopCommand("check the build"), {
    prompt: "check the build",
    cron: "*/10 * * * *",
    recurring: true,
  });
  assert.equal(loopCommand("5m check the build").cron, "*/5 * * * *");
  assert.equal(
    loopCommand("2h check\nthe deployment").prompt,
    "check\nthe deployment",
  );
  assert.equal(loopCommand("2h check").cron, "0 */2 * * *");
  assert.equal(loopCommand("1d check").cron, "0 0 */1 * *");
  assert.throws(() => loopCommand(""));
  assert.throws(() => loopCommand("0m check"));
  assert.throws(() => loopCommand("5m"));
  assert.throws(() => nextCron("*/5 * * * *", start));
  assert.equal(nextCron("*/5 * * * *", start, true), start + 300000);
  const actions: string[] = [];
  executeCodeSlashCommand(
    codeSlashCommands.find((command) => command.name === "loop")!,
    {
      platform: "darwin",
      navigate() {},
      settings() {},
      model() {},
      effort() {},
      permissions() {},
      plan() {},
      usage() {},
      compact() {},
      unavailable() {},
      loop: (args) => actions.push(args),
    },
    "5m check",
  );
  assert.deepEqual(actions, ["5m check"]);
});

test("loops run in their own idle session, coalesce missed occurrences, and stop by owner", async () => {
  const sent: string[] = [];
  let busy = false;
  const loops = new SessionLoops({
    available: () => (busy ? "busy" : "idle"),
    send: async (id, prompt) => {
      sent.push(`${id}:${prompt}`);
    },
  });
  const loop = loops.create("session", loopCommand("5m check"), start);
  await loops.tick(start + 299999);
  assert.deepEqual(sent, []);
  busy = true;
  await loops.tick(start + 300000);
  assert.deepEqual(sent, []);
  busy = false;
  await loops.tick(start + 950000);
  assert.deepEqual(sent, ["session:check"]);
  assert.equal(loops.list("session")[0].nextRunAt, start + 1200000);
  assert.equal(loops.stop("other", loop.id), false);
  assert.equal(loops.stop("session", loop.id), true);
  await loops.tick(start + 1200000);
  assert.equal(sent.length, 1);
  assert.deepEqual(loops.list("session"), []);
});

test("one-shot prompts run once; expired loops and missed one-shot prompts are removed", async () => {
  const sent: string[] = [];
  const loops = new SessionLoops({
    available: () => "idle",
    send: async (_id, prompt) => {
      sent.push(prompt);
    },
  });
  loops.create(
    "session",
    { ...loopCommand("5m once"), recurring: false },
    start,
  );
  await loops.tick(start + 300000);
  await loops.tick(start + 600000);
  assert.deepEqual(sent, ["once"]);
  assert.deepEqual(loops.list("session"), []);
  loops.create(
    "session",
    { ...loopCommand("5m missed"), recurring: false },
    start,
  );
  await loops.tick(start + 420000);
  assert.deepEqual(loops.list("session"), []);
  loops.create("session", loopCommand("5m expired"), start);
  await loops.tick(start + sessionLoopLifetime + 1);
  assert.deepEqual(loops.list("session"), []);
  assert.deepEqual(sent, ["once"]);
});

test("overlapping ticks cannot duplicate a prompt; failures back off without blocking another session", async () => {
  let finish: (() => void) | undefined;
  let sends = 0;
  const loops = new SessionLoops({
    available: () => "idle",
    send: async () => {
      sends++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  loops.create("session", loopCommand("5m check"), start);
  const tick = loops.tick(start + 300000);
  await loops.tick(start + 300000);
  assert.equal(sends, 1);
  finish!();
  await tick;
  const sent: string[] = [],
    errors: unknown[] = [];
  const failing = new SessionLoops({
    available: () => "idle",
    onError: (error) => errors.push(error),
    send: async (id) => {
      sent.push(id);
      if (id === "broken") throw Error("offline");
    },
  });
  failing.create("broken", loopCommand("1m check"), start);
  failing.create("ready", loopCommand("1m check"), start);
  await failing.tick(start + 60000);
  await failing.tick(start + 61000);
  assert.deepEqual(sent, ["broken", "ready"]);
  assert.equal(errors.length, 1);
  failing.clear();
  assert.deepEqual(failing.list("broken"), []);
});

test("desktop and runner handlers validate inputs, scope Cron tools, and clear on sign-out", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let activate: () => void = () => {},
    deactivate: () => void = () => {};
  let extension: EngineExtension | undefined;
  let removed = false;
  const engine = {
    peerExtensions: [] as EngineExtension[],
    extensions: {
      add(value: EngineExtension) {
        extension = value;
        return () => {
          removed = true;
        };
      },
    },
  };
  const context = {
    store: {
      conversation(id: string) {
        if (!["session", "other", "chat"].includes(id)) throw Error("unknown");
        return { id, mode: id === "chat" ? "chat" : "code", turns: [] };
      },
    },
    engine,
    services: {},
    onAccountActivated(callback: () => void) {
      activate = callback;
    },
    onAccountDeactivating(callback: () => void) {
      deactivate = callback;
    },
  } as unknown as AppContext;
  registerSessionLoopHandlers(
    (name, handler) => handlers.set(name, handler),
    context,
  );
  activate();
  try {
    const created = handlers.get("createSessionLoop")!(
      "session",
      loopCommand("5m build"),
    );
    assert.equal(handlers.get("listSessionLoops")!("session").length, 1);
    assert.equal(handlers.get("stopSessionLoop")!("other", created.id), false);
    assert.throws(() =>
      handlers.get("createSessionLoop")!("session", {
        cron: "bad",
        prompt: "build",
      }),
    );
    assert.throws(() =>
      handlers.get("createSessionLoop")!("session", {
        cron: "* * * * *",
        prompt: " ",
      }),
    );
    assert.throws(() => handlers.get("listSessionLoops")!("chat"));
    assert.equal(engine.peerExtensions[0], extension);
    const tools = extension!.dynamicTools!({ mode: "code" } as any)!;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["CronCreate", "CronList", "CronDelete"],
    );
    const call = {
      conversation: { id: "session" },
      tool: "CronCreate",
      arguments: { cron: "0 9 * * *", prompt: "once", recurring: false },
    } as DynamicToolCall;
    const result = await extension!.handleDynamicTool!(call);
    assert.equal(result?.success, true);
    const once = JSON.parse((result!.contentItems[0] as { text: string }).text);
    assert.equal(once.recurring, false);
    assert.equal(handlers.get("listSessionLoops")!("session").length, 2);
    const stop = await extension!.handleDynamicTool!({
      ...call,
      tool: "CronDelete",
      arguments: { id: once.id },
    });
    assert.equal(stop?.success, true);
    assert.equal(handlers.get("listSessionLoops")!("session").length, 1);
    for (const method of [
      "listSessionLoops",
      "createSessionLoop",
      "stopSessionLoop",
    ]) {
      assert.equal(webMethodKind(method), "remote-runner");
      assert.doesNotThrow(() => guardCall(method, ["session"]));
    }
  } finally {
    deactivate();
  }
  assert.ok(removed);
  assert.deepEqual(engine.peerExtensions, []);
  assert.deepEqual(handlers.get("listSessionLoops")!("session"), []);
});

test("the host timer sends the due prompt using its session model and noninteractive engine path", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval", "Date"], now: start });
  const handlers = new Map<string, (...args: any[]) => any>();
  let activate: () => void = () => {},
    deactivate: () => void = () => {};
  const sent: unknown[][] = [],
    trusts: unknown[] = [];
  const conversation = {
    id: "session",
    mode: "code",
    providerId: "provider",
    model: "model",
    cwd: "/project",
    turns: [] as { status: string }[],
  };
  const engine = {
    peerExtensions: [],
    extensions: { add: () => () => {} },
    async send(...args: unknown[]) {
      sent.push(args);
      conversation.turns.push({ status: "inProgress" });
      return conversation;
    },
  };
  const ctx = {
    store: { conversation: () => conversation },
    engine,
    services: {
      workspaceTrust: { assert: (value: unknown) => trusts.push(value) },
    },
    onAccountActivated(callback: () => void) {
      activate = callback;
    },
    onAccountDeactivating(callback: () => void) {
      deactivate = callback;
    },
  } as unknown as AppContext;
  registerSessionLoopHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx,
  );
  activate();
  try {
    const loop = handlers.get("createSessionLoop")!(
      "session",
      loopCommand("1m build"),
    );
    context.mock.timers.tick(60000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.deepEqual(sent, [
      [
        {
          conversationId: "session",
          text: "build",
          attachments: [],
          mode: "code",
          providerId: "provider",
          model: "model",
        },
        undefined,
        false,
        { interactive: false },
      ],
    ]);
    assert.equal(trusts.length, 1);
    context.mock.timers.tick(60000);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(sent.length, 1);
    assert.equal(handlers.get("stopSessionLoop")!("session", loop.id), true);
    conversation.turns[0].status = "completed";
    context.mock.timers.tick(60000);
    assert.equal(sent.length, 1);
  } finally {
    deactivate();
  }
});

test("loop rows match official Loop/Once, countdown, expiry and stop-request copy", () => {
  const loop = new SessionLoops({
    available: () => "idle",
    send: async () => {},
  }).create("session", loopCommand("5m check"), start);
  const render = (recurring: boolean, stopping = false) =>
    renderToStaticMarkup(
      createElement(SessionLoopTask, {
        loop: { ...loop, recurring },
        now: start,
        stopping,
        onStop() {},
      }),
    );
  const html = render(true);
  assert.match(html, /Loop: check/);
  assert.match(html, /Stop this loop/);
  assert.match(html, /Next <span class="session-loop-value">5m/);
  assert.match(html, /Ends <span class="session-loop-value">30d<\/span>/);
  assert.equal(loopNextRun(loop, start + 300000), start + 600000);
  const once = render(false);
  assert.match(once, /Once: check/);
  assert.match(once, /Stop this scheduled prompt/);
  assert.doesNotMatch(once, /Ends/);
  const stopping = render(true, true);
  assert.match(stopping, /Stop requested…/);
  assert.match(stopping, /Stop requested. Claudex will cancel it./);
  assert.match(stopping, /role="status"/);
  assert.equal(loopCountdown(0), "now");
  assert.equal(loopCountdown(241000), "4m 01s");
  assert.equal(loopCountdown(3600000), "1h");
});
