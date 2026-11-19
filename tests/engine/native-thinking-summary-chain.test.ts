/** Native preference → real Store/update handler → Engine; RPC is inert, no model process. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import { openPolicy } from "../../shared/client-policy";
import type { Conversation, Turn } from "../../shared/types";

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

import { registerExperimentalCodeSessions } from "../../electron/official-ui/native/code-sessions";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
function nativePreference(env: ReturnType<typeof setup>) {
  const service = new Map<string, any>(),
    native = new Map<string, any>();
  registerConversationHandlers((name, handler) => service.set(name, handler), {
    store: env.store,
    engine: env.engine,
    accountGeneration: () => 1,
    activeAccount: { id: "synthetic" } as any,
    replyFeedback: {} as any,
    selectedAttachments: new Map(),
    allowedFolder() {},
    noActive() {},
  });
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "synthetic" }),
      sessionIdentity: () => 1,
      isCurrent: () => true,
      settings: () => env.store.settings,
      localLoadConversation: async (id: string) =>
        structuredClone(env.store.conversation(id)),
      localCall: async (name: string, ...args: any[]) => {
        const fn = service.get(name);
        if (!fn) throw Error("Unexpected service");
        return fn(...args);
      },
      onEvent: () => () => {},
      log() {},
    },
    on: (name: string, fn: any) => native.set(name, fn),
    emit() {},
  } as any);
  return native.get("LocalSessions.setThinkingSummariesWanted");
}
const answer = (method: string) =>
  method === "turn/start"
    ? { turn: { id: "new-turn" } }
    : method === "thread/start"
      ? { thread: { id: "thread" } }
      : {};
test("actual native wanted update survives Store flush and existing-session model switch into engine turn/start", async () => {
  const env = setup(answer);
  try {
    const wanted = nativePreference(env);
    await wanted("local_c", false);
    await wanted("local_c", true);
    assert.equal(
      new Store(env.store.root).conversation("c").thinkingSummariesWanted,
      true,
    );
    await env.engine.send(
      {
        conversationId: "c",
        text: "inert",
        mode: "code",
        attachments: [],
        providerId: "p",
        model: "big",
      },
      undefined,
      false,
      { newTaskResolved: true },
    );
    const wire = env.calls.find((x) => x.method === "turn/start")!.params;
    assert.equal(wire.summary, "auto");
    assert.equal(wire.model, "big");
    assert.equal(env.c.thinkingSummariesWanted, true);
    env.notify("item/reasoning/summaryTextDelta", {
      turnId: "new-turn",
      itemId: "reasoning",
      summaryIndex: 0,
      delta: "Synthetic summary",
    });
    env.notify("item/started", {
      turnId: "new-turn",
      item: { id: "reasoning", type: "reasoning", summary: [], content: [] },
    });
    const projection = convertCodeTranscript(env.c);
    assert.ok(
      projection.rows.some(
        (row) =>
          Array.isArray(row.message.content) &&
          row.message.content.some(
            (x) => x.type === "thinking" && x.thinking === "Synthetic summary",
          ),
      ),
    );
    env.notify("item/completed", {
      turnId: "new-turn",
      item: {
        id: "reasoning",
        type: "reasoning",
        summary: ["Synthetic summary"],
        content: ["RAW_REASONING_SENTINEL"],
      },
    });
    assert.ok(
      convertCodeTranscript(env.c).rows.some(
        (row) => row.claudexReasoning?.[0] === "Synthetic summary",
      ),
    );
    env.store.flush();
    const reloaded = convertCodeTranscript(
      new Store(env.store.root).conversation("c"),
    );
    assert.ok(
      reloaded.rows.some(
        (row) => row.claudexReasoning?.[0] === "Synthetic summary",
      ),
    );
    assert.equal(
      JSON.stringify(reloaded).includes("RAW_REASONING_SENTINEL"),
      false,
    );
  } finally {
    env.close();
  }
});

test("Normal requests no future summaries without removing earlier public summaries", async () => {
  const earlier = turn("history");
  earlier.items = [
    { id: "reason", type: "reasoning", summary: ["Existing public summary"] },
  ];
  const env = setup(answer, [earlier]);
  try {
    await nativePreference(env)("local_c", false);
    await env.engine.send(
      {
        conversationId: "c",
        text: "inert",
        mode: "code",
        attachments: [],
        providerId: "p",
        model: "big",
      },
      undefined,
      false,
      { newTaskResolved: true },
    );
    assert.equal(
      env.calls.find((call) => call.method === "turn/start")!.params.summary,
      "none",
    );
    assert.ok(
      convertCodeTranscript(env.c).rows.some(
        (row) => row.claudexReasoning?.[0] === "Existing public summary",
      ),
    );
  } finally {
    env.close();
  }
});
test("global on-demand off omits explicit per-turn summary even when native preference is wanted", async () => {
  const env = setup(answer);
  try {
    await nativePreference(env)("local_c", true);
    env.store.settings.ccdThinkingSummaryOnDemand = false;
    await env.engine.send(
      {
        conversationId: "c",
        text: "inert",
        mode: "code",
        attachments: [],
        providerId: "p",
        model: "big",
      },
      undefined,
      false,
      { newTaskResolved: true },
    );
    const wire = env.calls.find((x) => x.method === "turn/start")!.params;
    assert.equal(Object.hasOwn(wire, "summary"), false);
    assert.equal(env.c.thinkingSummariesWanted, true);
  } finally {
    env.close();
  }
});
