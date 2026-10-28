import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBaseExtension } from "../../electron/git/sync-base-branch";
import { validSetupBranch } from "../../electron/git/worktree-tools";
import {
  setupQuestionServer,
  setupQuestionTool,
  syncBaseNamespace,
} from "../../shared/sync-base-branch";
import type { Conversation } from "../../shared/types";

const conversation = (cwd: string) =>
  ({
    id: "conversation",
    title: "Branch setup",
    mode: "code",
    cwd,
    turns: [],
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  }) as unknown as Conversation;

test("branch setup validation follows the live setup-question rules", () => {
  assert.equal(validSetupBranch("claude/changes"), true);
  assert.equal(validSetupBranch("feature/ui.v2"), true);
  assert.equal(validSetupBranch(".hidden"), false);
  assert.equal(validSetupBranch("feature/"), false);
  assert.equal(validSetupBranch("feature/../main"), false);
  assert.equal(validSetupBranch("feature.lock"), false);
  assert.equal(validSetupBranch("a".repeat(101)), false);
});

test("the setup tool is offered only on a new local Code session", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-branch-setup-"));
  fs.mkdirSync(path.join(repo, ".git"));
  const extension = syncBaseExtension(undefined, {
    conversations: () => [],
    ask: async () => undefined,
  });
  const base = {
    conversation: conversation(repo),
    mode: "code" as const,
    provider: {} as never,
    model: "model",
    policy: {} as never,
    settings: {} as never,
    sandbox: "workspace-write" as const,
  };
  const first = extension.dynamicTools!(base);
  assert.ok(
    first?.some(
      (tool) =>
        tool.type === "namespace" &&
        tool.tools.some((entry) => entry.name === setupQuestionTool),
    ),
  );
  const later = extension.dynamicTools!({
    ...base,
    conversation: {
      ...conversation(repo),
      threadId: "thread",
      turns: [
        {
          id: "t",
          prompt: "x",
          attachments: [],
          items: [],
          status: "completed",
          createdAt: 0,
        },
      ],
    } as Conversation,
  });
  assert.ok(
    !later?.some(
      (tool) =>
        tool.type === "namespace" &&
        tool.tools.some((entry) => entry.name === setupQuestionTool),
    ),
  );
  fs.rmSync(repo, { recursive: true, force: true });
});

test("setup_question asks, creates a branch, and publishes the changed conversation", async () => {
  const calls: string[][] = [];
  let asked: Record<string, unknown> | undefined;
  let changed = 0;
  const extension = syncBaseExtension(
    async (_cwd, args) => {
      calls.push(args);
      return "";
    },
    {
      conversations: () => [],
      ask: async (_id, params) => {
        asked = params;
        return {
          action: "accept",
          content: {
            branch: { kind: "branch", choice: "new", name: "claude/fix" },
          },
        };
      },
    },
  );
  const result = await extension.handleDynamicTool!({
    conversation: conversation("/repo"),
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    namespace: syncBaseNamespace,
    tool: setupQuestionTool,
    arguments: { suggested: "claude/fix" },
    changed: () => changed++,
  });
  assert.ok(result);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [["switch", "-c", "claude/fix"]]);
  assert.equal(asked?.serverName, setupQuestionServer);
  assert.equal(asked?.suggested, "claude/fix");
  assert.equal(changed, 1);
});

test("setup_question can stay on the current branch", async () => {
  let changed = 0;
  const extension = syncBaseExtension(async () => "", {
    conversations: () => [],
    ask: async () => ({
      action: "accept",
      content: { branch: { choice: "stay" } },
    }),
  });
  const result = await extension.handleDynamicTool!({
    conversation: conversation("/repo"),
    threadId: "thread",
    turnId: "turn",
    callId: "call",
    namespace: syncBaseNamespace,
    tool: setupQuestionTool,
    arguments: {},
    changed: () => changed++,
  });
  assert.ok(result);
  assert.equal(result.success, true);
  assert.equal(changed, 1);
});
