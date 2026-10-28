import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { TranscriptSlots } from "../../src/transcript/transcript-slots";
import { codeSlots } from "../../src/mobile-conversation/ConversationSurface";
import { OfficialTurnChanges } from "../../src/mobile-conversation/official/OfficialTurnChanges";
import type { Conversation, Item, Turn } from "../../shared/types";

const command = (id: string, extra: Partial<Item> = {}): Item => ({
  id,
  type: "commandExecution",
  command: "ls -la",
  cwd: "/repo",
  status: "completed",
  lifecycleStatus: "completed",
  aggregatedOutput: "a.txt",
  exitCode: 0,
  description: "List repository files",
  ...extra,
});

const edit = (id: string, paths: string[], kind = "update"): Item => ({
  id,
  type: "fileChange",
  status: "completed",
  lifecycleStatus: "completed",
  changes: paths.map((path) => ({
    path,
    kind: { type: kind },
    diff: "@@ -1 +1 @@\n-a\n+b\n",
  })),
});

const turn = (items: Item[], extra: Partial<Turn> = {}): Turn => ({
  id: "t1",
  prompt: "Do it",
  attachments: [],
  status: "completed",
  createdAt: 1,
  items,
  ...extra,
});

function transcript(turns: Turn[], slots = codeSlots) {
  const conversation = {
    id: "c",
    title: "T",
    mode: "code",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns,
  } as Conversation;
  return renderToStaticMarkup(
    createElement(
      TranscriptSlots.Provider,
      { value: slots },
      createElement(ConversationTranscript, {
        conversation,
        mode: "code",
        sending: false,
        running: false,
        approvals: [],
        replyFeedback: {},
        onReplyFeedback: async () => {},
        onArtifact: () => {},
        onOpenWorkflow: () => {},
        onEditPrompt: async () => true,
        onRetryResponse: () => {},
        onContinue: () => {},
        onSelectVersion: () => {},
        onError: () => {},
        onOpenChanges: () => {},
        scrollRef: createRef<HTMLDivElement>(),
        onScroll: () => {},
        onWheel: () => {},
        away: false,
        onJumpToLatest: () => {},
      }),
    ),
  );
}

test("a Code turn's tool calls are the official collapsed row, not an in-place disclosure", () => {
  const html = transcript([
    turn([command("c1"), command("c2", { command: "cat a" })]),
  ]);
  assert.match(html, /class="official-code-row"/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.doesNotMatch(html, /<details/);
  // Two calls give the summary, not one call's own words.
  assert.doesNotMatch(html, /List repository files/);
});

test("a lone command is worded by its description and the row opens a sheet", () => {
  const html = transcript([turn([command("c1")])]);
  assert.match(html, /official-code-label/);
  assert.match(html, /Listed repository files/);
});

test("a source control action is the official ccr row: its verb, then its subject", () => {
  const commit = transcript([
    turn([
      command("c1", {
        command: `git commit -m "Fix login"`,
        aggregatedOutput: "[feature 1a2b3c4] Fix login\n 1 file changed\n",
        description: "Commit the fix",
      }),
    ]),
  ]);
  assert.match(
    commit,
    /Committed <span class="official-code-subject">1a2b3c4<\/span>/,
  );
  assert.doesNotMatch(commit, /Commit the fix/);
  // The cloud session's GitHub tools word the same way.
  const pr = transcript([
    turn([
      {
        id: "g1",
        type: "dynamicToolCall",
        namespace: "github",
        tool: "create_pull_request",
        arguments: { title: "Fix", head: "feature" },
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              number: 12,
              html_url: "https://github.com/octo/repo/pull/12",
            }),
          },
        ],
        success: true,
        status: "completed",
        lifecycleStatus: "completed",
      },
    ]),
  ]);
  assert.match(
    pr,
    /Created PR <span class="official-code-subject">#12<\/span>/,
  );
  // A failed commit keeps the ordinary row.
  const failed = transcript([
    turn([
      command("c1", {
        command: "git commit -m x",
        aggregatedOutput: "[feature 1a2b3c4] x",
        exitCode: 1,
        status: "failed",
        lifecycleStatus: "failed",
      }),
    ]),
  ]);
  assert.doesNotMatch(failed, /Committed/);
});

test("a running call shimmers and a failed one is marked", () => {
  const running = transcript([
    turn(
      [command("c1", { status: "inProgress", lifecycleStatus: "inProgress" })],
      {
        status: "inProgress",
      },
    ),
  ]);
  assert.match(running, /official-code-label official-shimmer/);
  const bad = transcript([
    turn([
      command("c1", {
        status: "failed",
        lifecycleStatus: "failed",
        exitCode: 2,
      }),
    ]),
  ]);
  assert.match(bad, /data-failed="true"/);
  // A failure is an icon beside the finished wording, never "Failed to …".
  assert.match(bad, /official-code-failed/);
  assert.match(bad, /Listed repository files/);
  assert.doesNotMatch(bad, /Failed to/);
});

test("the turn's changes are the official card: Edited {file} with Review, no Undo", () => {
  const html = transcript([turn([edit("f1", ["src/app.js"])])]);
  assert.match(html, /class="official-turn-edits"/);
  assert.match(html, /Edited app\.js/);
  assert.match(html, />Review</);
  assert.doesNotMatch(html, /Undo/);
  assert.doesNotMatch(html, /code-turn-changes/);
});

test("a new file reads Created, several files list the first three then Show N more", () => {
  const created = renderToStaticMarkup(
    createElement(OfficialTurnChanges, {
      turn: turn([edit("f1", ["story.md"], "add")]),
      onOpen: () => {},
    }),
  );
  assert.match(created, /Created story\.md/);
  assert.doesNotMatch(created, /official-edits-files/);
  const many = renderToStaticMarkup(
    createElement(OfficialTurnChanges, {
      turn: turn([edit("f1", ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"])]),
      onOpen: () => {},
    }),
  );
  assert.match(many, /Edited 5 files/);
  assert.equal((many.match(/<li>/g) ?? []).length, 4);
  assert.match(many, /Show 2 more/);
  assert.match(many, /official-diff-pill/);
});

test("earlier Code replies keep Copy only: no Fork from here, no Pin as chapter", () => {
  const reply = (id: string): Item => ({
    id,
    type: "agentMessage",
    text: "Done.",
  });
  const html = transcript([
    turn([reply("m1")], { id: "t1" }),
    turn([reply("m2")], { id: "t2", createdAt: 2 }),
  ]);
  assert.match(html, /code-reply-actions/);
  assert.doesNotMatch(html, /Fork from here/);
  assert.doesNotMatch(html, /Pin as chapter/);
});

test("the back-to-bottom button is a pill with its words in Code", () => {
  const html = transcript([turn([])]);
  assert.match(html, /class="scroll-bottom-label">Scroll to bottom</);
});

test("the Code status line says Working…, not Claudex's own wording", () => {
  const html = transcript([
    turn(
      [command("c1", { status: "inProgress", lifecycleStatus: "inProgress" })],
      {
        status: "inProgress",
        createdAt: Date.now(),
      },
    ),
  ]);
  assert.match(html, />Working…</);
  assert.doesNotMatch(html, /Running tools…/);
  assert.doesNotMatch(html, /Waiting for Claudex…/);
});
