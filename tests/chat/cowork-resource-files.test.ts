import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AppContext } from "../../electron/app/app-context";
import { Store } from "../../electron/store/store";
import { registerCoworkHandlers } from "../../electron/ipc/cowork";
import type { Conversation } from "../../shared/types";
import { webMethodKind } from "../../shared/web-bridge-methods";

function setup(context: test.TestContext, remote = false) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cowork-resources-")),
  );
  context.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "work");
  fs.mkdirSync(root);
  const store = new Store(path.join(base, "profile"));
  store.flush = () => {};
  const conversation: Conversation = {
    id: "task",
    title: "Task",
    mode: "cowork",
    providerId: "p",
    model: "m",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
    turns: [],
  };
  store.conversations.push(conversation);
  const allowed: string[] = [];
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  registerCoworkHandlers((name, handler) => handlers.set(name, handler), {
    store,
    services: {},
    connectors: remote ? {} : undefined,
    allowedFolder(folder: string) {
      allowed.push(folder);
      if (folder !== root) throw new Error("Outside runner workspace");
    },
  } as unknown as AppContext);
  const invoke = (name: string, ...args: any[]) => handlers.get(name)!(...args);
  return { base, root, store, conversation, invoke, allowed };
}

test("folder instructions read, create, replace and clear CLAUDE.md on desktop and runner", async (context) => {
  for (const remote of [false, true]) {
    const { root, invoke, allowed, conversation, store } = setup(
      context,
      remote,
    );
    assert.equal(await invoke("readCoworkInstructions", "task"), "");
    for (const content of ["# Instructions\n中文\nKeep tables.", "Short", ""]) {
      await invoke("writeCoworkInstructions", "task", content);
      assert.equal(await invoke("readCoworkInstructions", "task"), content);
      assert.equal(
        fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"),
        content,
      );
    }
    if (remote) assert(allowed.every((folder) => folder === root));
    await assert.rejects(invoke("writeCoworkInstructions", "task", 123));
    await assert.rejects(invoke("readCoworkInstructions", "missing"));
    conversation.mode = "chat";
    store.settings.computerAccess = true;
    await invoke(
      "writeCoworkInstructions",
      "task",
      "Supported Chat instructions",
    );
    assert.equal(
      await invoke("readCoworkInstructions", "task"),
      "Supported Chat instructions",
    );
    store.settings.computerAccess = false;
    await assert.rejects(
      invoke("readCoworkInstructions", "task"),
      /unavailable for this session/,
    );
    await assert.rejects(
      invoke("writeCoworkInstructions", "task", "Blocked Chat change"),
      /unavailable for this session/,
    );
    assert.equal(
      fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"),
      "Supported Chat instructions",
    );
    conversation.mode = "cowork";
    assert.equal(
      await invoke("readCoworkInstructions", "task"),
      "Supported Chat instructions",
      "Computer access stops Chat execution eligibility; retained Cowork context can still be inspected",
    );
    store.settings.computerAccess = true;
    conversation.mode = "chat";
    conversation.linkedToComputer = true;
    await assert.rejects(
      invoke("readCoworkInstructions", "task"),
      /unavailable for this session/,
    );
    delete conversation.linkedToComputer;
    conversation.mode = "cowork";
    conversation.environment = { kind: "ssh", hostId: "remote" };
    await assert.rejects(invoke("writeCoworkInstructions", "task", "no"));
  }
  assert.equal(webMethodKind("readCoworkInstructions"), "remote-runner");
  assert.equal(webMethodKind("writeCoworkInstructions"), "remote-runner");
});

test("folder instructions never follow a symlink or truncate its target", async (context) => {
  const { base, root, invoke } = setup(context);
  const outside = path.join(base, "private.md");
  fs.writeFileSync(outside, "private");
  fs.symlinkSync(outside, path.join(root, "CLAUDE.md"));
  await assert.rejects(invoke("readCoworkInstructions", "task"));
  await assert.rejects(invoke("writeCoworkInstructions", "task", "overwrite"));
  assert.equal(fs.readFileSync(outside, "utf8"), "private");
});

