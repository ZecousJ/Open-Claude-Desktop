import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runningCommandTasks } from "../../src/conversation/running-command-tasks";
import { BackgroundTasksPanel } from "../../src/conversation/BackgroundTasksPanel";
import type { Conversation } from "../../shared/types";
const conversation: Conversation = {
  id: "fixture",
  title: "Synthetic",
  mode: "code",
  providerId: "test",
  model: "fixture-model",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  turns: [
    {
      id: "turn",
      prompt: "run",
      attachments: [],
      createdAt: 1,
      status: "inProgress",
      items: [
        {
          id: "command",
          type: "commandExecution",
          command: "echo synthetic",
          status: "inProgress",
          lifecycleStatus: "inProgress",
        },
      ],
    },
  ],
};
test("foreground Codex command appears as an interruptible Background task only while running", () => {
  assert.equal(runningCommandTasks([conversation], []).length, 1);
  const html = renderToStaticMarkup(
    createElement(BackgroundTasksPanel, {
      conversations: [conversation],
      engineReady: false,
      onClose() {},
      onStopCommand: async () => {},
      onError() {},
    }),
  );
  assert.match(html, /Running/);
  assert.match(html, /Bash · Running command/);
  assert.match(html, /Stop running command echo synthetic/);
  const native = [
    {
      conversationId: "fixture",
      itemId: "command",
      processId: "process",
      command: "echo synthetic",
      cwd: "",
    },
  ];
  assert.deepEqual(runningCommandTasks([conversation], native), []);
  const completed: Conversation = {
    ...conversation,
    turns: [{ ...conversation.turns[0], status: "completed" }],
  };
  assert.deepEqual(runningCommandTasks([completed], []), []);
});
