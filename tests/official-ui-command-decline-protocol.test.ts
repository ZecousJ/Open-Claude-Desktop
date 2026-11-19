import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { createCommandDeclineHost } from "../electron/official-ui/command-decline-host";
import { commandDeclineElicitations } from "../electron/official-ui/api/command-decline-projection";
import {
  conversationUpdate,
  deepCreate,
  loadRegistry,
  createTimelineRpc,
  STREAM_TIMELINE_PATH,
} from "../electron/official-ui/api/timeline";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import type { AdapterContext } from "../electron/official-ui/api/context";
import type { Approval, Conversation } from "../shared/types";

const root = "build/official-ui",
  pkg = "anthropic.bard.api.v1alpha";
const registry = loadRegistry(root + "/data/conversation-protocol.json");
const input = registry.getMessage(pkg + ".PerformActionRequest")!;
const output = registry.getMessage(pkg + ".PerformActionResponse")!;
function fixture(unknown = false) {
  const approval: Approval = {
    id: 7,
    conversationId: "c",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      command: "printf scoped",
    },
  };
  const conversation = {
    id: "c",
    mode: "chat",
    threadId: "thread",
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: "turn",
        createdAt: 2,
        status: "inProgress",
        prompt: "Test ordinary decline",
        attachments: [],
        items: [
          {
            id: "item",
            type: "commandExecution",
            command: "printf scoped",
            status: "inProgress",
          },
        ],
      },
    ],
  } as unknown as Conversation;
  let active = true,
    approvals = [approval],
    calls = 0;
  const events = new Set<(event: any) => void>();
  const host = createCommandDeclineHost({
    current: () => active,
    approvals: () => approvals,
    conversation: () => conversation,
    declineExact: (a) => {
      assert.equal(a, approval);
      calls++;
      if (unknown) throw Error("Unconfirmed fixture");
      approvals = [];
      for (const event of events)
        event({ type: "approval-resolved", id: a.id });
      return { status: "declined" };
    },
    confirmationWaitMs: 10,
  });
  const ctx = {
    root,
    commandDeclines: host,
    isCurrent: () => active,
    account: () => ({ id: "account" }),
    ratings: () => ({}),
    loadConversation: async () => structuredClone(conversation),
    log() {},
    onEvent: (fn: (event: any) => void) => {
      events.add(fn);
      return () => {
        events.delete(fn);
      };
    },
    call: async () => {
      throw Error("No generic approval dispatch");
    },
  } as unknown as AdapterContext;
  const route = createActionRpc(ctx, registry);
  const card = () => host.list("c")[0];
  return {
    host,
    ctx,
    card,
    conversation,
    route,
    events,
    retire: () => {
      active = false;
    },
    calls: () => calls,
  };
}
async function request(
  f: ReturnType<typeof fixture>,
  binary: boolean,
  value: Record<string, unknown>,
) {
  const message = deepCreate(input, {
    header: {
      conversationId: "c",
      mutationId: { sessionId: "s", version: 7n },
    },
    action: { case: "respondToElicitation", value },
  });
  const req: any = Readable.from([
    binary
      ? Buffer.from(toBinary(input, message))
      : Buffer.from(
          JSON.stringify(toJson(input, message, { useProtoFieldName: true })),
        ),
  ]);
  req.method = "POST";
  req.headers = {
    "content-type": binary ? "application/proto" : "application/json",
  };
  let status = 0,
    result: any;
  const res: any = {
    writeHead: (n: number) => {
      status = n;
    },
    end: (data: Uint8Array | string) => {
      result = binary
        ? fromBinary(output, data as Uint8Array)
        : JSON.parse(String(data));
    },
  };
  assert.equal(await f.route(req, res, PERFORM_ACTION_PATH), true);
  assert.equal(
    status,
    200,
    JSON.stringify(result, (_key, v) =>
      typeof v === "bigint" ? String(v) : v,
    ),
  );
  return result;
}
function legacy(card: ReturnType<ReturnType<typeof fixture>["card"]>) {
  return {
    elicitationId: card.elicitationId,
    askNonce: card.askNonce,
    response: {
      values: [
        {
          fieldName: "decision",
          value: { case: "stringValue", value: "deny" },
        },
        {
          fieldName: "tool_use_id",
          value: { case: "stringValue", value: card.elicitationId },
        },
      ],
    },
  };
}

