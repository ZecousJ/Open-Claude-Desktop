import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTurnContent } from "../../src/transcript/ChatTurnContent";
import { BackgroundTasksPanel } from "../../src/conversation/BackgroundTasksPanel";
import {
  agentOpener,
  type AgentTarget,
} from "../../src/transcript/agents/AgentItems";
import { tasksFromTurn } from "../../shared/workflow-model";
import type { Conversation } from "../../shared/types";
const conversation: Conversation = {
  id: "parent",
  title: "Parent",
  mode: "chat",
  providerId: "fixture",
  model: "fixture-model",
  pinned: false,
  archived: false,
  createdAt: 1000,
  updatedAt: 1000,
  turns: [
    {
      id: "turn",
      prompt: "Parent request",
      attachments: [],
      createdAt: 1000,
      status: "completed",
      items: [
        {
          id: "doc",
          type: "mcpToolCall",
          server: "Claudex Docs",
          tool: "Edit doc",
          status: "completed",
        },
        {
          id: "child",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "child-thread",
          agentPath: "/root/research:synthetic",
          agentToolUses: { "child-thread": 12 },
          agentTokenUsage: { "child-thread": 58700 },
          agentsStates: { "child-thread": { status: "running" } },
        },
      ],
    },
  ],
};
test("one child renders Used a tool activity and a standalone Agent card with transcript action", () => {
  const turn = conversation.turns[0];
  const content = renderToStaticMarkup(
    createElement(ChatTurnContent, {
      conversation,
      turn,
      awaitingApproval: false,
      onArtifact() {},
      onOpenWorkflow() {},
    }),
  );
  assert.match(content, /Used a tool/);
  assert.match(content, /Used Claudex Docs: Edit doc/);
  assert.match(content, /single-agent-prior-tool/);
  assert.match(content, /Background agent started/);
  assert.doesNotMatch(content, /workflow-card/);
  const panel = renderToStaticMarkup(
    createElement(BackgroundTasksPanel, {
      conversations: [conversation],
      engineReady: false,
      onClose() {},
      onError() {},
    }),
  );
  assert.match(panel, /single-agent-task/);
  assert.match(panel, /<b>58\.7k<\/b> tokens/);
  assert.match(panel, /<b>12<\/b> tool uses/);
  assert.match(panel, /View transcript/);
  assert.doesNotMatch(panel, /Phases/);
});

test("a single Agent row opens the child's own transcript, not the task list (S-0005)", () => {
  const [task] = tasksFromTurn(conversation.turns[0], conversation);
  const opened: (AgentTarget | "list")[] = [];
  agentOpener(
    task,
    () => opened.push("list"),
    (target) => opened.push(target),
  )();
  assert.deepEqual(opened, [
    { conversationId: "parent", agentId: "child-thread", title: task.title },
  ]);
  // Without a transcript opener (previews, tests) the row falls back to the list.
  const fallback: string[] = [];
  agentOpener(task, () => fallback.push("list"))();
  assert.deepEqual(fallback, ["list"]);
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
