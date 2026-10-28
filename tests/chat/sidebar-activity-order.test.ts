import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import { sortedSidebarConversations } from "../../shared/conversation-order";

test("two running conversations keep their places while their replies stream", () => {
  const row = (id: string, started: number, updatedAt: number) =>
    ({
      id,
      updatedAt,
      turns: [{ id: `${id}-t`, createdAt: started, status: "inProgress" }],
    }) as unknown as Conversation;
  // b's message came last: it stays on top whichever reply wrote last.
  const order = (aUpdated: number, bUpdated: number) =>
    sortedSidebarConversations([
      row("a", 100, aUpdated),
      row("b", 200, bUpdated),
    ])
      .map((c) => c.id)
      .join();
  assert.equal(order(500, 400), "b,a");
  assert.equal(order(400, 500), "b,a");
});
