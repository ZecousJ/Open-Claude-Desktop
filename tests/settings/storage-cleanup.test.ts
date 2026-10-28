/**
 * Settings → System → Storage: what each area measures, and Free up space… /
 * Clean up inactive sessions…, which delete only inactive conversations with
 * what only they use, after a preview, checking each one again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import type { StorageUsage } from "../../shared/settings-desktop-api";
import {
  cleanupEligible,
  conversationAttachments,
  storageUsage,
} from "../../electron/workspace/storage-usage";
import {
  exampleTitle,
  inUseMarker,
  planLifetimeMs,
  removeConversation,
  StorageCleanup,
  type CleanupHost,
} from "../../electron/workspace/storage-cleanup";
import {
  cleanupNotices,
  codeFound,
  confirmLabel,
  coworkFound,
  coworkNothing,
  coworkSummary,
  runtimeSummary,
  storageAreas,
  storageSize,
} from "../../src/settings/storage/storage-text";
import { Usage } from "../../src/settings/storage/StorageDialog";

const day = 24 * 60 * 60 * 1000;
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claudex-storage-"));
const thread = (n: number) =>
  `01a0fd6d-f59c-77e2-9f94-${String(n).padStart(12, "0")}`;

function conversation(
  id: string,
  fields: Partial<Conversation> & { idleDays?: number } = {},
  now = Date.now(),
): Conversation {
  const { idleDays = 100, ...rest } = fields;
  return {
    id,
    title: `Title ${id}`,
    mode: "cowork",
    providerId: "p",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: now - idleDays * day,
    updatedAt: now - idleDays * day,
    turns: [],
    ...rest,
  } as Conversation;
}

/** A profile with history files, attachments and screenshots. */
function profile(conversations: Conversation[]) {
  const root = temp();
  const write = (relative: string, bytes: number) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes));
    return file;
  };
  fs.writeFileSync(
    path.join(root, "conversations.json"),
    JSON.stringify(conversations, null, 2),
  );
  return { root, write };
}

test("storage splits the account's folder into the four areas, each byte once", async () => {
  const now = Date.now();
  const attachment = "6f9619ff-8b86-d011-b42d-00cf4fc964ff";
  const shared = "7f9619ff-8b86-d011-b42d-00cf4fc964ff";
  const digest = "a".repeat(64);
  const chat = conversation("chat", {
    mode: "chat",
    threadId: thread(1),
    turns: [
      {
        id: "t",
        status: "completed",
        createdAt: now - 100 * day,
        attachments: [{ path: "" }],
        items: [{ type: "file", digest }],
      } as any,
    ],
  });
  const codeSession = conversation("code", {
    mode: "code",
    threadId: thread(2),
    idleDays: 1,
  });
  const { root, write } = profile([chat, codeSession]);
  // The chat's attachment is in the profile; the second is shared with the session.
  chat.turns[0].attachments = [
    {
      id: "a",
      name: "a.png",
      kind: "image",
      size: 10,
      path: path.join(root, "attachments", attachment, "a.png"),
    },
    {
      id: "b",
      name: "b.png",
      kind: "image",
      size: 10,
      path: path.join(root, "attachments", shared, "b.png"),
    },
  ];
  codeSession.turns = [
    {
      id: "t2",
      status: "completed",
      createdAt: now - day,
      items: [],
      attachments: [chat.turns[0].attachments[1]],
    } as any,
  ];
  fs.writeFileSync(
    path.join(root, "conversations.json"),
    JSON.stringify([chat, codeSession], null, 2),
  );
  write(`attachments/${attachment}/a.png`, 300);
  write(`attachments/${shared}/b.png`, 70);
  write(`generated-files/${digest}`, 40);
  write(
    `codex-home/sessions/2026/01/02/rollout-2026-01-02T00-00-00-${thread(1)}.jsonl`,
    500,
  );
  write(
    `codex-home/archived_sessions/rollout-2026-01-03T00-00-00-${thread(2)}.jsonl`,
    200,
  );
  // A deleted conversation's history: the rest of the folder.
  write(
    `codex-home/sessions/2026/01/04/rollout-2026-01-04T00-00-00-${thread(9)}.jsonl`,
    900,
  );
  write("codex-home/skills/s/SKILL.md", 60);
  write("codex-home/log/codex.log", 25);
  write("workspace/notes.txt", 11);
  write("terminal-workspace/x", 13);
  write("settings.json", 7);
  const data = temp();
  const writeData = (relative: string, bytes: number) => {
    fs.mkdirSync(path.dirname(path.join(data, relative)), { recursive: true });
    fs.writeFileSync(path.join(data, relative), Buffer.alloc(bytes));
  };
  writeData("Cache/data_0", 1000);
  writeData("GPUCache/x", 24);
  writeData("Partitions/a/b", 64);
  writeData("updates/claudex.zip", 128);
  writeData("runtime-cache/codex-0.144.1-x86_64-unknown-linux-musl.tgz", 512);
  writeData("runtime-cache/codex-0.144.1-aarch64-unknown-linux-musl.tgz", 256);
  const logs = temp();
  fs.writeFileSync(path.join(logs, "main.log"), Buffer.alloc(5));
  const usage = await storageUsage({
    root,
    dataRoot: data,
    conversations: [chat, codeSession],
    logFolders: [logs],
    now,
  });
  const profileBytes = (folder: string): number =>
    fs.readdirSync(folder, { withFileTypes: true }).reduce((sum, entry) => {
      const full = path.join(folder, entry.name);
      return (
        sum +
        (entry.isDirectory() ? profileBytes(full) : fs.statSync(full).size)
      );
    }, 0);
  const areas = storageAreas(usage);
  // Every byte of the profile is in Cowork, Code or the logs.
  assert.equal(areas.cowork + areas.code + 25, profileBytes(root));
  assert.equal(usage.cowork.count, 1);
  assert.equal(usage.cowork.chatCount, 1);
  assert.equal(usage.code.sessionCount, 1);
  assert.equal(usage.cowork.filesBytes, 300 + 70 + 40);
  assert.equal(usage.cowork.pluginsAndSkillsBytes, 60);
  assert.equal(usage.cowork.workspaceBytes, 11);
  assert.equal(usage.code.scratchBytes, 13);
  assert.ok(usage.cowork.otherBytes >= 900 + 7);
  assert.ok(usage.code.historyBytes > 200);
  assert.ok(usage.cowork.historyBytes > 500);
  assert.equal(usage.runtime.versionCount, 1);
  assert.equal(usage.runtime.bytes, 768);
  assert.deepEqual(usage.app, {
    webCacheBytes: 1024,
    browserPanesBytes: 64,
    logsBytes: 30,
    otherCachesBytes: 128,
  });
  // The chat went quiet 100 days ago: its own files, not the shared one.
  assert.equal(usage.cowork.stale.count, 1);
  assert.ok(usage.cowork.stale.bytes > 500 + 300 + 40);
  assert.ok(usage.cowork.stale.bytes < 500 + 300 + 40 + 70 + 2000);
  assert.equal(usage.incomplete, false);
});

