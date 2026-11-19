import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerOfficialAttachmentHandlers } from "../electron/ipc/official-attachments";
import {
  storeCodeAttachments,
  storedAttachmentImage,
} from "../electron/official-ui/native/code-attachments";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { openPolicy } from "../shared/client-policy";
import { AttachmentSelectionGrants } from "../electron/official-ui/native/attachment-selection-grants";
import type { CodeTranscriptRow } from "../electron/official-ui/native/code-transcript";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jw1sAAAAASUVORK5CYII=";
function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-code-attachments-"),
  );
  const selectedAttachments = new Map(),
    ipc = new Map<string, any>();
  registerOfficialAttachmentHandlers((n, f) => ipc.set(n, f), {
    store: { root },
    selectedAttachments,
    policy: () => openPolicy,
  } as never);
  return {
    root,
    selectedAttachments,
    ipc,
    call: async (n: string, ...a: unknown[]) => ipc.get(n)(...a),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
test("official image and file wire payloads store original bytes and reject malformed inputs before writing", async () => {
  const f = fixture();
  try {
    const a = await storeCodeAttachments(
      f.call,
      [{ base64: png, mimeType: "image/png" }],
      [
        {
          name: "notes.txt",
          base64: Buffer.from("附件正文").toString("base64"),
        },
      ],
    );
    assert.equal(a.length, 2);
    assert.equal(fs.readFileSync(a[0].path).toString("base64"), png);
    assert.equal(fs.readFileSync(a[1].path, "utf8"), "附件正文");
    assert.equal(storedAttachmentImage(f.root, a[0])?.base64, png);
    const count = fs.readdirSync(path.join(f.root, "attachments")).length;
    for (const files of [
      [{ name: "bad.txt", base64: "!!" }],
      [{ name: "lost.txt", base64: "", readFailed: true }],
      [{ name: "bad.exe", base64: "YQ==" }],
    ])
      await assert.rejects(storeCodeAttachments(f.call, [], files));
    assert.equal(
      fs.readdirSync(path.join(f.root, "attachments")).length,
      count,
    );
    f.selectedAttachments.clear();
    const restored = await f.call(
      "officialRestoreCodeAttachments",
      a.map((x) => x.id),
    );
    assert.deepEqual(
      restored.map((x: any) => ({
        id: x.id,
        name: x.name,
        size: x.size,
        kind: x.kind,
        path: fs.realpathSync(x.path),
      })),
      a.map((x) => ({
        id: x.id,
        name: x.name,
        size: x.size,
        kind: x.kind,
        path: fs.realpathSync(x.path),
      })),
    );
    const other = fixture();
    try {
      await assert.rejects(
        other.call("officialRestoreCodeAttachments", [a[0].id]),
      );
      assert.equal(storedAttachmentImage(other.root, a[0]), null);
    } finally {
      other.cleanup();
    }
    fs.unlinkSync(a[1].path);
    fs.symlinkSync(a[0].path, a[1].path);
    await assert.rejects(
      f.call("officialRestoreCodeAttachments", [a[1].id]),
      /invalid|location/,
    );
  } finally {
    f.cleanup();
  }
});

test("Code attachments survive queued restart, reach send once, and appear in the official transcript", async () => {
  const f = fixture();
  const c: any = {
    id: "session",
    title: "Attached",
    mode: "code",
    cwd: f.root,
    providerId: "p",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "base",
        prompt: "base",
        attachments: [],
        items: [],
        status: "inProgress",
        createdAt: 1,
      },
    ],
  };
  let sends = 0;
  const ctx: any = {
    account: () => ({ id: "one" }),
    stateDirectory: () => f.root,
    localLoadConversation: async () => structuredClone(c),
    localListConversations: async () => [c],
    onEvent: () => () => {},
    log() {},
    localCall: async (name: string, ...args: any[]) => {
      if (f.ipc.has(name)) return f.call(name, ...args);
      if (name === "snapshot") return { approvals: [] };
      if (name === "send") {
        sends++;
        const input = args[0];
        const attachments = input.attachments.map((a: any) =>
          f.selectedAttachments.get(a.id),
        );
        assert.ok(attachments.every(Boolean));
        c.turns.push({
          id: "sent-" + sends,
          prompt: input.text,
          attachments,
          items: [],
          status: "completed",
          createdAt: 2,
        });
        return structuredClone(c);
      }
      throw Error(name);
    },
  };
  const attach = () => {
    const h = new Map<string, any>();
    registerExperimentalCodeSessions({
      ctx,
      on: (n: string, fn: any) => h.set(n, fn),
      emit() {},
    } as never);
    return (n: string, ...a: any[]) =>
      h.get("LocalSessions." + n)("local_session", ...a);
  };
  try {
    let call = attach();
    await call(
      "sendMessage",
      "Attached request",
      [{ base64: png, mimeType: "image/png" }],
      [],
      [{ name: "notes.txt", base64: "aGVsbG8=" }],
      "later",
      {},
      "attached-uuid",
    );
    assert.equal(sends, 0);
    f.selectedAttachments.clear();
    call = attach();
    const queued = await call("getTranscript");
    assert.ok(JSON.stringify(queued).includes(png));
    assert.ok(JSON.stringify(queued).includes("notes.txt"));
    c.turns[0].status = "completed";
    await call("sendSteeredNow", "attached-uuid");
    assert.equal(sends, 1);
    assert.equal(c.turns.at(-1).attachments.length, 2);
    const rows = await call("getTranscript");
    assert.ok(rows.some((r: any) => r.uuid === "attached-uuid"));
    assert.ok(JSON.stringify(rows).includes(png));
    assert.equal(
      fs.readFileSync(c.turns.at(-1).attachments[1].path, "utf8"),
      "hello",
    );
  } finally {
    f.cleanup();
  }
});

