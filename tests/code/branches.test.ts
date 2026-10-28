import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginReplyBranch,
  replyVersions,
  selectReplyVersion,
} from "../../shared/branches";
import { Store } from "../../electron/store/store";
import type { Conversation, Turn } from "../../shared/types";
const turn = (id: string, time: number, group?: string): Turn => ({
  id,
  responseGroupId: group,
  prompt: id,
  createdAt: time,
  status: "completed",
  attachments: [],
  items: [{ id: id + "-answer", type: "agentMessage", text: id }],
});
const base = (): Conversation => ({
  id: "c",
  title: "Synthetic branches",
  mode: "chat",
  providerId: "p",
  model: "m",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  threadId: "native-original",
  turns: [turn("a", 1), turn("b", 2), turn("c", 3)],
});

test("switching response versions restores full descendants, model and native thread without cross-mutation", () => {
  const c = base();
  const group = beginReplyBranch(c, "b", "native-retry", "retry");
  c.turns.push(turn("b2", 4, group), turn("d", 5));
  c.model = "new-model";
  assert.deepEqual(
    replyVersions(c, c.turns[1]).map((v) => v.turnId),
    ["b", "b2"],
  );
  selectReplyVersion(c, "b2", "b");
  assert.deepEqual(
    c.turns.map((t) => t.id),
    ["a", "b", "c"],
  );
  assert.equal(c.threadId, "native-original");
  assert.equal(c.model, "m");
  c.turns.push(turn("e", 6));
  selectReplyVersion(c, "b", "b2");
  assert.deepEqual(
    c.turns.map((t) => t.id),
    ["a", "b2", "d"],
  );
  assert.equal(c.threadId, "native-retry");
  assert.equal(c.model, "new-model");
  selectReplyVersion(c, "b2", "b");
  assert.deepEqual(
    c.turns.map((t) => t.id),
    ["a", "b", "c", "e"],
  );
});

test("nested retries remember the last selected continuation and deduplicate common ancestor versions", () => {
  const c = base();
  const g = beginReplyBranch(c, "b", "t2", "two");
  c.turns.push(turn("b2", 4, g), turn("d", 5));
  const g2 = beginReplyBranch(c, "d", "t3", "three");
  c.turns.push(turn("d2", 6, g2));
  assert.deepEqual(
    replyVersions(c, c.turns[1]).map((v) => v.turnId),
    ["b", "b2"],
  );
  selectReplyVersion(c, "b2", "b");
  selectReplyVersion(c, "b", "b2");
  assert.deepEqual(
    c.turns.map((t) => t.id),
    ["a", "b2", "d2"],
  );
  assert.equal(c.threadId, "t3");
  selectReplyVersion(c, "d2", "d");
  assert.equal(c.threadId, "t2");
  selectReplyVersion(c, "b2", "b");
  selectReplyVersion(c, "b", "b2");
  assert.equal(c.turns.at(-1)?.id, "d");
});

test("invalid versions and active runs cannot switch or damage saved history", () => {
  const c = base();
  const original = structuredClone(c);
  assert.throws(() => selectReplyVersion(c, "b", "c"), /does not belong/);
  assert.deepEqual(c, original);
  c.turns[2].status = "inProgress";
  assert.throws(() => beginReplyBranch(c, "b", "new", "new"), /Wait/);
  assert.throws(() => selectReplyVersion(c, "b", "b"), /Wait/);
});

test("saved branches survive restart, including interruption recovery in inactive paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-branches-"));
  try {
    const store = new Store(root);
    const c = base();
    store.conversations.push(c);
    const group = beginReplyBranch(c, "a", "new-native", "new");
    c.turns.push(turn("a2", 4, group));
    c.savedBranches![0].turns[2].status = "inProgress";
    store.flush();
    const restored = new Store(root).conversation(c.id);
    selectReplyVersion(restored, "a2", "a");
    assert.equal(restored.threadId, "native-original");
    assert.equal(restored.turns[2].status, "interrupted");
    assert.deepEqual(
      restored.turns.map((t) => t.id),
      ["a", "b", "c"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prompt versions deduplicate reply retries and restore their most recent continuation", async () => {
  const { promptVersions } = await import("../../shared/branches");
  const c = base();
  c.turns[1].promptGroupId = "prompt-b";
  c.turns[1].promptVersionId = "b-original";
  const group = beginReplyBranch(c, "b", "reply-native", "reply");
  c.turns.push({
    ...turn("b-retry", 4, group),
    promptGroupId: "prompt-b",
    promptVersionId: "b-original",
  });
  assert.equal(promptVersions(c, c.turns[1]).length, 1);
  beginReplyBranch(c, "b-retry", "edit-native", "edit");
  c.turns.push({
    ...turn("b-edit", 5, "edited-reply-group"),
    prompt: "new text",
    promptGroupId: "prompt-b",
    promptVersionId: "b-edited",
  });
  assert.equal(replyVersions(c, c.turns[1]).length, 1);
  assert.deepEqual(
    promptVersions(c, c.turns[1]).map((v) => v.turnId),
    ["b-retry", "b-edit"],
  );
  selectReplyVersion(c, "b-edit", "b-retry", "prompt");
  selectReplyVersion(c, "b-retry", "b");
  assert.deepEqual(
    promptVersions(c, c.turns[1]).map((v) => v.turnId),
    ["b", "b-edit"],
  );
  selectReplyVersion(c, "b", "b-edit", "prompt");
  selectReplyVersion(c, "b-edit", "b", "prompt");
  assert.deepEqual(
    c.turns.map((t) => t.id),
    ["a", "b", "c"],
  );
});
