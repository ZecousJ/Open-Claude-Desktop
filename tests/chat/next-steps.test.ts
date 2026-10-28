import assert from "node:assert/strict";
import { test } from "node:test";
import type { Conversation, Turn } from "../../shared/types";
import {
  dismiss,
  isDismissed,
  nextSteps,
  shownSteps,
  type NextStepsInput,
} from "../../src/code-home/next-steps";

const now = Date.UTC(2026, 9, 15);
const turn = (id: string, status: Turn["status"]): Turn =>
  ({
    id,
    prompt: "",
    attachments: [],
    items: [],
    status,
    createdAt: now,
  }) as Turn;
const session = (id: string, extra: Partial<Conversation>): Conversation =>
  ({
    id,
    title: id,
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: now - 1000,
    updatedAt: now - 1000,
    turns: [turn(`${id}-1`, "completed")],
    ...extra,
  }) as Conversation;
const base: NextStepsInput = {
  folder: "/repo",
  repository: true,
  worktreeOn: false,
  conversations: [],
  waiting: [],
  now,
};

test("the rows come in the original's order, one per kind, at most three", () => {
  const steps = nextSteps({
    ...base,
    conversations: [
      session("a", { cwd: "/repo", turns: [turn("a1", "inProgress")] }),
      session("b", { cwd: "/other", updatedAt: now - 10 }),
      session("c", { cwd: "/elsewhere", updatedAt: now - 20 }),
      session("d", { cwd: "/repo", turns: [turn("d1", "failed")] }),
    ],
    waiting: [
      { conversationId: "b", id: "1" },
      { conversationId: "c", id: "2" },
    ],
    branch: { current: "feature", defaultBranch: "main" },
    uncommittedFiles: 2,
  });
  const rows = shownSteps(steps, {});
  assert.deepEqual(
    rows.map((r) => [r.first.id, r.more]),
    [
      ["waiting-session", 1],
      ["worktree-apart", 0],
      ["resume-session", 0],
    ],
  );
  assert.equal(
    rows[0].first.id === "waiting-session" && rows[0].first.sessionId,
    "b",
  );
});

test("Worktree is suggested only for a repository without it, and continue only off the default branch", () => {
  const running = [
    session("a", { cwd: "/repo", turns: [turn("a1", "inProgress")] }),
  ];
  assert.equal(
    nextSteps({ ...base, conversations: running }).at(0)?.id,
    "worktree-apart",
  );
  assert.equal(
    nextSteps({ ...base, repository: false, conversations: running }).length,
    0,
  );
  const onMain = nextSteps({
    ...base,
    branch: { current: "main", defaultBranch: "main" },
    uncommittedFiles: 3,
  });
  assert.equal(onMain.length, 0);
  const onFeature = nextSteps({
    ...base,
    branch: { current: "feature", defaultBranch: "main" },
    uncommittedFiles: 3,
  });
  assert.deepEqual(onFeature, [
    { id: "continue-branch", folder: "/repo", branch: "feature", files: 3 },
  ]);
});

test("a dismissal holds until what it was about changes", () => {
  const step = {
    id: "continue-branch",
    folder: "/repo",
    branch: "f",
    files: 3,
  } as const;
  const dismissed = dismiss({}, step);
  assert.ok(isDismissed(dismissed, step));
  assert.equal(shownSteps([step], dismissed).length, 0);
  // One more uncommitted file: it shows again.
  assert.ok(!isDismissed(dismissed, { ...step, files: 4 }));
  // Stored keys don't hold the folder or branch.
  assert.ok(!JSON.stringify(dismissed).includes("/repo"));
});

test("the folder's pull request suggests fixing checks and answering comments", () => {
  const steps = nextSteps({
    ...base,
    branch: { current: "feature", defaultBranch: "main" },
    pullRequest: {
      repository: "o/r",
      number: 7,
      title: "Trim names",
      headSha: "abc",
      checks: "failed",
      failingCheck: "test",
      unansweredReviewThreads: 2,
      newestReviewComment: 9,
    },
  });
  assert.deepEqual(
    steps.map((s) => s.id),
    ["pr-ci-failed", "pr-review-comments"],
  );
  const rows = shownSteps(steps, {});
  assert.equal(rows.length, 2);
});
