import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import {
  dismissFinding,
  findingStatus,
  findingsOn,
  fixFindingPrompt,
  isDismissed,
  latestReviewFindings,
  markFixing,
} from "../../src/review/diff-findings";

const review = [
  "Looks mostly fine.",
  "",
  "Full review comments:",
  "",
  "- [P1] Handle a null name — /repo/src/app.js:3-4",
  "  greet(null) throws.",
].join("\n");

const conversation = (status: "completed" | "inProgress" = "completed") =>
  ({
    id: "c1",
    turns: [
      {
        id: "t0",
        status: "completed",
        items: [{ id: "r", type: "exitedReviewMode", review }],
      },
      { id: "t1", status, items: [] },
    ],
  }) as unknown as Conversation;

test("the latest review's findings are placed on the panel's files", () => {
  const findings = latestReviewFindings(conversation());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 4);
  assert.equal(findings[0].startLine, 3);
  assert.equal(findingsOn(findings, "src/app.js").length, 1);
  assert.equal(findingsOn(findings, "app.js").length, 1);
  assert.equal(findingsOn(findings, "other.js").length, 0);
  assert.match(
    fixFindingPrompt(findings[0], "src/app.js"),
    /`src\/app\.js:4`\nSummary:\n> \[P1\] Handle a null name|`src\/app\.js:4`\nSummary:\n> Handle a null name/,
  );
});

test("a finding sent to fix reads Fixing until that turn ends, then Fixed", () => {
  const [finding] = latestReviewFindings(conversation());
  assert.equal(findingStatus(conversation(), finding.id), "open");
  markFixing("c1", finding.id, 1);
  assert.equal(findingStatus(conversation("inProgress"), finding.id), "fixing");
  assert.equal(
    findingStatus(conversation("completed"), finding.id),
    "addressed",
  );
  dismissFinding("c1", finding.id);
  assert.equal(isDismissed("c1", finding.id), true);
});
