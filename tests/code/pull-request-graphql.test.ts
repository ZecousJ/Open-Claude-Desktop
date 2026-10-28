import assert from "node:assert/strict";
import { test } from "node:test";
import { pullRequestFromGraphQL } from "../../electron/git/github-cli";

const repo = (pull: Record<string, unknown>) => ({
  viewerPermission: "WRITE",
  pullRequest: {
    number: 7,
    url: "https://github.com/o/r/pull/7",
    title: "Trim names",
    state: "OPEN",
    isDraft: false,
    viewerDidAuthor: true,
    ...pull,
  },
});

test("a pull request names its failing check and counts its open threads", () => {
  const pr = pullRequestFromGraphQL(
    "o/r",
    repo({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      name: "lint",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                    },
                    {
                      name: "test",
                      status: "COMPLETED",
                      conclusion: "FAILURE",
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: true,
            comments: { nodes: [{ databaseId: 1, viewerDidAuthor: false }] },
          },
          {
            isResolved: false,
            comments: { nodes: [{ databaseId: 5, viewerDidAuthor: false }] },
          },
          {
            isResolved: false,
            comments: { nodes: [{ databaseId: 9, viewerDidAuthor: true }] },
          },
        ],
      },
    }),
  )!;
  assert.equal(pr.failingCheck, "test");
  assert.equal(pr.openReviewThreads, 2);
  assert.equal(pr.unansweredReviewThreads, 1);
  assert.equal(pr.newestReviewComment, 9);
  assert.equal(pr.viewerIsAuthor, true);
});

test("whose turn an open request is", async () => {
  const { reviewTurn } = await import("../../src/pr/ReviewChips");
  const base = {
    number: 1,
    url: "u",
    repository: "o/r",
    title: "",
    state: "open" as const,
    checks: "passed" as const,
    baseRef: "main",
    headRef: "x",
    viewerIsAuthor: true,
  };
  assert.equal(reviewTurn(base), false);
  assert.equal(reviewTurn({ ...base, review: "changesRequested" }), true);
  assert.equal(reviewTurn({ ...base, unansweredReviewThreads: 2 }), true);
  assert.equal(reviewTurn({ ...base, checks: "failed" }), true);
  assert.equal(reviewTurn({ ...base, state: "merged" }), undefined);
  assert.equal(reviewTurn({ ...base, viewerIsAuthor: false }), undefined);
});
