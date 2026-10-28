/**
 * E0 engine seams: /compact and steering pass through to the Codex
 * app-server, the full ThreadTokenUsage reaches the window, and the model
 * catalog's context limits reach Codex. The Codex process is faked here;
 * scripts/smoke-engine-seams.ts runs the same paths against the real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { passthroughMethods } from "../../electron/engine/mcp-servers";
import { Store } from "../../electron/store/store";
import { registerComposerHandlers } from "../../electron/ipc/composer";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import { createMemoryExtension } from "../../electron/memory/inject";
import { LocalMemoryStore } from "../../electron/memory/local-store";
import { MemoryService } from "../../electron/memory/service";
import { openPolicy } from "../../shared/client-policy";
import { isSteeredMessage, threadTokenUsage } from "../../shared/agent-api";
import { beginReplyBranch, selectReplyVersion } from "../../shared/branches";
import type { AppContext } from "../../electron/app/app-context";
import type { Attachment, Conversation, Turn } from "../../shared/types";

type Call = { method: string; params: any };

function turn(id: string, status: Turn["status"] = "completed"): Turn {
  return {
    id,
    prompt: `prompt ${id}`,
    attachments: [],
    items: [],
    status,
    createdAt: 1,
  };
}

function setup(
  answer: (method: string, params: any) => any = () => ({}),
  turns: Turn[] = [turn("t1")],
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-e0-"));
  const store = new Store(root);
  store.settings.providers = [
    {
      id: "p",
      name: "Local",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      models: ["m", "big"],
    },
  ];
  store.settings.activeProviderId = "p";
  const c: Conversation = {
    id: "c",
    title: "Fixture",
    mode: "code",
    providerId: "p",
    model: "m",
    threadId: "thread",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
  };
  store.conversations.push(c);
  const calls: Call[] = [];
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  engine.rpc = {
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      return answer(method, params);
    },
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const internals = engine as any;
  internals.loaded.add("thread");
  internals.routes.set("thread", "c");
  const notify = (method: string, params: any) =>
    internals.notification({
      method,
      params: { threadId: "thread", ...params },
    });
  return {
    store,
    c,
    engine,
    calls,
    notify,
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("safeguard failures honor the host's Code setting for local and cloud sessions; off and limits pause", async () => {
  for (const [enabled, code, kind, scope, expected] of [
    [true, "content_policy_violation", "local", "local", "big"],
    [false, "content_policy_violation", "local", "local", undefined],
    [true, "usage_limit", "local", "local", undefined],
    [true, "content_policy_violation", "space", "local", undefined],
    [true, "content_policy_violation", "space", "cloud", "big"],
    [false, "content_policy_violation", "space", "cloud", undefined],
    [true, "content_policy_violation", "runtime", "cloud", "big"],
  ] as const) {
    const env = setup(() => ({}), [turn("t1", "inProgress")]);
    try {
      env.store.settings.switchModelsOnFlag = enabled;
      env.engine.codeSafeguardScope = scope;
      if (kind === "runtime")
        Object.defineProperty(env.engine, "environment", {
          value: { kind: "space", spaceId: "space" },
        });
      else if (kind === "space")
        env.c.environment = { kind: "space", spaceId: "space" };
      const sends: any[] = [];
      env.engine.send = async (input, retryTurnId, _editing, options) => {
        sends.push({ input, retryTurnId, options });
        return env.c;
      };
      env.notify("turn/completed", {
        turn: { id: "t1", status: "failed", error: { code, message: code } },
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sends[0]?.input.model, expected);
      if (expected) {
        assert.equal(sends.length, 1);
        assert.equal(sends[0].input.text, "prompt t1");
        assert.equal(sends[0].retryTurnId, "t1");
        assert.equal(sends[0].options.safeguardRetry, true);
        env.c.model = expected;
        env.notify("turn/completed", {
          turn: { id: "t1", status: "failed", error: { code, message: code } },
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(sends.length, 1);
      } else assert.equal(sends.length, 0);
    } finally {
      env.close();
    }
  }
});

test("a repository engine follows its account host's safeguard scope", () => {
  const env = setup();
  try {
    env.engine.codeSafeguardScope = "cloud";
    const peer = env.engine.createPeer({
      environment: { kind: "space", spaceId: "repo" },
    });
    assert.equal(peer.codeSafeguardScope, "cloud");
    env.engine.codeSafeguardScope = "local";
    assert.equal(peer.codeSafeguardScope, "local");
  } finally {
    env.close();
  }
});

const usage = {
  total: {
    totalTokens: 76,
    inputTokens: 60,
    cachedInputTokens: 0,
    outputTokens: 16,
    reasoningOutputTokens: 0,
  },
  last: {
    totalTokens: 5612,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  },
  modelContextWindow: 258400,
};

test("only compaction and steering pass through to the app-server", async () => {
  assert.deepEqual(passthroughMethods, [
    "thread/compact/start",
    "thread/shellCommand",
    "review/start",
    "turn/steer",
  ]);
  const env = setup();
  try {
    const forward = (env.engine as any).forward.bind(env.engine);
    for (const method of ["thread/delete", "turn/start", "command/exec"])
      assert.throws(() => forward(method, {}), /not available/);
    assert.equal(env.calls.length, 0);
  } finally {
    env.close();
  }
});

test("the full ThreadTokenUsage reaches the conversation and follows its branch", () => {
  const env = setup(() => ({}), [turn("t1", "inProgress")]);
  try {
    env.notify("thread/tokenUsage/updated", {
      turnId: "t1",
      tokenUsage: usage,
    });
    assert.deepEqual(env.c.tokenUsage, usage);
    // The older summary keeps its meaning (cumulative totals).
    assert.deepEqual(env.c.usage, usage.total);
    // A malformed report changes nothing.
    env.notify("thread/tokenUsage/updated", {
      turnId: "t1",
      tokenUsage: { total: usage.total },
    });
    assert.deepEqual(env.c.tokenUsage, usage);

    env.c.turns[0].status = "completed";
    beginReplyBranch(env.c, "t1", "fork", "branch");
    assert.equal(env.c.tokenUsage, undefined);
    env.c.turns.push({ ...turn("t2"), responseGroupId: "t1" });
    selectReplyVersion(env.c, "t2", "t1");
    assert.deepEqual(env.c.tokenUsage, usage);
  } finally {
    env.close();
  }
});

test("threadTokenUsage accepts Codex's report and nothing else", () => {
  assert.deepEqual(threadTokenUsage(usage), usage);
  assert.equal(
    threadTokenUsage({ ...usage, modelContextWindow: null })
      ?.modelContextWindow,
    null,
  );
  assert.equal(
    threadTokenUsage({ ...usage, modelContextWindow: -5 })?.modelContextWindow,
    null,
  );
  assert.equal(threadTokenUsage(undefined), undefined);
  assert.equal(threadTokenUsage({ last: usage.last }), undefined);
  assert.equal(
    threadTokenUsage({ total: { totalTokens: -1 }, last: usage.last }),
    undefined,
  );
  // Missing parts of a breakdown count as zero.
  assert.deepEqual(
    threadTokenUsage({ total: { totalTokens: 9 }, last: { totalTokens: 3 } })
      ?.last,
    {
      totalTokens: 3,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    },
  );
});

test("/compact runs as a turn of its own and leaves the previous turn alone", async () => {
  const env = setup();
  try {
    const result = await env.engine.compactConversation("c");
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["thread/compact/start"],
    );
    assert.deepEqual(env.calls[0].params, { threadId: "thread" });
    const compaction = env.c.turns.at(-1)!;
    assert.equal(compaction.compaction, "manual");
    assert.equal(compaction.status, "inProgress");
    assert.equal(compaction.prompt, "");
    assert.equal(result.turns.at(-1)!.compaction, "manual");

    env.notify("turn/started", { turn: { id: "compact-turn" } });
    env.notify("item/started", {
      turnId: "compact-turn",
      item: { id: "cc", type: "contextCompaction" },
    });
    env.notify("thread/tokenUsage/updated", {
      turnId: "compact-turn",
      tokenUsage: usage,
    });
    env.notify("item/completed", {
      turnId: "compact-turn",
      item: { id: "cc", type: "contextCompaction" },
    });
    env.notify("turn/completed", {
      turn: { id: "compact-turn", status: "completed" },
    });
    assert.deepEqual(
      env.c.turns.map((t) => t.id),
      ["t1", "compact-turn"],
    );
    assert.equal(compaction.status, "completed");
    assert.deepEqual(
      compaction.items.map((item) => [item.type, item.lifecycleStatus]),
      [["contextCompaction", "completed"]],
    );
    assert.equal(env.c.tokenUsage?.last.totalTokens, 5612);

    await assert.rejects(
      env.engine.retryResponse("c", "compact-turn", "p", "m"),
      /compaction can't be retried/,
    );
    await assert.rejects(
      env.engine.editPrompt("c", "compact-turn", "text", "p", "m"),
      /no message to edit/,
    );
  } finally {
    env.close();
  }
});

test("/compact is refused while running or before there is anything to compact", async () => {
  const running = setup(() => ({}), [turn("t1", "inProgress")]);
  try {
    await assert.rejects(
      running.engine.compactConversation("c"),
      /still running/,
    );
    running.c.turns = [];
    running.c.threadId = undefined;
    await assert.rejects(
      running.engine.compactConversation("c"),
      /nothing to compact/,
    );
    assert.equal(running.calls.length, 0);
  } finally {
    running.close();
  }
});

test("a compaction Codex refuses leaves no turn behind", async () => {
  const env = setup((method) => {
    if (method === "thread/compact/start")
      throw new Error("compaction unavailable");
    return {};
  });
  try {
    await assert.rejects(
      env.engine.compactConversation("c"),
      /compaction unavailable/,
    );
    assert.deepEqual(
      env.c.turns.map((t) => t.id),
      ["t1"],
    );
    // The lock is released: the conversation can be sent to again.
    assert.equal((env.engine as any).pendingSend, false);
  } finally {
    env.close();
  }
});

test("/compact resumes a thread the engine has not loaded, with its context limits", async () => {
  const env = setup();
  try {
    (env.engine as any).loaded.clear();
    env.engine.modelLimits = (_provider, model) =>
      model === "m"
        ? { contextWindow: 200_000, autoCompactTokens: 150_000 }
        : undefined;
    await env.engine.compactConversation("c");
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["thread/resume", "thread/compact/start"],
    );
    assert.equal(env.calls[0].params.threadId, "thread");
    assert.equal(env.calls[0].params.model, "m");
    assert.deepEqual(env.calls[0].params.config, {
      web_search: "disabled",
      model_context_window: 200_000,
      model_auto_compact_token_limit: 150_000,
    });
  } finally {
    env.close();
  }
});

const image: Attachment = {
  id: "a",
  name: "shot.png",
  path: "/nonexistent/shot.png",
  size: 10,
  kind: "image",
};

test("a steered message joins the running turn when Codex hands it to the model", async () => {
  const env = setup(() => ({ turnId: "t1" }), [turn("t1", "inProgress")]);
  try {
    const result = await env.engine.steerTurn("c", "also check tests", [image]);
    assert(result);
    assert.match(result.messageId, /^steer-/);
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["turn/steer"],
    );
    assert.deepEqual(env.calls[0].params, {
      threadId: "thread",
      expectedTurnId: "t1",
      clientUserMessageId: result.messageId,
      input: [
        { type: "text", text: "also check tests", text_elements: [] },
        { type: "localImage", path: image.path },
      ],
    });
    // Not shown until the model reads it.
    assert.equal(env.c.turns[0].items.length, 0);

    // The turn's own prompt is not a steered message.
    env.notify("item/started", {
      turnId: "t1",
      item: { id: "u0", type: "userMessage", clientId: null, content: [] },
    });
    env.notify("item/completed", {
      turnId: "t1",
      item: { id: "a1", type: "agentMessage", text: "first" },
    });
    env.notify("item/completed", {
      turnId: "t1",
      item: {
        id: "u1",
        type: "userMessage",
        clientId: result.messageId,
        content: [{ type: "text", text: "also check tests" }],
      },
    });
    const items = env.c.turns[0].items;
    assert.deepEqual(
      items.map((item) => item.id),
      ["a1", "u1"],
    );
    assert(isSteeredMessage(items[1]));
    assert.equal(items[1].text, "also check tests");
    assert.deepEqual(items[1].attachments, [image]);
    assert.equal(items[1].clientId, result.messageId);
    assert.equal(items[1].lifecycleStatus, "completed");
  } finally {
    env.close();
  }
});

test("a steer with no turn to take it returns null so the window sends it instead", async () => {
  const idle = setup();
  try {
    assert.equal(await idle.engine.steerTurn("c", "hello", []), null);
    idle.c.turns.push(turn("pending-x", "inProgress"));
    assert.equal(await idle.engine.steerTurn("c", "hello", []), null);
    idle.c.turns.at(-1)!.id = "compact";
    idle.c.turns.at(-1)!.compaction = "manual";
    assert.equal(await idle.engine.steerTurn("c", "hello", []), null);
    assert.equal(idle.calls.length, 0);
    await assert.rejects(
      idle.engine.steerTurn("c", "  ", []),
      /Enter a message/,
    );
  } finally {
    idle.close();
  }
  for (const message of [
    "no active turn to steer",
    "expected active turn id `t1` but found `t2`",
  ]) {
    const ended = setup(() => {
      throw new Error(message);
    }, [turn("t1", "inProgress")]);
    try {
      assert.equal(await ended.engine.steerTurn("c", "hello", []), null);
      assert.equal((ended.engine as any).steers.size, 0);
    } finally {
      ended.close();
    }
  }
  const failing = setup(() => {
    throw new Error("engine crashed");
  }, [turn("t1", "inProgress")]);
  try {
    await assert.rejects(
      failing.engine.steerTurn("c", "hello", []),
      /engine crashed/,
    );
  } finally {
    failing.close();
  }
});

test("a steered message the model never read is dropped with its turn", async () => {
  const env = setup(() => ({ turnId: "t1" }), [turn("t1", "inProgress")]);
  try {
    const result = await env.engine.steerTurn("c", "late", []);
    assert(result);
    env.notify("turn/completed", {
      turn: { id: "t1", status: "interrupted" },
    });
    assert.equal((env.engine as any).steers.size, 0);
    // Nothing turns up later under its id.
    env.notify("item/completed", {
      turnId: "t1",
      item: { id: "u9", type: "userMessage", clientId: result.messageId },
    });
    assert.equal(env.c.turns[0].items.length, 0);
  } finally {
    env.close();
  }
});

test("steering follows the administrator's attachment and update rules", async () => {
  const env = setup(() => ({ turnId: "t1" }), [turn("t1", "inProgress")]);
  try {
    env.engine.policy = () => ({
      ...openPolicy,
      update: {
        state: "required",
        currentVersion: "0.0.1",
        latestVersion: "9.9.9",
      },
    });
    await assert.rejects(env.engine.steerTurn("c", "hi", []), /update/i);
    env.engine.policy = () => ({
      ...openPolicy,
      attachments: { ...openPolicy.attachments, maxBytes: 1 },
    });
    await assert.rejects(
      env.engine.steerTurn("c", "hi", [image]),
      /is 10 B, over the 0 MB limit/,
    );
    assert.equal(env.calls.length, 0);
  } finally {
    env.close();
  }
});

function sendAnswer(method: string) {
  if (method === "thread/start") return { thread: { id: "fresh" } };
  if (method === "turn/start") return { turn: { id: "new-turn" } };
  return {};
}

test("unified Chat permissions survive Store restart and reach real engine thread and turn requests", async () => {
  for (const mode of ["chat", "cowork"] as const) {
    for (const permission of ["default", "auto"] as const) {
      const env = setup(sendAnswer);
      try {
        env.store.settings.taskPermission = permission;
        env.c.mode = mode;
        env.c.threadId = undefined;
        env.store.flush();
        const restored = new Store(env.store.root);
        assert.equal(restored.settings.taskPermission, permission);
        await env.engine.send({
          conversationId: "c",
          text: "Synthetic permission reference",
          mode,
          attachments: [],
          providerId: "p",
          model: "m",
        });
        const start = env.calls.find((call) => call.method === "thread/start")!;
        const turn = env.calls.find((call) => call.method === "turn/start")!;
        assert.equal(start.params.sandbox, "workspace-write");
        assert.equal(start.params.approvalPolicy, "on-request");
        assert.equal(
          start.params.approvalsReviewer,
          permission === "auto" ? "auto_review" : "user",
        );
        assert.equal(turn.params.approvalPolicy, "on-request");
        assert.equal(
          turn.params.approvalsReviewer,
          permission === "auto" ? "auto_review" : "user",
        );
        assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
      } finally {
        env.close();
      }
    }
  }
});

test("Code session permissions persist through the real IPC/Store and do not change other sessions or account defaults", async () => {
  const env = setup(sendAnswer);
  try {
    const other = { ...structuredClone(env.c), id: "other" };
    env.store.conversations.push(other);
    const before = structuredClone(env.store.settings);
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      { engine: env.engine, store: env.store } as any,
    );
    await handlers.get("updateConversation")!("c", {
      codePermissionMode: "plan",
    });
    assert.equal(env.c.codePermissionMode, "plan");
    assert.equal(env.c.codePermissionRevision, 1);
    await handlers.get("updateConversation")!("c", {
      codePermissionMode: "plan",
    });
    assert.equal(env.c.codePermissionRevision, 2);
    assert.equal(other.codePermissionMode, undefined);
    assert.deepEqual(env.store.settings, before);
    assert.equal(
      new Store(env.store.root).conversation("c").codePermissionMode,
      "plan",
    );
    assert.throws(() =>
      handlers.get("updateConversation")!("c", {
        codePermissionMode: "unknown",
      }),
    );
    other.mode = "chat";
    assert.throws(
      () =>
        handlers.get("updateConversation")!("other", {
          codePermissionMode: "auto",
        }),
      /Only Code/,
    );
    other.mode = "code";
    other.scheduledRun = true;
    other.scheduledPermission = "default";
    assert.throws(
      () =>
        handlers.get("updateConversation")!("other", {
          codePermissionMode: "plan",
        }),
      /scheduled task/,
    );
    env.c.threadId = undefined;
    await env.engine.send({
      conversationId: "c",
      text: "Synthetic scope reference",
      mode: "code",
      providerId: "p",
      model: "m",
      attachments: [],
    });
    const start = env.calls.find((call) => call.method === "thread/start")!;
    const turn = env.calls.find((call) => call.method === "turn/start")!;
    assert.equal(start.params.sandbox, "read-only");
    assert.equal(turn.params.sandboxPolicy.type, "readOnly");
    assert.equal(turn.params.collaborationMode.mode, "plan");
    assert.equal(env.c.turns.at(-1)!.codePermissionMode, "plan");
  } finally {
    env.close();
  }
});

test("a new Code session stores its draft permission without changing defaults or another session", async () => {
  const env = setup(sendAnswer);
  try {
    const before = structuredClone(env.store.settings);
    const created = await env.engine.send({
      text: "Synthetic draft scope",
      mode: "code",
      codePermissionMode: "plan",
      providerId: "p",
      model: "m",
      cwd: env.store.root,
      attachments: [],
    });
    assert.equal(created.codePermissionMode, "plan");
    assert.equal(env.c.codePermissionMode, undefined);
    assert.equal(env.c.codePermissionRevision, undefined);
    assert.deepEqual(env.store.settings, before);
    env.store.flush();
    assert.equal(
      new Store(env.store.root).conversation(created.id).codePermissionMode,
      "plan",
    );
    assert.equal(
      env.calls.find((call) => call.method === "turn/start")!.params
        .collaborationMode.mode,
      "plan",
    );
  } finally {
    env.close();
  }
});

test("switching Code mode during a running turn does not immediately auto-approve that turn's edits", async () => {
  const env = setup(sendAnswer, [turn("active", "inProgress")]);
  try {
    env.c.codePermissionMode = "auto";
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      { engine: env.engine, store: env.store } as any,
    );
    const decisions: any[] = [];
    (env.engine.rpc as any).respond = (id: unknown, value: unknown) =>
      decisions.push({ id, value });
    await handlers.get("updateConversation")!("c", {
      codePermissionMode: "acceptEdits",
    });
    assert.equal(env.c.turns[0].codePermissionMode, "auto");
    (env.engine as any).request({
      id: "first",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread", turnId: "active", itemId: "change" },
    });
    assert.equal(decisions.length, 0);
    env.c.turns[0].codePermissionMode = "acceptEdits";
    (env.engine as any).request({
      id: "second",
      method: "item/fileChange/requestApproval",
      params: { threadId: "thread", turnId: "active", itemId: "change" },
    });
    assert.deepEqual(decisions, [
      { id: "second", value: { decision: "accept" } },
    ]);
    const other = {
      ...structuredClone(env.c),
      id: "other",
      threadId: "other-thread",
      codePermissionMode: "auto" as const,
    };
    other.turns[0].codePermissionMode = "auto";
    env.store.conversations.push(other);
    (env.engine as any).routes.set("other-thread", "other");
    (env.engine as any).request({
      id: "other-edit",
      method: "item/fileChange/requestApproval",
      params: { threadId: "other-thread", turnId: "active", itemId: "change" },
    });
    assert.equal(decisions.length, 1, "another session must still ask");
    assert.equal(env.store.settings.autoAcceptEdits, false);
  } finally {
    env.close();
  }
});

test("a stored Code bypass choice cannot bypass account opt-in and folder trust", async () => {
  const env = setup(sendAnswer);
  try {
    env.store.settings.allowBypassPermissions = false;
    env.store.settings.bypassFolders = [];
    await env.engine.send({
      text: "Synthetic bypass eligibility",
      mode: "code",
      codePermissionMode: "bypass",
      providerId: "p",
      model: "m",
      cwd: env.store.root,
      attachments: [],
    });
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.equal(start.params.sandbox, "workspace-write");
    assert.equal(start.params.approvalPolicy, "on-request");
  } finally {
    env.close();
  }
});

test("legacy Code requests without scope metadata still follow their account defaults", async () => {
  for (const planned of [false, true]) {
    const env = setup(sendAnswer);
    try {
      env.store.settings.codePlanMode = planned;
      const created = await env.engine.send({
        text: "Synthetic legacy default",
        mode: "code",
        providerId: "p",
        model: "m",
        cwd: env.store.root,
        attachments: [],
      });
      assert.equal(created.codePermissionMode, undefined);
      assert.equal(
        env.calls.find((call) => call.method === "thread/start")!.params
          .sandbox,
        planned ? "read-only" : "workspace-write",
      );
      assert.equal(
        env.calls.find((call) => call.method === "turn/start")!.params
          .collaborationMode.mode,
        planned ? "plan" : "default",
      );
    } finally {
      env.close();
    }
  }
});

test("leaving Plan updates an already loaded Code thread's next turn without changing account defaults", async () => {
  const env = setup(sendAnswer);
  try {
    env.store.settings.codePlanMode = true;
    env.c.codePermissionMode = "plan";
    env.c.turns[0].codePermissionMode = "plan";
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      { engine: env.engine, store: env.store } as any,
    );
    await handlers.get("updateConversation")!("c", {
      codePermissionMode: "auto",
    });
    await env.engine.send({
      conversationId: "c",
      text: "Synthetic plan acceptance",
      mode: "code",
      providerId: "p",
      model: "m",
      attachments: [],
    });
    const turn = env.calls.find((call) => call.method === "turn/start")!;
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(turn.params.collaborationMode.mode, "default");
    assert.equal(env.store.settings.codePlanMode, true);
    assert.equal(env.c.turns[0].codePermissionMode, "plan");
  } finally {
    env.close();
  }
});

test("a failed atomic session-permission save rolls back memory and leaves the prior persisted mode", () => {
  const env = setup(sendAnswer, [turn("active", "inProgress")]);
  const originalWrite = env.store.write.bind(env.store);
  try {
    env.store.flush();
    const handlers = new Map<string, (...args: any[]) => any>();
    const pushed: unknown[] = [];
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        engine: env.engine,
        store: env.store,
        push: (event: unknown) => pushed.push(event),
      } as any,
    );
    assert.throws(
      () =>
        handlers.get("updateConversation")!("c", {
          codePermissionMode: "plan",
          title: "compound",
        }),
      /separately/,
    );
    env.store.write = (name, value) => {
      if (name === "conversations.json") throw Error("disk full");
      originalWrite(name, value);
    };
    assert.throws(
      () =>
        handlers.get("updateConversation")!("c", {
          codePermissionMode: "plan",
        }),
      /disk full/,
    );
    assert.equal(env.c.codePermissionMode, undefined);
    assert.equal(env.c.turns[0].codePermissionMode, undefined);
    assert.equal(
      new Store(env.store.root).conversation("c").codePermissionMode,
      undefined,
    );
    assert.deepEqual(pushed, []);
  } finally {
    env.store.write = originalWrite;
    env.close();
  }
});

test("Code output intent starts a real session with an unchanged prompt and persisted artifact instructions", async () => {
  for (const kind of ["docs", "slides", "design", "dashboard"] as const) {
    const env = setup(sendAnswer);
    try {
      const text = "Create the selected output from this synthetic brief.";
      const created = await env.engine.send({
        text,
        mode: "code",
        providerId: "p",
        model: "m",
        cwd: env.store.root,
        attachments: [],
        artifactOutputKind: kind,
      });
      assert.equal(created.artifactOutputKind, kind);
      assert.equal(created.turns[0].prompt, text);
      const start = env.calls.find((call) => call.method === "thread/start")!;
      assert.match(
        start.params.developerInstructions,
        /Create the actual requested artifact as files/,
      );
      env.store.flush();
      assert.equal(
        new Store(env.store.root).conversation(created.id).artifactOutputKind,
        kind,
      );
    } finally {
      env.close();
    }
  }
});

test("unrelated Code tasks ask, stay here, or start a fresh linked session", async () => {
  for (const choice of ["ask", "here", "new_session"] as const) {
    const env = setup(sendAnswer);
    try {
      env.store.settings.ccNewTaskPrompt = choice;
      const internals = env.engine as any;
      internals.sessionAssistance.unrelatedTask = async () => choice !== "here";
      const result = await env.engine.send({
        conversationId: "c",
        text: "Build a separate project",
        attachments: [],
        mode: "code",
        providerId: "p",
        model: "m",
      });
      if (choice === "ask") {
        assert.equal(result.codeNewTask?.text, "Build a separate project");
        assert.equal(
          env.calls.some((call) => call.method === "turn/start"),
          false,
        );
        const linked = await env.engine.resolveCodeNewTask(
          "c",
          result.codeNewTask!.id,
          "new_session",
          true,
        );
        assert.notEqual(linked.id, "c");
        assert.equal(linked.parentSessionId, "c");
        assert.equal(linked.cwd, env.c.cwd);
        assert.equal(env.c.codeNewTask, undefined);
        assert.equal(env.c.turns.length, 1);
        assert.equal(env.store.settings.ccNewTaskPrompt, "new_session");
        await assert.rejects(
          env.engine.resolveCodeNewTask("c", result.codeNewTask!.id, "here"),
          /no longer available/,
        );
      } else if (choice === "here") {
        assert.equal(result.id, "c");
        assert.equal(result.turns.at(-1)?.prompt, "Build a separate project");
      } else {
        assert.notEqual(result.id, "c");
        assert.equal(result.parentSessionId, "c");
        assert.equal(result.turns[0].prompt, "Build a separate project");
        assert.equal(env.c.turns.length, 1);
      }
    } finally {
      env.close();
    }
  }
});

test("Do it here resumes once, and failed starts restore the pending offer", async () => {
  const env = setup(sendAnswer);
  try {
    const internals = env.engine as any;
    internals.sessionAssistance.unrelatedTask = async () => true;
    const result = await env.engine.send({
      conversationId: "c",
      text: "A new task",
      attachments: [],
      mode: "code",
      providerId: "p",
      model: "m",
    });
    const send = env.engine.send.bind(env.engine);
    env.engine.send = async () => {
      throw new Error("offline");
    };
    await assert.rejects(
      env.engine.resolveCodeNewTask("c", result.codeNewTask!.id, "here"),
      /offline/,
    );
    assert.equal(env.c.codeNewTask?.id, result.codeNewTask!.id);
    env.engine.send = send;
    await env.engine.resolveCodeNewTask(
      "c",
      result.codeNewTask!.id,
      "here",
      true,
    );
    assert.equal(env.c.turns.length, 2);
    assert.equal(env.c.codeNewTask, undefined);
    assert.equal(env.store.settings.ccNewTaskPrompt, "here");
  } finally {
    env.close();
  }
});

test("classification is captured for new Code sessions and does not follow later setting changes", async () => {
  for (const enabled of [true, false]) {
    const env = setup(sendAnswer);
    try {
      env.store.settings.classifySessionStates = enabled;
      const created = await env.engine.send({
        text: "Fix the tests",
        mode: "code",
        providerId: "p",
        model: "m",
        cwd: env.store.root,
        attachments: [],
      });
      assert.equal(created.classifySessionStates, enabled);
      env.store.settings.classifySessionStates = !enabled;
      assert.equal(
        env.store.conversation(created.id).classifySessionStates,
        enabled,
      );
    } finally {
      env.close();
    }
  }
});

test("sent prompt originals capture exactly the text input, including expanded attachments", async () => {
  const env = setup(sendAnswer);
  try {
    const file = path.join(env.store.root, "note.txt");
    fs.writeFileSync(file, "verbatim\n<file> & text");
    await env.engine.send({
      conversationId: "c",
      text: "hello",
      mode: "chat",
      providerId: "p",
      model: "m",
      attachments: [
        { id: "f", name: "note.txt", kind: "text", path: file } as Attachment,
      ],
    });
    const input = env.calls.find((call) => call.method === "turn/start")!.params
      .input;
    assert.deepEqual(
      env.c.turns.at(-1)!.rawOriginals,
      input
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text),
    );
    assert.match(
      env.c.turns.at(-1)!.rawOriginals![1],
      /verbatim\n<file> & text/,
    );
    assert.equal(env.c.turns.at(-1)!.sendFailed, undefined);
  } finally {
    env.close();
  }
});

test("a failed send persists and Discard removes only failed unsent prompts through the IPC handler", async () => {
  const env = setup((method) => {
    if (method === "turn/start") throw new Error("network request failed");
    return sendAnswer(method);
  });
  try {
    await assert.rejects(
      env.engine.send({
        conversationId: "c",
        text: "hello",
        attachments: [],
        mode: "chat",
        providerId: "p",
        model: "m",
      }),
      /network request failed/,
    );
    const failed = env.c.turns.at(-1)!;
    assert.equal(failed.status, "failed");
    assert.equal(failed.sendFailed, true);
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      { engine: env.engine, store: env.store } as any,
    );
    await handlers.get("discardTurn")!("c", "t1");
    assert.equal(env.c.turns.length, 2);
    const result = await handlers.get("discardTurn")!("c", failed.id);
    assert.deepEqual(
      result.turns.map((turn: Turn) => turn.id),
      ["t1"],
    );
    assert.equal(new Store(env.store.root).conversation("c").turns.length, 1);
  } finally {
    env.close();
  }
});

test("context-full stop reasons classify the turn without treating it as a failed send", () => {
  const env = setup(sendAnswer, [turn("t1", "inProgress")]);
  try {
    env.notify("turn/completed", {
      turn: {
        id: "t1",
        status: "failed",
        stop_reason: "conversation_length_limit",
      },
    });
    assert.equal(env.c.turns[0].stopReason, "conversation_length_limit");
    assert.equal(env.c.turns[0].sendFailed, undefined);
  } finally {
    env.close();
  }
});

test("usage refusals persist a per-reply hold with the gateway reset time", () => {
  const env = setup(sendAnswer, [turn("t1", "inProgress")]);
  try {
    (env.engine as any).lastRefusal = {
      message: "Weekly quota reached",
      at: Date.now(),
      exceeded: true,
      reason: "weekly",
      resetsAt: 1900000000000,
    };
    env.notify("turn/completed", {
      turn: { id: "t1", status: "failed", error: { message: "429" } },
    });
    assert.equal(env.c.turns[0].stopReason, "usage_limit");
    assert.deepEqual(env.c.turns[0].usageHold, { resetsAt: 1900000000000 });
    env.store.flush();
    assert.deepEqual(
      new Store(env.store.root).conversation("c").turns[0].usageHold,
      { resetsAt: 1900000000000 },
    );
  } finally {
    env.close();
  }
});

test("native usage-limit stops survive without a structured gateway refusal", () => {
  const env = setup(sendAnswer, [turn("t1", "inProgress")]);
  try {
    env.notify("turn/completed", {
      turn: { id: "t1", status: "failed", stop_reason: "usage_limit" },
    });
    assert.equal(env.c.turns[0].stopReason, "usage_limit");
    assert.deepEqual(env.c.turns[0].usageHold, { resetsAt: null });
  } finally {
    env.close();
  }
});

test("research model access failures retain the required model for the transcript", () => {
  const pending = turn("t1", "inProgress");
  pending.research = { state: "gathering", startedAt: 1, sourceCount: 0 };
  const env = setup(sendAnswer, [pending]);
  try {
    env.notify("turn/completed", {
      turn: {
        id: "t1",
        status: "failed",
        error: {
          code: "model_access",
          error_model: "Research model",
          message: "Access denied",
        },
      },
    });
    assert.equal(env.c.turns[0].research?.error, "model_access");
    assert.equal(env.c.turns[0].research?.errorModel, "Research model");
  } finally {
    env.close();
  }
});

test("local Code sends request on-demand summaries through the native runtime", async () => {
  const env = setup(sendAnswer);
  try {
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
      thinkingSummariesWanted: true,
    });
    assert.equal(env.c.thinkingSummariesWanted, true);
    assert.equal(
      env.calls.find((call) => call.method === "turn/start")?.params.summary,
      "auto",
    );
  } finally {
    env.close();
  }
});

test("Cowork thinking mode persists independently of effort through the shared desktop and runner handler", async () => {
  const env = setup(sendAnswer);
  try {
    env.c.mode = "cowork";
    const handlers = new Map<string, (...args: any[]) => any>();
    registerConversationHandlers(
      (name, handler) => handlers.set(name, handler),
      {
        store: env.store,
        engine: env.engine,
        replyFeedback: {} as any,
        selectedAttachments: new Map(),
        allowedFolder() {},
        noActive() {},
      },
    );
    const update = handlers.get("updateConversation")!;
    update("c", { thinkingMode: "standard" });
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "cowork",
      attachments: [],
      providerId: "p",
      model: "m",
      effort: "max",
    });
    assert.equal(env.c.thinkingMode, "standard");
    assert.equal(env.c.effort, "max");
    assert.equal(
      env.calls.find((call) => call.method === "turn/start")?.params.effort,
      "low",
    );
    env.notify("turn/completed", {
      turn: { id: "new-turn", status: "completed" },
    });
    update("c", { thinkingMode: "extended" });
    await env.engine.send({
      conversationId: "c",
      text: "again",
      mode: "cowork",
      attachments: [],
      providerId: "p",
      model: "m",
    });
    assert.equal(env.c.effort, "max");
    assert.equal(
      env.calls.filter((call) => call.method === "turn/start").at(-1)?.params
        .effort,
      "max",
    );
  } finally {
    env.close();
  }
});

test("normal Code view omits future summaries without deleting prior thinking", async () => {
  const env = setup(sendAnswer);
  try {
    env.c.turns[0].items.push({
      id: "thought",
      type: "reasoning",
      summary: ["Prior thinking"],
    });
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
      thinkingSummariesWanted: false,
    });
    assert.equal(
      env.calls.find((call) => call.method === "turn/start")?.params.summary,
      "none",
    );
    assert.equal(env.c.turns[0].items[0].summary?.[0], "Prior thinking");
  } finally {
    env.close();
  }
});

test("native subagent reports are not discarded as already-rendered user prompts", () => {
  const env = setup();
  try {
    env.notify("item/completed", {
      turnId: "t1",
      item: {
        id: "peer-report",
        type: "userMessage",
        content: [
          {
            type: "text",
            text: '<subagent_notification>{"agent_id":"child","status":{"completed":"A report"}}</subagent_notification>',
          },
        ],
      },
    });
    const item = env.c.turns[0].items.find((item) => item.id === "peer-report");
    assert.equal(item?.type, "peerMessage");
    assert.equal(item?.text, "A report");
    assert.equal(item?.origin?.handback, true);
  } finally {
    env.close();
  }
});

test("the model catalog's context limits reach Codex when a thread starts", async () => {
  const env = setup(sendAnswer);
  try {
    env.c.threadId = undefined;
    env.engine.modelLimits = (provider, model) => {
      assert.equal(provider, "p");
      return model === "m"
        ? { contextWindow: 128_000, autoCompactTokens: 100_000 }
        : { contextWindow: 0, autoCompactTokens: 2.5 };
    };
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
    });
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.deepEqual(start.params.config, {
      web_search: "disabled",
      model_context_window: 128_000,
      model_auto_compact_token_limit: 100_000,
    });
  } finally {
    env.close();
  }
});

test("a sent message stays running while the engine starts (the start's stop leaves it, and it blocks no start)", async () => {
  const env = setup(sendAnswer);
  try {
    env.c.threadId = undefined;
    const engine = env.engine as any;
    const other: Turn = turn("other", "inProgress");
    let busyDuringStart: boolean | undefined;
    let statusDuringStart: Turn["status"] | undefined;
    env.engine.ensure = async () => {
      busyDuringStart = env.engine.ownBusy();
      statusDuringStart = env.c.turns.at(-1)!.status;
      // A start begins with a stop; the rpc comes back as a new one would.
      const rpc = engine.rpc;
      rpc.stop = async () => {};
      engine.windowsSandbox.reset = () => {};
      env.store.conversations.push({ ...env.c, id: "c2", turns: [other] });
      await env.engine.stop();
      engine.rpc = rpc;
    };
    const sent = await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
    });
    assert.equal(statusDuringStart, "inProgress");
    assert.equal(busyDuringStart, false);
    const last = sent.turns.at(-1)!;
    assert.equal(last.id, "new-turn");
    assert.equal(last.status, "inProgress");
    // Another conversation's running turn is still stopped by a restart.
    assert.equal(other.status, "interrupted");
    assert.equal(engine.earlyTurn, undefined);
  } finally {
    env.close();
  }
});

test("without catalog limits Codex keeps its own", async () => {
  const env = setup(sendAnswer);
  try {
    env.c.threadId = undefined;
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
    });
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.deepEqual(start.params.config, { web_search: "disabled" });
  } finally {
    env.close();
  }
});

test("a loaded thread is loaded again only when its model's limits change", async () => {
  const env = setup(sendAnswer);
  const send = (model: string) =>
    env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model,
    });
  const finish = () => {
    for (const t of env.c.turns) t.status = "completed";
  };
  try {
    env.engine.modelLimits = (_provider, model) =>
      model === "big" ? { contextWindow: 400_000 } : undefined;
    await send("m");
    finish();
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["turn/start"],
    );
    env.calls.length = 0;
    await send("big");
    finish();
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["thread/unsubscribe", "thread/resume", "turn/start"],
    );
    assert.equal(env.calls[1].params.config.model_context_window, 400_000);
    env.calls.length = 0;
    await send("big");
    finish();
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["turn/start"],
    );

    // An incognito thread could not be loaded again; it keeps its limits.
    env.c.incognito = true;
    env.calls.length = 0;
    await send("m");
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["turn/start"],
    );
  } finally {
    env.close();
  }
});

test("composer IPC validates its input and reaches only the engine seams", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const seen: unknown[][] = [];
  const ctx = {
    selectedAttachments: new Map([["a", image]]),
    engine: {
      compactConversation: async (...args: unknown[]) => {
        seen.push(["compact", ...args]);
        return {};
      },
      steerTurn: async (...args: unknown[]) => {
        seen.push(["steer", ...args]);
        return null;
      },
      forkConversation: async (...args: unknown[]) => {
        seen.push(["fork", ...args]);
        return {};
      },
      handOffConversation: async (...args: unknown[]) => {
        seen.push(["hand-off", ...args]);
        return {};
      },
      askSideChat: async (...args: unknown[]) => {
        seen.push(["side", ...args]);
        return "answer";
      },
      interruptSideChat: async (...args: unknown[]) => {
        seen.push(["stop-side", ...args]);
      },
      endSideChat: async (...args: unknown[]) => {
        seen.push(["end-side", ...args]);
      },
      runShellCommand: async (...args: unknown[]) => {
        seen.push(["shell", ...args]);
        return {};
      },
      startReview: async (...args: unknown[]) => {
        seen.push(["review", ...args]);
        return {};
      },
    },
  } as unknown as AppContext;
  registerComposerHandlers((name, fn) => handlers.set(name, fn), ctx);
  assert.deepEqual([...handlers.keys()].sort(), [
    "addAttachmentData",
    "askSideChat",
    "attachmentPreview",
    "compactConversation",
    "endSideChat",
    "forkConversation",
    "handOffConversation",
    "interruptSideChat",
    "linkChatGitHubRepository",
    "listSlashCommands",
    "mentionFiles",
    "readCustomPrompt",
    "resolveCodeNewTask",
    "restoreRewindCode",
    "rewindConversation",
    "runShellCommand",
    "startReview",
    "steerTurn",
    "swapRewind",
  ]);
  await handlers.get("compactConversation")!("c");
  await handlers.get("steerTurn")!("c", "more", ["a"]);
  await handlers.get("forkConversation")!("c");
  await handlers.get("forkConversation")!("c", { turnId: "t", prompt: "go" });
  await handlers.get("handOffConversation")!("c");
  await handlers.get("runShellCommand")!("c", "ls | wc -l");
  assert.equal(
    await handlers.get("askSideChat")!("c", "side", "What was that?"),
    "answer",
  );
  await handlers.get("interruptSideChat")!("c", "side");
  await handlers.get("endSideChat")!("c", "side");
  await handlers.get("startReview")!("c", { type: "uncommittedChanges" });
  await handlers.get("startReview")!(
    "c",
    { type: "baseBranch", branch: "release/1.2" },
    "/review release/1.2",
  );
  assert.deepEqual(seen, [
    ["compact", "c"],
    ["steer", "c", "more", [image]],
    ["fork", "c", undefined, undefined],
    ["fork", "c", "t", "go"],
    ["hand-off", "c"],
    ["shell", "c", "ls | wc -l"],
    ["side", "c", "side", "What was that?"],
    ["stop-side", "c", "side"],
    ["end-side", "c", "side"],
    ["review", "c", { type: "uncommittedChanges" }, undefined],
    [
      "review",
      "c",
      { type: "baseBranch", branch: "release/1.2" },
      "/review release/1.2",
    ],
  ]);
  assert.throws(() => handlers.get("askSideChat")!("c", "side", 5));
  assert.throws(() => handlers.get("askSideChat")!("", "side", "q"));
  assert.throws(() => handlers.get("interruptSideChat")!("c", ""));
  assert.throws(() => handlers.get("endSideChat")!("c", ""));
  assert.throws(() =>
    handlers.get("resolveCodeNewTask")!("c", "offer", "wrong", false),
  );
  assert.throws(() =>
    handlers.get("resolveCodeNewTask")!("", "offer", "here", false),
  );
  assert.throws(() =>
    handlers.get("resolveCodeNewTask")!("c", "offer", "here", "true"),
  );
  // A branch that reads as an option, or a commit that isn't one, is refused.
  assert.throws(() =>
    handlers.get("startReview")!("c", { type: "baseBranch", branch: "--evil" }),
  );
  assert.throws(() =>
    handlers.get("startReview")!("c", { type: "commit", sha: "zzzz" }),
  );
  assert.throws(() => handlers.get("startReview")!("c", { type: "other" }));
  assert.throws(() => handlers.get("forkConversation")!("c", { turnId: 5 }));
  assert.throws(() => handlers.get("handOffConversation")!(""));
  assert.throws(() => handlers.get("handOffConversation")!(5));
  assert.throws(() => handlers.get("runShellCommand")!("c", ""));
  assert.throws(() => handlers.get("runShellCommand")!("c", 5));
  assert.throws(() => handlers.get("compactConversation")!(""));
  assert.throws(
    () => handlers.get("steerTurn")!("c", "more", ["unknown"]),
    /no longer available/,
  );
  assert.throws(() => handlers.get("steerTurn")!("c", 5, []));
});

test("R3 memory reaches a new Chat thread through the extension, never a Code one", async () => {
  const env = setup(sendAnswer);
  try {
    const memory = new MemoryService({
      store: new LocalMemoryStore(env.store.root),
      policy: () => openPolicy,
      changed: () => {},
    });
    await memory.setPrefs({ generate: true });
    await memory.saveDoc("global", "Prefers metric units.", 0);
    env.engine.extensions.add(createMemoryExtension({ service: () => memory }));
    env.c.threadId = undefined;
    env.c.mode = "chat";
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "chat",
      attachments: [],
      providerId: "p",
      model: "m",
    });
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.match(
      start.params.developerInstructions,
      /<user_memory scope="global" updated="[\d-]+">\nPrefers metric units\.\n<\/user_memory>/,
    );
    assert.deepEqual(
      start.params.dynamicTools
        .filter((tool: any) => tool.type === "namespace")
        .map((tool: any) => [
          tool.name,
          tool.tools.map((inner: any) => inner.name),
        ]),
      [["claudex_memory", ["memory_edits"]]],
    );
    // The model's tool call is answered by the memory extension.
    const answers: unknown[] = [];
    (env.engine as any).rpc.respond = (id: number, result: unknown) =>
      answers.push([id, result]);
    (env.engine as any).request({
      id: 7,
      method: "item/tool/call",
      params: {
        threadId: "fresh",
        turnId: "new-turn",
        callId: "call-1",
        namespace: "claudex_memory",
        tool: "memory_edits",
        arguments: { command: "add", text: "Has a cat" },
      },
    });
    for (let i = 0; i < 40 && !answers.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(answers, [
      [
        7,
        {
          contentItems: [
            { type: "inputText", text: "Saved to memory: Has a cat" },
          ],
          success: true,
        },
      ],
    ]);
    assert.equal(memory.memoryFor("global").edits[0].text, "Has a cat");

    // Code: no memory, no memory tools.
    env.calls.length = 0;
    env.c.threadId = undefined;
    env.c.mode = "code";
    env.c.turns = [turn("t1")];
    await env.engine.send({
      conversationId: "c",
      text: "hi",
      mode: "code",
      attachments: [],
      providerId: "p",
      model: "m",
    });
    const code = env.calls.find((call) => call.method === "thread/start")!;
    assert.equal(
      code.params.developerInstructions.includes("user_memory"),
      false,
    );
    assert.equal(code.params.dynamicTools, undefined);
  } finally {
    env.close();
  }
});

test("a captured picture goes where it was made and is not shown twice when the reply shares it as a file", async () => {
  const { createHash } = await import("node:crypto");
  const env = setup(() => ({}), [turn("t1", "inProgress")]);
  try {
    const engine = env.engine as any;
    const running = env.c.turns[0];
    running.items = [
      { id: "a1", type: "agentMessage", text: "Drawing it." },
      {
        id: "cmd1",
        type: "commandExecution",
        command: "generate",
        status: "completed",
      },
    ] as any;
    const picture = (byte: number) =>
      Buffer.from([0x89, 0x50, 0x4e, 0x47, byte]);
    engine.signals.generatedImage({
      threadId: "thread",
      callId: "img1",
      base64: picture(1).toString("base64"),
      format: "png",
    });
    engine.signals.generatedImage({
      threadId: "thread",
      callId: "img2",
      base64: picture(2).toString("base64"),
      format: "png",
    });
    running.items.push({
      id: "a2",
      type: "agentMessage",
      text: "Done.",
    } as any);
    // The reply shares the second picture as a workspace file.
    running.items.push({
      id: "outputs-t1",
      type: "outputFiles",
      generatedFiles: [
        {
          id: "f",
          name: "copy.png",
          path: "copy.png",
          state: "ready",
          digest: createHash("sha256").update(picture(2)).digest("hex"),
        },
      ],
    } as any);
    engine.signals.settleGeneratedImages("thread", running);
    assert.deepEqual(
      running.items.map((item: any) => item.id),
      ["a1", "cmd1", "img1", "a2", "outputs-t1"],
    );
  } finally {
    env.close();
  }
});
