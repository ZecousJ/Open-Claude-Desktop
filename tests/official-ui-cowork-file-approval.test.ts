import test from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { Approval, Conversation } from "../shared/types";

test("Cowork exposes and resolves only the current file change approval", async () => {
  const c: Conversation = {
    id: "cowork",
    title: "Task",
    mode: "cowork",
    cwd: "/tmp",
    providerId: "p",
    model: "m",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [
      {
        id: "turn",
        status: "inProgress",
        prompt: "Create file",
        createdAt: 1,
        attachments: [],
        items: [
          {
            id: "patch",
            type: "fileChange",
            status: "inProgress",
            lifecycleStatus: "inProgress",
            changes: [
              {
                path: "/tmp/example.txt",
                kind: { type: "add" },
                diff: "hello\n",
              },
            ],
          },
        ],
      },
    ],
  };
  const approval: Approval = {
    id: 42,
    conversationId: c.id,
    method: "item/fileChange/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "patch",
      grantRoot: null,
      reason: "retry without sandbox",
    },
  };
  let approvals = [approval];
  const calls: unknown[][] = [];
  const events: any[] = [];
  let listener: (event: any) => void = () => {};
  const handlers = new Map<string, (...args: any[]) => any>();
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      localLoadConversation: async (id: string) =>
        id === c.id ? c : undefined,
      onEvent(fn: (event: any) => void) {
        listener = fn;
        return () => {};
      },
      log() {},
      localCall: async (method: string, ...args: unknown[]) => {
        if (method === "snapshot") return { approvals };
        if (method === "coworkFolderAccess") return { state: "default" };
        if (method === "mcpServers") return { servers: [] };
        calls.push([method, ...args]);
        if (method === "approve") {
          approvals = [];
          listener({ type: "approval-resolved", id: 42 });
        }
      },
    },
    on(name: string, fn: any) {
      handlers.set(name, fn);
    },
    emit(_a: string, _b: string, event: any) {
      events.push(event);
    },
  } as never);
  const invoke = (name: string, ...args: unknown[]) =>
    handlers.get(`LocalAgentModeSessions.${name}`)!(...args);
  const session = await invoke("getSession", "local_cowork");
  const card = session.pendingToolPermissions[0];
  assert.equal(card.requestId, "42");
  assert.equal(card.toolName, "Write");
  assert.equal(card.input.file_path, "/tmp/example.txt");
  assert.equal(card.decisionReason, "retry without sandbox");
  listener({ type: "approval", approval });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    events.some(
      (row) =>
        row.type === "tool_permission_request" &&
        row.request.requestId === "42",
    ),
  );
  await assert.rejects(
    invoke("respondToToolPermission", "42", "once", { file_path: "/other" }),
    /Edited approval/,
  );
  assert.equal(calls.length, 0);
  await invoke("respondToToolPermission", "42", "deny");
  assert.deepEqual(calls, [["approve", 42, { decision: "decline" }]]);
  assert.ok(events.some((row) => row.type === "tool_permission_resolved"));
  await assert.rejects(
    invoke("respondToToolPermission", "42", "once"),
    /no longer available/,
  );
  approvals = [
    { ...approval, params: { ...approval.params, turnId: "stale" } },
  ];
  assert.deepEqual(
    (await invoke("getSession", "local_cowork")).pendingToolPermissions,
    [],
  );
  approvals = [
    { ...approval, params: { ...approval.params, grantRoot: "/outside" } },
  ];
  assert.deepEqual(
    (await invoke("getSession", "local_cowork")).pendingToolPermissions,
    [],
  );
  approvals = [approval];
  c.turns.push({ ...c.turns[0] });
  assert.deepEqual(
    (await invoke("getSession", "local_cowork")).pendingToolPermissions,
    [],
  );
  c.turns.pop();
  await invoke("respondToToolPermission", "42", "once");
  assert.deepEqual(calls.at(-1), ["approve", 42, { decision: "accept" }]);
});
