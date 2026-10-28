import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { modeInstructions } from "../../electron/engine/instructions";
import { Store } from "../../electron/store/store";
import { openPolicy } from "../../shared/client-policy";
import {
  chatArtifactsEnabled,
  chatExecutionEnvironments,
} from "../../shared/chat-execution";
import { preferenceFields } from "../../shared/settings-extras-schema";

function setup() {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-chat-execution-")),
  );
  const store = new Store(path.join(root, "profile"));
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  engine.ensure = async () => {};
  const calls: { method: string; params: any }[] = [];
  let nextThread = 0;
  engine.rpc = {
    async call(method: string, params: any) {
      calls.push({ method, params: structuredClone(params) });
      if (method === "thread/start" || method === "thread/fork")
        return { thread: { id: `thread-${++nextThread}` } };
      if (method === "turn/start")
        return { turn: { id: `turn-${calls.length}` } };
      return {};
    },
    respond(id: unknown, result: unknown) {
      calls.push({ method: "respond", params: { id, result } });
    },
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  return {
    engine,
    store,
    calls,
    send: (mode: "chat" | "code", extra: object = {}) =>
      engine.send({
        text: "hello",
        mode,
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

test("execution and Artifacts persist as boolean preferences and keep the source interlock", () => {
  const env = setup();
  try {
    assert.equal(chatArtifactsEnabled(env.store.settings), true);
    assert.equal(preferenceFields.chatExecution.safeParse(false).success, true);
    assert.equal(preferenceFields.artifacts.safeParse("false").success, false);
    env.store.settings = {
      ...env.store.settings,
      chatExecution: false,
      artifacts: false,
    };
    env.store.flush();
    const reloaded = new Store(env.store.root);
    assert.equal(reloaded.settings.chatExecution, false);
    assert.equal(reloaded.settings.artifacts, false);
    assert.equal(chatArtifactsEnabled(reloaded.settings), false);
    assert.equal(
      chatArtifactsEnabled({ ...reloaded.settings, chatExecution: true }),
      true,
    );
    assert.match(
      modeInstructions("chat", reloaded.settings),
      /artifacts are off/,
    );
    assert.doesNotMatch(modeInstructions("code", reloaded.settings), /are off/);
    assert.deepEqual(
      chatExecutionEnvironments(reloaded.settings, "code", "/w"),
      {},
    );
  } finally {
    env.close();
  }
});

test("Chat disables execution and child agents, restores the same thread, and leaves Code independent", async () => {
  const env = setup();
  try {
    env.store.settings = { ...env.store.settings, chatExecution: false };
    const chat = await env.send("chat");
    const start = env.calls.find((c) => c.method === "thread/start")!.params;
    assert.deepEqual(start.environments, []);
    assert.equal(start.config["features.multi_agent"], false);
    assert.equal(start.config["features.multi_agent_v2"], false);
    assert.deepEqual(
      [...env.calls].reverse().find((c) => c.method === "turn/start")!.params
        .environments,
      [],
    );
    env.store.conversation(chat.id).turns.at(-1)!.status = "completed";
    env.store.settings = { ...env.store.settings, chatExecution: true };
    await env.send("chat", { conversationId: chat.id });
    assert.equal(
      [...env.calls].reverse().find((c) => c.method === "turn/start")!.params
        .environments[0].environmentId,
      "local",
    );
    assert.ok(env.calls.some((c) => c.method === "thread/resume"));
    env.store.settings = { ...env.store.settings, chatExecution: false };
    await env.send("code");
    assert.equal(
      [...env.calls].reverse().find((c) => c.method === "turn/start")!.params
        .environments,
      undefined,
    );
    const code = [...env.calls]
      .reverse()
      .find((c) => c.method === "thread/start")!.params;
    assert.equal(code.config["features.multi_agent"], undefined);
  } finally {
    env.close();
  }
});

test("turning execution off declines outstanding native execution approval without prompting", async () => {
  const env = setup();
  try {
    const chat = await env.send("chat");
    env.store.settings = { ...env.store.settings, chatExecution: false };
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      (env.engine as any).request({
        id: method,
        method,
        params: { threadId: chat.threadId },
      });
      const reply = env.calls.at(-1)!;
      assert.equal(reply.method, "respond");
      if (method === "item/permissions/requestApproval")
        assert.deepEqual(reply.params.result.permissions, {});
      else assert.equal(reply.params.result.decision, "decline");
    }
    assert.equal(env.engine.approvals.length, 0);
  } finally {
    env.close();
  }
});

test("incognito reuse refuses a changed execution policy that cannot be reloaded", async () => {
  const env = setup();
  try {
    const chat = await env.send("chat", { incognito: true });
    env.store.conversation(chat.id).turns.at(-1)!.status = "completed";
    env.store.settings = { ...env.store.settings, chatExecution: false };
    const sent = env.calls.filter((c) => c.method === "turn/start").length;
    await assert.rejects(
      env.send("chat", { conversationId: chat.id }),
      /new incognito chat/,
    );
    assert.equal(
      env.calls.filter((c) => c.method === "turn/start").length,
      sent,
    );
  } finally {
    env.close();
  }
});
