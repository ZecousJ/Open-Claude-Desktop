import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addReviewComment,
  clearReviewComments,
  commentWhere,
  reviewComments,
  withReviewComments,
} from "../../src/changes/review-comments";

test("diff comments go with the next message, then clear", () => {
  addReviewComment("c1", {
    file: "app.js",
    startLine: 2,
    endLine: 3,
    code: "const a = 1;\nconst b = 2;",
    text: "Use one declaration",
  });
  const notes = reviewComments("c1");
  assert.equal(commentWhere(notes[0]), "app.js:2–3");
  assert.equal(
    withReviewComments("", notes),
    "Review comment on app.js:2–3:\n```\nconst a = 1;\nconst b = 2;\n```\nUse one declaration\n\nAddress these review comments.",
  );
  assert.match(withReviewComments("Thanks", notes), /\n\nThanks$/);
  clearReviewComments("c1");
  assert.equal(reviewComments("c1").length, 0);
});
