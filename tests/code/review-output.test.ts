import test from "node:test";
import assert from "node:assert/strict";
import {
  fileName,
  findingsByFile,
  parseReviewOutput,
} from "../../src/review/review-output";
import { parseReviewArguments } from "../../src/review/review-target";
import {
  availableCodeSlashCommands,
  filterCodeSlashCommands,
} from "../../src/composer/code/code-slash-commands";
import { executeCodeSlashCommand } from "../../src/composer/code/code-slash-actions";

// The text Codex renders for a review (codex-rs render_review_output_text).
const several = [
  "The change mostly works, but two things need attention.",
  "",
  "Full review comments:",
  "",
  "- [P1] Missing null check — /repo/src/a.ts:12-14",
  "  `user` can be undefined here.",
  "  Guard it before reading `user.name`.",
  "",
  "- [P2] Slow loop — /repo/src/a.ts:40-40",
  "  Hoist the lookup out of the loop.",
  "",
  "- Typo — /repo/README.md:3-3",
  '  Says "teh".',
].join("\n");

test("a review's findings are read back out of Codex's text", () => {
  const output = parseReviewOutput(several);
  assert.equal(output.failed, false);
  assert.equal(
    output.summary,
    "The change mostly works, but two things need attention.",
  );
  assert.deepEqual(output.findings, [
    {
      title: "Missing null check",
      priority: 1,
      path: "/repo/src/a.ts",
      start: 12,
      end: 14,
      body: "`user` can be undefined here.\nGuard it before reading `user.name`.",
    },
    {
      title: "Slow loop",
      priority: 2,
      path: "/repo/src/a.ts",
      start: 40,
      end: 40,
      body: "Hoist the lookup out of the loop.",
    },
    {
      title: "Typo",
      path: "/repo/README.md",
      start: 3,
      end: 3,
      body: 'Says "teh".',
    },
  ]);
});

test("one finding is headed 'Review comment:', and a title may hold a dash", () => {
  const output = parseReviewOutput(
    "Review comment:\n\n- Rename — it is unclear — /repo/b.ts:1-2\n  Pick a clearer name.",
  );
  assert.equal(output.summary, "");
  assert.equal(output.findings.length, 1);
  assert.equal(output.findings[0].title, "Rename — it is unclear");
  assert.equal(output.findings[0].path, "/repo/b.ts");
  // Checkbox lists (the CLI's selection view) read the same.
  assert.equal(
    parseReviewOutput("Full review comments:\n\n- [x] Done — /a.ts:1-1\n  ok")
      .findings[0].title,
    "Done",
  );
});

test("a review without findings keeps its words; a failed one says so", () => {
  const plain = parseReviewOutput("Looks good to me. No issues found.");
  assert.deepEqual(plain, {
    summary: "Looks good to me. No issues found.",
    findings: [],
    failed: false,
  });
  assert.equal(
    parseReviewOutput("Reviewer failed to output a response.").failed,
    true,
  );
  assert.equal(parseReviewOutput("   ").failed, true);
  // A header with nothing under it is just text.
  assert.equal(
    parseReviewOutput("Notes\n\nFull review comments:\n\nnothing").findings
      .length,
    0,
  );
});

test("findings group under their file in order, and a path gives its file name", () => {
  const groups = findingsByFile(parseReviewOutput(several).findings);
  assert.deepEqual(
    groups.map((group) => [
      group.path,
      group.entries.map((entry) => entry.index),
    ]),
    [
      ["/repo/src/a.ts", [0, 1]],
      ["/repo/README.md", [2]],
    ],
  );
  assert.equal(fileName("/repo/src/a.ts"), "a.ts");
  assert.equal(fileName("C:\\repo\\a.ts"), "a.ts");
});

test("/review's text picks the target, and refuses what could read as an option", () => {
  assert.deepEqual(parseReviewArguments(""), { type: "uncommittedChanges" });
  assert.deepEqual(parseReviewArguments("  "), { type: "uncommittedChanges" });
  assert.deepEqual(parseReviewArguments("base main"), {
    type: "baseBranch",
    branch: "main",
  });
  assert.deepEqual(parseReviewArguments("base release/1.2"), {
    type: "baseBranch",
    branch: "release/1.2",
  });
  assert.deepEqual(parseReviewArguments("commit 1a2b3c4"), {
    type: "commit",
    sha: "1a2b3c4",
  });
  assert.deepEqual(parseReviewArguments("look at the error handling"), {
    type: "custom",
    instructions: "look at the error handling",
  });
  for (const bad of [
    "base",
    "base --evil",
    "base a b",
    "commit",
    "commit nope",
  ])
    assert.ok("error" in parseReviewArguments(bad), bad);
});

test("/review runs when typed in an open session, and is not in the unfiltered list", () => {
  assert.ok(
    !filterCodeSlashCommands("").some((value) => value.name === "review"),
  );
  assert.equal(filterCodeSlashCommands("review")[0]?.name, "review");
  const names = (conversationIdle: boolean) =>
    availableCodeSlashCommands({ conversationIdle, planAllowed: true }).map(
      (value) => value.name,
    );
  assert.ok(names(true).includes("review"));
  assert.ok(!names(false).includes("review"));
  const seen: string[] = [];
  const review = filterCodeSlashCommands("review")[0];
  const actions = {
    platform: "darwin" as NodeJS.Platform,
    navigate: () => {},
    settings: () => {},
    model: () => {},
    effort: () => {},
    permissions: () => {},
    plan: () => {},
    usage: () => {},
    compact: () => {},
    unavailable: (message: string) => seen.push(`unavailable:${message}`),
  };
  executeCodeSlashCommand(review, actions);
  executeCodeSlashCommand(review, {
    ...actions,
    review: () => seen.push("review"),
  });
  assert.deepEqual(seen, [
    "unavailable:Open a session to review its changes.",
    "review",
  ]);
});
