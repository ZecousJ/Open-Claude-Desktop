import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { Scheduler } from "../../electron/routines/scheduler";
import { EngineExtensions } from "../../electron/engine/engine-extensions";
import {
  computerUseExtension,
  computerUseServerFor,
  registerComputerUseExtension,
} from "../../electron/connectors/computer-use-extension";
import {
  projectAgentItems,
  withScreenshotRefs,
} from "../../electron/conversations/agent-transcript-item";
import { storageUsage } from "../../electron/workspace/storage-usage";
import {
  customConnectorEntry,
  parseMcpConfig,
} from "../../electron/connectors/mcp-config-file";
import type { ComputerUseService } from "../../electron/computer-use/service";
import {
  computerUseInstructions,
  screenshotRef,
} from "../../shared/computer-use";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation, Item } from "../../shared/types";

const SHOT = "0f8fad5b-d9cb-469f-a165-70867728950e";

/** A stand-in for the broker's service (electron/ipc/computer-use.ts). */
function fakeService(enabled = (_id: string) => true) {
  const marks: [string, boolean][] = [];
  const deleted: string[] = [];
  const service: ComputerUseService = {
    instructions: computerUseInstructions,
    enabledFor: enabled,
    mcpServer: (id) =>
      enabled(id)
        ? {
            name: "computer-use",
            command: "/path/to/Claudex",
            args: ["/resources/computer-use-mcp.cjs"],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              CLAUDEX_CU_SOCKET: "/run/cu.sock",
              CLAUDEX_CU_TOKEN: `token-${id}`,
              CLAUDEX_CU_CONVERSATION: id,
            },
            startupTimeoutSec: 10,
            toolTimeoutSec: 660,
          }
        : undefined,
    markUnattended: (id, unattended) => marks.push([id, unattended]),
    screenshotBytes: () => 0,
    deleteConversation: async (id) => {
      deleted.push(id);
    },
  };
  return { service, marks, deleted };
}

