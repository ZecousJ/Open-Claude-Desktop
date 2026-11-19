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
import { selectChatLeaf } from "../../shared/branches";
import {
  CloudStore,
  fitTurnDoc,
  normalizeSettings,
} from "../../runner/src/cloud-store";
import { memoryWebstore } from "./runner-core-support.test.ts";
import { ResearchReports } from "../../electron/ipc/research";

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

test("reopening the runner preserves a Cowork turn executing on its account's desktop", async () => {
  const web = memoryWebstore();
  const root = temp();
  const otherRoot = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  try {
    const binding = {
      version: 1, organizationId: null, accountScope: "1", deviceId: "pc-desktop",
      remoteConversationId: "desktop-session", revision: 1, permission: "default",
    };
    store.conversations.push(
      conversation("desktop", [turn("desktop-turn", "partial desktop reply", "inProgress")], { mode: "cowork", chatDeviceBinding: binding }),
      conversation("runner", [turn("runner-turn", "partial runner reply", "inProgress")], { mode: "cowork" }),
      conversation("wrong-account", [turn("wrong-turn", "partial reply", "inProgress")], { mode: "cowork", chatDeviceBinding: { ...binding, accountScope: "2" } }),
    );
    await store.sync();
    const reopened = await CloudStore.open({ root: otherRoot, userId: 1, transport: web });
    try {
      assert.equal(reopened.conversation("desktop").turns[0].status, "inProgress");
      assert.equal(reopened.conversation("desktop").turns[0].stopReason, undefined);
      assert.equal(reopened.conversation("runner").turns[0].stopReason, "restart");
      assert.equal(reopened.conversation("wrong-account").turns[0].stopReason, "restart");
    } finally { await reopened.close(); }
  } finally {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("verified research reports follow a cloud turn to a fresh runner", async () => {
  const web = memoryWebstore();
  const root = temp();
  const otherRoot = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  try {
    const markdown = "# Résumé\n\nA private report.";
    const saved = new ResearchReports(root).write("chat", "t1", markdown);
    const t = turn("t1", "x".repeat(4 * 1024 * 1024));
    t.research = { state: "done", startedAt: 1, sourceCount: 0, report: { title: "Report", ...saved } };
    store.conversations.push(conversation("chat", [t]));
    await store.sync();
    const reopened = await CloudStore.open({ root: otherRoot, userId: 1, transport: web });
    try {
      assert.equal(reopened.conversations[0].turns[0].research?.report?.markdown, markdown);
      assert.ok(reopened.conversations[0].turns[0].items[0].text!.length < 4 * 1024 * 1024);
    } finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(otherRoot, { recursive: true, force: true }); }
});

test("cloud store never snapshots unverified or another conversation's report", async () => {
  const web = memoryWebstore();
  const root = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  try {
    const saved = new ResearchReports(root).write("other", "t1", "private");
    const corrupt = new ResearchReports(root).write("chat", "t2", "original");
    fs.writeFileSync(path.join(root, corrupt.path), "replaced");
    const t = turn("t1");
    t.research = { state: "done", startedAt: 1, sourceCount: 0, report: { title: "Report", ...saved } };
    const t2 = turn("t2");
    t2.research = { state: "done", startedAt: 1, sourceCount: 0, report: { title: "Report", ...corrupt } };
    store.conversations.push(conversation("chat", [t, t2]));
    await store.sync();
    const reopened = await CloudStore.open({ root: temp(), userId: 1, transport: web });
    try {
      assert.equal(reopened.conversations[0].turns[0].research?.report?.markdown, undefined);
      assert.equal(reopened.conversations[0].turns[1].research?.report?.markdown, undefined);
    }
    finally { reopened.close(); }
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("a new user starts with default settings and nothing on disk", async () => {
  const web = memoryWebstore();
  const root = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  assert.equal(store.settings.theme, normalizeSettings(null).theme);
  // Every folder is confirmed for bypass as soon as the account loads: a
  // Code session set to full access must not wait for a web settings save.
  assert.deepEqual(store.settings.bypassFolders, ["*"]);
  assert.deepEqual(
    normalizeSettings({ codeSandbox: "read-only" }).bypassFolders,
    ["*"],
  );
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
  await store.confirmProjectDeletion("p", () => true);
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

const deletionProject = (id: string) => ({
  id,
  name: id,
  description: "",
  instructions: "",
  createdAt: 1,
  visibility: "private",
});

test("project cascade saves pending moves and deletes unloaded sessions within the owning account", async (t) => {
  const web = memoryWebstore(1);
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const seed = async (userId: number) => {
    const store = new CloudStore({ root, userId, transport: web });
    store.projects = [deletionProject("project"), deletionProject("other")];
    store.conversations = [
      conversation("chat", [turn("chat")], { projectId: "project" }),
      conversation("cowork", [turn("cowork")], { mode: "cowork", projectId: "project" }),
      conversation("code", [turn("code")], { mode: "code", projectId: "project" }),
      conversation("moved-out", [turn("out")], { projectId: "project" }),
      conversation("moved-in", [turn("in")], { projectId: "other" }),
      conversation("unloaded", [turn("unloaded")], { projectId: "project" }),
      conversation("unrelated", [turn("unrelated")], { projectId: "other" }),
    ];
    await store.close();
  };
  await seed(1);
  await seed(2);
  const store = await CloudStore.open({ root, userId: 1, transport: web, maxConversations: 5, log() {} });
  const project = store.projects[0]!;
  const code = store.conversation("code");
  store.conversation("moved-out").projectId = "other";
  store.conversation("moved-in").projectId = project.id;
  store.conversations.push(conversation("private", [], { incognito: true, projectId: project.id }));
  await assert.rejects(store.deleteProjectWithChats({ ...project }, () => true), /project changed/);
  web.log.length = 0;
  await store.deleteProjectWithChats(project, () => true);
  code.turns = [...code.turns, turn("continued")];
  await store.close();
  assert.equal(code.projectId, undefined);
  assert.deepEqual(store.conversations.map(row => row.id), ["code", "moved-out"]);
  assert.deepEqual(web.log.filter(row => row.op.endsWith(".delete")), [
    { op: "store.projects.delete", userId: 1, body: { id: "project", deleteChats: true } },
  ]);
  assert.ok(web.log.every(row => row.userId === 1));
  assert.ok(web.log.every(row => !JSON.stringify(row.body).includes('"id":"private"')));
  const reopened = await CloudStore.open({ root, userId: 1, transport: web });
  assert.deepEqual(reopened.projects.map(row => row.id), ["other"]);
  assert.deepEqual(reopened.conversations.map(row => [row.id, row.projectId, row.turns.map(turn => turn.id)]), [
    ["code", undefined, ["code", "continued"]],
    ["moved-out", "other", ["out"]],
    ["unrelated", "other", ["unrelated"]],
  ]);
  assert.deepEqual([...web.users.get(1)!.turns.keys()], ["code", "moved-out", "unrelated"]);
  assert.equal(web.users.get(2)!.projects.has("project"), true);
  assert.equal(web.users.get(2)!.turns.get("unloaded")?.size, 1);
  await reopened.close();
});

test("project cascade waits for acknowledgement and can retry a failed or unknown outcome", async (t) => {
  for (const failure of ["rejected", "lost", "malformed", "retired"] as const) {
    await t.test(failure, async (t) => {
      const web = memoryWebstore();
      const root = temp();
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      let current = true;
      let intercept = true;
      const store = new CloudStore({
        root, userId: 1, log() {},
        transport: {
          async request(op, userId, body) {
            if (op !== "store.projects.delete" || !intercept) return web.request(op, userId, body);
            intercept = false;
            entered();
            await gate;
            if (failure === "rejected") throw new Error("request rejected");
            const ack = await web.request(op, userId, body);
            if (failure === "lost") throw new Error("acknowledgement lost");
            if (failure === "malformed") return {};
            current = false;
            return ack;
          },
        },
      });
      const project = deletionProject("project");
      const linked = conversation("linked", [turn("linked")], { projectId: project.id });
      const unrelated = conversation("unrelated", []);
      store.projects = [project];
      store.conversations = [linked, unrelated];
      await store.sync();
      web.log.length = 0;
      const pending = store.deleteProjectWithChats(project, () => current);
      await started;
      assert.deepEqual(store.projects, [project]);
      assert.equal(store.conversation("linked"), linked);
      linked.title = "Old in-memory edit";
      unrelated.title = "Independent edit";
      store.flush();
      release();
      await assert.rejects(pending, failure === "retired" ? /account changed/ : /deletion could not be confirmed/);
      await store.settled();
      assert.deepEqual(store.projects, [project]);
      assert.equal(store.conversation("linked"), linked);
      const remote = web.users.get(1)!;
      assert.equal(remote.projects.has(project.id), failure === "rejected");
      assert.equal(remote.conversations.has(linked.id), failure === "rejected");
      assert.equal(remote.conversations.get(unrelated.id)?.doc.conversation.title, "Independent edit");
      assert.equal(web.log.some(row => row.body.doc?.conversation.id === linked.id), false);
      if (current) {
        await store.deleteProjectWithChats(project, () => current);
        assert.deepEqual(store.projects, []);
        assert.deepEqual(store.conversations.map(row => row.id), [unrelated.id]);
      }
      await store.close();
      const reopened = await CloudStore.open({ root, userId: 1, transport: web });
      assert.deepEqual(reopened.projects, []);
      assert.deepEqual(reopened.conversations.map(row => row.id), [unrelated.id]);
      await reopened.close();
    });
  }
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

test("project metadata is published only after acknowledgement and a rejected change is never replayed", async t => {
  const web = memoryWebstore();
  const root = temp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = { id: "project", name: "Saved name", description: "Saved description", instructions: "Keep", createdAt: 1, visibility: "private" };
  await web.request("store.projects.put", 1, { project, position: 0 });
  let releaseWrite: (() => void) | undefined;
  let onWrite: (() => void) | undefined;
  const writing = new Promise<void>(resolve => { onWrite = resolve; });
  const hold = new Promise<void>(resolve => { releaseWrite = resolve; });
  const store = await CloudStore.open({ root, userId: 1, transport: {
    async request(op, userId, body) {
      if (op === "store.projects.put" && onWrite) {
        onWrite();
        onWrite = undefined;
        await hold;
      }
      return web.request(op, userId, body);
    },
  } });
  const edit = { name: "New name", description: "New description" };
  const pending = store.persistProjectMetadata(project.id, edit, () => true);
  await writing;
  assert.deepEqual(store.projects[0], project);
  const pin = store.persistProjectMetadata(project.id, { pinned: true }, () => true);
  releaseWrite?.();
  await Promise.all([pending, pin]);
  const saved = { ...project, ...edit, pinned: true };
  assert.deepEqual(store.projects[0], saved);
  assert.deepEqual(web.users.get(1)?.projects.get(project.id)?.project, saved);
  web.failNext("store.projects.put");
  await assert.rejects(store.persistProjectMetadata(project.id, { name: "Rejected" }, () => true));
  assert.deepEqual(store.projects[0], saved);
  web.log.length = 0;
  await store.sync("full");
  assert.ok(!ops(web.log).includes("store.projects.put"));
  assert.deepEqual(web.users.get(1)?.projects.get(project.id)?.project, saved);
  await store.close();
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

test("an exact leaf save rejects an unacknowledged turn write and preserves every path once acknowledged", async (t) => {
  const web = memoryWebstore(1);
  const root = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  t.after(async () => {
    await store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const active = conversation("versions", [turn("edited")], {
    activeBranchId: "edit",
    savedBranches: [
      { id: "original", providerId: "sub2api", model: "old", visited: 1, turns: [turn("first"), turn("older-leaf")] },
      { id: "retry", providerId: "sub2api", model: "new", visited: 2, turns: [turn("first"), turn("newer-leaf")] },
    ],
  });
  store.conversations.push(active);
  await store.sync();

  const next = { ...active };
  assert.equal(selectChatLeaf(next, { conversationCreatedAt: 1, turnId: "older-leaf", turnCreatedAt: 1, branchId: "original" }), true);
  web.failNext("store.turns.put");
  await assert.rejects(store.persistChatLeaf(active, next, () => true), /save could not be confirmed/);
  await store.persistChatLeaf(active, active, () => true);

  const freshRoot = temp();
  const reopened = await CloudStore.open({ root: freshRoot, userId: 1, transport: web });
  try {
    const saved = reopened.conversation(active.id);
    assert.equal(saved.model, "old");
    assert.deepEqual(saved.turns.map(turn => turn.id), ["first", "older-leaf"]);
    assert.deepEqual(saved.savedBranches?.map(branch => [branch.id, branch.turns.map(turn => turn.id)]), [
      ["retry", ["first", "newer-leaf"]],
      ["edit", ["edited"]],
    ]);
  } finally {
    await reopened.close();
    fs.rmSync(freshRoot, { recursive: true, force: true });
  }
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

test("legacy reports recover on load only from their own intact file", async () => {
  const web = memoryWebstore();
  const root = temp(), otherRoot = temp();
  const first = await CloudStore.open({ root, userId: 1, transport: web });
  try {
    const reports = new ResearchReports(root);
    const good = reports.write("chat", "good", "# Legacy\n\nRésumé");
    const other = reports.write("chat", "other", "private");
    const badUtf8 = reports.write("chat", "utf8", "abc");
    fs.writeFileSync(path.join(root, badUtf8.path), Buffer.from([0xff, 0xfe, 0xfd]));
    const modern = reports.write("chat", "modern", "signed");
    const changed = reports.write("chat", "changed", "original");
    fs.writeFileSync(path.join(root, changed.path), "modified");
    const nul = reports.write("chat", "nul", "a\0b");
    const link = reports.write("chat", "link", "abc");
    fs.unlinkSync(path.join(root, link.path));
    fs.symlinkSync(path.join(root, other.path), path.join(root, link.path));
    const make = (id: string, metadata: object) => {
      const t = turn(id);
      t.research = { state: "done", startedAt: 1, sourceCount: 0, report: { title: id, ...metadata } as NonNullable<Turn["research"]>["report"] };
      return t;
    };
    const legacy = ({ sha256: _sha, ...metadata }: typeof good) => metadata;
    // First publish metadata alone, before the local report becomes available.
    fs.renameSync(path.join(root, good.path), path.join(root, "pending.md"));
    fs.renameSync(path.join(root, modern.path), path.join(root, "pending-modern.md"));
    first.conversations.push(conversation("chat", [
      make("good", legacy(good)), make("cross", legacy(other)),
      make("modern", modern), make("changed", changed), make("nul", legacy(nul)),
      make("utf8", legacy(badUtf8)), make("link", legacy(link)),
      make("size", { path: "research/chat/size.md", bytes: 4 }),
      make("missing", { path: "research/chat/missing.md" }),
      make("malformed", { ...legacy(good), path: "research/chat/malformed.md", sha256: "bad" }),
    ]));
    fs.writeFileSync(path.join(root, "research/chat/size.md"), "abc");
    fs.writeFileSync(path.join(root, "research/chat/missing.md"), "abc");
    fs.writeFileSync(path.join(root, "research/chat/malformed.md"), "abc");
    await first.sync();
    fs.renameSync(path.join(root, "pending.md"), path.join(root, good.path));
    fs.renameSync(path.join(root, "pending-modern.md"), path.join(root, modern.path));
    const loaded = await CloudStore.open({ root, userId: 1, transport: web });
    try {
      const saved = loaded.conversations[0].turns.map(t => t.research!.report!);
      assert.equal(saved[0].markdown, "# Legacy\n\nRésumé");
      assert.equal(saved[0].sha256, good.sha256);
      assert.equal(saved[2].markdown, "signed");
      assert.equal(saved[3].sha256, changed.sha256);
      for (const report of [saved[1], ...saved.slice(3)]) assert.equal(report.markdown, undefined);
      const remote = await CloudStore.open({ root: otherRoot, userId: 1, transport: web });
      try { assert.equal(remote.conversations[0].turns[0].research?.report?.markdown, "# Legacy\n\nRésumé"); }
      finally { await remote.close(); }
    } finally { await loaded.close(); }
  } finally { await first.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(otherRoot, { recursive: true, force: true }); }
});

test("the opening Cowork event is acknowledged and survives Runner reload", async () => {
  const web = memoryWebstore();
  const root = temp();
  const otherRoot = temp();
  const store = await CloudStore.open({ root, userId: 1, transport: web });
  try {
    const opening = turn("assigned-turn");
    const task = conversation("cowork-start", [opening], { mode: "cowork" });
    store.conversations.push(task);
    await store.sync();
    const openingEvent = "d4ff6720-719e-4444-a12b-012c55524ea6";
    opening.officialCodeEventId = openingEvent;
    await store.confirmOfficialCodeEvent(task, openingEvent, () => true);
    const reopened = await CloudStore.open({ root: otherRoot, userId: 1, transport: web });
    try {
      const reloaded = reopened.conversation(task.id);
      assert.equal(reloaded.turns[0].officialCodeEventId, openingEvent);
      assert.equal(reopened.hasConfirmedOfficialCodeEvent(reloaded, openingEvent), true);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});
