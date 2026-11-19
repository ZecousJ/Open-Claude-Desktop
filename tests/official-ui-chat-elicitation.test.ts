import assert from "node:assert/strict";
import test from "node:test";
import { ChatElicitationHost } from "../electron/official-ui/api/chat-elicitation";
import type { Approval, Conversation } from "../shared/types";

function fixture(urlAllowed?: () => boolean) {
  const conversation = {
    id: "chat",
    mode: "chat",
    threadId: "thread",
    turns: [{ id: "turn", status: "inProgress", items: [] }],
  } as unknown as Conversation;
  let approvals: Approval[] = [];
  let current = true;
  const sent: { approval: Approval; response: unknown }[] = [];
  const host = new ChatElicitationHost({
    isCurrent: () => current,
    urlAllowed,
    load: async (id) =>
      id === conversation.id ? { conversation, approvals } : undefined,
    dispatch: (approval, response) => {
      sent.push({ approval, response });
      approvals = approvals.filter((a) => a !== approval);
    },
  });
  const add = (method: string, params: Record<string, unknown>) => {
    const approval = {
      id: approvals.length + 1,
      conversationId: conversation.id,
      method,
      params: { threadId: "thread", turnId: "turn", ...params },
    };
    approvals.push(approval);
    return approval;
  };
  const reply = (
    card: Awaited<ReturnType<typeof host.list>>[number],
    response: unknown,
  ) =>
    host.respond("chat", {
      elicitationId: card.id,
      askNonce: card.request.askNonce,
      response,
    });
  return {
    host,
    conversation,
    sent,
    add,
    reply,
    setApprovals: (v: Approval[]) => {
      approvals = v;
    },
    deactivate: () => {
      current = false;
    },
  };
}

test("Chat MCP form projects the original input card and submits validated typed values once", async () => {
  const f = fixture();
  const approval = f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    message: "Enter details",
    mode: "form",
    requestedSchema: {
      type: "object",
      required: ["name", "copies"],
      properties: {
        name: { type: "string" },
        copies: { type: "integer", minimum: 1 },
        draft: { type: "boolean" },
      },
    },
  });
  const [card] = await f.host.list("chat");
  assert.equal(card.request.kind, 3);
  assert.ok("originServerId" in card.request);
  assert.match(card.request.originServerId, /^[a-f0-9-]{36}$/);
  assert.equal((await f.host.list("chat"))[0].id, card.id);
  assert.ok(
    "error" in
      (await f.reply(card, {
        values: [
          { fieldName: "name", value: { case: "stringValue", value: "A" } },
        ],
      })),
  );
  assert.deepEqual(
    await f.reply(card, {
      values: [
        { fieldName: "name", value: { case: "stringValue", value: "A" } },
        { fieldName: "copies", value: { case: "stringValue", value: "3" } },
        { fieldName: "draft", value: { case: "booleanValue", value: true } },
      ],
    }),
    { claimed: true },
  );
  assert.deepEqual(f.sent, [
    {
      approval,
      response: {
        action: "accept",
        content: { name: "A", copies: 3, draft: true },
        _meta: null,
      },
    },
  ]);
  assert.ok("error" in (await f.reply(card, { values: [] })));
});

test("Chat URL, tool decisions and questions reach their matching engine responses", async () => {
  const f = fixture();
  f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    mode: "url",
    url: "https://example.com/connect",
    message: "Connect",
  });
  let [card] = await f.host.list("chat");
  assert.ok("externalUrl" in card.request);
  assert.equal(card.request.externalUrl, "https://example.com/connect");
  assert.deepEqual(await f.reply(card, { values: [] }), { claimed: true });
  assert.deepEqual(f.sent.at(-1)?.response, {
    action: "accept",
    content: null,
    _meta: null,
  });
  f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    message: "Run?",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      tool_name: "lookup",
      tool_params: { q: "value" },
    },
  });
  [card] = await f.host.list("chat");
  assert.equal(card.request.kind, 1);
  assert.deepEqual(await f.reply(card, { verdict: 2, values: [] }), {
    claimed: true,
  });
  assert.deepEqual(f.sent.at(-1)?.response, {
    action: "decline",
    content: null,
    _meta: null,
  });
  f.add("item/tool/requestUserInput", {
    questions: [
      { id: "target", question: "Which?", options: [{ label: "One" }] },
    ],
  });
  [card] = await f.host.list("chat");
  assert.equal(card.request.kind, 2);
  assert.deepEqual(
    await f.reply(card, {
      values: [
        { fieldName: "target", value: { case: "stringValue", value: "One" } },
      ],
    }),
    { claimed: true },
  );
  assert.deepEqual(f.sent.at(-1)?.response, {
    answers: { target: { answers: ["One"] } },
  });
});

