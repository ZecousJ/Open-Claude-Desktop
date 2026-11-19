import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcHandle } from "../electron/app/app-context";
import { assertCodeSessionSendAvailable } from "../electron/conversations/code-lifecycle-guard";
import { Engine } from "../electron/engine/engine";
import { registerOfficialSessionFolder } from "../electron/ipc/official-session-folder";
import { Store } from "../electron/store/store";
import type { AppEvent, Conversation } from "../shared/types";

function setup(t: TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "cwd-integrity-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  const other = path.join(root, "other");
  for (const folder of [a, b, other]) fs.mkdirSync(folder);
  const c: Conversation = {
    id: "c",
    cwd: a,
    mode: "code",
    threadId: "original",
    title: "Fixture",
    pinned: false,
    archived: false,
    providerId: "mock",
    model: "mock",
    turns: [],
    createdAt: 123,
    updatedAt: 123,
  };
  const store = new Store(path.join(root, "profile"));
  store.conversations.push(c);
  store.flush();
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  const handlers = new Map<string, Parameters<IpcHandle>[1]>();
  const events: AppEvent[] = [];
  const selected = new Set<string>();
  let activate = () => {};
  let close = async () => {};
  let allowed = true;
  registerOfficialSessionFolder((name, fn) => handlers.set(name, fn), {
    store,
    engine,
    selectedFolders: selected,
    allowedFolder() {
      if (!allowed) throw Error("not selected");
    },
    services: {},
    onAccountDeactivating: (fn: () => void | Promise<void>) => {
      activate = () => {
        void fn();
      };
      return () => {};
    },
    terminals: { closeConversation: () => close() },
    push: (event: AppEvent) => events.push(event),
  });
  return {
    c,
    a,
    b,
    other,
    events,
    selected,
    store,
    engine,
    change: handlers.get("officialChangeSessionFolder")!,
    activate: () => activate(),
    close: (fn: () => Promise<void>) => {
      close = fn;
    },
    forbidPickerGrant: () => {
      allowed = false;
    },
  };
}

test("only authorized idle local Code sessions can change their working folder", async (t) => {
  const { c, a, b, change, store, events, forbidPickerGrant } = setup(t);
  const result = await change(c.id, b);
  assert.deepEqual(result, {
    status: "ok",
    cwd: b,
    changed: true,
    transcriptRelocated: true,
  });
  assert.equal(c.cwd, b);
  assert.equal(c.threadId, "original");
  assert.equal(events.length, 1);
  assert.equal(new Store(store.root).conversation(c.id).cwd, b);
  assert.deepEqual(await change(c.id, b), { ...result, changed: false });
  assert.equal(events.length, 1);

  c.turns = [
    {
      id: "running",
      prompt: "",
      attachments: [],
      items: [],
      createdAt: 0,
      status: "inProgress",
    },
  ];
  await assert.rejects(change(c.id, a), /finish/);
  c.turns = [];
  forbidPickerGrant();
  await assert.rejects(change(c.id, a), /not selected/);
  c.cloudHosted = true;
  await assert.rejects(change(c.id, a), /local Code/);
  assert.equal(c.cwd, b);
});

test("folder change rejects stale selection, replaced target, and retired account", async (t) => {
  for (const scenario of ["target", "account", "session", "lease"] as const) {
    const h = setup(t);
    let nativeCurrent = true;
    h.close(async () => {
      if (scenario === "target") {
        fs.renameSync(h.b, h.b + "-removed");
        fs.renameSync(h.other, h.b);
      }
      if (scenario === "account") h.activate();
      if (scenario === "session") h.c.archived = true;
      if (scenario === "lease") nativeCurrent = false;
    });
    const current = () => nativeCurrent;
    await assert.rejects(
      h.change(h.c.id, h.b, { expected: { cwd: h.a, createdAt: 0 }, current }),
      /changed/,
    );
    await assert.rejects(
      h.change(h.c.id, h.b, {
        expected: { cwd: h.a, createdAt: 123 },
        current,
      }),
      /changed/,
    );
    assert.equal(h.c.cwd, h.a);
    assert.equal(h.c.updatedAt, 123);
    assert.equal(new Store(h.store.root).conversation(h.c.id).cwd, h.a);
    assert.deepEqual(h.events, []);
    assert.equal(h.selected.size, 0);
  }
});

