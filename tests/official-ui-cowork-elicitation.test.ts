import { test } from "node:test";
import assert from "node:assert/strict";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import type { Approval, AppEvent, Conversation } from "../shared/types";

test("Cowork answers only the current account's displayed form and link", async () => {
  const conversation: Conversation = {
    id: "task",
    title: "Task",
    mode: "cowork",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread",
    sessionAuthors: {
      ownerAccountUuid: "account",
      viewerAccountUuid: "account",
    },
    turns: [
      {
        id: "turn",
        status: "inProgress",
        prompt: "Ask",
        attachments: [],
        items: [],
        createdAt: 1,
      },
    ],
  };
  const schema = {
    type: "object",
    properties: { count: { type: "integer" }, ok: { type: "boolean" } },
    required: ["count", "ok"],
  };
  const form: Approval = {
    id: 7,
    conversationId: "task",
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread",
      turnId: "turn",
      serverName: "fixture",
      mode: "form",
      message: "Choose",
      requestedSchema: schema,
    },
  };
  const link: Approval = {
    ...form,
    params: {
      threadId: "thread",
      turnId: "turn",
      serverName: "fixture",
      mode: "url",
      message: "Connect",
      url: "https://example.com/connect",
    },
  };
  let approvals = [form],
    owner = "account",
    identity = {};
  let listener: (event: AppEvent) => void = () => {};
  const responses: unknown[] = [],
    events: unknown[] = [];
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  registerExperimentalCoworkSessions({
    ctx: {
      account: () => ({ id: owner }),
      sessionIdentity: () => identity,
      localListConversations: async () => [structuredClone(conversation)],
      localLoadConversation: async (id: string) =>
        id === conversation.id ? structuredClone(conversation) : undefined,
      localCall: async (name: string) => {
        if (name === "snapshot") return { approvals };
        if (name === "mcpServers") return { servers: [] };
        throw Error(name);
      },
      respondToLocalCodeElicitation: (
        approval: Approval,
        response: unknown,
      ) => {
        assert.ok(approvals.includes(approval));
        responses.push(response);
        approvals = approvals.filter((item) => item !== approval);
        listener({ type: "approval-resolved", id: approval.id });
      },
      onEvent: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
    },
    on(name: string, fn: (...args: any[]) => Promise<any>) {
      handlers.set(name, fn);
    },
    emit(_domain: string, _channel: string, event: unknown) {
      events.push(event);
    },
  } as never);
  const get = async () =>
    (await handlers.get("LocalAgentModeSessions.getAll")!())[0]
      .pendingToolPermissions;
  const respond = handlers.get(
    "LocalAgentModeSessions.respondToToolPermission",
  )!;
  const [offer] = await get();
  assert.equal(offer.isElicitation, true);
  assert.deepEqual(offer.elicitationForm, {
    message: "Choose",
    requestedSchema: schema,
    fieldNames: ["count", "ok"],
  });
  assert.equal((await get())[0].requestId, offer.requestId);
  await assert.rejects(
    respond("7", "once", { action: "accept", content: { count: 2, ok: true } }),
  );
  await assert.rejects(
    respond(offer.requestId, "once", {
      action: "accept",
      content: { count: "2", ok: true },
    }),
  );
  await assert.rejects(
    respond(offer.requestId, "deny", {
      action: "accept",
      content: { count: 2, ok: true },
    }),
  );
  conversation.turns[0].status = "completed";
  await assert.rejects(
    respond(offer.requestId, "once", {
      action: "accept",
      content: { count: 2, ok: true },
    }),
  );
  conversation.turns[0].status = "inProgress";
  await respond(offer.requestId, "once", {
    action: "accept",
    content: { count: 2, ok: true },
  });
  assert.deepEqual(responses, [
    { action: "accept", content: { count: 2, ok: true }, _meta: null },
  ]);
  await assert.rejects(
    respond(offer.requestId, "once", {
      action: "accept",
      content: { count: 2, ok: true },
    }),
  );
  assert.equal(
    (events.at(-1) as { type: string }).type,
    "tool_permission_resolved",
  );

  approvals = [link];
  listener({ type: "approval", approval: link });
  await new Promise((resolve) => setImmediate(resolve));
  const [linkOffer] = await get();
  assert.notEqual(linkOffer.requestId, offer.requestId);
  assert.deepEqual(linkOffer.elicitationLink, {
    message: "Connect",
    href: "https://example.com/connect",
    host: "example.com",
  });
  owner = "another";
  await assert.rejects(
    respond(linkOffer.requestId, "once", { action: "accept" }),
  );
  owner = "account";
  identity = {};
  await assert.rejects(
    respond(linkOffer.requestId, "once", { action: "accept" }),
  );
  const [fresh] = await get();
  await respond(fresh.requestId, "once", { action: "accept" });
  assert.deepEqual(responses[1], {
    action: "accept",
    content: null,
    _meta: null,
  });

  approvals = [{ ...form }];
  const [stale] = await get();
  approvals = [{ ...form }];
  await assert.rejects(respond(stale.requestId, "deny", { action: "decline" }));
  const [replacement] = await get();
  assert.notEqual(replacement.requestId, stale.requestId);
  await respond(replacement.requestId, "deny", { action: "decline" });
  assert.deepEqual(responses[2], {
    action: "decline",
    content: null,
    _meta: null,
  });
});
