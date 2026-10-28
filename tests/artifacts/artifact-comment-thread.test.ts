import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactNotesStore } from "../../electron/artifacts/artifact-library";
import {
  artifactNoteKey,
  type ArtifactComment,
} from "../../shared/artifact-notes";
import {
  addReply,
  deleteReply,
  deleteThread,
  editComment,
  editReply,
  openCommentCount,
  threadText,
  toggleResolved,
} from "../../src/artifacts/comment-thread";
import { ArtifactCommentCard } from "../../src/artifacts/ArtifactCommentCard";
import { cleanArtifactName } from "../../src/artifacts/artifact-name";
import {
  ArtifactChrome,
  openInWebReason,
} from "../../src/artifacts/ArtifactChrome";
import type { Artifact } from "../../src/ui/components";

const comment = (id: string, extra: Partial<ArtifactComment> = {}) => ({
  id,
  text: "Make the button blue",
  x: 0.25,
  y: 0.5,
  createdAt: 10,
  resolved: false,
  ...extra,
});

test("a thread can be edited, answered and deleted without touching the others", () => {
  const start = [comment("a"), comment("b", { resolved: true })];
  const edited = editComment(start, "a", "  Make it green  ", 50);
  assert.equal(edited[0].text, "Make it green");
  assert.equal(edited[0].editedAt, 50);
  assert.equal(edited[1], start[1]);
  // The same text, or nothing, is not an edit.
  assert.equal(
    editComment(start, "a", "Make the button blue", 60)[0].editedAt,
    undefined,
  );
  assert.equal(
    editComment(start, "a", "   ", 60)[0].text,
    "Make the button blue",
  );

  const replied = addReply(start, "a", "Done", { id: "r1", now: 70 });
  assert.deepEqual(replied[0].replies, [
    { id: "r1", text: "Done", createdAt: 70 },
  ]);
  // A reply to a resolved thread reopens it.
  const reopened = addReply(start, "b", "Still wrong", { id: "r2", now: 80 });
  assert.equal(reopened[1].resolved, false);
  assert.equal(openCommentCount(reopened), 2);
  assert.equal(openCommentCount(toggleResolved(reopened, "a")), 1);

  const changed = editReply(replied, "a", "r1", "Done!", 90);
  assert.deepEqual(changed[0].replies, [
    { id: "r1", text: "Done!", createdAt: 70, editedAt: 90 },
  ]);
  assert.deepEqual(deleteReply(changed, "a", "r1")[0].replies, []);
  assert.deepEqual(
    deleteThread(changed, "a").map((c) => c.id),
    ["b"],
  );
});

test("a thread takes only text, and stops at the reply limit", () => {
  assert.equal(threadText("  hi "), "hi");
  assert.equal(threadText(" \n "), undefined);
  assert.equal(threadText("x".repeat(10_001)), undefined);
  const full = Array.from({ length: 200 }, (_, i) => ({
    id: `r${i}`,
    text: "x",
    createdAt: i,
  }));
  const [limited] = addReply(
    [comment("a", { replies: full })],
    "a",
    "one more",
    { id: "new", now: 1 },
  );
  assert.equal(limited.replies?.length, 200);
});

test("replies and edits persist with the profile's notes and stay validated", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-thread-"));
  try {
    const store = new ArtifactNotesStore(root, () => 100);
    const key = artifactNoteKey('["chat","/card.html"]');
    const thread = comment("a", {
      editedAt: 20,
      replies: [{ id: "r", text: "Done", createdAt: 30, editedAt: 40 }],
    });
    store.update(key, { comments: [thread] });
    assert.deepEqual(new ArtifactNotesStore(root).all()[key].comments, [
      thread,
    ]);
    // Comments saved before replies existed still load.
    store.update(key, { comments: [comment("old")] });
    assert.equal(new ArtifactNotesStore(root).all()[key].comments?.length, 1);
    for (const bad of [
      comment("a", {
        replies: [{ id: "r", text: "x", createdAt: 1, extra: 1 } as never],
      }),
      comment("a", { replies: [{ id: "", text: "x", createdAt: 1 }] }),
      comment("a", {
        replies: Array.from({ length: 201 }, (_, i) => ({
          id: `r${i}`,
          text: "x",
          createdAt: 1,
        })),
      }),
    ])
      assert.throws(() => store.update(key, { comments: [bad] }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the card shows the thread with its edit mark, menus and reply field", () => {
  const html = (value: ArtifactComment) =>
    renderToStaticMarkup(
      createElement(ArtifactCommentCard, {
        comment: value,
        authorName: "Zed",
        pulse: false,
        onResolve: async () => {},
        onEdit: async () => {},
        onDelete: async () => {},
        onReply: async () => {},
        onEditReply: async () => {},
        onDeleteReply: async () => {},
        onError() {},
      }),
    );
  const open = html(
    comment("a", {
      editedAt: 5,
      replies: [{ id: "r", text: "Done", createdAt: 6 }],
    }),
  );
  assert.match(open, /Resolve/);
  assert.match(open, /aria-label="Comment options"/);
  assert.match(open, /aria-label="Reply actions"/);
  assert.match(open, /edited/);
  assert.match(open, /placeholder="Add your comment"/);
  assert.match(open, /aria-label="Reply"/);
  const resolved = html(comment("a", { resolved: true }));
  assert.match(resolved, /Reopen/);
  assert.match(resolved, /placeholder="Reply to reopen…"/);
});

test("Publish shows only with hosted artifact links; Open in web says why it is greyed", () => {
  const artifact: Artifact = {
    id: "a",
    name: "Notes",
    language: "markdown",
    content: "# Notes",
    sourcePath: "/synthetic/notes.md",
    conversationId: "one",
    surface: "artifact",
  };
  const html = renderToStaticMarkup(
    createElement(ArtifactChrome, {
      artifact,
      expanded: false,
      onExpand() {},
      onClose() {},
      onRefresh() {},
      onError() {},
    }),
  );
  // No Claudex service with artifact links: no Publish button.
  assert.doesNotMatch(html, /artifact-publish-button/);
  assert.doesNotMatch(html, />Share</);
  assert.equal(
    openInWebReason,
    "Only a published artifact has a page on the web",
  );
  assert.match(html, /aria-keyshortcuts="c"/);
});

test("a typed artifact name loses control characters and folds its blanks", () => {
  assert.equal(cleanArtifactName("  My\u0007  card \n 2 "), "My card 2");
  assert.equal(cleanArtifactName("a​b"), "ab");
  assert.equal(cleanArtifactName(" ​ ㅤ "), "");
  assert.equal(cleanArtifactName(""), "");
});
