import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AgentTranscriptBody,
  agentTranscriptGroups,
} from "../../src/transcript/agents/AgentTranscriptBody";
const items = [
  { id: "first", type: "agentMessage", text: "Starting" },
  { id: "one", type: "commandExecution", command: "echo one" },
  {
    id: "two",
    type: "commandExecution",
    command: "echo two",
    status: "failed",
    exitCode: 1,
  },
  { id: "last", type: "agentMessage", text: "After the commands" },
];
test("child transcript preserves model message and command chronology", () => {
  assert.deepEqual(
    agentTranscriptGroups(items).map((group) =>
      group.commands ? "commands" : group.item?.type,
    ),
    ["agentMessage", "commands", "agentMessage"],
  );
  const html = renderToStaticMarkup(
    createElement(AgentTranscriptBody, { items }),
  );
  assert(html.indexOf("Starting") < html.indexOf("Ran 2 commands"));
  assert(html.indexOf("Ran 2 commands") < html.indexOf("After the commands"));
  assert.match(html, /1 failed/);
  const running = renderToStaticMarkup(
    createElement(AgentTranscriptBody, {
      items: [
        {
          id: "live",
          type: "commandExecution",
          command: "echo waiting",
          status: "inProgress",
        },
      ],
    }),
  );
  // The summary names what runs now, as Code's tool rows do (G-18).
  assert.match(running, /Running a command/);
  // A running card shows no placeholder.
  assert.doesNotMatch(running, /Waiting for output/);
  const families = renderToStaticMarkup(
    createElement(AgentTranscriptBody, {
      items: [
        { id: "plan", type: "plan", text: "Synthetic plan" },
        { id: "wait", type: "sleep", durationMs: 2000 },
        { id: "review", type: "enteredReviewMode", review: "Synthetic review" },
        {
          id: "agent",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child",
          agentPath: "/root/fixture",
        },
        { id: "compact", type: "contextCompaction" },
      ],
    }),
  );
  assert.match(families, /Synthetic plan/);
  assert.match(families, /Slept for 2 seconds/);
  assert.match(families, /Started review/);
  assert.match(families, /Agent started/);
  assert.match(families, /Compacted session/);
});