test("cleanup picks only saved, local, unpinned, idle conversations of its area", () => {
  const now = Date.now();
  const idle = (fields: Partial<Conversation> = {}) =>
    cleanupEligible(conversation("c", fields, now), "cowork", 30, now);
  assert.equal(idle(), true);
  assert.equal(idle({ mode: "chat" }), true);
  assert.equal(idle({ mode: "code" }), false);
  assert.equal(idle({ pinned: true }), false);
  assert.equal(idle({ incognito: true }), false);
  assert.equal(
    idle({ environment: { kind: "ssh", hostId: "h" } } as any),
    false,
  );
  assert.equal(idle({ idleDays: 10 } as any), false);
  assert.equal(
    idle({ turns: [{ id: "t", status: "inProgress", createdAt: 1 }] } as any),
    false,
  );
  // A message newer than the record's dates counts as activity.
  assert.equal(
    idle({
      turns: [{ id: "t", status: "completed", createdAt: now - day }],
    } as any),
    false,
  );
  assert.equal(
    cleanupEligible(conversation("s", { mode: "code" }, now), "code", 30, now),
    true,
  );
});

function host(root: string, conversations: Conversation[], now: () => number) {
  const store = {
    conversations,
    flushed: 0,
    flush() {
      this.flushed++;
      fs.writeFileSync(
        path.join(root, "conversations.json"),
        JSON.stringify(this.conversations),
      );
    },
  };
  const forgotten: string[] = [];
  let finished = 0;
  const cleanupHost: CleanupHost = {
    root,
    conversations: () => store.conversations,
    remove: (c, rollouts) =>
      removeConversation(
        { root, store, forget: (id) => void forgotten.push(id) },
        c,
        rollouts,
      ),
    finished: () => finished++,
    now,
  };
  return {
    store,
    forgotten,
    finished: () => finished,
    cleanup: new StorageCleanup(cleanupHost),
  };
}

