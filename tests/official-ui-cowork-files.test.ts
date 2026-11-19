import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerOfficialFileHandlers } from "../electron/ipc/official-files";
import { registerNativeFileDownloads } from "../electron/official-ui/native/file-downloads";
import { Store } from "../electron/store/store";
import type { Conversation } from "../shared/types";

test("native Cowork previews and opens files from the current account's session workspace", async (t) => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cowork-files-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  const sibling = path.join(root, "other-workspace");
  fs.mkdirSync(cwd);
  fs.mkdirSync(sibling);
  const name = "résumé % #.txt";
  const file = path.join(cwd, name);
  const contents = "Cowork workspace 中文";
  fs.writeFileSync(file, contents);
  const outside = path.join(sibling, name);
  fs.writeFileSync(outside, "A different session's file");
  fs.symlinkSync(outside, path.join(cwd, "linked.txt"));
  const document = Buffer.from([0x50, 0x4b, 0, 0xff]);
  fs.writeFileSync(path.join(cwd, "report.docx"), document);
  fs.writeFileSync(path.join(cwd, "script.sh"), "#!/bin/sh\n");
  const large = path.join(cwd, "large.txt");
  fs.closeSync(fs.openSync(large, "w"));
  fs.truncateSync(large, 8_000_001);

  const store = new Store(path.join(root, "profile"));
  const cowork = { id: "cowork", mode: "cowork", cwd } as Conversation;
  store.conversations = [
    cowork,
    { ...cowork, id: "another", cwd: sibling },
    { ...cowork, id: "code", mode: "code" },
    {
      ...cowork,
      id: "remote",
      environment: { kind: "space", spaceId: "space" },
    },
    {
      ...cowork,
      id: "foreign",
      sessionAuthors: {
        ownerAccountUuid: "another",
        viewerAccountUuid: "owner",
      },
    },
  ];
  let owner = "owner";
  const internal = new Map<string, (...args: any[]) => any>();
  const native = new Map<string, (...args: any[]) => any>();
  let afterResolve: (() => void) | undefined;
  registerOfficialFileHandlers((name, fn) => internal.set(name, fn), {
    store,
    get activeAccount() {
      return { id: owner };
    },
    accountRetiring: false,
    allowedFolder(folder: string) {
      assert.ok(folder === cwd || folder === sibling);
    },
  } as never);
  const opened: string[] = [];
  const revealed: string[] = [];
  let permitCodeOpen = false;
  registerNativeFileDownloads(
    {
      window: {},
      ctx: {
        account: () => ({ id: owner }),
        localLoadConversation: async (id: string) => store.conversations.find((row) => row.id === id),
        localCall: async (name: string, input: { operation: string }) => {
          const result = internal.get(name)!(input);
          if (input.operation === "resolveCowork") afterResolve?.();
          return result;
        },
      },
      on: (name: string, fn: (...args: any[]) => any) => native.set(name, fn),
    } as never,
    {
      downloadsDirectory: () => path.join(root, "downloads"),
      revealFile: (filename) => revealed.push(filename),
      openFile: async (filename) => {
        opened.push(filename);
        return "";
      },
      confirmOpen: async () => permitCodeOpen,
    },
  );
  const read = (filename: string, id = "local_cowork") =>
    native.get("FileSystem.readLocalFile")!(id, encodeURIComponent(filename));
  const open = (filename: string, reveal?: boolean) =>
    native.get("FileSystem.openLocalFile")!(
      "local_cowork",
      encodeURIComponent(filename),
      reveal,
    );
  assert.deepEqual(await read(file), { content: contents });
  assert.deepEqual(await read("report.docx"), {
    content: document.toString("base64"),
    encoding: "base64",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  await open(file);
  await open(file, true);
  assert.deepEqual(opened, [file]);
  assert.deepEqual(revealed, [file]);

  for (const target of [outside, "linked.txt"]) {
    await assert.rejects(read(target), /PATH_NOT_ALLOWED/);
    await assert.rejects(open(target, true), /PATH_NOT_ALLOWED/);
  }
  for (const id of ["local_code", "local_remote", "local_foreign"])
    await assert.rejects(read(file, id), /INVALID_SESSION/);
  await assert.rejects(read("missing.txt"), /NOT_FOUND/);
  await assert.rejects(read("large.txt"), /FILE_TOO_LARGE/);
  await assert.rejects(open("script.sh"), /BLOCKED_EXTENSION/);
  const codeAction = (action: string, target: string) =>
    native.get(`LocalSessions.${action}`)!('local_code', target);
  assert.equal(native.get("CoworkFilePreview.isOpenInDefaultAppEnabled")!(), true);
  assert.deepEqual(await codeAction("getSessionFileOutsideActions", outside), {
    canReveal: false, outsideFolders: true,
  });
  assert.equal(await codeAction("showSessionFileInFolder", file), true);
  assert.equal(await codeAction("showSessionFileInFolder", "linked.txt"), false);
  assert.deepEqual(await codeAction("openSessionFileInDefaultApp", "script.sh"), {
    ok: false, error: "Blocked executable file type",
  });
  assert.deepEqual(await codeAction("openSessionFileInDefaultApp", file), {
    ok: false, error: "Declined",
  });
  assert.deepEqual(opened, [file]);
  permitCodeOpen = true;
  assert.deepEqual(await codeAction("openSessionFileInDefaultApp", file), { ok: true });
  afterResolve = () => {
    owner = "another";
  };
  await assert.rejects(open(file), /account changed/);
  assert.deepEqual(opened, [file, file]);
  assert.deepEqual(revealed, [file, file]);
});
