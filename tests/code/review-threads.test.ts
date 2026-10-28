import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySuggestion,
  reviewThreadsFrom,
} from "../../electron/git/review-threads";
import {
  commentSegments,
  commentSummary,
  hasHiddenCharacters,
  reviewedText,
} from "../../shared/review-threads";

test("review threads are read from GitHub's answer", () => {
  const threads = reviewThreadsFrom({
    reviewThreads: {
      nodes: [
        {
          id: "PRRT_1",
          isResolved: false,
          isOutdated: false,
          path: "app.js",
          line: 3,
          startLine: null,
          viewerCanReply: true,
          viewerCanResolve: true,
          comments: {
            nodes: [
              {
                id: "C1",
                databaseId: 5,
                body: "Nit",
                url: "https://github.com/a/b/pull/1#r5",
                author: { login: "rev" },
              },
            ],
          },
        },
        {
          id: "PRRT_2",
          path: "x.js",
          line: null,
          comments: { nodes: [{ id: "C2", url: "u", body: "old" }] },
        },
        { id: "PRRT_3", path: "y.js", comments: { nodes: [] } },
      ],
    },
  });
  assert.equal(threads.length, 2);
  assert.equal(threads[0].line, 3);
  assert.equal(threads[0].viewerCanResolve, true);
  assert.equal(threads[0].comments[0].author, "rev");
  assert.equal(threads[1].outdated, true);
});

test("a comment splits into text and suggested changes", () => {
  const segments = commentSegments(
    "Use const here.\n```suggestion\nconst x = 1;\n```\nThanks",
  );
  assert.deepEqual(segments, [
    { kind: "text", text: "Use const here." },
    { kind: "suggestion", code: "const x = 1;" },
    { kind: "text", text: "Thanks" },
  ]);
  assert.equal(commentSummary(segments), "Use const here.");
  assert.equal(
    commentSummary(commentSegments("```suggestion\nx\n```")),
    "Suggested change",
  );
  assert.equal(
    commentSummary(commentSegments("**Bold** [link](u)")),
    "Bold link",
  );
  assert.equal(hasHiddenCharacters("a‮b"), true);
  assert.equal(hasHiddenCharacters("plain"), false);
});

test("the reviewed lines are the hunk's last new-side lines", () => {
  const hunk = "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c";
  assert.equal(reviewedText(hunk, 1), "c");
  assert.equal(reviewedText(hunk, 2), "B\nc");
  assert.equal(reviewedText(hunk, 9), undefined);
});

test("a suggestion is applied only where the reviewed lines still are", () => {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), "suggest-"));
  try {
    fs.writeFileSync(path.join(top, "a.js"), "one\nlet x = 1;\nthree\n");
    const input = {
      path: "a.js",
      startLine: 2,
      endLine: 2,
      original: "let x = 1;",
      suggestion: "const x = 1;",
    };
    assert.deepEqual(applySuggestion(top, input), { ok: true });
    assert.equal(
      fs.readFileSync(path.join(top, "a.js"), "utf8"),
      "one\nconst x = 1;\nthree\n",
    );
    assert.deepEqual(applySuggestion(top, input), {
      ok: false,
      reason: "changed",
    });
    fs.writeFileSync(path.join(top, "a.js"), "zero\none\nlet x = 1;\n");
    assert.deepEqual(applySuggestion(top, input), {
      ok: false,
      reason: "moved",
    });
    assert.deepEqual(applySuggestion(top, { ...input, path: "../out.js" }), {
      ok: false,
      reason: "denied",
    });
    assert.deepEqual(applySuggestion(top, { ...input, suggestion: "x​" }), {
      ok: false,
      reason: "hidden",
    });
  } finally {
    fs.rmSync(top, { recursive: true, force: true });
  }
});
