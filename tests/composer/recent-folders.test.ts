import test from "node:test";
import assert from "node:assert/strict";
import type { Conversation } from "../../shared/types";
import { folderName, recentFolders } from "../../src/composer/recentFolders";

const row = (
  id: string,
  updatedAt: number,
  patch: Partial<Conversation> = {},
): Conversation => ({
  id,
  title: id,
  mode: "code",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 0,
  updatedAt,
  turns: [],
  ...patch,
});

test("recent folders come from Code rows, newest first, once each", () => {
  const folders = recentFolders([
    row("a", 1, { cwd: "/w/old" }),
    row("b", 5, { cwd: "/w/new" }),
    row("c", 3, { cwd: "/w/old" }),
    row("d", 9, { cwd: "/w/chat", mode: "chat" }),
    row("e", 7),
  ]);
  assert.deepEqual(folders, ["/w/new", "/w/old"]);
});

test("recent folders are capped", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row(String(i), i, { cwd: `/w/${i}` }),
  );
  assert.equal(recentFolders(rows).length, 8);
  assert.equal(recentFolders(rows)[0], "/w/11");
});

test("folder names are the last path segment", () => {
  assert.equal(folderName("/Users/me/claudex"), "claudex");
  assert.equal(folderName("C:\\work\\codex 客户端\\"), "codex 客户端");
});
