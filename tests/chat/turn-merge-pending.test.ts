import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation, Turn } from "../../shared/types";
import { mergeConversationTurn } from "../../src/host/events";

const turn = (id: string, extra: Partial<Turn> = {}) =>
  ({
    id,
    prompt: "Draw it",
    attachments: [],
    items: [],
    status: "inProgress",
    createdAt: 1,
    ...extra,
  }) as Turn;

const conversation = (turns: Turn[]) =>
  ({ id: "c", mode: "cowork", title: "t", turns }) as unknown as Conversation;

test("a turn named by Codex replaces its provisional one instead of doubling it", () => {
  const before = conversation([
    turn("t1", { status: "completed" }),
    turn("pending-9"),
  ]);
  const merged = mergeConversationTurn(before, {
    type: "conversation-turn",
    conversationId: "c",
    turn: turn("019abc", {
      items: [{ id: "m", type: "agentMessage", text: "Drawing." }] as never,
    }),
  } as never)!;
  assert.deepEqual(
    merged.turns.map((t) => t.id),
    ["t1", "019abc"],
  );
  assert.equal(merged.turns[1].items.length, 1);
});

test("a new turn still joins the end when there is no provisional one", () => {
  const before = conversation([turn("t1", { status: "completed" })]);
  const merged = mergeConversationTurn(before, {
    type: "conversation-turn",
    conversationId: "c",
    turn: turn("t2"),
  } as never)!;
  assert.deepEqual(
    merged.turns.map((t) => t.id),
    ["t1", "t2"],
  );
});