test("Chat rejects stale, cross-conversation and changed pending requests", async () => {
  const f = fixture();
  const approval = f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    mode: "url",
    url: "https://example.com/connect",
    message: "Connect",
  });
  const [card] = await f.host.list("chat");
  assert.ok(
    "error" in
      (await f.host.respond("other", {
        elicitationId: card.id,
        askNonce: card.request.askNonce,
        response: { verdict: 2 },
      })),
  );
  f.setApprovals([{ ...approval }]);
  assert.ok("error" in (await f.reply(card, { verdict: 2 })));
  assert.deepEqual(f.sent, []);
  f.deactivate();
  assert.deepEqual(await f.host.list("chat"), []);
});

test("legacy SSE binds a unique running tool and validates the result before dispatch", async () => {
  const f = fixture();
  const turn = f.conversation.turns[0];
  turn.items = [
    {
      id: "call",
      type: "mcpToolCall",
      server: "probe",
      tool: "ask",
      status: "inProgress",
    },
  ];
  f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    message: "Enter a name",
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  });
  const [offer] = await f.host.legacyList("chat");
  assert.equal(offer.tool_use_id, "turn:call");
  const { RestCompletionTextStream } =
    await import("../electron/official-ui/api/rest-completion-stream");
  const stream = new RestCompletionTextStream();
  stream.update(turn, "human", "assistant", "model");
  stream.updateElicitations([offer]);
  stream.updateElicitations([offer]);
  assert.equal(
    stream.events.filter((e) => e.event === "mcp_elicitation").length,
    1,
  );
  assert.ok(
    "error" in
      (await f.host.respondLegacy("chat", offer.elicitation_id, {
        action: "accept",
        content: {},
      })),
  );
  assert.deepEqual(
    await f.host.respondLegacy("chat", offer.elicitation_id, {
      action: "accept",
      content: { name: "Ada" },
    }),
    { claimed: true },
  );
  stream.updateElicitations(await f.host.legacyList("chat"));
  assert.equal(
    stream.events.filter((e) => e.event === "mcp_elicitation_complete").length,
    1,
  );
  assert.deepEqual(f.sent.at(-1)?.response, {
    action: "accept",
    content: { name: "Ada" },
    _meta: null,
  });
});

test("legacy result endpoint is account scoped and accepts only a displayed offer", async () => {
  const { Readable } = await import("node:stream");
  const { createRestCompletionRoute } =
    await import("../electron/official-ui/api/rest-completion");
  const { organizationUuid } =
    await import("../electron/official-ui/api/context");
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const conversation = {
    id: conversationId,
    mode: "chat",
    threadId: "thread",
    turns: [
      {
        id: "turn",
        status: "inProgress",
        items: [
          {
            id: "call",
            type: "mcpToolCall",
            server: "probe",
            tool: "ask",
            status: "inProgress",
          },
        ],
      },
    ],
  } as unknown as Conversation;
  const approval: Approval = {
    id: 1,
    conversationId,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "thread",
      turnId: "turn",
      serverName: "probe",
      mode: "url",
      url: "https://example.com/connect",
      message: "Connect",
    },
  };
  let pending = true;
  const sent: unknown[] = [];
  const host = new ChatElicitationHost({
    isCurrent: () => true,
    load: async () => ({ conversation, approvals: pending ? [approval] : [] }),
    dispatch: (_a, response) => {
      sent.push(response);
      pending = false;
    },
  });
  const route = createRestCompletionRoute({
    account: () => ({ id: "owner" }),
    sessionIdentity: () => "session",
    isCurrent: () => true,
    chatElicitation: host,
  } as never);
  const [offer] = await host.legacyList(conversationId);
  async function post(org: string, result: unknown) {
    const p = `/api/organizations/${org}/chat_conversations/${conversationId}/mcp_elicitation_result`;
    const req = Object.assign(
      Readable.from([Buffer.from(JSON.stringify(result))]),
      {
        method: "POST",
        url: p,
        headers: { "content-type": "application/json" },
      },
    );
    let status = 0;
    const res = {
      writeHead(n: number) {
        status = n;
      },
      end() {},
    };
    assert.equal(
      await route(
        req as never,
        res as never,
        p,
        new URL(p, "http://localhost"),
      ),
      true,
    );
    return status;
  }
  const body = {
    elicitation_id: offer.elicitation_id,
    result: JSON.stringify({ action: "accept", content: {} }),
  };
  assert.equal(await post(organizationUuid("other"), body), 404);
  assert.equal(
    await post(organizationUuid("owner"), { ...body, result: "{}" }),
    400,
  );
  assert.equal(await post(organizationUuid("owner"), body), 200);
  assert.equal(await post(organizationUuid("owner"), body), 409);
  assert.deepEqual(sent, [{ action: "accept", content: null, _meta: null }]);
});