type Call = { method: string; params: any };
function setup(emit: (event: any) => void = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cu-engine-"));
  const store = new Store(root);
  const engine = new Engine(store, "unused", () => "", emit);
  engine.policy = () => openPolicy;
  const calls: Call[] = [];
  let threads = 0;
  engine.ensure = async () => {};
  engine.rpc = {
    async call(method: string, params: any) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${++threads}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    respond() {},
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const workspace = path.join(root, "work");
  return {
    root,
    store,
    engine,
    calls,
    workspace,
    send: (extra: Record<string, unknown> = {}) =>
      engine.send({
        text: "Tidy my desktop",
        mode: "cowork",
        cwd: workspace,
        attachments: [],
        providerId: "default",
        model: "m",
        ...extra,
      }),
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const screenshotItem = (extra: Partial<Item> = {}): Item => ({
  id: "call-1",
  type: "mcpToolCall",
  server: "computer-use",
  tool: "screenshot",
  status: "completed",
  arguments: { app: "Notes" },
  result: {
    content: [
      { type: "text", text: "Notes · screenshot · full" },
      { type: "image", data: "QUJD".repeat(1000), mimeType: "image/jpeg" },
      { type: "text", text: screenshotRef(SHOT) },
    ],
  },
  ...extra,
});

test("a computer-use screenshot is recorded as a reference, not as base64", () => {
  const item = screenshotItem();
  const trimmed = withScreenshotRefs(item);
  const content = (trimmed.result as any).content;
  assert.deepEqual(content[1], {
    type: "image",
    mimeType: "image/jpeg",
    uri: screenshotRef(SHOT),
  });
  assert.equal(content[2].text, screenshotRef(SHOT));
  assert.equal(content[0].text, "Notes · screenshot · full");
  // The original item is left alone.
  assert.equal(typeof (item.result as any).content[1].data, "string");
  // Other servers, and images without a saved screenshot, are untouched.
  const other = screenshotItem({ server: "someone-else" });
  assert.equal(withScreenshotRefs(other), other);
  const unsaved = screenshotItem({
    result: {
      content: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
    },
  });
  assert.equal(withScreenshotRefs(unsaved), unsaved);
  const forged = screenshotItem({
    result: {
      content: [
        { type: "image", data: "QUJD", mimeType: "image/png" },
        { type: "text", text: "claudex-screenshot://../../etc/passwd" },
      ],
    },
  });
  assert.equal(withScreenshotRefs(forged), forged);
  // A child agent's transcript is trimmed the same way.
  const [projected] = projectAgentItems([item]);
  assert.equal((projected.result as any).content[1].data, undefined);
  assert.equal((projected.result as any).content[1].uri, screenshotRef(SHOT));
});

test("a Code or Cowork thread gets the adapter, the guidance once per thread, and nothing else", async () => {
  const env = setup();
  try {
    const { service } = fakeService();
    env.engine.extensions.add(
      computerUseExtension({ service: () => service, unattended: () => false }),
    );
    const conversation = await env.send();
    const start = env.calls.find((call) => call.method === "thread/start")!;
    const config = start.params.config;
    assert.equal(
      config["mcp_servers.computer-use.command"],
      "/path/to/Claudex",
    );
    assert.deepEqual(config["mcp_servers.computer-use.args"], [
      "/resources/computer-use-mcp.cjs",
    ]);
    assert.deepEqual(config["mcp_servers.computer-use.env"], {
      ELECTRON_RUN_AS_NODE: "1",
      CLAUDEX_CU_SOCKET: "/run/cu.sock",
      CLAUDEX_CU_TOKEN: `token-${conversation.id}`,
      CLAUDEX_CU_CONVERSATION: conversation.id,
    });
    assert.equal(config["mcp_servers.computer-use.tool_timeout_sec"], 660);
    assert.equal(config["mcp_servers.computer-use.startup_timeout_sec"], 10);
    assert.equal(
      config["mcp_servers.computer-use.default_tools_approval_mode"],
      "approve",
    );
    const firstTurn = env.calls.find((call) => call.method === "turn/start")!;
    assert.deepEqual(firstTurn.params.additionalContext, {
      "computer-use.guidance": {
        value: computerUseInstructions,
        kind: "application",
      },
    });
    // The next message in the same thread doesn't repeat the guidance.
    env.store.conversation(conversation.id).turns[0].status = "completed";
    env.calls.length = 0;
    await env.send({ conversationId: conversation.id });
    const resume = env.calls.find((call) => call.method === "thread/resume");
    if (resume)
      assert.equal(
        resume.params.config["mcp_servers.computer-use.command"],
        "/path/to/Claudex",
      );
    const secondTurn = env.calls.find((call) => call.method === "turn/start")!;
    assert.equal(secondTurn.params.additionalContext, undefined);
  } finally {
    env.close();
  }
});

test("Chat, a conversation computer use is off for, and an SSH conversation get no adapter", async () => {
  const env = setup();
  try {
    let on = false;
    const { service } = fakeService(() => on);
    const deps = { service: () => service, unattended: () => false };
    env.engine.extensions.add(computerUseExtension(deps));
    await env.send({ mode: "chat" });
    await env.send({ mode: "code" });
    for (const call of env.calls.filter((c) => c.method === "thread/start"))
      assert.ok(
        !Object.keys(call.params.config).some((key) =>
          key.startsWith("mcp_servers.computer-use"),
        ),
      );
    for (const call of env.calls.filter((c) => c.method === "turn/start"))
      assert.ok(
        !Object.keys(call.params.additionalContext ?? {}).some((key) =>
          key.startsWith("computer-use"),
        ),
      );
    on = true;
    const remote = {
      conversation: {
        id: "ssh-1",
        mode: "code",
        environment: { kind: "ssh", hostId: "h" },
      } as Conversation,
      mode: "code" as const,
    };
    assert.equal(computerUseServerFor(remote, deps), undefined);
    const chat = {
      conversation: { id: "c", mode: "code" } as Conversation,
      mode: "chat" as const,
    };
    assert.equal(computerUseServerFor(chat, deps), undefined);
    // Signed out: no service, no adapter.
    assert.equal(
      computerUseServerFor(
        {
          conversation: { id: "c", mode: "code" } as Conversation,
          mode: "code",
        },
        { service: () => undefined, unattended: () => false },
      ),
      undefined,
    );
  } finally {
    env.close();
  }
});

test("a routine's run never gets computer use, and the broker is told it is unattended", async () => {
  let scheduler!: Scheduler;
  const env = setup((event) => {
    if (event.type === "conversation")
      scheduler.observeConversation(event.conversation);
  });
  const schedulerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-cu-scheduler-"),
  );
  try {
    const { service, marks } = fakeService();
    scheduler = new Scheduler(schedulerRoot, {
      isBusy: () => false,
      run: (task) =>
        env.engine.send({
          text: task.prompt,
          mode: task.mode,
          cwd: env.workspace,
          attachments: [],
          providerId: "default",
          model: "m",
        }),
    });
    const changes: [string, boolean][] = [];
    scheduler.onUnattendedChange((id, unattended) => {
      changes.push([id, unattended]);
      service.markUnattended(id, unattended);
    });
    env.engine.extensions.add(
      computerUseExtension({
        service: () => service,
        unattended: (conversation) =>
          scheduler.isUnattendedConversation(conversation),
      }),
    );
    const routine = scheduler.save({
      name: "Morning tidy",
      prompt: "Tidy my desktop",
      mode: "cowork",
      providerId: "default",
      model: "m",
      frequency: "daily",
      nextRunAt: Date.now() + 60 * 60_000,
      enabled: true,
    });
    const ran = await scheduler.runNow(routine.id);
    const id = ran.conversationId!;
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.ok(
      !Object.keys(start.params.config).some((key) =>
        key.startsWith("mcp_servers.computer-use"),
      ),
    );
    const turn = env.calls.find((call) => call.method === "turn/start")!;
    assert.equal(turn.params.additionalContext, undefined);
    assert.ok(marks.some(([mark, on]) => mark === id && on));
    assert.ok(scheduler.isUnattended(id));
    assert.deepEqual(changes, [[id, true]]);
    // The run's turn ends: the conversation is attended again.
    const conversation = env.store.conversation(id);
    conversation.turns[0].status = "completed";
    scheduler.observeConversation(structuredClone(conversation));
    assert.equal(scheduler.isUnattended(id), false);
    assert.deepEqual(changes.at(-1), [id, false]);
    assert.deepEqual(marks.at(-1), [id, false]);
    // A message the person writes afterwards may use the computer.
    env.calls.length = 0;
    await env.send({ conversationId: id });
    const config = (
      env.calls.find((call) => call.method === "thread/resume") ??
      env.calls.find((call) => call.method === "thread/start")
    )?.params.config;
    if (config)
      assert.equal(
        config["mcp_servers.computer-use.command"],
        "/path/to/Claudex",
      );
  } finally {
    scheduler?.stop();
    env.close();
    fs.rmSync(schedulerRoot, { recursive: true, force: true });
  }
});

test("a conversation created while a routine is dispatched counts as the run's", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cu-dispatch-"));
  try {
    const scheduler = new Scheduler(root, {
      isBusy: () => false,
      run: async () => {
        throw new Error("unused");
      },
    });
    const internals = scheduler as any;
    const conversation = { id: "new", createdAt: 1000, turns: [] as any[] };
    assert.equal(scheduler.isUnattendedConversation(conversation), false);
    internals.dispatch = { prompt: "Tidy", since: 1000 };
    assert.equal(scheduler.isUnattendedConversation(conversation), true);
    assert.equal(
      scheduler.isUnattendedConversation({ ...conversation, createdAt: 999 }),
      false,
    );
    assert.equal(
      scheduler.isUnattendedConversation({
        ...conversation,
        turns: [{ prompt: "Tidy" }] as any[],
      }),
      true,
    );
    assert.equal(
      scheduler.isUnattendedConversation({
        ...conversation,
        turns: [{ prompt: "Something else" }] as any[],
      }),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the engine records computer-use results without screenshot data", async () => {
  const events: any[] = [];
  const env = setup((event) => events.push(event));
  try {
    const { service } = fakeService();
    env.engine.extensions.add(
      computerUseExtension({ service: () => service, unattended: () => false }),
    );
    const conversation = await env.send();
    (env.engine as any).notification({
      method: "item/completed",
      params: {
        threadId: conversation.threadId,
        turnId: conversation.turns[0].id,
        item: screenshotItem(),
      },
    });
    const stored = env.store
      .conversation(conversation.id)
      .turns[0].items.find((item) => item.id === "call-1")!;
    const content = (stored.result as any).content;
    assert.equal(content[1].data, undefined);
    assert.equal(content[1].uri, screenshotRef(SHOT));
    assert.ok(!JSON.stringify(stored).includes("QUJDQUJD"));
    // Other MCP servers' images are kept as Codex reported them.
    (env.engine as any).notification({
      method: "item/completed",
      params: {
        threadId: conversation.threadId,
        turnId: conversation.turns[0].id,
        item: screenshotItem({ id: "call-2", server: "figma" }),
      },
    });
    const other = env.store
      .conversation(conversation.id)
      .turns[0].items.find((item) => item.id === "call-2")!;
    assert.equal(typeof (other.result as any).content[1].data, "string");
  } finally {
    env.close();
  }
});

test("recordItem skips extensions an incognito chat doesn't use, and bad replacements", () => {
  const registry = new EngineExtensions();
  const seen: string[] = [];
  registry.add({
    id: "private",
    recordItem: (item) => {
      seen.push("private");
      return { ...item, text: "changed" };
    },
  });
  registry.add({
    id: "wrong",
    incognito: true,
    recordItem: (item) => ({ ...item, id: "other" }),
  });
  registry.add({
    id: "broken",
    incognito: true,
    recordItem: () => {
      throw new Error("boom");
    },
  });
  const item: Item = { id: "i", type: "agentMessage", text: "hi" };
  const original = console.error;
  console.error = () => {};
  try {
    const incognito = registry.recordItem(
      { incognito: true } as Conversation,
      item,
    );
    assert.equal(incognito, item);
    assert.deepEqual(seen, []);
    const normal = registry.recordItem({} as Conversation, item);
    assert.equal(normal.text, "changed");
    assert.equal(normal.id, "i");
  } finally {
    console.error = original;
  }
});

test("Settings → Storage counts computer-use screenshots with their conversation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cu-storage-"));
  try {
    const conversations = [
      { id: "c1", mode: "cowork", title: "Task", turns: [], updatedAt: 1 },
      { id: "c2", mode: "code", title: "Session", turns: [], updatedAt: 1 },
    ] as unknown as Conversation[];
    const usage = () =>
      storageUsage({ root, dataRoot: root, conversations, now: 1 });
    const before = await usage();
    assert.equal(before.cowork.filesBytes, 0);
    for (const [id, bytes] of [
      ["c1", 2048],
      ["c2", 1024],
    ] as const) {
      const folder = path.join(root, "computer-use", "screenshots", id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${SHOT}.jpg`), Buffer.alloc(bytes));
    }
    const after = await usage();
    // A Cowork task's screenshots are its files; a Code session's its history.
    assert.equal(after.cowork.filesBytes, 2048);
    assert.equal(after.code.historyBytes, 1024);
    assert.equal(after.cowork.historyBytes, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration follows the account: unattended runs reach the broker, deleted chats are cleaned up", async () => {
  const env = setup();
  const schedulerRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-cu-register-"),
  );
  try {
    const { service, marks, deleted } = fakeService();
    const scheduler = new Scheduler(schedulerRoot, {
      isBusy: () => false,
      run: async () => {
        throw new Error("unused");
      },
    });
    let activated!: () => void;
    let deactivating!: () => void;
    const ctx = {
      engine: env.engine,
      scheduler,
      services: { computerUse: service },
      store: env.store,
      onAccountActivated: (cb: () => void) => {
        activated = cb;
        return () => {};
      },
      onAccountDeactivating: (cb: () => void) => {
        deactivating = cb;
        return () => {};
      },
    };
    registerComputerUseExtension(ctx as any, { deletionCheckMs: 20 });
    assert.equal(env.engine.extensions.has("computer-use"), false);
    activated();
    assert.equal(env.engine.extensions.has("computer-use"), true);
    assert.ok(
      env.engine.extensions.reservedMcpServerNames().has("computer-use"),
    );
    // The scheduler's unattended changes reach the broker.
    (scheduler as any).unattendedChanged("run-1", true);
    assert.deepEqual(marks.at(-1), ["run-1", true]);
    const conversation = await env.send();
    env.store.conversation(conversation.id).turns[0].status = "completed";
    env.store.conversations = env.store.conversations.filter(
      (c) => c.id !== conversation.id,
    );
    for (let i = 0; i < 50 && !deleted.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(deleted, [conversation.id]);
    // Signing out removes the extension and stops following the scheduler.
    deactivating();
    assert.equal(env.engine.extensions.has("computer-use"), false);
    const count = marks.length;
    (scheduler as any).unattendedChanged("run-2", true);
    assert.equal(marks.length, count);
  } finally {
    env.close();
    fs.rmSync(schedulerRoot, { recursive: true, force: true });
  }
});

test("a configured MCP server can't take the built-in computer-use name", () => {
  for (const name of ["computer-use", "Computer-Use"])
    assert.throws(
      () =>
        parseMcpConfig(
          JSON.stringify({ mcpServers: { [name]: { command: "x" } } }),
        ),
      /reserved by Claudex/,
    );
  assert.throws(
    () =>
      customConnectorEntry(
        { name: "computer-use", url: "https://example.com/mcp" },
        {},
      ),
    /reserved by Claudex/,
  );
  assert.deepEqual(
    Object.keys(
      parseMcpConfig(
        JSON.stringify({ mcpServers: { "computer-tools": { command: "x" } } }),
      ),
    ),
    ["computer-tools"],
  );
});
