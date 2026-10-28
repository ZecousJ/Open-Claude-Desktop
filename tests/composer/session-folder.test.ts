import assert from "node:assert/strict";
import test from "node:test";
import type { Conversation } from "../../shared/types";
import {
  isSessionFolder,
  recentFolders,
  recentWorkFolders,
} from "../../src/composer/recentFolders";

test("a folderless session's own folder is not offered as a recent folder", () => {
  const scratch =
    "/Users/me/Library/Application Support/Claudex/profiles/p/workspace/sessions/c885e6e9-bb32-4b40-b255-9f8c4b906c92";
  assert.ok(isSessionFolder(scratch));
  assert.ok(!isSessionFolder("/Users/me/code/sessions"));
  const conversations = [
    { mode: "code", cwd: scratch, updatedAt: 2 },
    { mode: "code", cwd: "/Users/me/app", updatedAt: 1 },
  ] as Conversation[];
  assert.deepEqual(recentFolders(conversations), ["/Users/me/app"]);
  assert.deepEqual(recentWorkFolders(conversations), ["/Users/me/app"]);
});
