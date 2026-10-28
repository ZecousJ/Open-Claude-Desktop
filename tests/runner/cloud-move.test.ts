import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationImport } from "../../shared/cloud-sync-api";
import type { AppEvent, Conversation, Project } from "../../shared/types";
import { moveToCloud, movedFile } from "../../electron/cloud/migrate";
import { registerCloudSyncHandlers } from "../../electron/ipc/cloud-sync";
import type { AppContext } from "../../electron/app/app-context";

const threadA = "01a0fe0a-daa6-7683-b5d8-d0321cae99ee";
const threadB = "01a0fe0a-daa6-7683-b5d8-d0321cae99ef";
const rolloutA = `rollout-2026-10-03T03-15-19-${threadA}.jsonl`;
const rolloutB = `rollout-2026-09-01T10-00-00-${threadB}.jsonl`;

const conversation = (
  id: string,
  part: Partial<Conversation> = {},
): Conversation =>
  ({
    id,
    title: id,
    mode: "chat",
    providerId: "sub2api",
    model: "m",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [{ id: `${id}-t`, prompt: "hi", status: "completed", items: [] }],
    ...part,
  }) as unknown as Conversation;

function profile() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-move-"));
  const day = path.join(root, "codex-home", "sessions", "2026", "10", "03");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, rolloutA), '{"type":"session_meta"}\n');
  return root;
}

test("Chat and Cowork conversations move oldest first, with their project and history", async () => {
  const root = profile();
  const project = {
    id: "p1",
    name: "Notes",
    description: "",
    instructions: "Be brief",
    cwd: "/Users/me/notes",
    createdAt: 5,
  } as Project;
  const store = {
    root,
    projects: [project],
    conversations: [
      conversation("new", {
        updatedAt: 30,
        threadId: threadA,
        projectId: "p1",
      }),
      conversation("old", {
        updatedAt: 10,
        mode: "cowork",
        cwd: "/Users/me/Desktop",
      }),
      conversation("code", { mode: "code" }),
      conversation("secret", { incognito: true }),
      conversation("busy", {
        turns: [{ id: "t", status: "inProgress", items: [] } as never],
      }),
      conversation("already", {}),
    ],
  };
  const sent: ConversationImport[] = [];
  const result = await moveToCloud({
    store,
    inCloud: (id) => id === "already",
    call: async (_method, [input]) => {
      sent.push(input);
      const parsed = JSON.parse(new TextDecoder().decode(input.conversation));
      return { id: parsed.id, state: "imported" };
    },
  });
  assert.deepEqual(result, { moved: 2, failed: 0 });
  const ids = sent.map(
    (input) => JSON.parse(new TextDecoder().decode(input.conversation)).id,
  );
  assert.deepEqual(ids, ["old", "new"]);
  assert.deepEqual(
    sent[1].rollouts.map((r) => r.name),
    [rolloutA],
  );
  assert.deepEqual(sent[1].project, {
    id: "p1",
    name: "Notes",
    description: "",
    instructions: "Be brief",
    createdAt: 5,
  });
  assert.equal(sent[0].rollouts.length, 0);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, movedFile), "utf8")).sort(),
    ["new", "old"],
  );
  // Moved once: a conversation deleted on the web does not come back.
  let calls = 0;
  const again = await moveToCloud({
    store,
    inCloud: (id) => id === "already",
    call: async () => {
      calls++;
      return {};
    },
  });
  assert.deepEqual(again, { moved: 0, failed: 0 });
  assert.equal(calls, 0);
});

