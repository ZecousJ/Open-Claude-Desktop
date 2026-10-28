/**
 * The Cowork folder check in the main process (R11-A): sends, edits,
 * retries and routine runs refuse a folder the person never allowed, and
 * only picked folders can be allowed through the bridge.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import type { Conversation } from "../../shared/types";
import { Store } from "../../electron/store/store";
import { Scheduler } from "../../electron/routines/scheduler";
import { registerConversationHandlers } from "../../electron/ipc/conversations";
import { registerCoworkHandlers } from "../../electron/ipc/cowork";
import {
  coworkFolderGrants,
  coworkFolderPermissionMessage,
  routineFolderPermissionMessage,
} from "../../electron/workspace/cowork-folders";

type Handlers = Map<string, (...args: any[]) => any>;

function setup(t: any) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cowork-gate-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const folder = (name: string) => {
    const value = path.join(base, name);
    fs.mkdirSync(value, { recursive: true });
    return value;
  };
  const root = folder("profile");
  const store = new Store(root);
  store.flush = () => {};
  const picked = new Set<string>();
  const allowedFolder = (value?: string) => {
    if (
      value &&
      !picked.has(value) &&
      !store.conversations.some((c) => c.cwd === value)
    )
      throw new Error("Choose the working folder with the folder picker.");
  };
  const sent: any[] = [];
  const engine = {
    async send(input: any) {
      sent.push(input);
      const existing = input.conversationId
        ? store.conversation(input.conversationId)
        : undefined;
      if (existing) return structuredClone(existing);
      const c: Conversation = {
        id: `c-${sent.length}`,
        title: input.text,
        mode: input.mode,
        providerId: input.providerId,
        model: input.model,
        cwd: input.cwd ?? path.join(root, "workspace"),
        pinned: false,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
        turns: [],
        ...(input.incognito ? { incognito: true } : {}),
      };
      store.conversations.unshift(c);
      return structuredClone(c);
    },
    async editPrompt(id: string) {
      sent.push({ edit: id });
      return store.conversation(id);
    },
    async retryResponse(id: string) {
      sent.push({ retry: id });
      return store.conversation(id);
    },
  };
  const conversations: Handlers = new Map();
  registerConversationHandlers((name, fn) => conversations.set(name, fn), {
    store,
    engine: engine as never,
    replyFeedback: { deleteConversation() {} } as never,
    selectedAttachments: new Map(),
    allowedFolder,
    noActive() {},
  });
  const pushed: any[] = [];
  let scheduler: Scheduler | undefined;
  const cowork: Handlers = new Map();
  registerCoworkHandlers((name, fn) => cowork.set(name, fn), {
    store,
    allowedFolder,
    push: (event: unknown) => pushed.push(event),
    get scheduler() {
      return scheduler;
    },
    services: {},
  } as unknown as AppContext);
  const send = (input: Record<string, unknown>) =>
    conversations.get("send")!({
      text: "Sort these files",
      mode: "cowork",
      attachments: [],
      providerId: "p",
      model: "m",
      ...input,
    });
  return {
    root,
    store,
    folder,
    picked,
    sent,
    pushed,
    send,
    conversations,
    cowork,
    setScheduler: (value: Scheduler) => (scheduler = value),
  };
}

test("a new Cowork task in a folder nobody allowed is refused before the engine runs", async (t) => {
  const { folder, picked, sent, send } = setup(t);
  const notes = folder("notes");
  picked.add(notes);
  await assert.rejects(
    send({ cwd: notes }),
    new RegExp(coworkFolderPermissionMessage),
  );
  assert.equal(sent.length, 0);
  // Chat and Code are not Cowork's business.
  await send({ mode: "code", cwd: notes });
  await send({ mode: "chat" });
  // The app's own workspace never asks.
  await send({});
  assert.equal(sent.length, 3);
});

test("Allow lets the next task start there, and that task keep the folder", async (t) => {
  const { folder, picked, sent, send, cowork, conversations, pushed, store } =
    setup(t);
  const notes = folder("notes");
  picked.add(notes);
  const before = await cowork.get("coworkFolderAccess")!(notes);
  assert.equal(before.state, "ask");
  const granted = await cowork.get("grantCoworkFolder")!(notes, "session");
  assert.equal(granted.state, "granted");
  assert.deepEqual(pushed.at(-1), { type: "cowork-folders" });
  const task = await send({ cwd: notes });
  assert.equal(sent[0].cwd, notes);
  // Follow-ups, edits and retries keep working; a second new task asks again.
  await send({ conversationId: task.id });
  await conversations.get("editPrompt")!(task.id, "t", "Again", "p", "m");
  await conversations.get("retryResponse")!(task.id, "t", "p", "m");
  assert.equal(sent.length, 4);
  await assert.rejects(send({ cwd: notes }), /Allow Cowork/);
  assert.deepEqual(await cowork.get("coworkFolders")!(task.id), {
    primary: notes,
    extra: [],
    browser: { kind: "native" },
  });
  // Deleting the task deletes its grant.
  await conversations.get("deleteConversation")!(task.id);
  assert.equal(
    coworkFolderGrants(store.root).access(notes, task.id).state,
    "ask",
  );
});

test("edits and retries in a task whose folder was never allowed are refused", async (t) => {
  const { folder, store, sent, conversations, send } = setup(t);
  const moved = folder("moved");
  store.conversations.push({
    id: "old",
    title: "Moved",
    mode: "cowork",
    providerId: "p",
    model: "m",
    cwd: moved,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
  });
  await assert.rejects(
    async () => conversations.get("editPrompt")!("old", "t", "Again", "p", "m"),
    /Allow Cowork/,
  );
  await assert.rejects(
    async () => conversations.get("retryResponse")!("old", "t", "p", "m"),
    /Allow Cowork/,
  );
  await assert.rejects(send({ conversationId: "old" }), /Allow Cowork/);
  assert.equal(sent.length, 0);
});

test("only a folder chosen with the picker can be allowed", async (t) => {
  const { folder, cowork, root } = setup(t);
  const typed = folder("typed-in");
  await assert.rejects(
    cowork.get("grantCoworkFolder")!(typed, "always"),
    /folder picker/,
  );
  await assert.rejects(
    cowork.get("coworkFolderAccess")!(typed),
    /folder picker/,
  );
  await assert.rejects(
    cowork.get("grantCoworkFolder")!("relative/path", "session"),
  );
  await assert.rejects(cowork.get("grantCoworkFolder")!(typed, "forever"));
  assert.deepEqual(coworkFolderGrants(root).trusted(), []);
});

test("Always allow trusts the folder for every task; removing it asks again", async (t) => {
  const { folder, picked, cowork, send } = setup(t);
  const projects = folder("projects");
  const site = folder("projects/site");
  picked.add(projects);
  picked.add(site);
  const trusted = await cowork.get("grantCoworkFolder")!(projects, "always");
  assert.equal(trusted.state, "trusted");
  assert.deepEqual(await cowork.get("trustedCoworkFolders")!(), [projects]);
  await send({ cwd: site });
  await send({ cwd: projects });
  assert.deepEqual(
    await cowork.get("removeTrustedCoworkFolder")!(projects),
    [],
  );
  await assert.rejects(send({ cwd: site }), /Allow Cowork/);
});

test("a folder added to a running task is kept as its extra folder", async (t) => {
  const { folder, picked, cowork, send, pushed } = setup(t);
  const notes = folder("notes");
  const extra = folder("extra");
  picked.add(notes);
  picked.add(extra);
  await cowork.get("grantCoworkFolder")!(notes, "session");
  const task = await send({ cwd: notes });
  const added = await cowork.get("grantCoworkFolder")!(extra, "session", {
    conversationId: task.id,
  });
  assert.equal(added.state, "granted");
  assert.deepEqual(await cowork.get("coworkFolders")!(task.id), {
    primary: notes,
    extra: [extra],
    browser: { kind: "native" },
  });
  assert.equal(
    pushed.some(
      (event) =>
        event.type === "cowork-folders" && event.conversationId === task.id,
    ),
    true,
  );
  // Only the task's own folders can be shown in the file manager.
  await assert.rejects(
    cowork.get("revealCoworkFolder")!(task.id, folder("elsewhere")),
    /isn't part of this task/,
  );
  await assert.rejects(
    cowork.get("grantCoworkFolder")!(extra, "session", {
      conversationId: "missing",
    }),
    /not found/,
  );
});

test("an unattended Cowork routine runs only in a trusted folder or the one allowed for it", async (t) => {
  const { folder, picked, cowork, root, setScheduler } = setup(t);
  const reports = folder("reports");
  picked.add(reports);
  const runs: string[] = [];
  const scheduler = new Scheduler(root, {
    isBusy: () => false,
    run: async (task) => {
      runs.push(task.id);
      return {
        id: `run-${runs.length}`,
        title: task.name,
        mode: task.mode,
        providerId: task.providerId,
        model: task.model,
        cwd: task.cwd,
        pinned: false,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
        turns: [],
      };
    },
  });
  setScheduler(scheduler);
  const base = {
    name: "Weekly report",
    prompt: "Summarize the reports.",
    providerId: "p",
    model: "m",
    frequency: "weekly" as const,
    nextRunAt: Date.now() + 60_000,
    enabled: true,
  };
  const cowork1 = scheduler.save({ ...base, mode: "cowork", cwd: reports });
  const code = scheduler.save({
    ...base,
    name: "Weekly report (code)",
    mode: "code",
    cwd: reports,
  });
  await assert.rejects(
    scheduler.runNow(cowork1.id),
    new RegExp(routineFolderPermissionMessage.slice(0, 40)),
  );
  assert.equal(scheduler.runs(cowork1.id)[0].status, "failed");
  assert.deepEqual(runs, []);
  await scheduler.runNow(code.id);
  assert.deepEqual(runs, [code.id]);
  // Allowed from the routine's editor: its runs may use the folder.
  await assert.rejects(
    cowork.get("grantCoworkFolder")!(reports, "session", {
      routineId: code.id,
    }),
    /no longer exists/,
  );
  await cowork.get("grantCoworkFolder")!(reports, "session", {
    routineId: cowork1.id,
  });
  await scheduler.runNow(cowork1.id);
  assert.deepEqual(runs, [code.id, cowork1.id]);
  // The person can write in the run's conversation afterwards.
  assert.equal(
    coworkFolderGrants(root).access(reports, "run-2").state,
    "granted",
  );
  // A deleted routine's grant goes with it.
  scheduler.delete(cowork1.id);
  assert.equal(
    coworkFolderGrants(root).routineAllowed(cowork1.id, reports),
    false,
  );
});
