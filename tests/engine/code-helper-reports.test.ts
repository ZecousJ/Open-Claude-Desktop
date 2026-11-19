import assert from "node:assert/strict";
import { test } from "node:test";
import {
  pendingCodeHelperReports,
  recordCodeHelperReport,
} from "../../electron/engine/code-helper-reports";
import { convertCodeTranscript } from "../../electron/official-ui/native/code-transcript";
import type { Conversation, Turn } from "../../shared/types";

function fixture() {
  const parentTurn = {
    id: "parent-turn",
    items: [],
    status: "completed",
    createdAt: 1,
    prompt: "Start the child",
    attachments: [],
  } as unknown as Turn;
  const childTurn = {
    id: "child-turn",
    status: "completed",
    items: [
      {
        id: "reasoning",
        type: "agentMessage",
        phase: "commentary",
        text: "working",
      },
      {
        id: "final",
        type: "agentMessage",
        phase: null,
        text: "Finished the task.",
      },
    ],
  } as unknown as Turn;
  const parent = {
    id: "parent",
    title: "Parent",
    mode: "code",
    turns: [parentTurn],
  } as Conversation;
  const child = {
    id: "child",
    title: "Child",
    mode: "code",
    parentSessionId: parent.id,
    nativeSideSession: { taskId: "task_123" },
    codeHelperParentTurnId: parentTurn.id,
    turns: [childTurn],
  } as Conversation;
  return { parent, child, parentTurn, childTurn, rows: [parent, child] };
}

test("reports a linked child's final result once in the originating turn", () => {
  const { parent, child, parentTurn, childTurn, rows } = fixture();
  assert.equal(recordCodeHelperReport(rows, child, childTurn), parent);
  assert.deepEqual(parentTurn.items[0], {
    id: "code-helper-report:child:child-turn",
    type: "peerMessage",
    text: "Finished the task.",
    agentThreadId: "child",
    origin: { kind: "peer", name: "Child", subagent: true, handback: true },
  });
  assert.equal(recordCodeHelperReport(rows, child, childTurn), undefined);
  assert.equal(parentTurn.items.length, 1);
  const report = convertCodeTranscript(parent).rows.find(
    (row) => row.type === "user" && row.origin?.kind === "peer",
  );
  assert.ok(report);
  assert.equal(report.message.content, "Finished the task.");
  assert.equal(report.origin?.kind === "peer" && report.origin.from, "child");
  assert.equal(pendingCodeHelperReports(rows, parent).length, 1);
  parentTurn.codeHelperReportIds = [parentTurn.items[0].id];
  assert.deepEqual(pendingCodeHelperReports(rows, parent), []);
});

test("ignores unmarked, foreign and ambiguous child results", () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      delete f.child.codeHelperParentTurnId;
    },
    (f: ReturnType<typeof fixture>) => {
      f.child.cloudHosted = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.parent.turns.push({ ...f.parentTurn });
    },
  ]) {
    const f = fixture();
    change(f);
    assert.equal(
      recordCodeHelperReport(f.rows, f.child, f.childTurn),
      undefined,
    );
    assert.equal(f.parentTurn.items.length, 0);
  }
});

test("reports terminal outcomes and sanitizes cross-place mentions", () => {
  const f = fixture();
  f.child.environment = { kind: "ssh", hostId: "fixture" };
  f.childTurn.items.at(-1)!.text = "Finished @production.";
  assert.equal(recordCodeHelperReport(f.rows, f.child, f.childTurn), f.parent);
  assert.equal(f.parentTurn.items[0].text, "Finished ＠production.");
  assert.equal(pendingCodeHelperReports(f.rows, f.parent)[0].text, "Finished ＠production.");
  const failed = { ...f.childTurn, id: "failed", status: "failed" as const, items: [] };
  f.child.turns.push(failed);
  assert.equal(recordCodeHelperReport(f.rows, f.child, failed), f.parent);
  assert.equal(f.parentTurn.items[1].text, "The linked Code session ended with an error.");
});
