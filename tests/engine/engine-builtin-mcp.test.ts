import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import { instructionOrder } from "../../electron/engine/engine-extensions";
import { openPolicy } from "../../shared/client-policy";
import {
  chatEffortLevels,
  toggledThinkingEffort,
} from "../../shared/chat-effort";

type Call = { method: string; params: any };

test("extension Node preference selects the bundled runtime without leaking extension metadata", () => {
  const env = setup();
  try {
    env.store.settings.mcpServers = {
      extension: {
        command: "node",
        args: ["server.js"],
        env: { EXAMPLE: "1" },
        claudex_extension: "/extension",
      },
      developer: { command: "node" },
    };
    const config = () => JSON.parse((env.engine as any).mcpConfig());
    assert.equal(config().extension.command, process.execPath);
    assert.deepEqual(config().extension.env, {
      EXAMPLE: "1",
      ELECTRON_RUN_AS_NODE: "1",
    });
    assert.equal(config().extension.claudex_extension, undefined);
    assert.equal(config().developer.command, "node");
    const before = (env.engine as any).runtimeKey();
    env.store.settings.extensionBuiltInNode = false;
    assert.equal(config().extension.command, "node");
    assert.notEqual((env.engine as any).runtimeKey(), before);
  } finally {
    env.close();
  }
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-builtin-mcp-"));
  const store = new Store(root);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.policy = () => openPolicy;
  const calls: Call[] = [];
  const responses: { id: unknown; result: unknown }[] = [];
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
    respond(id: unknown, result: unknown) {
      responses.push({ id, result });
    },
    reject() {},
  } as any;
  (engine as any).windowsSandbox = { assertReady() {}, async ensureReady() {} };
  const workspace = path.join(root, "work");
  return {
    root,
    store,
    engine,
    calls,
    responses,
    workspace,
    send: (extra: Record<string, unknown> = {}) =>
      engine.send({
        text: "Hello",
        mode: "cowork",
        cwd: workspace,
        attachments: [],
        providerId: "default",
        model: "m",
        ...extra,
      }),
    finish(conversationId: string) {
      for (const turn of store.conversation(conversationId).turns)
        turn.status = "completed";
    },
    close() {
      store.flush();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function browserExtension(state: { url: string }) {
  return {
    id: "browser",
    reservedMcpServerNames: ["claudex_browser"],
    builtinMcpServers: () => [
      {
        name: "claudex_browser",
        url: state.url,
        bearerTokenEnvVar: "CLAUDEX_BROWSER_MCP_TOKEN",
        defaultToolsApprovalMode: "approve" as const,
      },
    ],
    processEnv: () => ({ CLAUDEX_BROWSER_MCP_TOKEN: "stable-token" }),
  };
}

test("Chat thinking choices reach native turn/start and persist for subsequent turns", async () => {
  const env = setup();
  try {
    const effort = toggledThinkingEffort("low", chatEffortLevels)!;
    const chat = await env.send({ mode: "chat", effort });
    const sentEffort = () =>
      env.calls.filter((call) => call.method === "turn/start").at(-1)!.params
        .effort;
    assert.equal(sentEffort(), "high");
    env.finish(chat.id);
    await env.send({
      mode: "chat",
      conversationId: chat.id,
      effort: toggledThinkingEffort(effort, chatEffortLevels),
    });
    assert.equal(sentEffort(), "low");
    env.finish(chat.id);
    await env.send({ mode: "chat", conversationId: chat.id });
    assert.equal(sentEffort(), "low");
    env.store.flush();
    assert.equal(new Store(env.root).conversation(chat.id).effort, "low");
  } finally {
    env.close();
  }
});

test("project effort defaults reach turns without changing global settings and allow session overrides", async () => {
  const env = setup();
  try {
    env.store.settings.effort = "high";
    env.store.projects.push({
      id: "p",
      name: "Project",
      description: "",
      instructions: "",
      createdAt: 1,
      defaultEffort: "low",
    });
    const chat = await env.send({ mode: "chat", projectId: "p" });
    assert.equal(chat.effort, "low");
    assert.equal(
      env.calls.filter((call) => call.method === "turn/start").at(-1)!.params
        .effort,
      "low",
    );
    assert.equal(env.store.settings.effort, "high");
    env.finish(chat.id);
    await env.send({ conversationId: chat.id, mode: "chat", effort: "max" });
    assert.equal(env.store.conversation(chat.id).effort, "max");
    env.store.flush();
    assert.equal(new Store(env.root).conversation(chat.id).effort, "max");
    assert.equal(
      env.calls.filter((call) => call.method === "turn/start").at(-1)!.params
        .effort,
      "max",
    );
    env.finish(chat.id);
    env.store.projects[0].defaultEffort = "medium";
    await env.send({ conversationId: chat.id, mode: "chat" });
    assert.equal(
      env.calls.filter((call) => call.method === "turn/start").at(-1)!.params
        .effort,
      "max",
    );
  } finally {
    env.close();
  }
});

test("new project chats inherit persisted tools, preserve chat overrides and leave global connectors alone", async () => {
  const env = setup();
  try {
    env.store.settings.mcpServers = {
      project_tool: {
        command: "server",
        enabled: false,
        disabled_tools: ["read"],
      },
      other: { command: "other" },
    };
    env.store.projects.push({
      id: "p",
      name: "Project",
      description: "",
      instructions: "project instructions",
      createdAt: 1,
      tools: { webSearch: true, research: true, connectors: ["project_tool"] },
    });
    env.store.flush();
    assert.deepEqual(
      new Store(env.root).projects[0].tools,
      env.store.projects[0].tools,
    );
    const chat = await env.send({ mode: "chat", projectId: "p" });
    assert.equal(chat.webSearch, true);
    assert.equal(chat.research, true);
    assert.deepEqual(chat.connectorOverrides, { project_tool: true });
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.equal(start.params.config["mcp_servers.project_tool.enabled"], true);
    assert.equal(
      start.params.config["mcp_servers.project_tool.disabled_tools"],
      undefined,
    );
    assert.equal(start.params.config["mcp_servers.other.enabled"], undefined);
    assert.match(start.params.developerInstructions, /project instructions/);
    env.finish(chat.id);
    env.store.projects[0].tools = { connectors: ["other"] };
    env.store.conversation(chat.id).connectorOverrides = {
      project_tool: false,
    };
    await env.send({ conversationId: chat.id, mode: "chat", projectId: "p" });
    const resume = env.calls.find((call) => call.method === "thread/resume")!;
    assert.equal(
      resume.params.config["mcp_servers.project_tool.enabled"],
      false,
    );
    assert.equal(resume.params.config["mcp_servers.other.enabled"], undefined);
    assert.equal(
      (env.store.settings.mcpServers.project_tool as any).enabled,
      false,
    );
    assert.deepEqual(
      (env.store.settings.mcpServers.project_tool as any).disabled_tools,
      ["read"],
    );
    env.finish(chat.id);
    const plain = await env.send({ mode: "chat" });
    assert.deepEqual(plain.connectorOverrides, {});
    assert.equal(plain.research, undefined);
  } finally {
    env.close();
  }
});

test("project tools respect administrator restrictions and explicit draft choices", async () => {
  const env = setup();
  try {
    env.store.settings.mcpServers = { blocked: { command: "server" } };
    env.store.projects.push({
      id: "p",
      name: "Project",
      description: "",
      instructions: "",
      createdAt: 1,
      tools: { webSearch: true, research: true, connectors: ["blocked"] },
    });
    env.engine.policy = () => ({
      ...openPolicy,
      webSearch: false,
      connectors: [],
    });
    const chat = await env.send({ mode: "chat", projectId: "p" });
    assert.equal(chat.webSearch, false);
    assert.equal(chat.research, undefined);
    assert.equal(
      env.calls.find((call) => call.method === "thread/start")!.params.config[
        "mcp_servers.blocked.enabled"
      ],
      undefined,
    );
    env.finish(chat.id);
    env.engine.policy = () => openPolicy;
    const explicit = await env.send({
      mode: "chat",
      projectId: "p",
      webSearch: false,
      research: false,
      connectorOverrides: { blocked: false },
    });
    assert.equal(explicit.webSearch, false);
    assert.equal(explicit.research, undefined);
    assert.deepEqual(explicit.connectorOverrides, { blocked: false });
  } finally {
    env.close();
  }
});

test("a thread starts with the extensions' servers, tools, config, instructions and turn extras", async () => {
  const env = setup();
  try {
    const extra = path.join(env.root, "extra");
    env.engine.extensions.add(
      browserExtension({ url: "http://127.0.0.1:9/mcp" }),
    );
    env.engine.extensions.add({
      id: "research",
      order: instructionOrder.research,
      developerInstructions: () => "RESEARCH-BLOCK",
      threadConfigOverrides: () => ({ web_search: "live" }),
      dynamicTools: () => [
        {
          type: "function",
          name: "research_plan",
          description: "Plan",
          inputSchema: { type: "object" },
        },
      ],
    });
    env.engine.extensions.add({
      id: "memory",
      order: instructionOrder.memory,
      developerInstructions: () => "<user_memory>likes tea</user_memory>",
      turnContext: () => ({ update: "Memory changed" }),
    });
    env.engine.extensions.add({
      id: "cowork",
      turnSandboxExtras: () => [extra],
    });
    const conversation = await env.send();
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.equal(start.params.config.web_search, "live");
    assert.equal(
      start.params.config["mcp_servers.claudex_browser.url"],
      "http://127.0.0.1:9/mcp",
    );
    assert.equal(
      start.params.config["mcp_servers.claudex_browser.bearer_token_env_var"],
      "CLAUDEX_BROWSER_MCP_TOKEN",
    );
    assert.deepEqual(
      start.params.dynamicTools.map((tool: any) => tool.name),
      ["research_plan"],
    );
    const instructions: string = start.params.developerInstructions;
    const at = (text: string) => instructions.indexOf(text);
    assert.ok(
      at("<user_memory>") >= 0 && at("<user_memory>") < at("RESEARCH-BLOCK"),
    );
    assert.ok(
      at("RESEARCH-BLOCK") < at("You are a collaborative desktop assistant"),
    );
    assert.match(instructions, /short description \(5-10 words, imperative\)/);
    const turn = env.calls.find((call) => call.method === "turn/start")!;
    assert.deepEqual(turn.params.additionalContext, {
      "memory.update": { value: "Memory changed", kind: "application" },
    });
    // A Manual task (the default) writes in its folder and the added one,
    // and asks the person before anything else.
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(turn.params.sandboxPolicy.writableRoots.length, 2);
    assert.equal(turn.params.approvalPolicy, "on-request");
    assert.equal(turn.params.approvalsReviewer, "user");
    assert.ok(conversation.threadId);
  } finally {
    env.close();
  }
});

test("Code session extra folders reach the turn sandbox and can be revoked", async () => {
  const env = setup();
  try {
    const initial = path.join(env.root, "initial");
    const started = await env.send({
      mode: "code",
      additionalFolders: [initial, initial, env.workspace],
    });
    const conversation = env.store.conversation(started.id);
    assert.deepEqual(conversation.additionalFolders, [initial]);
    const firstTurn = env.calls
      .filter((call) => call.method === "turn/start")
      .at(-1)!;
    assert.ok(firstTurn.params.sandboxPolicy.writableRoots.includes(initial));
    assert.match(
      firstTurn.params.additionalContext["code.folders"].value,
      /initial/,
    );
    env.finish(conversation.id);
    const folder = path.join(env.root, "docs");
    conversation.additionalFolders = [folder];
    await env.send({ mode: "code", conversationId: conversation.id });
    const turns = () =>
      env.calls.filter((call) => call.method === "turn/start");
    assert.ok(
      turns().at(-1)!.params.sandboxPolicy.writableRoots.includes(folder),
    );
    assert.match(
      turns().at(-1)!.params.additionalContext["code.folders"].value,
      /docs/,
    );
    env.finish(conversation.id);
    conversation.additionalFolders = [];
    await env.send({ mode: "code", conversationId: conversation.id });
    assert.ok(
      !turns().at(-1)!.params.sandboxPolicy.writableRoots.includes(folder),
    );
    assert.match(
      turns().at(-1)!.params.additionalContext["code.folders"].value,
      /No additional folders/,
    );
  } finally {
    env.close();
  }
});

test("without extensions a turn is sent exactly as before", async () => {
  const env = setup();
  try {
    env.engine.describeTools = false;
    await env.send();
    const start = env.calls.find((call) => call.method === "thread/start")!;
    assert.equal(start.params.dynamicTools, undefined);
    assert.deepEqual(Object.keys(start.params.config), ["web_search"]);
    assert.doesNotMatch(
      start.params.developerInstructions,
      /short description/,
    );
    const turn = env.calls.find((call) => call.method === "turn/start")!;
    assert.equal(turn.params.additionalContext, undefined);
    // A task's turn always carries its permission mode, which can change
    // between turns.
    assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(turn.params.approvalPolicy, "on-request");
  } finally {
    env.close();
  }
});

test("per-thread servers go with every resume, and a changed set reloads a loaded thread", async () => {
  const env = setup();
  try {
    const state = { url: "http://127.0.0.1:9/mcp" };
    env.engine.extensions.add(browserExtension(state));
    env.engine.extensions.add({
      id: "tools",
      dynamicTools: () => [
        { type: "function", name: "t", description: "t", inputSchema: {} },
      ],
    });
    const first = await env.send();
    env.finish(first.id);
    // Same servers: the loaded thread is used as is.
    env.calls.length = 0;
    await env.send({ conversationId: first.id });
    env.finish(first.id);
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["turn/start"],
    );
    // The server moved: unsubscribe and resume with the new address.
    state.url = "http://127.0.0.1:10/mcp";
    env.calls.length = 0;
    await env.send({ conversationId: first.id });
    env.finish(first.id);
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["thread/unsubscribe", "thread/resume", "turn/start"],
    );
    const resume = env.calls[1].params;
    assert.equal(resume.config["mcp_servers.claudex_browser.url"], state.url);
    assert.equal(
      resume.dynamicTools,
      undefined,
      "dynamic tools are start-only",
    );
    // After a restart the thread is resumed with its servers again.
    (env.engine as any).loaded.clear();
    env.calls.length = 0;
    await env.send({ conversationId: first.id });
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["thread/resume", "turn/start"],
    );
    assert.equal(
      env.calls[0].params.config["mcp_servers.claudex_browser.url"],
      state.url,
    );
  } finally {
    env.close();
  }
});

