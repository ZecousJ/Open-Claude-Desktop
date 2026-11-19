import test from "node:test";
import assert from "node:assert/strict";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
import { applyTurnEvent } from "../../electron/engine/engine-events";
import type { Conversation, Turn } from "../../shared/types";

test("only an exact structured safeguard error records a refused prompt", () => {
  const engine = {
    refusalText: (_turn: Turn, text: string) => text,
    clearApprovals() {},
    recordOutputFiles() {},
    steers: new Map(),
  };
  for (const [id, error, expected] of [
    ["turn", { code: "content_filter", message: "Blocked" }, true],
    ["other-turn", { code: "content_filter", message: "Blocked" }, false],
    ["turn", { code: "network_error", message: "content_filter" }, false],
    ["turn", { message: "I cannot help with that request" }, false],
  ] as const) {
    const turn: Turn = {
      id: "turn",
      prompt: "Prompt",
      attachments: [],
      items: [],
      status: "inProgress",
      createdAt: 1,
    };
    const c = {
      id: "c",
      mode: "code",
      model: "original",
      turns: [turn],
    } as Conversation;
    applyTurnEvent.call(engine as never, c, turn, "turn/completed", {
      turn: { id, status: "failed", error },
    });
    assert.deepEqual(
      turn.refusedPrompt,
      expected ? { model: "original" } : undefined,
    );
  }
});

test("structured refusals and fallback models use the stock transcript fields", () => {
  const turn: Turn = {
    id: "turn",
    prompt: "Prompt",
    attachments: [],
    items: [],
    status: "failed",
    createdAt: 1,
    refusedPrompt: { model: "original" },
    error: "Blocked",
  };
  const c = {
    id: "c",
    mode: "code",
    model: "original",
    turns: [turn],
  } as Conversation;
  assert.equal(
    convertCodeTranscript(c).rows.at(-1)?.message.stop_reason,
    "refusal",
  );
  turn.status = "completed";
  delete turn.error;
  turn.switchedTo = "fallback";
  const notice = convertCodeTranscript(c).rows.find(
    (row) => row.subtype === "model_refusal_fallback",
  );
  assert.ok(notice && notice.subtype === "model_refusal_fallback");
  assert.equal(notice.direction, "retry");
  assert.equal(notice.original_model, "original");
  assert.equal(notice.fallback_model, "fallback");
});