test("folder browsing filters desktop system files and refuses traversal, absolute paths and escaping symlinks", async (context) => {
  const { root, base, invoke, conversation } = setup(context);
  fs.mkdirSync(path.join(root, "nested"));
  for (const name of [
    "notes.txt",
    ".hidden",
    "~$draft.docx",
    "~cache.tmp",
    "Thumbs.db",
    "desktop.ini",
    "icon\r",
  ])
    fs.writeFileSync(path.join(root, name), "content");
  fs.writeFileSync(path.join(base, "private.txt"), "private");
  fs.symlinkSync(path.join(base, "private.txt"), path.join(root, "link.txt"));
  const result = await invoke("listCoworkFolder", "task", 0, "");
  assert.deepEqual(
    result.entries.map((entry: { name: string }) => entry.name),
    ["nested", "link.txt", "notes.txt"],
  );
  assert.equal(result.truncated, false);
  for (const relative of [
    "../private.txt",
    path.join(base, "private.txt"),
    "link.txt",
  ])
    await assert.rejects(
      invoke("readCoworkFile", "task", 0, relative),
      /outside/,
    );
  await assert.rejects(invoke("listCoworkFolder", "task", 1, ""), /isn't part/);
  await assert.rejects(
    invoke("listCoworkFolder", "missing", 0, ""),
    /not found/,
  );
  conversation.mode = "code";
  await assert.rejects(invoke("listCoworkFolder", "task", 0, ""), /not found/);
});

test("folder previews capture files using the existing generated-file preview pipeline", async (context) => {
  const { root, invoke } = setup(context);
  fs.writeFileSync(path.join(root, "notes.txt"), "Hello resource");
  const file = await invoke("readCoworkFile", "task", 0, "notes.txt");
  assert.equal(file.path, "notes.txt");
  assert.equal(file.snapshot.state, "ready");
  assert.equal(file.snapshot.content, "Hello resource");
  assert.equal(file.bytes, 14);
  await assert.rejects(invoke("readCoworkFile", "task", 0, "nested/missing"));
});

test("scratchpad and output access is restricted to successful recorded reads and current nondeleted outputs", async (context) => {
  const { base, root, conversation, invoke } = setup(context);
  const scratch = path.join(base, "scratch.txt");
  const secret = path.join(base, "secret.txt");
  fs.writeFileSync(scratch, "scratch");
  fs.writeFileSync(secret, "secret");
  conversation.turns = [
    {
      id: "turn",
      prompt: "Task",
      attachments: [],
      status: "completed",
      createdAt: 0,
      items: [
        {
          id: "read",
          type: "commandExecution",
          cwd: root,
          status: "completed",
          commandActions: [{ type: "read", path: "../scratch.txt" }],
        },
        {
          id: "failed",
          type: "commandExecution",
          status: "failed",
          commandActions: [{ type: "read", path: secret }],
        },
      ],
    },
  ];
  assert.equal(
    (await invoke("readCoworkResource", "task", scratch)).snapshot.content,
    "scratch",
  );
  await assert.rejects(
    invoke("readCoworkResource", "task", secret),
    /isn't part/,
  );
  const read = conversation.turns[0].items[0];
  read.generatedFiles = [
    {
      id: "deleted",
      path: scratch,
      name: "scratch.txt",
      language: "text",
      operation: "delete",
      state: "deleted",
      content: "",
    },
  ];
  await assert.rejects(
    invoke("readCoworkResource", "task", scratch),
    /isn't part/,
  );
  read.generatedFiles = [
    {
      id: "moved",
      path: secret,
      previousPath: scratch,
      name: "secret.txt",
      language: "text",
      operation: "update",
      state: "ready",
      content: "secret",
    },
  ];
  await assert.rejects(
    invoke("readCoworkResource", "task", scratch),
    /isn't part/,
  );
  assert.equal(
    (await invoke("readCoworkResource", "task", secret)).snapshot.content,
    "secret",
  );
});

test("runner file access checks the user's workspace boundary; SSH folders cannot be read locally", async (context) => {
  const { base, root, conversation, invoke, allowed } = setup(context, true);
  fs.writeFileSync(path.join(root, "notes.txt"), "notes");
  await invoke("readCoworkFile", "task", 0, "notes.txt");
  assert.deepEqual(allowed, [root]);
  conversation.cwd = base;
  await assert.rejects(
    invoke("listCoworkFolder", "task", 0, ""),
    /Outside runner/,
  );
  conversation.environment = { kind: "ssh", targetId: "host" } as never;
  await assert.rejects(invoke("listCoworkFolder", "task", 0, ""), /SSH host/);
  for (const method of [
    "coworkFolders",
    "listCoworkFolder",
    "readCoworkFile",
    "readCoworkResource",
    "connectConnector",
    "completeConnectorLogin",
  ])
    assert.equal(webMethodKind(method), "remote-runner");
  for (const method of [
    "revealCoworkFolder",
    "revealCoworkFile",
    "revealCoworkResource",
  ])
    assert.equal(webMethodKind(method), "absent");
});
