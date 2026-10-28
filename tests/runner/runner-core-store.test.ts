/**
 * CloudStore (runner/src/cloud-store.ts): the desktop Store backed by
 * webstore rows over the runner link.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Conversation, Turn } from "../../shared/types";
import { webLimits } from "../../shared/web-protocol";
import { type TurnDoc } from "../../shared/web-docs";
import {
  CloudStore,
  fitTurnDoc,
  normalizeSettings,
} from "../../runner/src/cloud-store";
import { memoryWebstore } from "./runner-core-support.test.ts";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "runner-store-"));

const turn = (
  id: string,
  text = "reply",
  status: Turn["status"] = "completed",
) =>
  ({
    id,
    prompt: `prompt ${id}`,
    attachments: [],
    items: [{ id: `${id}-i`, type: "agentMessage", text }],
    status,
    createdAt: 1,
  }) as unknown as Turn;

const conversation = (id: string, turns: Turn[], extra: object = {}) =>
  ({
    id,
    title: `Title ${id}`,
    mode: "chat",
    providerId: "sub2api",
    model: "gpt",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    turns,
    ...extra,
  }) as unknown as Conversation;

const ops = (log: { op: string }[]) => log.map((entry) => entry.op);

test("a new user starts with default settings and nothing on disk", async () => {
  const web = memoryWebstore();
  const root = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  assert.equal(store.settings.theme, normalizeSettings(null).theme);
  assert.deepEqual(store.conversations, []);
  store.settings.name = "Ada";
  store.flush();
  await store.settled();
  assert.equal((web.users.get(1)!.settings as any).name, "Ada");
  // The account never lands in the runner's files.
  for (const name of ["settings.json", "conversations.json", "projects.json"])
    assert.equal(fs.existsSync(path.join(root, name)), false);
});

test("deleting stored Code sessions leaves Chat, Cowork and other accounts intact", async () => {
  const web = memoryWebstore(1);
  const root = temp();
  const store = await CloudStore.open({ root, userId: 18, transport: web });
  try {
    store.conversations.push(
      conversation("chat", [turn("chat")]),
      conversation("cowork", [turn("cowork")], { mode: "cowork" }),
      conversation("code1", [turn("code1")], { mode: "code" }),
      conversation("code2", [turn("code2")], { mode: "code" }),
    );
    await store.sync();
    await store.deleteStoredCodeSessions();
    await store.sync();
    assert.deepEqual(
      store.conversations.map((item) => item.id),
      ["chat", "cowork"],
    );
    assert.deepEqual(
      [...web.users.get(18)!.conversations.keys()],
      ["chat", "cowork"],
    );
    assert.deepEqual([...web.users.get(18)!.turns.keys()], ["chat", "cowork"]);
    assert.ok(web.log.every((entry) => entry.userId === 18));
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("flush writes only the rows that changed, in sidebar order", async () => {
  const web = memoryWebstore();
  const store = await CloudStore.open({
    root: temp(),
    userId: 2,
    transport: web,
  });
  store.conversations.push(conversation("a", [turn("a1"), turn("a2")]));
  store.conversations.push(conversation("b", [turn("b1")]));
  store.projects.push({
    id: "p",
    name: "P",
    description: "",
    instructions: "",
    createdAt: 1,
  });
  store.flush();
  await store.settled();
  const rows = web.users.get(2)!;
  assert.equal(rows.conversations.get("a")!.position, 0);
  assert.equal(rows.conversations.get("b")!.position, 1);
  assert.equal(rows.turns.get("a")!.size, 2);
  assert.equal(rows.projects.size, 1);
  // Nothing changed: nothing is written.
  web.log.length = 0;
  store.flush();
  await store.settled();
  assert.deepEqual(ops(web.log), []);
  // One turn changes: only that turn row.
  (store.conversations[0]!.turns[1]!.items[0] as any).text = "edited";
  store.flush();
  await store.settled();
  assert.deepEqual(ops(web.log), ["store.turns.put"]);
  assert.equal(web.log[0]!.body.turns.length, 1);
  assert.equal(web.log[0]!.body.turns[0].turnId, "a2");
  // Reordering rewrites the conversation rows (their position), not turns.
  web.log.length = 0;
  store.conversations.reverse();
  store.flush();
  await store.settled();
  assert.deepEqual(ops(web.log), [
    "store.conversations.put",
    "store.conversations.put",
  ]);
  assert.equal(rows.conversations.get("b")!.position, 0);
});

test("deleted turns, conversations and projects are deleted; incognito never leaves", async () => {
  const web = memoryWebstore();
  const store = await CloudStore.open({
    root: temp(),
    userId: 3,
    transport: web,
  });
  store.conversations.push(conversation("a", [turn("a1"), turn("a2")]));
  store.conversations.push(conversation("b", [turn("b1")]));
  store.conversations.push(
    conversation("secret", [turn("s1")], { incognito: true }),
  );
  store.projects.push({
    id: "p",
    name: "P",
    description: "",
    instructions: "",
    createdAt: 1,
  });
  store.flush();
  await store.settled();
  const rows = web.users.get(3)!;
  assert.equal(rows.conversations.has("secret"), false);
  store.conversations[0]!.turns.pop();
  store.conversations.splice(1, 1);
  store.projects = [];
  web.log.length = 0;
  store.flush();
  await store.settled();
  assert.deepEqual(ops(web.log).sort(), [
    "store.conversations.delete",
    "store.projects.delete",
    "store.turns.delete",
  ]);
  assert.deepEqual([...rows.turns.get("a")!.keys()], ["|a1"]);
  assert.equal(rows.conversations.has("b"), false);
  assert.equal(
    web.log.some((entry) => JSON.stringify(entry.body).includes("secret")),
    false,
  );
});

test("a reopened store joins its rows, pages included, and marks cut-off turns", async () => {
  const web = memoryWebstore(1);
  const first = await CloudStore.open({
    root: temp(),
    userId: 4,
    transport: web,
  });
  first.conversations.push(
    conversation("a", [turn("a1"), turn("a2", "partial", "inProgress")], {
      savedBranches: [{ id: "br", turns: [turn("x1")] }],
    }),
  );
  first.conversations.push(conversation("b", [turn("b1")]));
  first.flush();
  await first.settled();
  const again = await CloudStore.open({
    root: temp(),
    userId: 4,
    transport: web,
  });
  assert.deepEqual(
    again.conversations.map((c) => c.id),
    ["a", "b"],
  );
  const a = again.conversations[0]!;
  assert.deepEqual(
    a.turns.map((t) => t.id),
    ["a1", "a2"],
  );
  assert.deepEqual(
    a.savedBranches![0]!.turns.map((t) => t.id),
    ["x1"],
  );
  // A turn a restart cut off reads as interrupted and is written back.
  assert.equal(a.turns[1]!.status, "interrupted");
  assert.equal(a.turns[1]!.stopReason, "restart");
  web.log.length = 0;
  again.flush();
  await again.settled();
  assert.deepEqual(ops(web.log), ["store.turns.put"]);
});

test("streamed writes look at running conversations only", async () => {
  const web = memoryWebstore();
  const store = await CloudStore.open({
    root: temp(),
    userId: 5,
    transport: web,
  });
  store.conversations.push(conversation("done", [turn("d1")]));
  store.conversations.push(
    conversation("live", [turn("l1"), turn("l2", "", "inProgress")]),
  );
  store.flush();
  await store.settled();
  web.log.length = 0;
  (store.conversations[1]!.turns[1]!.items[0] as any).text = "more";
  // A change outside the running conversation waits for the next flush.
  store.conversations[0]!.title = "renamed";
  await store.sync("partial");
  assert.deepEqual(ops(web.log), ["store.turns.put"]);
  assert.equal(web.log[0]!.body.turns[0].turnId, "l2");
  // The turn finishes: the partial write after that still stores it.
  store.conversations[1]!.turns[1]!.status = "completed";
  web.log.length = 0;
  await store.sync("partial");
  assert.deepEqual(ops(web.log), ["store.turns.put"]);
  web.log.length = 0;
  store.flush();
  await store.settled();
  assert.deepEqual(ops(web.log), ["store.conversations.put"]);
});

test("a failed write is sent again", async () => {
  const web = memoryWebstore();
  const logs: string[] = [];
  const store = await CloudStore.open({
    root: temp(),
    userId: 6,
    transport: web,
    log: (m) => logs.push(m),
  });
  store.conversations.push(conversation("a", [turn("a1")]));
  web.failNext("store.turns.put");
  store.flush();
  await store.settled();
  assert.match(logs[0]!, /saving user 6's data failed/);
  assert.equal(web.users.get(6)!.turns.get("a")!.size, 0);
  store.flush();
  await store.settled();
  assert.equal(web.users.get(6)!.turns.get("a")!.size, 1);
  await store.close();
});

test("a turn over the size limit is stored with its longest text cut", () => {
  const big = turn("t", "x".repeat(2000));
  const doc: TurnDoc = {
    schema: 1,
    conversationId: "c",
    branchId: null,
    turnId: "t",
    ordinal: 0,
    turn: big,
  };
  const fitted = fitTurnDoc(doc, 800);
  assert.ok(Buffer.byteLength(fitted.json) <= 800);
  assert.match(
    (fitted.doc.turn.items[0] as any).text,
    /\[Truncated: too large to store\.\]$/,
  );
  // The live turn keeps everything.
  assert.equal((big.items[0] as any).text.length, 2000);
  assert.equal(fitTurnDoc(doc).doc, doc);
  assert.equal(webLimits.turnDocBytes, 4 * 1024 * 1024);
});

test("a turn renamed while its write is on the way is stored as it was described", async () => {
  const web = memoryWebstore();
  const store = await CloudStore.open({
    root: temp(),
    userId: 9,
    transport: web,
  });
  const live = turn("pending-1", "", "inProgress");
  store.conversations.push(conversation("p", [live]));
  // Codex names the turn (turn/start) while the conversation row is written.
  const request = web.request.bind(web);
  const mismatched: string[] = [];
  web.request = async (op: string, userId: number, body?: any) => {
    if (op === "store.conversations.put") live.id = "019real";
    if (op === "store.turns.put")
      for (const doc of body.turns as TurnDoc[])
        if (doc.turn.id !== doc.turnId)
          mismatched.push(`${doc.turnId}/${doc.turn.id}`);
    return request(op, userId, body);
  };
  store.flush();
  await store.settled();
  assert.deepEqual(mismatched, [], "turn.id must equal turnId");
  // The next write follows the new name and drops the provisional row.
  store.flush();
  await store.settled();
  const ids = [
    ...(web.users.get(9)!.turns.get("p") as Map<string, any>).values(),
  ].map((row) => row.turnId);
  assert.deepEqual(ids, ["019real"]);
});