test("a selected Code document can be taken back from the queue and sent again", async (t) => {
  const fixtureRoot = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(fixtureRoot, "code-selected-document-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = path.join(root, "selected.txt");
  const unselected = path.join(root, "unselected.txt");
  fs.writeFileSync(selected, "selected bytes");
  fs.writeFileSync(unselected, "unselected bytes");
  const c = {
    id: "session",
    title: "Selected document",
    mode: "code",
    cwd: root,
    providerId: "p",
    model: "m",
    createdAt: 1,
    updatedAt: 1,
    turns: [{
      id: "base", prompt: "base", attachments: [], items: [],
      status: "inProgress", createdAt: 1,
    }],
  };
  const account = { owner: "owner", activation: {} };
  const window = {};
  const sessionId = "local_session";
  const scope = "epitaxy:local_session";
  const grants = new AttachmentSelectionGrants(() => account);
  grants.grant(window, [selected], scope);
  const selectedAttachments = new Map();
  const ipc = new Map<string, (...args: any[]) => unknown>();
  const native = new Map<string, (...args: any[]) => unknown>();
  registerOfficialAttachmentHandlers((name, fn) => ipc.set(name, fn), {
    store: { root }, selectedAttachments, policy: () => openPolicy,
  } as never);
  registerExperimentalCodeSessions({
    caller: window,
    ctx: {
      account: () => ({ id: account.owner }),
      sessionIdentity: () => account.activation,
      stateDirectory: () => root,
      localLoadConversation: async () => structuredClone(c),
      localCall: async (name: string, ...args: unknown[]) => {
        if (name === "snapshot") return { approvals: [] };
        return ipc.get(name)!(...args);
      },
      onEvent: () => () => {},
      log() {},
    },
    takeCodeComposerAttachments(caller: object, files: string[], budget: number, target: string) {
      assert.equal(target, sessionId);
      const authorized = grants.matchingPaths(caller, files, scope);
      return grants.take(caller, authorized, budget, scope);
    },
    grantQueuedCodeAttachments(caller: object, files: string[], target: string) {
      assert.equal(target, sessionId);
      grants.grant(caller, files, scope);
    },
    on: (name: string, fn: (...args: any[]) => unknown) => native.set(name, fn),
    emit() {},
  } as never);
  const call = async (name: string, ...args: any[]) =>
    native.get("LocalSessions." + name)!(sessionId, ...args);
  const send = (message: string, uuid: string) =>
    call("sendMessage", message, [], [], [], "later", {}, uuid);

  await send(`@"${selected}" @"${unselected}"\nInspect both paths`, "first");
  const [first] = selectedAttachments.values();
  assert.equal(selectedAttachments.size, 1);
  assert.equal(first.name, "selected.txt");
  assert.equal(fs.readFileSync(first.path, "utf8"), "selected bytes");
  assert.deepEqual(grants.matchingPaths(window, [selected], scope), []);

  const rows = await call("getTranscript") as CodeTranscriptRow[];
  const queued = rows.find((row) => row.uuid === "first");
  const composerText = `@"${first.path}" @"${unselected}"\nInspect both paths`;
  assert.equal(queued?.message.content, composerText);
  assert.equal(await call("cancelQueuedMessage", "first"), true);
  assert.deepEqual(grants.matchingPaths(window, [first.path], scope), [first.path]);

  await send(composerText, "second");
  assert.equal(selectedAttachments.size, 2);
  const second = [...selectedAttachments.values()].at(-1);
  assert.equal(fs.readFileSync(second.path, "utf8"), "selected bytes");
  assert.deepEqual(grants.matchingPaths(window, [first.path], scope), []);
});
