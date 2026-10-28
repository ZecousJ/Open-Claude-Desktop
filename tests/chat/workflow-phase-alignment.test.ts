import test from "node:test";
import assert from "node:assert/strict";
import { alignWorkflowPhaseNames } from "../../shared/workflow-phase-alignment";
import { workflowFromTurn } from "../../shared/workflow-model";
import type { Conversation, Turn } from "../../shared/types";
test("planned Workflow phases accept explicit per-child phase metadata and unambiguous ordered aliases", () => {
  assert.deepEqual(
    [
      ...alignWorkflowPhaseNames(
        ["Understand", "Evidence", "Find", "Verify"],
        ["Map", "Data", "Find"],
      ),
    ],
    [
      ["Map", "Understand"],
      ["Data", "Evidence"],
    ],
  );
  const turn: Turn = {
    id: "turn",
    prompt: "Synthetic workflow",
    attachments: [],
    createdAt: 1000,
    status: "completed",
    items: [
      {
        id: "spawn",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        receiverThreadIds: ["one", "two", "three"],
        workflowPhases: ["Understand", "Evidence", "Find", "Verify"],
        agentsStates: {
          one: { status: "completed" },
          two: { status: "completed" },
          three: { status: "running" },
        },
      },
      {
        id: "a",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "one",
        agentPath: "/root/map:ui",
      },
      {
        id: "b",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "two",
        agentPath: "/root/data:public",
      },
      {
        id: "c",
        type: "subAgentActivity",
        kind: "started",
        agentThreadId: "three",
        agentPath: "/root/find:layout",
      },
    ],
  };
  const conversation: Conversation = {
    id: "parent",
    title: "Synthetic",
    mode: "code",
    providerId: "fixture",
    model: "fixture-model",
    pinned: false,
    archived: false,
    createdAt: 1000,
    updatedAt: 1000,
    turns: [turn],
  };
  const phases = workflowFromTurn(turn, conversation)?.phases;
  assert.deepEqual(
    phases?.map((phase) => [phase.name, phase.agents.length, phase.status]),
    [
      ["Understand", 1, "completed"],
      ["Evidence", 1, "completed"],
      ["Find", 1, "running"],
      ["Verify", 0, "queued"],
    ],
  );
  turn.items[1].workflowPhase = "Evidence";
  assert.equal(
    workflowFromTurn(turn, conversation)?.agents[0].phase,
    "Evidence",
  );
});
test("partial ambiguous phase names remain separate rather than inventing assignment", () => {
  assert.deepEqual(
    [
      ...alignWorkflowPhaseNames(
        ["Understand", "Evidence", "Find"],
        ["Data", "Find"],
      ),
    ],
    [],
  );
  assert.deepEqual(
    [...alignWorkflowPhaseNames(["Understand", "Evidence"], ["Other", "Else"])],
    [],
  );
});
