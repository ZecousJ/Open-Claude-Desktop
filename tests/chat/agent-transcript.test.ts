import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../electron/store/store";
import { readWorkflowAgent } from "../../electron/ipc/workflow";
import {
  summarizeAgentThread,
  projectAgentTranscript,
} from "../../electron/conversations/agent-transcript";
import type { Engine } from "../../electron/engine/engine";
test("child transcript preserves messages and tool summary without raw thread metadata", () => {
  const thread = {
    turns: [
      {
        items: [
          {
            id: "command",
            type: "commandExecution",
            command: "echo synthetic",
            status: "completed",
            aggregatedOutput: "ok",
          },
          { id: "text", type: "agentMessage", text: "Finding" },
        ],
      },
    ],
  };
  assert.deepEqual(summarizeAgentThread(thread), {
    toolUses: 1,
    currentAction: undefined,
  });
  const transcript = projectAgentTranscript(
    thread,
    "fixture-model",
    "Parent context",
  );
  assert.equal(transcript.status, "completed");
  assert.equal(transcript.model, "fixture-model");
  assert.equal(transcript.context, "Parent context");
  assert.deepEqual(
    transcript.items.map((item) => item.type),
    ["commandExecution", "agentMessage"],
  );
  assert.equal(transcript.items[0].command, "echo synthetic");
  const projected = projectAgentTranscript(
    {
      turns: [
        {
          status: "completed",
          items: [
            { id: "wait", type: "sleep", durationMs: 2500 },
            {
              id: "review",
              type: "enteredReviewMode",
              review: "Synthetic review",
            },
            {
              id: "agent",
              type: "subAgentActivity",
              agentPath: "/root/fixture",
              agentThreadId: "child",
            },
          ],
        },
      ],
    },
    "fixture-model",
    "Context",
  );
  assert.equal(projected.items[0].durationMs, 2500);
  assert.equal(projected.items[1].review, "Synthetic review");
  assert.equal(projected.items[2].agentThreadId, "child");
  const active = projectAgentTranscript(
    {
      status: { type: "active" },
      turns: [
        {
          status: "inProgress",
          items: [
            {
              id: "running",
              type: "commandExecution",
              status: "inProgress",
              command: "echo pending",
            },
          ],
        },
      ],
    },
    "fixture-model",
    "Context",
  );
  assert.equal(active.status, "running");
  assert.equal(active.currentAction, "Running a command");
  assert.equal(
    projectAgentTranscript(
      { status: { type: "systemError" }, turns: [] },
      "fixture-model",
      "",
    ).status,
    "failed",
  );
  assert.equal(
    projectAgentTranscript(
      { turns: [{ status: "interrupted", items: [] }] },
      "fixture-model",
      "",
    ).status,
    "stopped",
  );
});
test("transcript access is limited to children recorded in this account conversation", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-agent-transcript-"),
  );
  try {
    const store = new Store(root);
    store.conversations = [
      {
        id: "parent",
        title: "Synthetic",
        mode: "code",
        providerId: "fixture",
        model: "fixture-model",
        pinned: false,
        archived: false,
        createdAt: 1,
        updatedAt: 1,
        turns: [
          {
            id: "turn",
            prompt: "Parent request",
            attachments: [],
            status: "completed",
            createdAt: 1,
            items: [
              {
                id: "child",
                type: "subAgentActivity",
                agentThreadId: "child-id",
                agentPath: "/root/review",
              },
            ],
          },
        ],
      },
    ];
    let calls = 0;
    const engine = {
      state: { state: "ready" },
      rpc: {
        call: async (method: string, params: any) => {
          calls++;
          assert.equal(method, "thread/read");
          assert.equal(params.threadId, "child-id");
          return {
            thread: {
              id: "child-id",
              turns: [
                {
                  items: [
                    { id: "response", type: "agentMessage", text: "Done" },
                  ],
                },
              ],
            },
          };
        },
      },
    } as unknown as Engine;
    await assert.rejects(
      readWorkflowAgent({ store, engine }, "parent", "other"),
      /not part/,
    );
    assert.equal(calls, 0);
    const result = await readWorkflowAgent(
      { store, engine },
      "parent",
      "child-id",
    );
    assert.equal(result.context, "Parent request");
    assert.equal(result.items[0].text, "Done");
    store.conversations[0].turns[0].items[0].agentPrompt =
      "Child-specific synthetic instructions";
    store.conversations[0].turns[0].items[0].agentModel = "fixture-child-model";
    const child = await readWorkflowAgent(
      { store, engine },
      "parent",
      "child-id",
    );
    assert.equal(child.context, "Child-specific synthetic instructions");
    assert.equal(child.model, "fixture-child-model");
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
