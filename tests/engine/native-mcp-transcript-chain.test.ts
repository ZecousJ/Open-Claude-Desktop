/** Actual Engine notification → native transcript → Store reopen; no RPC or model. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { finishTurn } from "../../shared/activity";
import { registerExperimentalCodeSessions } from "../../electron/official-ui/native/code-sessions";
import type { Conversation } from "../../shared/types";
import { protectedToolFailure } from "../support/f040-auth-rejection";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-f089-"));
  const store = new Store(root);
  const c: Conversation = {
    id: "fixture",
    mode: "code",
    title: "MCP fixture",
    providerId: "inert",
    model: "inert",
    threadId: "thread",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "fixture",
        attachments: [],
        items: [],
        createdAt: 1,
        status: "inProgress",
      },
    ],
  };
  store.conversations.push(c);
  const listeners = new Set<(event: any) => void>();
  const engine = new Engine(
    store,
    "unused",
    () => "",
    (event) => {
      for (const listener of listeners) listener(event);
    },
  );
  const internals = engine as any;
  internals.routes.set("thread", c.id);
  const events: any[] = [],
    handlers = new Map<string, any>();
  let rpcCalls = 0;
  engine.rpc = {
    call: async () => {
      rpcCalls++;
      throw Error("No RPC is expected for replay");
    },
  } as any;
  const closeNative = registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "fixture-owner" }),
      settings: () => store.settings,
      sessionIdentity: () => 1,
      isCurrent: () => true,
      localLoadConversation: async (id: string) =>
        structuredClone(store.conversation(id)),
      localCall: async (name: string) => {
        assert.equal(name, "snapshot");
        return { approvals: [] };
      },
      onEvent: (fn: any) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      log: (...args: unknown[]) => {
        throw Error("Unexpected native log " + JSON.stringify(args));
      },
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit: (_a: string, _b: string, event: any) => events.push(event),
  } as any);
  const notify = (method: string, params: any) =>
    internals.notification({
      method,
      params: { threadId: "thread", turnId: "turn", ...params },
    });
  return {
    root,
    store,
    c,
    engine,
    events,
    handlers,
    notify,
    rpcCalls: () => rpcCalls,
    async flushEvents() {
      internals.changed(c, true);
      await new Promise((resolve) => setImmediate(resolve));
    },
    close() {
      closeNative();
      for (const timer of internals.notificationTimer.values())
        clearTimeout(timer);
      internals.notificationTimer.clear();
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a protected tool rejection identifies the bearer used by the active runtime", () => {
  const fixture = setup();
  try {
    const url = "https://example.test/mcp";
    fixture.store.settings.mcpServers.wiki = { url };
    fixture.engine.connectorHeaders = () => ({ Authorization: "Bearer later-token" });
    fixture.engine.startedMcpServers = JSON.stringify({
      wiki: { url, http_headers: { Authorization: "Bearer rejected-token" } },
    });
    const rejected: [string, string, string][] = [];
    fixture.engine.connectorAuthorizationRejected = (...args) => rejected.push(args);
    fixture.notify("item/completed", { item: protectedToolFailure });
    assert.deepEqual(rejected, [["wiki", url, "rejected-token"]]);
    fixture.store.settings.mcpServers.wiki = { url: "https://example.test/replaced" };
    fixture.notify("item/completed", { item: { ...protectedToolFailure, id: "another" } });
    assert.equal(rejected.length, 1);
    assert.doesNotMatch(JSON.stringify(fixture.c), /rejected-token|later-token/);
  } finally {
    fixture.close();
  }
});

test("explicit logout withdraws an otherwise anonymous connector from the runtime", () => {
  const fixture = setup();
  try {
    const url = "https://example.test/mcp";
    fixture.store.settings.mcpServers.wiki = { url };
    assert.equal(JSON.parse(fixture.engine.mcpConfig()).wiki.url, url);
    fixture.engine.connectorAuthStatus = () => "disconnected";
    assert.equal(JSON.parse(fixture.engine.mcpConfig()).wiki, undefined);
    fixture.engine.connectorAuthStatus = () => "connected";
    assert.equal(JSON.parse(fixture.engine.mcpConfig()).wiki.url, url);
  } finally {
    fixture.close();
  }
});

test("real Engine and Store preserve complex result through native live events and disk reopen", async () => {
  const h = setup();
  try {
    h.store.settings.mcpServers["Field-Notes"] = {
      display_name: "Field Notes",
      url: "https://example.com/mcp",
      claudex_directory_id: "a2545dc6-cc30-4f5b-8482-96108b4c5142",
    };
    h.notify("item/mcpToolCall/progress", {
      itemId: "tool",
      message: "looking up",
    });
    await h.flushEvents();
    assert.equal(h.c.turns[0].items[0].progress, "looking up");
    const pendingHistory = await h.handlers.get("LocalSessions.getTranscript")(
      "local_fixture",
    );
    assert.deepEqual(pendingHistory.map((row: { uuid: string }) => row.uuid), [
      "turn:user",
    ]);
    assert.deepEqual(
      h.events.filter((e) => e.type === "message").map((e) => e.message),
      pendingHistory,
    );
    h.notify("item/started", {
      item: {
        id: "tool",
        type: "mcpToolCall",
        server: "Field-Notes",
        tool: "fixture_widget-v2",
        appContext: null,
        mcpAppResourceUri: "ui://fixture/widget.html",
        arguments: { query: "fixture" },
        progress: "",
        status: "inProgress",
      },
    });
    await h.flushEvents();
    const pending = h.events.filter((e) => e.type === "message").at(-1).message;
    assert.equal(pending.uuid, "turn:tool:tool:use");
    assert.equal(pending.claudexToolProgress, "looking up");
    assert.equal(
      pending.message.content[0].name,
      "mcp__3d7dbae0-89f2-4b6b-85c5-392460c543f9__fixture_widget-v2",
    );
    h.notify("item/completed", {
      item: {
        id: "tool",
        type: "mcpToolCall",
        result: {
          content: [{ type: "text", text: "not found" }],
          structuredContent: { matches: [] },
          _meta: { token: "inert marker" },
          isError: true,
        },
      },
    });
    finishTurn(h.c.turns[0], "completed");
    await h.flushEvents();
    h.store.flush();
    const loaded = new Store(h.root).conversation(h.c.id);
    assert.deepEqual(loaded.turns[0].items, h.c.turns[0].items);
    const history = await h.handlers.get("LocalSessions.getTranscript")(
      "local_fixture",
    );
    const result = history.at(-1);
    assert.deepEqual(result.mcpMeta, { structuredContent: { matches: [] } });
    assert.deepEqual(result.toolUseResult, { structuredContent: { matches: [] } });
    assert.equal(result.message.content[0].is_error, true);
    const live = new Map(h.events.filter((e) => e.type === "message")
      .map((e) => [e.message.uuid, e.message]));
    assert.deepEqual([...live.values()], history);
    assert.equal(h.events.at(-1)?.type, "close");
    assert.equal(h.rpcCalls(), 0);
  } finally {
    h.close();
  }
});

test("reopening Store with an unfinished legacy running MCP preserves interrupted outcome", async () => {
  const h = setup();
  try {
    h.c.turns[0].items = [
      {
        id: "tool",
        type: "mcpToolCall",
        server: "wiki",
        tool: "lookup",
        status: "running",
        progress: "waiting",
      },
    ];
    h.store.flush();
    const loaded = new Store(h.root).conversation(h.c.id);
    assert.equal(loaded.turns[0].status, "interrupted");
    assert.equal(loaded.turns[0].items[0].lifecycleStatus, "interrupted");
    assert.equal(loaded.turns[0].items[0].progress, "waiting");
    assert.equal(h.rpcCalls(), 0);
  } finally {
    h.close();
  }
});
