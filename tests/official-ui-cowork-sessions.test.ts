import { test } from "node:test";
import assert from "node:assert/strict";
import { permissionKeys } from "../electron/official-ui/api/connectors";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { McpServerState } from "../shared/settings-desktop-api";
import type { AppEvent, Conversation } from "../shared/types";

test("confirmed project deletion removes a Cowork row through the original event", () => {
  const events: unknown[][] = [];
  let notify: ((event: AppEvent) => void) | undefined;
  registerExperimentalCoworkSessions({
    ctx: { onEvent(listener: (event: AppEvent) => void) { notify = listener; return () => {}; } },
    on() {},
    emit(...args: unknown[]) { events.push(args); },
  } as never);
  assert.ok(notify);
  notify({ type: "cowork-session-deleted", conversationId: "project-task" });
  assert.deepEqual(events, [
    ["LocalAgentModeSessions", "onEvent", { type: "deleted", sessionId: "local_project-task" }],
  ]);
});

test("Cowork session reads stay in mode and never infer an external folder grant", async () => {
  const c: Conversation = {
    id: "cowork",
    title: "Task",
    mode: "cowork",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "turn",
        prompt: "Hello",
        attachments: [],
        status: "completed",
        createdAt: 1,
        items: [{ id: "answer", type: "agentMessage", text: "World" }],
      },
    ],
  };
  const connector = {
    name: "wiki",
    url: "https://example.test/mcp",
    state: "ready",
    toolList: [{ name: "search", enabled: true, approval: "prompt" }],
  } as McpServerState;
  c.connectorOverrides = { wiki: false };
  c.connectorToolOverrides = { wiki: { search: false } };
  const handlers = new Map<string, (...args: any[]) => any>();
  let sends = 0;
  let connectorReads = 0;
  let lastInput: any;
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: "fixture" }),
      localListConversations: async () => [
        c,
        { ...c, id: "cloud-mirror", cloudHosted: true },
        { ...c, id: "code", mode: "code" },
      ],
      localLoadConversation: async (id: string) =>
        id === c.id ? c : undefined,
      onEvent: () => () => {},
      settings: () => ({
        providers: [{ id: "p", model: "m" }],
        activeProviderId: "p",
        mcpServers: { wiki: { url: connector.url } },
      }),
      localCall: async (_name: string, input: unknown) => {
        if (_name === "snapshot") return { approvals: [] };
        if (_name === "coworkFolderAccess") return { state: "default" };
        if (_name === "mcpServers") {
          connectorReads++;
          return { servers: [connector] };
        }
        sends++;
        lastInput = input;
        // The real send contract returns the requested new conversation ID.
        const requestedId =
          input && typeof input === "object" && "newConversationId" in input
            ? input.newConversationId
            : undefined;
        return {
          ...c,
          id: typeof requestedId === "string" ? requestedId : c.id,
        };
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit() {},
  } as never);
  const list = await handlers.get("LocalAgentModeSessions.getSessionList")!();
  assert.deepEqual(
    list.sessions.map((row: { sessionId: string }) => row.sessionId),
    ["local_cowork"],
  );
  const hydrated = await handlers.get("LocalAgentModeSessions.getSession")!(
    "local_cowork",
  );
  assert.equal(
    hydrated.enabledMcpTools[
      permissionKeys(connector, connector.toolList![0]).enabled
    ],
    false,
  );
  assert.equal(
    connectorReads,
    0,
    "Cowork restore must not wait for live connector discovery",
  );
  assert.deepEqual(list.sessions[0].userSelectedFolders, []);
  assert.equal(
    (
      await handlers.get("LocalAgentModeSessions.getTranscript")!(
        "local_cowork",
      )
    ).length,
    2,
  );
  await assert.rejects(
    handlers.get("LocalAgentModeSessions.start")!({
      message: "hi",
      userSelectedFolders: [process.cwd()],
    }),
    /Allow the selected Cowork folder/,
  );
  assert.equal(sends, 0);
  assert.deepEqual(
    await handlers.get("LocalAgentModeSessions.start")!({ message: "hi" }),
    { sessionId: "local_cowork" },
  );
  assert.equal(sends, 1, "local Cowork must use the desktop local handler");
  const sessionId = "local_2f3a06f5-a30a-46a0-a914-5021272f6c23";
  assert.deepEqual(
    await handlers.get("LocalAgentModeSessions.start")!({
      message: "hi",
      sessionId,
      systemPrompt: "Base\n\nAppend",
      systemPromptRendererAppends: ["Append"],
    }),
    { sessionId },
  );
  assert.equal(
    lastInput.sessionInstructions,
    "Base\n\nAppend",
    "renderer appends must not be duplicated",
  );
  assert.equal(lastInput.newConversationId, sessionId.slice(6));
  await assert.rejects(
    handlers.get("LocalAgentModeSessions.start")!({
      message: "hi",
      systemPrompt: { forged: true },
    }),
    /Invalid Cowork system prompt/,
  );
  await assert.rejects(
    handlers.get("LocalAgentModeSessions.start")!({
      message: "hi",
      systemPromptRendererAppends: [42],
    }),
    /Invalid Cowork system prompt appends/,
  );
  await handlers.get("LocalAgentModeSessions.sendMessage")!(
    "local_cowork",
    "follow-up",
    [],
    [],
    "uuid",
    [],
    [],
    [],
    false,
    true,
    false,
    true,
    true,
    [],
    undefined,
    { personSent: true },
  );
  assert.equal(lastInput.thinkingMode, "extended");
});

