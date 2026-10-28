import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CodeLanding,
  attentionKind,
  attentionSessions,
  landingProjects,
  landingRowLimit,
} from "../../src/code-home/CodeLanding";
import type { Conversation, Project } from "../../shared/types";

const session = (id: string, extra: Partial<Conversation> = {}): Conversation =>
  ({
    id,
    title: `Session ${id}`,
    mode: "code",
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
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  }) as Conversation;

test("sessions on the landing: blocked first, then the rest newest first; pinned and archived ones left out", () => {
  const rows = attentionSessions(
    [
      session("a", { unread: true, updatedAt: 3 }),
      session("b", { updatedAt: 1 }),
      session("c", { updatedAt: 2 }),
      session("d", { unread: true, pinned: true }),
      session("e", { unread: true, archived: true }),
      session("f", {
        updatedAt: 5,
        turns: [
          {
            id: "t",
            prompt: "x",
            attachments: [],
            items: [],
            status: "inProgress",
            createdAt: 0,
          },
        ],
      }),
    ],
    [{ conversationId: "c" }],
  );
  assert.deepEqual(
    rows.map((r) => `${r.conversation.id}:${r.kind}`),
    ["c:blocked", "f:working", "a:unread"],
  );
  assert.equal(attentionKind(session("x"), []), undefined);
});

test("projects with something going on, and the row limit by the window's height", () => {
  const now = 1_000_000_000_000;
  const projects = [
    { id: "p1", name: "Alpha" },
    { id: "p2", name: "Beta" },
    { id: "p3", name: "Old" },
  ] as Project[];
  const listed = landingProjects(
    projects,
    [
      session("1", { projectId: "p1", updatedAt: now - 1000 }),
      session("2", { projectId: "p2", updatedAt: now - 5000, unread: true }),
      session("3", { projectId: "p3", updatedAt: now - 9e8 }),
    ],
    now,
  );
  assert.deepEqual(
    listed.map((p) => p.project.name),
    ["Beta", "Alpha"],
  );
  assert.equal(landingRowLimit(700), 3);
  assert.equal(landingRowLimit(950), 5);
  assert.equal(landingRowLimit(1200), 5);
  assert.equal(landingRowLimit(1200, Infinity), 7);
});

test("the landing draws Sessions with its pills and leaves out empty sections", () => {
  const html = renderToStaticMarkup(
    createElement(CodeLanding, {
      conversations: [session("a", { unread: true })],
      projects: [],
      approvals: [],
      onOpen() {},
      onOpenProject() {},
      onOpenPr() {},
      onMarkAllRead() {},
    }),
  );
  assert.match(html, /<h2>Sessions<\/h2>/);
  assert.match(html, /data-kind="unread".*Unread/);
  assert.match(html, /Mark all as read/);
  assert.doesNotMatch(html, /Projects|Pull requests/);
  assert.equal(
    renderToStaticMarkup(
      createElement(CodeLanding, {
        conversations: [],
        projects: [],
        approvals: [],
        onOpen() {},
        onOpenProject() {},
        onOpenPr() {},
      }),
    ),
    "",
  );
});

test("the Sessions page's search sort: Type puts title matches first, Date is newest first", async () => {
  const { sortSearchResults } =
    await import("../../src/collections/history/history-rows");
  const rows = [
    session("a", { title: "Payments bug", updatedAt: 1 }),
    session("b", { title: "Other", updatedAt: 3 }),
    session("c", { title: "payments refactor", updatedAt: 2 }),
  ];
  assert.deepEqual(
    sortSearchResults(rows, "payments", "type").map((c) => c.id),
    ["c", "a", "b"],
  );
  assert.deepEqual(
    sortSearchResults(rows, "payments", "date").map((c) => c.id),
    ["b", "c", "a"],
  );
});

test("Clean up inactive sessions without deleting them removes their worktrees", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { StorageCleanup } =
    await import("../../electron/workspace/storage-cleanup");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cleanup-"));
  try {
    const tree = path.join(root, "tree");
    fs.mkdirSync(tree);
    const old = session("old", {
      updatedAt: 1000,
      createdAt: 1000,
      worktree: {
        path: tree,
        branch: "b",
        repository: root,
        origin: root,
        name: "n",
      },
    });
    const removed: string[] = [];
    const cleanup = new StorageCleanup({
      root,
      conversations: () => [old],
      remove: async () => {},
      removeWorktree: async (c) => void removed.push(c.id),
      now: () => 400 * 864e5,
    });
    const { preview } = await cleanup.preview("code", 30);
    assert.equal(preview?.worktreeCount, 1);
    const result = await cleanup.run(preview!.token, { deleteSessions: false });
    assert.equal(result.worktreesRemoved, 1);
    assert.deepEqual(removed, ["old"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("discard_kept_worktree and clean_up_worktrees ask first and act only when allowed", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { discardKeptWorktree, cleanUpWorktrees } =
    await import("../../electron/git/worktree-tools");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-host-"));
  try {
    const tree = path.join(root, "tree");
    fs.mkdirSync(tree);
    const worktree = {
      path: tree,
      branch: "claudex/x",
      repository: root,
      origin: root,
      name: "x",
    };
    const kept = session("kept", { archived: true, worktree, updatedAt: 1000 });
    const calls: string[][] = [];
    const git = async (_cwd: string, args: string[]) => {
      calls.push(args);
      return "";
    };
    let answer = "decline";
    const asked: string[] = [];
    const deps = {
      conversations: () => [kept],
      ask: async (_id: string, params: Record<string, unknown>) => {
        asked.push(String(params.message));
        return { action: answer };
      },
    };
    const no = await discardKeptWorktree(deps, "me", "kept", git as never);
    assert.equal(no.success, false);
    assert.match(
      asked[0],
      /^Allow Claudex to discard the kept worktree of “Session kept”\?\nDeletes the worktree this archived session left on disk/,
    );
    assert.equal(calls.filter((a) => a.includes("remove")).length, 0);
    answer = "accept";
    const yes = await discardKeptWorktree(deps, "me", "kept", git as never);
    assert.equal(yes.success, true);
    assert.ok(calls.some((a) => a.includes("--force") && a.includes(tree)));
    const none = await discardKeptWorktree(deps, "me", "missing", git as never);
    assert.equal(none.success, false);
    const clean = await cleanUpWorktrees(
      deps,
      "me",
      30,
      git as never,
      1000 + 40 * 864e5,
    );
    assert.match(asked.at(-1)!, /inactive for 30 days\?\nRemoves 1 worktree/);
    assert.equal(clean.success, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("set_pr_monitor asks in the original's words", async () => {
  const { prMonitorQuestion } = await import("../../shared/sync-base-branch");
  assert.equal(
    prMonitorQuestion(12, { autoFix: true, autoArchive: true }),
    "Allow Claudex to turn on auto-fix and auto-archive for pull request #12?\nAuto-archive archives this session once the pull request merges or closes.",
  );
  assert.equal(
    prMonitorQuestion(12, { autoFix: true, autoArchive: false }),
    "Allow Claudex to turn on auto-fix and turn off auto-archive for pull request #12?\nThis session stays in your list after the pull request merges or closes.",
  );
  assert.equal(
    prMonitorQuestion(7, { autoFix: false }),
    "Allow Claudex to turn off auto-fix for pull request #7?",
  );
});