test("Free up space deletes the inactive tasks with their history and only their files", async () => {
  const now = Date.now();
  const shared = "8f9619ff-8b86-d011-b42d-00cf4fc964ff";
  const own = "9f9619ff-8b86-d011-b42d-00cf4fc964ff";
  const conversations = [
    conversation("old-chat", {
      mode: "chat",
      threadId: thread(1),
      title: "  Old chat  ",
    }),
    conversation("old-task", { threadId: thread(2), idleDays: 200 }),
    conversation("pinned", { pinned: true }),
    conversation("recent", { idleDays: 3 }),
    conversation("session", { mode: "code" }),
  ];
  const { root, write } = profile(conversations);
  const attach = (c: Conversation, name: string) =>
    c.turns.push({
      id: `t-${c.id}-${name}`,
      status: "completed",
      createdAt: c.updatedAt,
      items: [],
      attachments: [
        {
          id: name,
          name: "f",
          kind: "text",
          size: 1,
          path: path.join(root, "attachments", name, "f"),
        },
      ],
    } as any);
  attach(conversations[0], own);
  attach(conversations[0], shared);
  attach(conversations[3], shared);
  const ownFile = write(`attachments/${own}/f`, 100);
  // Larger than every record together, so counting it would show.
  const sharedFile = write(`attachments/${shared}/f`, 20_000);
  const history = write(
    `codex-home/sessions/2026/01/02/rollout-2026-01-02T00-00-00-${thread(1)}.jsonl`,
    400,
  );
  const archived = write(
    `codex-home/archived_sessions/rollout-2026-01-02T00-00-00-${thread(2)}.jsonl`,
    300,
  );
  const shots = write("computer-use/screenshots/old-chat/a.jpg", 50);
  // History files were written "now"; the clock runs 300 days ahead so they
  // are as old as their conversations.
  const clock = () => now + 300 * day;
  conversations.forEach((c) => {
    c.updatedAt += 300 * day;
    c.createdAt += 300 * day;
    for (const turn of c.turns) turn.createdAt += 300 * day;
  });
  const { store, cleanup, forgotten, finished } = host(
    root,
    conversations,
    clock,
  );
  const { preview } = await cleanup.preview("cowork", 30);
  assert.ok(preview);
  assert.equal(preview.count, 2);
  assert.equal(preview.chatCount, 1);
  assert.equal(preview.unverifiedCount, 0);
  // Most recently active first, titles trimmed.
  assert.deepEqual(
    preview.examples.map((example) => example.title),
    ["Old chat", "Title old-task"],
  );
  assert.ok(preview.bytes >= 400 + 300 + 100 + 50);
  assert.ok(preview.bytes < 400 + 300 + 100 + 50 + 20_000);
  const progress: [number, number][] = [];
  const result = await cleanup.run(preview.token, {}, (done, total) =>
    progress.push([done, total]),
  );
  assert.deepEqual(result, {
    deletedCount: 2,
    skippedCount: 0,
    failedCount: 0,
    failedInUseCount: 0,
    cancelled: false,
  });
  assert.deepEqual(progress, [
    [0, 2],
    [1, 2],
    [2, 2],
  ]);
  assert.deepEqual(
    store.conversations.map((c) => c.id),
    ["pinned", "recent", "session"],
  );
  // The oldest first.
  assert.deepEqual(forgotten, ["old-task", "old-chat"]);
  assert.equal(finished(), 1);
  for (const gone of [history, archived, ownFile, shots])
    assert.equal(fs.existsSync(gone), false, gone);
  // Still used by "recent".
  assert.equal(fs.existsSync(sharedFile), true);
  // A token works once.
  assert.equal((await cleanup.run(preview.token, {})).errorCode, "expired");
});

test("a cleanup leaves alone what changed since the preview, and stops when asked", async () => {
  const now = Date.now();
  const conversations = [
    conversation("a", { idleDays: 90 }),
    conversation("b", { idleDays: 80 }),
    conversation("c", { idleDays: 70 }),
  ];
  const { root } = profile(conversations);
  let clock = now;
  const { cleanup, store } = host(root, conversations, () => clock);
  const first = (await cleanup.preview("cowork", 60)).preview!;
  assert.equal(first.count, 3);
  // Pinned after the preview: kept.
  conversations[0].pinned = true;
  const result = await cleanup.run(first.token, {}, (done) => {
    if (done === 2) cleanup.cancel();
  });
  assert.equal(result.skippedCount, 1);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.cancelled, true);
  assert.deepEqual(
    store.conversations.map((c) => c.id),
    ["a", "c"],
  );
  // A preview older than ten minutes is refused.
  const second = (await cleanup.preview("cowork", 60)).preview!;
  clock += planLifetimeMs + 1;
  assert.equal((await cleanup.run(second.token, {})).errorCode, "expired");
  // A newer preview replaces the older one.
  const third = (await cleanup.preview("cowork", 30)).preview!;
  await cleanup.preview("cowork", 30);
  assert.equal((await cleanup.run(third.token, {})).errorCode, "expired");
});