test("pinned descriptor preserves decline-only card, nonce, and waiting status", () => {
  const f = fixture(),
    card = f.card();
  const schema = registry.getMessage(pkg + ".ConversationUpdate")!;
  const update = conversationUpdate(f.conversation, false, {
    org: "org",
    commandDeclines: [card],
  });
  const decoded: any = fromBinary(
    schema,
    toBinary(schema, deepCreate(schema, update)),
  );
  assert.equal(decoded.conversation.status, 3);
  assert.equal(decoded.elicitations.length, 1);
  const elicitation = decoded.elicitations[0];
  assert.equal(elicitation.request.askNonce, card.askNonce);
  assert.equal(elicitation.request.kind, 1);
  assert.equal(elicitation.request.descriptionFormat.style, 2);
  assert.deepEqual(
    elicitation.request.fields[0].options.map((o: any) => [
      o.value,
      o.isDeny,
      o.approvalOption,
    ]),
    [["deny", true, 0]],
  );
  assert.deepEqual(JSON.parse(elicitation.request.reportedAction.toolInput), {
    command: "printf scoped",
  });
});

for (const binary of [false, true]) {
  test(`original legacy decline-only payload dispatches exactly once (${binary ? "proto" : "JSON"})`, async () => {
    const f = fixture(),
      value = legacy(f.card());
    assert.equal((await request(f, binary, value)).ack.outcome.case, "applied");
    assert.equal((await request(f, binary, value)).ack.outcome.case, "applied");
    assert.equal(f.calls(), 1);
    assert.deepEqual(f.host.list("c"), []);
  });
  test(`typed decline with empty default fields works (${binary ? "proto" : "JSON"})`, async () => {
    const f = fixture(),
      c = f.card();
    assert.equal(
      (
        await request(f, binary, {
          elicitationId: c.elicitationId,
          askNonce: c.askNonce,
          response: { verdict: 2 },
        })
      ).ack.outcome.case,
      "applied",
    );
    assert.equal(f.calls(), 1);
  });
  test(`unknown outcome retains pending state and correlated refusal (${binary ? "proto" : "JSON"})`, async () => {
    const f = fixture(true),
      value = legacy(f.card());
    const result = await request(f, binary, value);
    assert.equal(result.ack.outcome.case, "error");
    assert.equal(result.ack.outcome.value.action, "respond_to_elicitation");
    assert.equal(String(result.ack.highWaterMark.version), "7");
    assert.match(
      result.ack.outcome.value.error.displayMessage,
      /will not be sent again/,
    );
    assert.equal(
      (await request(f, binary, legacy(f.card()))).ack.outcome.case,
      "error",
    );
    const projected = commandDeclineElicitations(f.host.list("c"), "page");
    assert.equal(projected[0].request.status, 1);
    assert.match(projected[0].request.description, /will not be sent again/);
    assert.equal(f.calls(), 1);
  });
  for (const tamper of ["tool", "allow", "extra", "duplicate", "approval"]) {
    test(`legacy ${tamper} tampering cannot dispatch (${binary ? "proto" : "JSON"})`, async () => {
      const f = fixture(),
        value: any = legacy(f.card());
      if (tamper === "tool") value.response.values[1].value.value = "other";
      if (tamper === "allow") value.response.values[0].value.value = "once";
      if (tamper === "extra")
        value.response.values.push({
          fieldName: "message",
          value: { case: "stringValue", value: "deny" },
        });
      if (tamper === "duplicate")
        value.response.values[1] = value.response.values[0];
      if (tamper === "approval") value.response.verdict = 1;
      assert.equal((await request(f, binary, value)).ack.outcome.case, "error");
      assert.equal(f.calls(), 0);
    });
  }
}

test("real timeline stream refreshes cards on decline and disposes listeners", async () => {
  const f = fixture(),
    rpc = createTimelineRpc(f.ctx, {
      missingConversationWaitMs: 0,
      heartbeatMs: 10000,
    });
  const schema = registry.getMessage(pkg + ".StreamTimelineRequest")!;
  const response = registry.getMessage(pkg + ".StreamTimelineResponse")!;
  const data = Buffer.from(
    toBinary(schema, deepCreate(schema, { conversationId: "c" })),
  );
  const envelope = Buffer.alloc(5);
  envelope.writeUInt32BE(data.length, 1);
  const req: any = Readable.from([Buffer.concat([envelope, data])]);
  req.method = "POST";
  req.headers = {};
  const res: any = new EventEmitter();
  const frames: any[] = [];
  res.writeHead = () => {};
  res.write = (data: Buffer) => {
    if (data[0] === 0) frames.push(fromBinary(response, data.subarray(5)));
  };
  res.end = () => {
    res.writableEnded = true;
    res.emit("close");
  };
  assert.equal(rpc(req, res, STREAM_TIMELINE_PATH), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const first = frames.at(-1).event.event.value;
  assert.equal(first.elicitations.length, 1);
  await request(f, true, legacy(f.card()));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const last = frames.at(-1).event.event.value;
  assert.equal(last.elicitations.length, 0);
  assert.equal(last.conversation.status, 2);
  res.end();
  assert.equal(f.events.size, 0);
});
