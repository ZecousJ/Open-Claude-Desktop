import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowTask } from "../../src/transcript/workflow/WorkflowTask";
import type { WorkflowSummary } from "../../shared/workflow-model";
const agent = {
  id: "child",
  name: "review",
  phase: "Review",
  status: "completed",
  model: "fixture",
};
test("Workflow expands finished and active phases but leaves queued ones collapsed", () => {
  const workflow: WorkflowSummary = {
    id: "workflow",
    kind: "workflow",
    conversationId: "fixture",
    title: "Synthetic workflow",
    description: "",
    startedAt: 1,
    status: "running",
    agents: [agent],
    phases: [
      {
        name: "Understand",
        agents: [agent],
        completed: 1,
        status: "completed",
      },
      {
        name: "Find",
        agents: [{ ...agent, id: "running", status: "running" }],
        completed: 0,
        status: "running",
      },
      { name: "Verify", agents: [], completed: 0, status: "queued" },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(WorkflowTask, { workflow, now: 2000, onError() {} }),
  );
  const states = [
    ...html.matchAll(
      /class="workflow-phase-trigger" aria-expanded="(true|false)"/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(states, ["true", "true", "false"]);
});