test("Cowork command permissions hydrate and resolve with the original request's decision", async () => {
  const c = {
    id: "cowork",
    title: "Task",
    mode: "cowork",
    cwd: process.cwd(),
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  } as Conversation;
  const approval = {
    id: 32,
    conversationId: c.id,
    method: "item/commandExecution/requestApproval",
    params: { command: "printf permission-test" },
  };
  let pending = [approval];
  let listener!: (event: any) => void;
  const calls: unknown[][] = [],
    events: any[] = [],
    handlers = new Map<string, (...args: any[]) => any>();
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: "fixture" }),
      localLoadConversation: async (id: string) =>
        id === c.id ? c : undefined,
      onEvent(fn: (event: any) => void) {
        listener = fn;
        return () => {};
      },
      log() {},
      async localCall(method: string, ...args: unknown[]) {
        if (method === "snapshot") return { approvals: pending };
        if (method === "coworkFolderAccess") return { state: "default" };
        if (method === "mcpServers") return { servers: [] };
        calls.push([method, ...args]);
        if (method === "approve") {
          pending = [];
          listener({ type: "approval-resolved", id: approval.id });
        }
      },
    },
    on(name: string, fn: (...args: any[]) => any) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: any) {
      events.push(event);
    },
  } as never);
  const run = (method: string, ...args: unknown[]) =>
    handlers.get(`LocalAgentModeSessions.${method}`)!(...args);
  const session = await run("getSession", "local_cowork");
  assert.deepEqual(session.pendingToolPermissions[0].input, {
    command: "printf permission-test",
  });
  assert.equal(session.pendingToolPermissions[0].suppressAlwaysAllowRule, true);
  await assert.rejects(
    run("respondToToolPermission", "32", "always"),
    /Only allow once or deny/,
  );
  await assert.rejects(
    run("respondToToolPermission", "32", "once", { command: "other command" }),
    /Edited approval input/,
  );
  assert.equal(calls.length, 0);
  listener({ type: "approval", approval });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "tool_permission_request"));
  await run("respondToToolPermission", "32", "deny");
  assert.deepEqual(calls, [["approve", 32, { decision: "decline" }]]);
  assert.ok(events.some((event) => event.type === "tool_permission_resolved"));
  assert.deepEqual(
    (await run("getSession", "local_cowork")).pendingToolPermissions,
    [],
  );
  await assert.rejects(
    run("respondToToolPermission", "32", "once"),
    /no longer available/,
  );
  pending = [
    {
      ...approval,
      params: { ...approval.params, additionalPermissions: { network: true } },
    } as typeof approval,
  ];
  assert.deepEqual(
    (await run("getSession", "local_cowork")).pendingToolPermissions,
    [],
  );
});
