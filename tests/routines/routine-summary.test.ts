import test from "node:test";
import assert from "node:assert/strict";
import { routineSummary } from "../../electron/routines/routine-summary";
import type { Conversation } from "../../shared/types";
import type { Routine } from "../../shared/routines";

const task = { prompt: "Watch for a new issue", name: "watch" } as Routine;
const conversation = {
  id: "c1",
  turns: [
    {
      status: "completed",
      items: [{ type: "agentMessage", text: "No issue found" }],
    },
  ],
} as unknown as Conversation;

test("routine summary suppresses unmet conditions", async () => {
  const result = await routineSummary(async () =>
    JSON.stringify({ notify: false, summary: "No issue" }),
  )(task, conversation);
  assert.equal(result, null);
});

test("routine summary returns a collapsed one-line result", async () => {
  const result = await routineSummary(
    async () => '```json\n{"notify":true,"summary":"Issue\\nfound"}\n```',
  )(task, conversation);
  assert.equal(result, "Issue found");
});

test("routine summary rejects malformed model output", async () => {
  await assert.rejects(
    routineSummary(async () => "not json")(task, conversation),
  );
});