test("history changed on this computer recently is not freed", async () => {
  const now = Date.now();
  // Inactive for 25 days by its record; its history file was just written.
  const conversations = [
    conversation("copied", { threadId: thread(5), idleDays: 25 }),
    conversation("quiet", { idleDays: 25 }),
  ];
  const { root, write } = profile(conversations);
  write(
    `codex-home/sessions/2026/01/02/rollout-2026-01-02T00-00-00-${thread(5)}.jsonl`,
    10,
  );
  const { cleanup } = host(root, conversations, () => now + 10 * day);
  const preview = (await cleanup.preview("cowork", 30)).preview!;
  assert.equal(preview.count, 1);
  assert.equal(preview.unverifiedCount, 1);
  assert.deepEqual(
    preview.examples.map((example) => example.title),
    ["Title quiet"],
  );
});

test("Clean up inactive sessions deletes Code sessions only when asked to", async () => {
  const conversations = [
    conversation("session", { mode: "code" }),
    conversation("task"),
  ];
  const { root } = profile(conversations);
  const { cleanup, store } = host(root, conversations, () => Date.now());
  const preview = (await cleanup.preview("code", 30)).preview!;
  assert.equal(preview.count, 1);
  assert.equal(preview.chatCount, 0);
  // Without "Also delete…" there is nothing to remove (no worktrees).
  const nothing = await cleanup.run(preview.token, {});
  assert.equal(nothing.deletedCount, 0);
  assert.equal(store.conversations.length, 2);
  const again = (await cleanup.preview("code", 30)).preview!;
  const result = await cleanup.run(again.token, { deleteSessions: true });
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(
    store.conversations.map((c) => c.id),
    ["task"],
  );
});

test("a conversation whose history can't be moved is left whole", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const c = conversation("locked", { threadId: thread(7) });
  const { root, write } = profile([c]);
  const file = write(
    `codex-home/sessions/2026/01/02/rollout-2026-01-02T00-00-00-${thread(7)}.jsonl`,
    10,
  );
  const store = { conversations: [c], flush() {} };
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    await assert.rejects(
      removeConversation({ root, store }, c, [file]),
      (error: Error) => error.message.includes(inUseMarker),
    );
    assert.equal(store.conversations.length, 1);
    assert.equal(fs.existsSync(file), true);
  } finally {
    fs.chmodSync(path.dirname(file), 0o755);
  }
  // Files outside the account's history are never touched.
  await assert.rejects(
    removeConversation({ root, store }, c, [path.join(temp(), "x.jsonl")]),
  );
});

test("history and attachments another conversation or a draft still uses stay", async () => {
  const draft = "1f9619ff-8b86-d011-b42d-00cf4fc964ff";
  const gone = conversation("gone", { threadId: thread(3) });
  const keeper = conversation("keeper", {
    savedBranches: [{ threadId: thread(3).toUpperCase() }] as any,
  });
  const { root, write } = profile([gone, keeper]);
  const file = write(
    `codex-home/sessions/2026/01/02/rollout-2026-01-02T00-00-00-${thread(3)}.jsonl`,
    10,
  );
  const draftFile = write(`attachments/${draft}/note.txt`, 5);
  gone.turns.push({
    id: "t",
    status: "completed",
    createdAt: 1,
    items: [],
    attachments: [{ path: draftFile }],
  } as any);
  const calls: string[] = [];
  const store = { conversations: [gone, keeper], flush() {} };
  await removeConversation(
    {
      root,
      store,
      rpc: { call: async (method) => void calls.push(method) },
      attachmentsInUse: () => [draftFile],
    },
    gone,
    [file],
  );
  assert.deepEqual(
    store.conversations.map((c) => c.id),
    ["keeper"],
  );
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(draftFile), true);
  // The shared thread is neither unloaded nor archived.
  assert.deepEqual(calls, []);
});

test("attachments are read from the profile's attachment folder only", () => {
  const root = temp();
  const c = conversation("c", {
    turns: [
      {
        id: "t",
        status: "completed",
        createdAt: 1,
        items: [],
        attachments: [
          {
            path: path.join(
              root,
              "attachments",
              "0f8fad5b-d9cb-469f-a165-70867728950e",
              "a",
            ),
          },
          { path: "/Users/someone/Desktop/report.pdf" },
          { path: path.join(root, "attachments", "..", "settings.json") },
        ],
      } as any,
    ],
  });
  assert.deepEqual(conversationAttachments(root, c), [
    "0f8fad5b-d9cb-469f-a165-70867728950e",
  ]);
});