test("a retry fork is loaded again so its per-thread tools come back", async () => {
  const env = setup();
  try {
    env.engine.extensions.add(
      browserExtension({ url: "http://127.0.0.1:9/mcp" }),
    );
    const first = await env.send();
    env.finish(first.id);
    await env.send({ conversationId: first.id });
    env.finish(first.id);
    const turns = env.store.conversation(first.id).turns;
    env.calls.length = 0;
    await env.engine.retryResponse(first.id, turns[1].id, "default", "m");
    assert.deepEqual(
      env.calls.map((call) => call.method),
      ["thread/fork", "thread/unsubscribe", "thread/resume", "turn/start"],
    );
    const forkId = env.calls[1].params.threadId;
    assert.equal(env.calls[2].params.threadId, forkId);
    assert.equal(
      env.calls[2].params.config["mcp_servers.claudex_browser.url"],
      "http://127.0.0.1:9/mcp",
    );
    assert.equal(env.store.conversation(first.id).threadId, forkId);
  } finally {
    env.close();
  }
});

test("user servers named like a built-in one are not started, and extension env or config changes restart the agent", async () => {
  const env = setup();
  try {
    env.store.settings.mcpServers = {
      claudex_browser: { command: "evil" },
      notes: { command: "notes-mcp" },
    } as any;
    const internals = env.engine as any;
    assert.deepEqual(Object.keys(JSON.parse(internals.mcpConfig())), [
      "claudex_browser",
      "notes",
    ]);
    const before = internals.runtimeKey();
    env.engine.extensions.add(browserExtension({ url: "http://127.0.0.1:9/" }));
    assert.deepEqual(Object.keys(JSON.parse(internals.mcpConfig())), ["notes"]);
    assert.notEqual(internals.runtimeKey(), before);
    // ensure() starts again when the key changed.
    const fresh = new Engine(
      env.store,
      "unused",
      () => "",
      () => {},
    );
    fresh.policy = () => openPolicy;
    let starts = 0;
    (fresh as any).start = async () => {
      starts++;
      (fresh as any).startedMcp = (fresh as any).runtimeKey();
      fresh.state = { state: "ready" };
    };
    fresh.rpc = {} as any;
    const provider = env.store.settings.providers[0];
    await fresh.ensure(provider);
    (fresh as any).providerId = provider.id;
    await fresh.ensure(provider);
    assert.equal(starts, 1);
    fresh.extensions.add({
      id: "memory",
      appServerConfig: () => ({ "features.memories": false }),
    });
    await fresh.ensure(provider);
    assert.equal(starts, 2);
  } finally {
    env.close();
  }
});

