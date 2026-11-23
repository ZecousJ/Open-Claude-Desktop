import assert from "node:assert/strict";
import { test } from "node:test";
import { codeWorkflowTranscript } from "../electron/official-ui/native/code-workflow-transcript";
import type { Conversation, Item, Turn } from "../shared/types";

const workflowItem: Item = {
  id: "workflow-call-1",
  type: "collabAgentToolCall",
  tool: "workflow",
  status: "failed",
  workflowStatus: "failed",
  workflowRunId: "wf_123456",
  workflowName: "Audit findings",
  workflowDescription: "Review and verify the findings",
  workflowStartedAt: 2000,
  workflowEndedAt: 5000,
  workflowPhases: ["Review", "Verify", "Report"],
  workflowError: "Verification failed",
  receiverThreadIds: ["thread-review", "thread-verify"],
  agentsStates: {
    "thread-review": { status: "completed", message: null },
    "thread-verify": { status: "errored", message: "Missing evidence" },
  },
  agentNames: { "thread-review": "Reviewer", "thread-verify": "Verifier" },
  agentPhases: { "thread-review": "Review", "thread-verify": "Verify" },
  agentModels: {
    "thread-review": "review-model",
    "thread-verify": "verify-model",
  },
  agentStartedAt: { "thread-review": 2200, "thread-verify": 4100 },
  agentDurationMs: { "thread-review": 1600, "thread-verify": 700 },
  agentTokenUsage: { "thread-review": 42, "thread-verify": 20 },
  agentToolUses: { "thread-review": 3, "thread-verify": 1 },
};

function project(item: Item) {
  const turn: Turn = {
    id: "turn",
    prompt: "Audit this change",
    status: "inProgress",
    attachments: [],
    items: [item],
    createdAt: 1000,
  };
  const conversation: Conversation = {
    id: "session",
    title: "Audit session",
    mode: "code",
    providerId: "provider",
    model: "session-model",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 5000,
    turns: [turn],
  };
  return codeWorkflowTranscript({
    conversation,
    turn,
    item,
    toolId: "turn:activity:workflow-call-1:0",
  });
}

test("a settled workflow replays its recorded phases, agent metrics and outcome while the parent turn is still active", () => {
  const events = project(workflowItem);
  assert.deepEqual(
    events.map(({ subtype }) => subtype),
    ["task_started", "task_progress", "task_notification"],
  );
  for (const event of events) {
    assert.equal(event.task_id, "wf_123456");
    assert.equal(event.run_id, "wf_123456");
    assert.equal(event.tool_use_id, "turn:activity:workflow-call-1:0");
  }
  const [start, progress, notification] = events;
  assert.ok(start.subtype === "task_started");
  assert.equal(start.task_type, "local_workflow");
  assert.equal(start.workflow_name, "Audit findings");
  assert.equal(start.timestamp, "1970-01-01T00:00:02.000Z");
  assert.ok(progress.subtype === "task_progress");
  assert.deepEqual(progress.workflow_progress, [
    { type: "workflow_phase", index: 0, title: "Review" },
    { type: "workflow_phase", index: 1, title: "Verify" },
    { type: "workflow_phase", index: 2, title: "Report" },
    {
      type: "workflow_agent",
      index: 0,
      agentId: "thread-review",
      label: "Reviewer",
      phaseIndex: 0,
      phaseTitle: "Review",
      state: "done",
      model: "review-model",
      startedAt: 2200,
      durationMs: 1600,
      tokens: 42,
      toolCalls: 3,
    },
    {
      type: "workflow_agent",
      index: 1,
      agentId: "thread-verify",
      label: "Verifier",
      phaseIndex: 1,
      phaseTitle: "Verify",
      state: "error",
      model: "verify-model",
      startedAt: 4100,
      durationMs: 700,
      tokens: 20,
      toolCalls: 1,
      error: "Missing evidence",
    },
  ]);
  assert.ok(notification.subtype === "task_notification");
  assert.equal(notification.timestamp, "1970-01-01T00:00:05.000Z");
  assert.equal(notification.status, "failed");
  assert.equal(notification.summary, "Verification failed");
  assert.deepEqual(notification.usage, {
    total_tokens: 62,
    tool_uses: 4,
    duration_ms: 3000,
  });
  assert.equal(new Set(events.map(({ uuid }) => uuid)).size, 3);
  assert.deepEqual(project(structuredClone(workflowItem)), events);
});

test("a running workflow publishes stable start and progress before settling", () => {
  const events = project({
      ...workflowItem,
      status: "inProgress",
      workflowStatus: undefined,
      workflowEndedAt: undefined,
    });
  assert.deepEqual(events.map(event => event.subtype), ["task_started", "task_progress"]);
  assert.deepEqual(events.map(event => event.uuid), project(workflowItem).slice(0, 2).map(event => event.uuid));
});
