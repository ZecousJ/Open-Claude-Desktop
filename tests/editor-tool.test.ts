import { registerHooks } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Conversation } from "../shared/types";
import { identifySshEditorFile } from "../electron/workspace/editor-ssh-file";
registerHooks({
  resolve(spec, context, next) {
    if (spec === "electron")
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          "export const app={getApplicationInfoForProtocol:async()=>({path:'/fixture/zed'})};" +
          "export const shell={openExternal:async()=>{}};",
      };
    return next(spec, context);
  },
});
const { editorToolExtension } =
  await import("../electron/workspace/editor-tool");
const { openFileInEditor } = await import("../electron/workspace/editors");

test("editor tool respects preference, approval, scope and target identity", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-tool-"));
  try {
    const file = path.join(root, "file.txt");
    await fs.writeFile(file, "a");
    const c: any = {
      id: "c",
      mode: "code",
      cwd: root,
      createdAt: 1,
      threadId: "t",
      turns: [{ id: "t", status: "inProgress" }],
    };
    let approved = true;
    let replace = false;
    let localGrant: string | undefined;
    let revokeLocalGrant = false;
    let approvalRoute: string[] = [];
    const opened: string[] = [];
    const extension = editorToolExtension({
      owner: () => "owner",
      current: () => true,
      conversation: () => c,
      preferred: () => "cursor",
      authorizeRoot: (candidate) => {
        if (candidate === localGrant)
          throw Error("The folder is scoped to its session.");
      },
      inventory: async () => [
        { kind: "vscode", name: "VS Code", installed: true },
        { kind: "cursor", name: "Cursor", installed: true },
      ],
      approve: async (_id, _file, threadId, turnId) => {
        approvalRoute = [threadId, turnId];
        if (revokeLocalGrant) c.codeSessionFolderGrants = [];
        if (replace) {
          await fs.rename(file, file + ".old");
          await fs.writeFile(file, "b");
        }
        return approved;
      },
      open: async (kind, p) => {
        opened.push(`${kind}:${p}`);
        return true;
      },
    });
    const call = async (p: string, editor?: string) =>
      extension.handleDynamicTool!({
        conversation: c,
        threadId: "t",
        turnId: "t",
        callId: "i",
        namespace: null,
        tool: "open_file_in_editor",
        arguments: { path: p, ...(editor ? { editor } : {}) },
        changed() {},
      });
    assert.equal((await call("file.txt"))?.success, true);
    assert.deepEqual(opened, [`cursor:${file}`]);
    assert.deepEqual(approvalRoute, ["t", "t"]);
    const extra = await fs.mkdtemp(
      path.join(os.tmpdir(), "editor-tool-extra-"),
    );
    try {
      const extraFile = path.join(extra, "other.txt");
      await fs.writeFile(extraFile, "extra");
      c.additionalFolders = [extra];
      assert.equal((await call(extraFile, "vscode"))?.success, true);
      assert.equal(opened.at(-1), `vscode:${extraFile}`);
      localGrant = extra;
      c.codeSessionFolderGrants = [extra];
      assert.equal((await call(extraFile))?.success, true);
      assert.equal(opened.at(-1), `cursor:${extraFile}`);
      revokeLocalGrant = true;
      assert.equal((await call(extraFile))?.success, false);
      c.additionalFolders = [];
      c.codeSessionFolderGrants = [extra];
      assert.equal((await call(extraFile))?.success, false);
    } finally {
      await fs.rm(extra, { recursive: true, force: true });
    }
    approved = false;
    assert.equal((await call("file.txt"))?.success, false);
    assert.equal((await call("../outside"))?.success, false);
    await fs.link(file, path.join(root, "hardlink"));
    assert.equal((await call("file.txt"))?.success, false);
    await fs.unlink(path.join(root, "hardlink"));
    approved = true;
    replace = true;
    assert.equal((await call("file.txt"))?.success, false);
    assert.equal(opened.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "Zed file links do not open a sibling named with the position suffix",
  { skip: process.platform === "win32" },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-tool-zed-"));
    try {
      const file = path.join(root, "file.txt");
      await fs.writeFile(file, "approved target");
      assert.equal(await openFileInEditor("zed", file, 3, 2), true);

      await fs.writeFile(file + ":3:2", "different target");
      assert.equal(await openFileInEditor("zed", file, 3, 2), false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("only approved SSH files on the same host reach remote-capable editors", async () => {
  const host = { destination: "user@server", port: 2222 };
  const c: Conversation = {
    id: "session",
    mode: "code",
    title: "SSH editor fixture",
    model: "fixture-model",
    providerId: "fixture-provider",
    archived: false,
    pinned: false,
    cwd: "/remote/workspace",
    environment: { kind: "ssh", hostId: "saved" },
    additionalFolders: ["/remote/extra"],
    codeSessionFolderGrants: ["/remote/extra"],
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread",
    turns: [
      {
        id: "turn",
        status: "inProgress",
        createdAt: 1,
        prompt: "Open the fixture",
        items: [],
        attachments: [],
      },
    ],
  };
  const launches: unknown[][] = [];
  const prompts: string[] = [];
  let approved = true,
    generation = 1,
    inode = "500";
  let changeBeforeApproval = () => {};
  const extension = editorToolExtension({
    owner: () => "owner",
    current: () => true,
    conversation: () => c,
    preferred: () => "zed",
    authorizeRoot(root) {
      assert.equal(root, c.cwd);
    },
    async inventory() {
      return [
        { kind: "vscode", name: "VS Code", installed: true },
        { kind: "zed", name: "Zed", installed: true },
      ];
    },
    sshWorkspace() {
      const expected = generation;
      return {
        target: host,
        current: () => generation === expected,
        async identify(_root, file) {
          return { real: file, dev: "2", ino: inode };
        },
      };
    },
    async approve(_id, display) {
      prompts.push(display);
      changeBeforeApproval();
      return approved;
    },
    async open(...args) {
      launches.push(args);
      return true;
    },
  });
  const call = (file: string, editor?: string) =>
    extension.handleDynamicTool!({
      conversation: c,
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      namespace: null,
      tool: "open_file_in_editor",
      arguments: {
        path: file,
        line: 3,
        column: 2,
        ...(editor ? { editor } : {}),
      },
      changed() {},
    });
  assert.equal((await call("/remote/extra/file.txt"))?.success, true);
  assert.match(prompts[0], /user@server:2222/);
  assert.deepEqual(launches[0].slice(0, 4), [
    "vscode",
    "/remote/extra/file.txt",
    3,
    2,
  ]);
  assert.equal((await call("file.txt", "zed"))?.success, false);
  assert.equal((await call("../outside.txt"))?.success, false);
  assert.equal((await call("might#change.txt"))?.success, false);
  approved = false;
  assert.equal((await call("file.txt"))?.success, false);
  approved = true;
  changeBeforeApproval = () => {
    generation++;
  };
  assert.equal((await call("file.txt"))?.success, false);
  changeBeforeApproval = () => {
    inode = "501";
  };
  assert.equal((await call("file.txt"))?.success, false);
  assert.equal(launches.length, 1);
});

test(
  "SSH identity command accepts regular files and rejects filesystem aliases",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "editor-identity-"));
    try {
      const exec = promisify(execFile);
      const identify = (name: string) =>
        identifySshEditorFile(
          async ({ argv: [command, ...args] }) => ({
            code: 0,
            ...(await exec(command, args, { maxBuffer: 24_576 })),
          }),
          root,
          path.join(root, name),
        );
      const directory = path.join(root, "original");
      await fs.mkdir(directory);
      const file = path.join(directory, "single 'quoted' file.txt");
      await fs.writeFile(file, "plain file");
      const info = await identify(path.relative(root, file));
      const stat = await fs.lstat(file, { bigint: true });
      assert.equal(info.real, await fs.realpath(file));
      assert.equal(info.dev, String(stat.dev));
      assert.equal(info.ino, String(stat.ino));
      await fs.symlink(file, path.join(root, "link"));
      await fs.symlink(directory, path.join(root, "dirlink"));
      await assert.rejects(identify("link"));
      await assert.rejects(identify("dirlink/single 'quoted' file.txt"));
      await assert.rejects(identify("original"));
      await assert.rejects(identify("../outside"));
      await fs.link(file, path.join(root, "hardlink"));
      await assert.rejects(identify("hardlink"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