test("a conversation that fails to move is tried again next time", async () => {
  const root = profile();
  const store = { root, projects: [], conversations: [conversation("c1")] };
  const first = await moveToCloud({
    store,
    inCloud: () => false,
    call: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(first, { moved: 0, failed: 1 });
  const second = await moveToCloud({
    store,
    inCloud: () => false,
    call: async () => ({ id: "c1", state: "imported" }),
  });
  assert.deepEqual(second, { moved: 1, failed: 0 });
});

function runner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-import-"));
  const pushed: AppEvent[] = [];
  const store = {
    root,
    conversations: [] as Conversation[],
    projects: [] as Project[],
    flushed: 0,
    flush() {
      this.flushed++;
    },
  };
  const handlers = new Map<string, (...args: any[]) => any>();
  const ctx = {
    store,
    push: (event: AppEvent) => pushed.push(event),
    spaceFolder: (spaceId: string) => {
      const space = path.join(root, "spaces", spaceId);
      fs.mkdirSync(path.join(space, "workspace"), { recursive: true });
      return space;
    },
  } as unknown as AppContext;
  registerCloudSyncHandlers((name, fn) => handlers.set(name, fn), ctx);
  return {
    root,
    store,
    pushed,
    importConversation: handlers.get("importConversation")!,
  };
}

const encode = (c: unknown) => new TextEncoder().encode(JSON.stringify(c));

test("a Cowork claim records the linking device in both the cloud and the handoff", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-device-claim-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = conversation("linked-task", {
    mode: "cowork",
    turns: [],
    environment: { kind: "space", spaceId: "task-space" },
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  const events: AppEvent[] = [];
  let flushed = 0;
  registerCloudSyncHandlers((name, fn) => handlers.set(name, fn), {
    store: { root, conversation: () => task, flush: () => flushed++ },
    spaceFolder: () => root,
    push: (event: AppEvent) => events.push(event),
  } as unknown as AppContext);
  const owner = { id: "pc-computer1", name: "My Mac" };
  const payload = handlers.get("exportCoworkTask")!(task.id, owner);
  assert.equal(task.linkedComputerId, owner.id);
  assert.equal(task.linkedComputerName, owner.name);
  assert.equal(task.linkedToComputer, true);
  const exported = JSON.parse(Buffer.from(payload.conversation).toString());
  assert.equal(exported.linkedComputerId, owner.id);
  assert.equal(exported.linkedComputerName, owner.name);
  assert.equal(flushed, 1);
  assert.equal(events[0].type, "conversation");
  handlers.get("releaseCoworkTask")!(task.id);
  assert.equal(task.linkedComputerId, undefined);
  assert.equal(task.linkedComputerName, undefined);
});

test("the runner keeps a moved conversation in its own space, with its history", async () => {
  const r = runner();
  const source = conversation("c1", {
    threadId: threadA,
    cwd: "/Users/me",
    projectId: "p1",
    savedBranches: [{ id: "b", threadId: threadB, turns: [] } as never],
  });
  const answer = await r.importConversation({
    conversation: encode(source),
    project: {
      id: "p1",
      name: "Notes",
      description: "",
      instructions: "",
      createdAt: 1,
    },
    rollouts: [{ name: rolloutA, data: new TextEncoder().encode("{}\n") }],
  });
  assert.deepEqual(answer, { id: "c1", state: "imported" });
  const space = path.join(r.root, "spaces", "c-c1");
  assert.ok(
    fs.existsSync(
      path.join(space, "codex-home", "sessions", "2026", "10", "03", rolloutA),
    ),
  );
  const kept = r.store.conversations[0];
  assert.equal(kept.threadId, threadA);
  assert.equal(kept.cwd, path.join(space, "workspace"));
  assert.deepEqual(kept.environment, { kind: "space", spaceId: "c-c1" });
  assert.equal(kept.projectId, "p1");
  assert.deepEqual(
    r.store.projects.map((p) => p.id),
    ["p1"],
  );
  assert.equal(r.pushed[0].type, "conversation");
  assert.equal(r.store.flushed, 1);

  // Again: nothing changes.
  const again = await r.importConversation({
    conversation: encode(source),
    rollouts: [],
  });
  assert.deepEqual(again, { id: "c1", state: "exists" });
  assert.equal(r.store.conversations.length, 1);
});

test("without its history a moved conversation starts a new thread", async () => {
  const r = runner();
  await r.importConversation({
    conversation: encode(
      conversation("c2", { threadId: threadA, projectId: "gone" }),
    ),
    rollouts: [],
  });
  const kept = r.store.conversations[0];
  assert.equal(kept.threadId, undefined);
  assert.equal(
    kept.projectId,
    undefined,
    "a project that did not come along is dropped",
  );
});

test("the runner refuses what it should not keep", async () => {
  const r = runner();
  await assert.rejects(
    r.importConversation({
      conversation: encode(conversation("c3", { mode: "code" })),
      rollouts: [],
    }),
  );
  await assert.rejects(
    r.importConversation({
      conversation: encode(conversation("c4")),
      rollouts: [{ name: "../../etc/passwd", data: new Uint8Array() }],
    }),
  );
  await assert.rejects(
    r.importConversation({
      conversation: new TextEncoder().encode("not json"),
      rollouts: [],
    }),
  );
  assert.equal(r.store.conversations.length, 0);

  const desktop = new Map<string, (...args: any[]) => any>();
  registerCloudSyncHandlers((name, fn) => desktop.set(name, fn), {
    store: r.store,
  } as unknown as AppContext);
  await assert.rejects(
    desktop.get("importConversation")!({
      conversation: encode(conversation("c5")),
      rollouts: [],
    }),
    /from the desktop app/,
  );
});