test("pending requests and overlapping sends cannot move or use a changing workspace", async (t) => {
  const h = setup(t);
  h.engine.approvals = [
    {
      id: 1,
      conversationId: h.c.id,
      method: "item/tool/requestUserInput",
      params: {},
    },
  ];
  await assert.rejects(h.change(h.c.id, h.b), /request to finish/);
  h.engine.approvals = [];
  h.c.codeNewTask = {
    id: "choice",
    text: "waiting",
    attachments: [],
    providerId: "mock",
    model: "mock",
  };
  await assert.rejects(h.change(h.c.id, h.b), /request to finish/);
  delete h.c.codeNewTask;
  let finishClosing!: () => void;
  const closing = new Promise<void>((resolve) => {
    finishClosing = resolve;
  });
  h.close(() => closing);
  const changing = h.change(h.c.id, h.b);
  await assert.rejects(h.change(h.c.id, h.other), /already in progress/);
  assert.throws(
    () => assertCodeSessionSendAvailable(h.c),
    /finish before sending/,
  );
  finishClosing();
  await changing;
  assert.doesNotThrow(() => assertCodeSessionSendAvailable(h.c));
});

test("failed persistence leaves the saved working directory and timestamp intact", async (t) => {
  const h = setup(t);
  h.store.write = () => {
    throw Error("disk full");
  };
  await assert.rejects(h.change(h.c.id, h.b), /disk full/);
  assert.equal(h.c.cwd, h.a);
  assert.equal(h.c.updatedAt, 123);
  assert.equal(new Store(h.store.root).conversation(h.c.id).cwd, h.a);
  assert.equal(h.events.length, 0);
  assert.equal(h.selected.size, 0);
});

test("a scratch folder move leaves files behind when a destination directory is a link", async (t) => {
  const h = setup(t);
  const scratch = path.join(
    h.engine.defaultWorkspace,
    "sessions",
    "4099bc32-6b03-4cad-9e8c-ad7bb5c99e05",
  );
  h.c.cwd = scratch;
  fs.mkdirSync(path.join(scratch, "subfolder"), { recursive: true });
  fs.writeFileSync(path.join(scratch, "subfolder", "marker"), "source bytes");
  fs.symlinkSync(
    h.other,
    path.join(h.b, "subfolder"),
    process.platform === "win32" ? "junction" : "dir",
  );

  assert.deepEqual((await h.change(h.c.id, h.b)).filesCarried, {
    outcome: "copied",
    copied: 0,
    alreadyThere: 0,
    notCopied: 1,
  });
  assert.deepEqual(fs.readdirSync(h.other), []);
  assert.equal(
    fs.readFileSync(path.join(scratch, "subfolder", "marker"), "utf8"),
    "source bytes",
  );
});

test("copying a scratch folder over the entry limit makes no writes to the destination", async (t) => {
  const h = setup(t);
  const scratch = path.join(
    h.engine.defaultWorkspace,
    "sessions",
    "4099bc32-6b03-4cad-9e8c-ad7bb5c99e05",
  );
  h.c.cwd = scratch;
  fs.mkdirSync(scratch, { recursive: true });
  for (let index = 0; index <= 5000; index++)
    fs.writeFileSync(path.join(scratch, `file-${index}`), "source bytes");

  assert.deepEqual((await h.change(h.c.id, h.b)).filesCarried, {
    outcome: "too_many",
    copied: 0,
    alreadyThere: 0,
    notCopied: 0,
  });
  assert.deepEqual(fs.readdirSync(h.b), []);
  assert.equal(h.c.cwd, h.b);
});
