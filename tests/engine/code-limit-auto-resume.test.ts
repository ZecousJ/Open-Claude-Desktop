import assert from "node:assert/strict";
import test from "node:test";
import type { Engine } from "../../electron/engine/engine";
import { recordCodeLimitRefusal } from "../../electron/engine/engine-status";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
import type { GatewayRefusal } from "../../server/sub2api-errors";
import type { Conversation, Turn } from "../../shared/types";

test("only an exact five-hour refusal is preserved after the Code turn settles", () => {
  const turn: Turn = {
    id: "turn",
    status: "failed",
    prompt: "Continue",
    createdAt: 1,
    attachments: [],
    items: [],
  };
  const conversation: Conversation = {
    id: "conversation",
    mode: "code",
    threadId: "thread",
    title: "Sample",
    providerId: "provider",
    model: "model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [turn],
  };
  let updates = 0;
  const engine = {
    store: { conversations: [conversation] },
    changed: () => {
      updates++;
    },
  } as unknown as Engine;
  const refusal: GatewayRefusal = {
    threadId: "thread",
    turnId: "turn",
    code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
    status: 429,
    exceeded: true,
    reason: "session",
    invalidKey: false,
    message: "Limit reached",
    resetsAt: 1_800_000_000_000,
    claudex: {
      v: 1,
      reason: "RULE_LIMIT",
      kind: "rule_limit",
      ruleKind: "session",
      window: "5h",
      action: "wait",
      reprovision: false,
      message: "Limit reached",
    },
  };

  recordCodeLimitRefusal.call(engine, { ...refusal, turnId: "other" });
  recordCodeLimitRefusal.call(engine, { ...refusal, threadId: undefined });
  recordCodeLimitRefusal.call(engine, { ...refusal, claudex: undefined });
  assert.equal(updates, 0);
  assert.equal(turn.stopReason, undefined);

  recordCodeLimitRefusal.call(engine, refusal);
  assert.equal(updates, 1);
  assert.equal(turn.stopReason, "usage_limit");
  const hold = turn.usageHold;
  assert.ok(hold);
  assert.deepEqual(hold, {
    resetsAt: refusal.resetsAt,
    window: "five_hour",
    providerId: "provider",
    model: "model",
  });
  hold.continuationId = "continued";
  recordCodeLimitRefusal.call(engine, refusal);
  assert.equal(turn.usageHold?.continuationId, "continued");
  const { rows } = convertCodeTranscript(conversation);
  assert.deepEqual(
    rows.find((row) => row.type === "rate_limit_event")?.rate_limit_info,
    {
      status: "rejected",
      rateLimitType: "five_hour",
      resetsAt: 1_800_000_000,
      utilization: 1,
    },
  );
  assert.equal(
    rows.find((row) => row.isApiErrorMessage)?.api_error_status,
    429,
  );
  assert.match(
    JSON.stringify(rows.find((row) => row.isApiErrorMessage)?.message),
    /hit your usage limit/,
  );
});