test("an extension can refuse a message before anything starts", async () => {
  const env = setup();
  try {
    env.engine.extensions.add({
      id: "research",
      beforeSend: (ctx) => {
        if (ctx.mode === "cowork")
          throw new Error("Research isn't available for this model.");
      },
    });
    await assert.rejects(env.send(), /Research isn't available/);
    assert.deepEqual(env.calls, []);
    assert.equal(env.store.conversations.length, 0);
  } finally {
    env.close();
  }
});

test("dynamic tool calls are answered by extensions for the routed conversation only", async () => {
  const env = setup();
  try {
    let seen: any;
    env.engine.extensions.add({
      id: "memory",
      handleDynamicTool: (call) => {
        seen = call;
        call.changed();
        return {
          contentItems: [{ type: "inputText", text: "remembered" }],
          success: true,
        };
      },
    });
    const conversation = await env.send();
    const internals = env.engine as any;
    internals.request({
      id: 7,
      method: "item/tool/call",
      params: {
        threadId: conversation.threadId,
        turnId: conversation.turns[0].id,
        callId: "call-1",
        namespace: null,
        tool: "memory_edits",
        arguments: { add: "likes tea" },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(env.responses, [
      {
        id: 7,
        result: {
          contentItems: [{ type: "inputText", text: "remembered" }],
          success: true,
        },
      },
    ]);
    assert.equal(seen.conversation.id, conversation.id);
    assert.equal(seen.turn.id, conversation.turns[0].id);
    assert.deepEqual(seen.arguments, { add: "likes tea" });
    // An unknown thread is refused before any extension sees it.
    let rejected = 0;
    env.engine.rpc!.reject = () => {
      rejected++;
    };
    internals.request({
      id: 8,
      method: "item/tool/call",
      params: { threadId: "other", tool: "memory_edits" },
    });
    assert.equal(rejected, 1);
  } finally {
    env.close();
  }
});

test("turn completion reaches extensions", async () => {
  const env = setup();
  try {
    const completed: string[] = [];
    env.engine.extensions.add({
      id: "research",
      onTurnCompleted: (_c, turn) =>
        completed.push(`${turn.id}:${turn.status}`),
    });
    const conversation = await env.send();
    (env.engine as any).notification({
      method: "turn/completed",
      params: {
        threadId: conversation.threadId,
        turn: { id: conversation.turns[0].id, status: "completed" },
      },
    });
    assert.deepEqual(completed, [`${conversation.turns[0].id}:completed`]);
  } finally {
    env.close();
  }
});