test("pinned Chat protobuf preserves the original MCP form and URL fields", async () => {
  const { toBinary, fromBinary } = await import("@bufbuild/protobuf");
  const { loadRegistry, deepCreate } =
    await import("../electron/official-ui/api/timeline");
  const schema = loadRegistry(
    "build/official-ui/data/conversation-protocol.json",
  ).getMessage("anthropic.bard.api.v1alpha.ConversationUpdate")!;
  const f = fixture();
  f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    mode: "form",
    message: "Enter",
    requestedSchema: {
      type: "object",
      required: ["n"],
      properties: { n: { type: "integer" } },
    },
  });
  f.add("mcpServer/elicitation/request", {
    serverName: "probe",
    mode: "url",
    message: "Connect",
    url: "https://example.com/connect",
  });
  const cards = await f.host.list("chat");
  const decoded = fromBinary(
    schema,
    toBinary(schema, deepCreate(schema, { elicitations: cards })),
  ) as any;
  assert.equal(decoded.elicitations[0].request.kind, 3);
  assert.equal(decoded.elicitations[0].request.fields[0].textKind, 1);
  assert.ok(decoded.elicitations[0].request.mcpRequestedSchema);
  assert.equal(
    decoded.elicitations[1].request.externalUrl,
    "https://example.com/connect",
  );
  assert.equal(decoded.elicitations[1].request.trigger, 1);
});

test("legacy user-input method and nullable options render without a tool item", async () => {
  const f = fixture();
  f.add("tool/requestUserInput", {
    questions: [
      { id: "answer", question: "What should I use?", options: null },
    ],
  });
  const [card] = await f.host.list("chat");
  assert.equal(card.request.kind, 2);
  assert.deepEqual(
    await f.reply(card, {
      values: [
        { fieldName: "answer", value: { case: "stringValue", value: "A" } },
      ],
    }),
    { claimed: true },
  );
  assert.deepEqual(f.sent[0].response, {
    answers: { answer: { answers: ["A"] } },
  });
});

test("ordinary Chat command exposes once or decline and refuses expanded grants", async () => {
  const f = fixture();
  const turn = f.conversation.turns[0];
  turn.items.push({ id: "shell", type: "commandExecution", command: "echo marker", status: "inProgress" });
  const approval = f.add("item/commandExecution/requestApproval", {
    itemId: "shell", command: "echo marker",
    proposedExecpolicyAmendment: ["echo", "marker"],
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo", "marker"] } }, "cancel"],
  });
  f.add("item/commandExecution/requestApproval", {
    itemId: "shell", command: "echo marker", additionalPermissions: {},
  });
  const [card, extra] = await f.host.list("chat");
  assert.equal(extra, undefined);
  assert.equal(card.request.kind, 1);
  assert.ok("acceptsTypedAnswer" in card.request && card.request.acceptsTypedAnswer);
  assert.ok("error" in await f.reply(card, { verdict: 1, approvalOption: 2 }));
  assert.deepEqual(await f.reply(card, { verdict: 1, approvalOption: 1 }), { claimed: true });
  assert.deepEqual(f.sent, [{ approval, response: { decision: "accept" } }]);
});

test("URL policy is checked again when the original card accepts", async () => {
  let allowed = true;
  const f = fixture(() => allowed);
  const approval = f.add("mcpServer/elicitation/request", {
    mode: "url", serverName: "probe", message: "Open service", url: "https://example.com/test",
  });
  const [card] = await f.host.list("chat");
  assert.ok("externalUrl" in card.request);
  assert.equal(card.request.externalUrl, "https://example.com/test");
  allowed = false;
  const [blocked] = await f.host.list("chat");
  assert.ok("externalUrl" in blocked.request);
  assert.equal(blocked.request.externalUrl, "");
  const result = await f.reply(card, { values: [] });
  assert.ok(result.claimed && result.error?.code === "permission_denied");
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await f.reply(blocked, { verdict: 2 }), { claimed: true });
  assert.equal(f.sent[0]?.approval, approval);
});
