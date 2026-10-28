import test from "node:test";
import assert from "node:assert/strict";
import {
  workflowFromTurn,
  workflowsIn,
  tasksFromTurn,
  formatWorkflowTime,
  formatWorkflowTokens,
} from "../../shared/workflow-model";
import type { Conversation, Turn } from "../../shared/types";
const turn: Turn = {
  id: "turn",
  prompt: "Review synthetic changes",
  attachments: [],
  createdAt: 1000,
  status: "inProgress",
  items: [
    {
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      receiverThreadIds: ["agent-one"],
      model: "fixture-model",
      prompt: "Inspect synthetic code",
      agentsStates: { "agent-one": { status: "running", message: "Checking" } },
    },
    {
      id: "activity",
      type: "subAgentActivity",
      kind: "started",
      agentThreadId: "agent-one",
      agentPath: "/root/review:dialog",
    },
  ],
};
const conversation: Conversation = {
  id: "c",
  title: "review-run-start-fix",
  mode: "code",
  createdAt: 1000,
  updatedAt: 1000,
  pinned: false,
  archived: false,
  providerId: "fixture",
  model: "fixture-model",
  turns: [turn],
};
test("single background agent becomes one Workflow card and one phase", () => {
  const view = workflowFromTurn(turn, conversation)!;
  assert.equal(view.title, "Inspect synthetic code");
  assert.equal(view.status, "running");
  assert.equal(view.agents.length, 1);
  assert.equal(view.agents[0].name, "review:dialog");
  assert.equal(view.phases[0].name, "Review");
  assert.equal(view.phases[0].completed, 0);
  assert.equal(workflowsIn([conversation]).length, 1);
  assert.equal(formatWorkflowTime(51), "51s");
  assert.equal(formatWorkflowTime(382), "6m 22s");
  assert.equal(formatWorkflowTokens(415000), "415.0k");
  assert.equal(formatWorkflowTokens(2400000), "2.4M");
});
test("multiple agent states and completed phases do not create duplicate cards", () => {
  const other: Turn = {
    ...turn,
    items: [
      ...turn.items,
      {
        id: "spawn2",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "completed",
        receiverThreadIds: ["agent-two"],
        model: "model-b",
        agentsStates: { "agent-two": { status: "completed" } },
      },
      {
        id: "activity2",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "agent-two",
        agentPath: "/root/verify:tests",
      },
    ],
  };
  const view = workflowFromTurn(other, conversation)!;
  assert.equal(view.kind, "workflow");
  assert.equal(view.agents.length, 2);
  assert.deepEqual(
    view.phases.map((p) => p.name),
    ["Review", "Verify"],
  );
  assert.equal(view.phases[1].completed, 1);
  assert.equal(view.status, "running");
});

test("completed, running and queued phases carry distinct progress with measured tokens", () => {
  const extended: Turn = {
    ...turn,
    items: [
      {
        ...turn.items[0],
        workflowPhases: ["Review", "Verify", "Critic"],
        agentTokenUsage: { "agent-one": 232500 },
      },
      turn.items[1],
    ],
  };
  const view = workflowFromTurn(extended, conversation)!;
  assert.equal(view.kind, "workflow");
  assert.deepEqual(
    view.phases.map((p) => [p.name, p.status, p.completed, p.agents.length]),
    [
      ["Review", "running", 0, 1],
      ["Verify", "queued", 0, 0],
      ["Critic", "queued", 0, 0],
    ],
  );
  assert.equal(view.totalTokens, 232500);
  assert.equal(view.agents[0].tokens, 232500);
  const finished: Turn = {
    ...turn,
    items: [
      {
        ...turn.items[0],
        agentsStates: { "agent-one": { status: "completed", message: null } },
        agentTokenUsage: { "agent-one": 232500 },
      },
      turn.items[1],
    ],
  };
  assert.equal(
    workflowFromTurn(finished, conversation)?.phases[0].status,
    "completed",
  );
  const betweenPhases: Turn = {
    ...turn,
    status: "inProgress",
    items: [
      {
        ...turn.items[0],
        workflowPhases: ["Review", "Verify"],
        agentsStates: { "agent-one": { status: "completed" } },
      },
      turn.items[1],
    ],
  };
  assert.equal(
    workflowFromTurn(betweenPhases, conversation)?.status,
    "running",
  );
  assert.equal(
    workflowFromTurn({ ...betweenPhases, status: "completed" }, conversation)
      ?.status,
    "completed",
  );
  assert.equal(workflowFromTurn(finished, conversation)?.durationMs, undefined);
  const measured: Turn = {
    ...turn,
    items: [
      {
        ...finished.items[0],
        agentStartedAt: { "agent-one": 1500 },
        agentDurationMs: { "agent-one": 2000 },
      },
      turn.items[1],
    ],
  };
  assert.equal(workflowFromTurn(measured, conversation)?.durationMs, 2000);
  assert.equal(workflowFromTurn(measured, conversation)?.startedAt, 1500);
});

test("native V2 subAgentActivity without a legacy collab item is a live single-agent Workflow", () => {
  const v2: Turn = {
    ...turn,
    items: [
      {
        id: "child",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "agent-v2",
        agentPath: "/root/review:single",
        agentModel: "fixture-child-model",
        agentTokenUsage: { "agent-v2": 1234 },
        agentsStates: { "agent-v2": { status: "running" } },
      },
    ],
  };
  const view = workflowFromTurn(v2, conversation)!;
  assert.equal(view.kind, "agent");
  assert.equal(view.agents.length, 1);
  assert.equal(view.title, "Review:single");
  assert.equal(view.description, turn.prompt);
  assert.equal(view.agents[0].model, "fixture-child-model");
  assert.equal(view.agents[0].tokens, 1234);
  assert.equal(view.phases[0].name, "Review");
  assert.equal(view.status, "running");
});

test("several independent children in one parent turn remain separate tasks", () => {
  const multiple: Turn = {
    ...turn,
    items: [
      {
        id: "a",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "agent-one",
        agentPath: "/root/first",
      },
      {
        id: "b",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "agent-two",
        agentPath: "/root/second",
      },
    ],
  };
  const tasks = tasksFromTurn(multiple, conversation);
  assert.deepEqual(
    tasks.map((task) => task.kind),
    ["agent", "agent"],
  );
  assert.deepEqual(
    tasks.map((task) => task.agents[0].id),
    ["agent-one", "agent-two"],
  );
  assert.notEqual(tasks[0].id, tasks[1].id);
  assert.equal(workflowsIn([{ ...conversation, turns: [multiple] }]).length, 2);
});
