import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import type { Conversation } from "../../shared/types";
const conversation: Conversation = {
  id: "synthetic",
  title: "workflow-fixture",
  mode: "code",
  providerId: "fixture",
  model: "model",
  pinned: false,
  archived: false,
  createdAt: 1000,
  updatedAt: 1000,
  turns: [
    {
      id: "turn",
      prompt: "review",
      attachments: [],
      createdAt: 1000,
      status: "inProgress",
      items: [
        {
          id: "spawn-a",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["a"],
          workflowPhases: ["Review", "Verify"],
          prompt: "Inspect code",
          agentsStates: { a: { status: "running" } },
        },
        {
          id: "activity-a",
          type: "subAgentActivity",
          kind: "started",
          agentThreadId: "a",
          agentPath: "/root/review:dialog",
        },
        {
          id: "spawn-b",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          receiverThreadIds: ["b"],
          prompt: "Inspect tests",
          agentsStates: { b: { status: "running" } },
        },
      ],
    },
  ],
};
test("Code transcript groups concurrent child events into one Workflow card", () => {
  const html = renderToStaticMarkup(
    createElement(ConversationTranscript, {
      conversation,
      mode: "code",
      sending: false,
      running: true,
      approvals: [],
      replyFeedback: {},
      onReplyFeedback: async () => {},
      onArtifact() {},
      onOpenWorkflow() {},
      onEditPrompt: async () => true,
      onRetryResponse() {},
      onContinue() {},
      onSelectVersion() {},
      onError() {},
      scrollRef: createRef<HTMLDivElement>(),
      onScroll() {},
      onWheel() {},
      away: false,
      onJumpToLatest() {},
    }),
  );
  assert.equal((html.match(/class="workflow-card"/g) ?? []).length, 1);
  assert.match(html, /<b>2<\/b> agents/);
  assert.doesNotMatch(html, /"type": "collabAgentToolCall"/);
});

test("multiple unphased child tasks in one turn stay separate Agent cards", () => {
  const independent: Conversation = {
    ...conversation,
    turns: [
      {
        ...conversation.turns[0],
        items: conversation.turns[0].items.map((item) =>
          item.type === "collabAgentToolCall"
            ? { ...item, workflowPhases: undefined }
            : item,
        ),
      },
    ],
  };
  const html = renderToStaticMarkup(
    createElement(ConversationTranscript, {
      conversation: independent,
      mode: "code",
      sending: false,
      running: true,
      approvals: [],
      replyFeedback: {},
      onReplyFeedback: async () => {},
      onArtifact() {},
      onOpenWorkflow() {},
      onEditPrompt: async () => true,
      onRetryResponse() {},
      onContinue() {},
      onSelectVersion() {},
      onError() {},
      scrollRef: createRef<HTMLDivElement>(),
      onScroll() {},
      onWheel() {},
      away: false,
      onJumpToLatest() {},
    }),
  );
  // Code shows each agent as its own one-line row.
  assert.equal((html.match(/class="code-agent-row"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /class="workflow-card"/);
});