test("the dialog's words follow the counts", () => {
  assert.equal(storageSize(0, "en-US"), "0 bytes");
  assert.equal(storageSize(1500, "en-US"), "1.5 kB");
  assert.equal(storageSize(2_300_000_000, "en-US"), "2.3 GB");
  assert.equal(exampleTitle(`  ${"x".repeat(100)}  `), `${"x".repeat(79)}…`);
  assert.equal(confirmLabel("cowork", 1, 1, false), "Delete 1 task or chat");
  assert.equal(confirmLabel("cowork", 3, 0, false), "Delete 3 tasks");
  assert.equal(confirmLabel("cowork", 0, 0, false), "Delete");
  assert.equal(confirmLabel("code", 2, 0, false), "Remove");
  assert.equal(confirmLabel("code", 2, 0, true), "Delete 2 sessions");
  assert.match(
    coworkFound(2, 1, "1 MB"),
    /^2 inactive tasks and chats · 1 MB$/,
  );
  assert.equal(coworkFound(1, 0, "1 MB"), "1 inactive task · 1 MB");
  assert.equal(codeFound(1), "The inactive session no longer has a worktree");
  assert.equal(
    coworkNothing(0, 60),
    "Nothing has been inactive for 60 days, so there is nothing to delete.",
  );
  assert.match(coworkNothing(2, 30), /^2 tasks look inactive/);
  const base = {
    deletedCount: 3,
    skippedCount: 0,
    failedCount: 0,
    failedInUseCount: 0,
    cancelled: false,
  };
  assert.deepEqual(cleanupNotices("cowork", true, base), {
    success: "Deleted 3 tasks and chats.",
  });
  assert.deepEqual(
    cleanupNotices("cowork", false, { ...base, skippedCount: 1 }),
    {
      success: "Deleted 3 tasks; 1 was kept.",
    },
  );
  assert.deepEqual(
    cleanupNotices("cowork", true, {
      ...base,
      deletedCount: 0,
      failedCount: 2,
      failedInUseCount: 2,
    }),
    {
      error:
        "2 tasks and chats couldn’t be deleted because files in them are in use.",
    },
  );
  assert.deepEqual(
    cleanupNotices("cowork", true, {
      ...base,
      deletedCount: 0,
      cancelled: true,
    }),
    { success: "Stopped before deleting anything." },
  );
  assert.deepEqual(
    cleanupNotices("code", false, {
      ...base,
      deletedCount: 1,
      skippedCount: 2,
    }),
    {
      success:
        "Deleted 1 session. 2 were left as they are (in use, pinned, or changed since).",
    },
  );
});

test("the dialog shows the four areas and offers each cleanup only when it has something to do", () => {
  const usage: StorageUsage = {
    computedAt: Date.now(),
    incomplete: false,
    folder: "/x",
    cowork: {
      count: 4,
      chatCount: 1,
      historyBytes: 5_000_000,
      filesBytes: 1_000,
      pluginsAndSkillsBytes: 0,
      workspaceBytes: 0,
      otherBytes: 10,
      stale: { olderThanDays: 30, count: 2, bytes: 2_000_000 },
    },
    code: { sessionCount: 0, historyBytes: 0, scratchBytes: 0 },
    runtime: { versionCount: 0, bytes: 0 },
    app: {
      webCacheBytes: 3_000,
      browserPanesBytes: 0,
      logsBytes: 0,
      otherCachesBytes: 0,
    },
  };
  assert.equal(
    coworkSummary(usage),
    "4 tasks and chats. 2 have had no activity in the last 30 days (2 MB).",
  );
  assert.equal(runtimeSummary(usage), "Codex downloads.");
  const html = renderToStaticMarkup(
    createElement(Usage, {
      usage,
      onCleanup: () => {},
      onClearCache: () => {},
    }),
  );
  for (const text of [
    "Disk space used",
    "Cowork tasks",
    "Code sessions and worktrees",
    "Runtime",
    "App caches and logs",
    "0 sessions.",
  ])
    assert.ok(html.includes(text), text);
  assert.ok(html.includes("5 MB"));
  // Details are closed until opened.
  assert.ok(!html.includes("Free up space…"));
  assert.ok(!html.includes("Clean up inactive sessions…"));
});
