import test from "node:test";
import assert from "node:assert/strict";
import { newDraft } from "../../src/collections/routines/routine-draft";
import { routineCompletionNotices } from "../../shared/routine-notices";
import type { Routine } from "../../shared/routines";

const NOW = new Date(2026, 9, 12, 12, 0, 0).getTime();

test("a new task notifies when it finishes, so the Scheduled tasks switch reaches it", () => {
  const draft = newDraft(NOW, undefined, "cowork");
  assert.equal(draft.notifyOnCompletion?.push, true);
  const before = {
    id: "a",
    name: "Report",
    lastRunStatus: "running",
    notifyOnCompletion: draft.notifyOnCompletion,
  } as Routine;
  const after = { ...before, lastRunStatus: "completed" } as Routine;
  assert.equal(routineCompletionNotices([before], [after]).length, 1);
});
