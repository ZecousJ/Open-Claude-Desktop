import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import {
  ToolDescriptionStore,
  applyToolDescriptions,
  maxStoredDescriptions,
  releaseToolDescriptions,
  toolDescriptionsFile,
  toolDescriptionsFor,
  toolDescriptionsOf,
} from "../../electron/engine/tool-description-store";
import {
  readWorkflowAgent,
  refreshWorkflowAgents,
  registerWorkflowHandlers,
} from "../../electron/ipc/workflow";
import { rebuildChildCommands } from "../../electron/ipc/workflow-rollout";
import type { Conversation } from "../../shared/types";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "claudex-descriptions-"));
}
function readFile(root: string) {
  return JSON.parse(
    fs.readFileSync(path.join(root, toolDescriptionsFile), "utf8"),
  );
}
function parent(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: id,
    mode: "code",
    providerId: "default",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: `thread-${id}`,
    turns: [
      {
        id: "turn",
        prompt: "p",
        attachments: [],
        createdAt: 1,
        status: "inProgress",
        items: [
          {
            id: "spawn",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            receiverThreadIds: [`child-${id}`],
            agentsStates: { [`child-${id}`]: { status: "running" } },
          },
        ],
      },
    ],
    ...extra,
  };
}

test("the first description of a call wins, cleaned, and bad ids are refused", () => {
  const root = tempRoot();
  try {
    const store = new ToolDescriptionStore(root);
    const options = { conversationId: "a" };
    assert.equal(
      store.put("child", "call_1", "  List‮ repository\nfiles ", options),
      true,
    );
    assert.equal(
      store.put("child", "call_1", "Something else", options),
      false,
    );
    assert.equal(store.get("child", "call_1"), "List repository files");
    assert.equal(store.put("child", "call_2", "​ \u0007", options), false);
    assert.equal(store.put("", "call_3", "Run tests", options), false);
    assert.equal(store.put("child", "x".repeat(501), "Run", options), false);
    assert.equal(store.put("child", "c", 42, options), false);
    assert.equal(store.put("child", "c", "Run", { conversationId: "" }), false);
    const long = store.put("child", "call_4", "é".repeat(400), options);
    assert.equal(long, true);
    assert.equal(Array.from(store.get("child", "call_4")!).length, 160);
    assert.deepEqual([...store.forThread("child").keys()].sort(), [
      "call_1",
      "call_4",
    ]);
    assert.equal(store.forThread("other").size, 0);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("at most 5000 descriptions are kept, least recently used dropped first", () => {
  const root = tempRoot();
  try {
    const store = new ToolDescriptionStore(root);
    for (let i = 0; i < maxStoredDescriptions; i++)
      store.put("t", `c${i}`, `Step ${i}`, { conversationId: "a" });
    // Reading c0 makes it recent, so c1 is the oldest now.
    assert.equal(store.get("t", "c0"), "Step 0");
    store.put("t", "new", "Newest step", { conversationId: "a" });
    assert.equal(store.size, maxStoredDescriptions);
    assert.equal(store.get("t", "c0"), "Step 0");
    assert.equal(store.get("t", "c1"), undefined);
    assert.equal(store.get("t", "new"), "Newest step");
    store.flush();
    assert.equal(readFile(root).entries.length, maxStoredDescriptions);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writes are debounced, atomic and private; incognito children stay in memory", async () => {
  const root = tempRoot();
  try {
    const store = new ToolDescriptionStore(root);
    store.put("t", "c1", "Run the unit tests", { conversationId: "a" });
    store.put("t", "c2", "Read secret notes", {
      conversationId: "incognito",
      persist: false,
    });
    const file = path.join(root, toolDescriptionsFile);
    assert.equal(fs.existsSync(file), false);
    await delay(450);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readFile(root), {
      version: 1,
      entries: [{ t: "t", c: "c1", d: "Run the unit tests", p: "a" }],
    });
    assert.equal(store.get("t", "c2"), "Read secret notes");
    const again = new ToolDescriptionStore(root);
    assert.equal(again.get("t", "c1"), "Run the unit tests");
    assert.equal(again.get("t", "c2"), undefined);
    store.close();
    again.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a damaged file is an empty store; bad entries are skipped and cleaned", () => {
  const root = tempRoot();
  try {
    const file = path.join(root, toolDescriptionsFile);
    fs.writeFileSync(file, "{not json");
    const broken = new ToolDescriptionStore(root);
    assert.equal(broken.size, 0);
    broken.put("t", "c", "List files", { conversationId: "a" });
    broken.flush();
    assert.equal(readFile(root).entries.length, 1);
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          null,
          { t: "t", c: "ok", d: "Show⁦ changes", p: "a" },
          { t: "t", c: "empty", d: "​", p: "a" },
          { t: 5, c: "bad", d: "x", p: "a" },
          { t: "t", c: "noparent", d: "x" },
        ],
      }),
    );
    const cleaned = new ToolDescriptionStore(root);
    assert.equal(cleaned.size, 1);
    assert.equal(cleaned.get("t", "ok"), "Show changes");
    fs.writeFileSync(file, JSON.stringify({ entries: "nope" }));
    assert.equal(new ToolDescriptionStore(root).size, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("entries of deleted conversations and dropped threads go away", () => {
  const root = tempRoot();
  try {
    let live = ["a", "b"];
    const store = new ToolDescriptionStore(root, () => live);
    store.put("ta", "c1", "List files", { conversationId: "a" });
    store.put("tb", "c1", "Run tests", { conversationId: "b" });
    store.put("tb2", "c1", "Build app", { conversationId: "b" });
    store.flush();
    live = ["a"];
    store.prune();
    assert.equal(store.get("tb", "c1"), undefined);
    assert.equal(store.get("ta", "c1"), "List files");
    store.put("tb", "c1", "Run tests", { conversationId: "b" });
    store.dropConversations(["b"]);
    assert.equal(store.get("tb", "c1"), undefined);
    store.dropThreads(["ta"]);
    assert.equal(store.size, 0);
    store.flush();
    assert.deepEqual(readFile(root).entries, []);
    // A file left from before the conversation was deleted is pruned on load.
    fs.writeFileSync(
      path.join(root, toolDescriptionsFile),
      JSON.stringify({
        version: 1,
        entries: [
          { t: "ta", c: "c1", d: "List files", p: "a" },
          { t: "tz", c: "c1", d: "Gone", p: "deleted" },
        ],
      }),
    );
    const loaded = new ToolDescriptionStore(root, () => ["a"]);
    assert.equal(loaded.size, 1);
    loaded.close();
    assert.equal(readFile(root).entries.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stored descriptions go onto a child thread's command items, never replacing one", () => {
  const root = tempRoot();
  try {
    const store = new ToolDescriptionStore(root);
    store.put("child", "call_1", "List repository files", {
      conversationId: "a",
    });
    store.put("child", "call_2", "Read README.md", { conversationId: "a" });
    store.put("child", "msg", "Not a command", { conversationId: "a" });
    const thread: any = {
      id: "child",
      turns: [
        {
          items: [
            { id: "call_1", type: "commandExecution", command: "ls" },
            {
              id: "call_2",
              type: "commandExecution",
              description: "Kept as it is",
            },
            { id: "msg", type: "agentMessage", text: "hi" },
            null,
          ],
        },
        { items: "broken" },
      ],
    };
    assert.equal(applyToolDescriptions(thread, store), 1);
    assert.equal(
      thread.turns[0].items[0]!.description,
      "List repository files",
    );
    assert.equal(thread.turns[0].items[1]!.description, "Kept as it is");
    assert.equal((thread.turns[0].items[2] as any).description, undefined);
    assert.equal(applyToolDescriptions({ turns: [] }, store), 0);
    assert.equal(applyToolDescriptions(thread, undefined), 0);
    store.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function engineSetup(conversations: Conversation[]) {
  const root = tempRoot();
  const store = new Store(root);
  store.conversations = conversations;
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const internals = engine as any;
  for (const c of conversations) internals.routes.set(c.threadId, c.id);
  return {
    root,
    store,
    engine,
    internals,
    close() {
      releaseToolDescriptions(engine);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a child agent's descriptions reach the store through the engine's gateway signals", () => {
  const a = parent("a");
  const secret = parent("s", { mode: "chat", incognito: true });
  const env = engineSetup([a, secret]);
  try {
    const store = toolDescriptionsFor(
      env.engine,
      env.store.root,
      () => env.store.conversations,
    );
    assert.equal(
      toolDescriptionsFor(env.engine, env.store.root, () => []),
      store,
    );
    assert.equal(toolDescriptionsOf(env.engine), store);
    env.internals.signals.toolDescription({
      threadId: "child-a",
      callId: "call_1",
      description: "Check greet against README",
    });
    // The conversation's own command goes on its item, not in the store.
    env.internals.signals.toolDescription({
      threadId: "thread-a",
      callId: "call_own",
      description: "List files",
    });
    env.internals.signals.toolDescription({
      threadId: "child-s",
      callId: "call_2",
      description: "Read private notes",
    });
    env.internals.signals.toolDescription({
      threadId: "stranger",
      callId: "call_3",
      description: "Unknown",
    });
    assert.equal(store.get("child-a", "call_1"), "Check greet against README");
    assert.equal(store.get("thread-a", "call_own"), undefined);
    assert.equal(store.get("child-s", "call_2"), "Read private notes");
    assert.equal(store.size, 2);
    store.flush();
    assert.deepEqual(
      readFile(env.root).entries.map((entry: any) => entry.p),
      ["a"],
    );
    releaseToolDescriptions(env.engine);
    assert.equal(toolDescriptionsOf(env.engine), undefined);
    assert.equal(
      env.engine.extensions.list().some((e) => e.id === "tool-descriptions"),
      false,
    );
    env.internals.signals.toolDescription({
      threadId: "child-a",
      callId: "call_9",
      description: "After sign-out",
    });
    assert.equal(store.get("child-a", "call_9"), undefined);
  } finally {
    env.close();
  }
});

test("the Workflow panel shows child command descriptions from the store", async () => {
  const a = parent("a");
  const env = engineSetup([a]);
  try {
    const descriptions = toolDescriptionsFor(
      env.engine,
      env.store.root,
      () => env.store.conversations,
    );
    env.internals.signals.toolDescription({
      threadId: "child-a",
      callId: "call_1",
      description: "Run the unit tests",
    });
    const thread = () => ({
      id: "child-a",
      status: { type: "active" },
      createdAt: 10,
      updatedAt: 12,
      turns: [
        {
          id: "t",
          status: "inProgress",
          items: [
            {
              id: "call_1",
              type: "commandExecution",
              command: "npm test",
              status: "inProgress",
            },
          ],
        },
      ],
    });
    (env.engine as any).state = { state: "ready" };
    env.engine.rpc = {
      call: async (method: string) =>
        method === "thread/read" ? { thread: thread() } : {},
    } as any;
    const context = { store: env.store, engine: env.engine };
    const transcript = await readWorkflowAgent(context, "a", "child-a");
    assert.equal(transcript.items[0].description, "Run the unit tests");
    const refreshed = await refreshWorkflowAgents(context, "a");
    assert.equal(
      refreshed.turns[0].items[0].agentCurrentAction?.["child-a"],
      "Run the unit tests",
    );
    descriptions.dropThreads(["child-a"]);
    const plain = await readWorkflowAgent(context, "a", "child-a");
    assert.equal(plain.items[0].description, undefined);
  } finally {
    env.close();
  }
});

test("registering the workflow calls follows the account's lifecycle", async () => {
  const env = engineSetup([parent("a")]);
  try {
    // The handlers hook in twice (descriptions and the Workflow tool).
    const activated: ((account: any) => void)[] = [];
    const deactivating: (() => void | Promise<void>)[] = [];
    const activate = () => activated.forEach((cb) => cb({}));
    const deactivate = async () => {
      for (const cb of deactivating) await cb();
    };
    const names: string[] = [];
    registerWorkflowHandlers((name) => names.push(name), {
      store: env.store,
      engine: env.engine,
      onAccountActivated(cb) {
        activated.push(cb);
        return () => {};
      },
      onAccountDeactivating(cb) {
        deactivating.push(cb);
        return () => {};
      },
    });
    assert.ok(names.includes("readWorkflowAgent"));
    assert.equal(toolDescriptionsOf(env.engine), undefined);
    activate();
    const store = toolDescriptionsOf(env.engine);
    assert.ok(store);
    assert.ok(env.engine.extensions.has("workflows"));
    activate();
    assert.equal(toolDescriptionsOf(env.engine), store);
    env.internals.signals.toolDescription({
      threadId: "child-a",
      callId: "call_1",
      description: "List repository files",
    });
    await deactivate();
    assert.equal(toolDescriptionsOf(env.engine), undefined);
    assert.equal(env.engine.extensions.has("workflows"), false);
    assert.equal(readFile(env.root).entries[0].d, "List repository files");
  } finally {
    env.close();
  }
});

function rollout(root: string, lines: unknown[], name = "rollout-x.jsonl") {
  const dir = path.join(root, "sessions", "2026", "09", "26");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n{broken\n",
  );
  return file;
}
const started = (turn: string) => ({
  type: "event_msg",
  payload: { type: "task_started", turn_id: turn },
});
const said = (text: string) => ({
  type: "event_msg",
  payload: { type: "agent_message", message: text },
});
const call = (
  id: string,
  name: string,
  args: unknown,
  turn?: string,
): unknown => ({
  type: "response_item",
  payload: {
    type: "function_call",
    name,
    call_id: id,
    arguments: typeof args === "string" ? args : JSON.stringify(args),
    ...(turn
      ? { internal_chat_message_metadata_passthrough: { turn_id: turn } }
      : {}),
  },
});
const result = (id: string, output: unknown) => ({
  type: "response_item",
  payload: { type: "function_call_output", call_id: id, output },
});

test("a child's commands are rebuilt from its rollout, among its messages", async () => {
  const root = tempRoot();
  try {
    const file = rollout(root, [
      started("t1"),
      call("c1", "exec_command", {
        cmd: "ls",
        description: "List‮ repository files",
      }),
      result(
        "c1",
        "Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOriginal token count: 2\nOutput:\na.txt\n",
      ),
      said("Looked around."),
      call("c2", "shell_command", { command: "sh -c 'exit 7'" }),
      result("c2", "Exit code: 7\nWall time: 0.1 seconds\nOutput:\n"),
      call("x", "apply_patch", {}),
      said("Done."),
      started("t2"),
      call("c3", "shell", { command: ["sleep", "60"], description: "Wait" }),
      result("c3", "Process running with session ID 4"),
      call("c4", "exec_command", "{not json", "t2"),
    ]);
    const thread: any = {
      id: "child",
      path: file,
      turns: [
        {
          id: "t1",
          status: "completed",
          items: [
            { id: "u", type: "userMessage" },
            { id: "m1", type: "agentMessage", text: "Looked around." },
            { id: "m2", type: "agentMessage", text: "Done." },
          ],
        },
        {
          id: "t2",
          status: "inProgress",
          items: [{ id: "u2", type: "userMessage" }],
        },
      ],
    };
    assert.equal(await rebuildChildCommands(thread), 4);
    assert.deepEqual(
      thread.turns[0].items.map((item: any) => item.id),
      ["u", "c1", "m1", "c2", "m2"],
    );
    const [c1, c2] = [thread.turns[0].items[1], thread.turns[0].items[3]];
    assert.equal(c1.description, "List repository files");
    assert.equal(c1.command, "ls");
    assert.equal(c1.exitCode, 0);
    assert.equal(c1.aggregatedOutput, "a.txt\n");
    assert.equal(c1.lifecycleStatus, "completed");
    assert.equal(c2.description, undefined);
    assert.equal(c2.exitCode, 7);
    assert.equal(c2.status, "failed");
    assert.equal(c2.lifecycleStatus, "failed");
    const [, c3, c4] = thread.turns[1].items;
    assert.equal(c3.command, "sleep 60");
    assert.equal(c3.status, "inProgress");
    assert.equal(c3.lifecycleStatus, "inProgress");
    assert.equal(c4.command, "");
    assert.equal(c4.status, "inProgress");
    // Rebuilt once: commands now present, nothing is added twice.
    assert.equal(await rebuildChildCommands(thread), 0);
    // A running command the model described is the child's current action.
    const a = parent("a");
    const env = engineSetup([a]);
    try {
      (env.engine as any).state = { state: "ready" };
      env.engine.rpc = {
        call: async () => ({
          thread: {
            id: "child-a",
            path: rollout(path.join(env.root, "codex-home"), [
              started("t"),
              call("c", "exec_command", {
                cmd: "npm test",
                description: "Run the unit tests",
              }),
            ]),
            status: { type: "active" },
            turns: [{ id: "t", status: "inProgress", items: [] }],
          },
        }),
      } as any;
      const refreshed = await refreshWorkflowAgents(
        { store: env.store, engine: env.engine },
        "a",
      );
      const spawn = refreshed.turns[0].items[0];
      assert.equal(spawn.agentCurrentAction?.["child-a"], "Run the unit tests");
      assert.equal(spawn.agentToolUses?.["child-a"], 1);
    } finally {
      env.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only a rollout file of a Codex session is read, and only when small enough", async () => {
  const root = tempRoot();
  try {
    const lines = [started("t"), call("c", "exec_command", { cmd: "ls" })];
    const thread = (file: unknown, items: any[] = []) => ({
      id: "child",
      path: file,
      turns: [{ id: "t", status: "completed", items }],
    });
    const good = rollout(root, lines);
    assert.equal(await rebuildChildCommands(thread(good)), 1);
    const outside = path.join(root, "rollout-y.jsonl");
    fs.copyFileSync(good, outside);
    assert.equal(await rebuildChildCommands(thread(outside)), 0);
    const renamed = rollout(root, lines, "notes.jsonl");
    assert.equal(await rebuildChildCommands(thread(renamed)), 0);
    assert.equal(
      await rebuildChildCommands(thread(path.relative(process.cwd(), good))),
      0,
    );
    assert.equal(await rebuildChildCommands(thread(null)), 0);
    assert.equal(
      await rebuildChildCommands(
        thread(path.join(root, "sessions", "rollout-missing.jsonl")),
      ),
      0,
    );
    const big = rollout(root, lines, "rollout-big.jsonl");
    fs.appendFileSync(big, " ".repeat(16 * 1024 * 1024 + 1));
    assert.equal(await rebuildChildCommands(thread(big)), 0);
    // With the engine's Codex home, only its own session folders count,
    // links resolved.
    const home = path.join(root, "home");
    const own = rollout(home, lines);
    assert.equal(await rebuildChildCommands(thread(own), home), 1);
    assert.equal(await rebuildChildCommands(thread(good), home), 0);
    const other = path.join(root, "other-home");
    assert.equal(await rebuildChildCommands(thread(own), other), 0);
    const link = path.join(home, "sessions", "rollout-link.jsonl");
    fs.symlinkSync(outside, link);
    assert.equal(await rebuildChildCommands(thread(link), home), 0);
    assert.equal(
      await rebuildChildCommands(
        thread(path.join(home, "rollout-x.jsonl")),
        home,
      ),
      0,
    );
    // A changed rollout is parsed again; each read gets its own items.
    const first = thread(own);
    await rebuildChildCommands(first, home);
    first.turns[0].items[0].command = "changed";
    const second = thread(own);
    await rebuildChildCommands(second, home);
    assert.equal(second.turns[0].items[0].command, "ls");
    fs.writeFileSync(
      own,
      [started("t"), call("c", "exec_command", { cmd: "pwd" })]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    );
    fs.utimesSync(own, new Date(), new Date(Date.now() + 5000));
    const third = thread(own);
    await rebuildChildCommands(third, home);
    assert.equal(third.turns[0].items[0].command, "pwd");
    // Codex already reported commands: the rollout is not read.
    assert.equal(
      await rebuildChildCommands(
        thread(good, [{ id: "c", type: "commandExecution", command: "ls" }]),
      ),
      0,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
