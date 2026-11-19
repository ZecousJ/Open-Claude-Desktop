import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createSessionWorktree } from "../../electron/git/code-worktree";
import { registerCodeSessionHelpers } from "../../electron/engine/code-session-helpers";
import type { SendInput } from "../../electron/engine/new-conversation";
import {
  inAdapterScope,
  newAdapterScope,
} from "../../electron/official-ui/api/scope";
import { writeState } from "../../electron/official-ui/api/state";

test("session helpers use the live account preference and scoped loopback calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "session-helpers-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(root, "file"), "first");
  git("add", "file");
  git("commit", "-qm", "first");
  git("branch", "source");
  const sourceCommit = git("rev-parse", "source");
  const parent: any = {
    id: "parent",
    title: "Parent",
    mode: "code",
    providerId: "p",
    model: "m",
    cwd: root,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    threadId: "thread",
    turns: [{ id: "turn", status: "inProgress", codePermissionMode: "plan" }],
  };
  const store: any = {
    root,
    conversations: [parent],
    flush() {},
    settings: {
      codeEffort: "high",
      providers: [{ id: "p", model: "m", models: ["m", "other"] }],
    },
    projects: [],
  };
  const extensions: any[] = [];
  let input: any;
  const sentInput = () => {
    const sent = input as SendInput | undefined;
    assert.ok(sent);
    return sent;
  };
  const createdWorktrees: Awaited<ReturnType<typeof createSessionWorktree>>[] =
    [];
  const engine: any = {
    extensions: {
      add(x: any) {
        extensions.push(x);
        return () => {};
      },
    },
    async send(value: any, _a: unknown, _b: unknown, options: any) {
      assert.equal(options.current(), true);
      input = value;
      if (value.worktree) {
        const createdWorktree = await createSessionWorktree(value.cwd, {
          location: path.join(root, "..", `worktrees-${path.basename(root)}`),
          startBranch: value.worktreeBranch,
          branchHint: value.worktreeBranchHint,
        });
        createdWorktrees.push(createdWorktree);
      }
      const child = {
        ...parent,
        id: value.newConversationId,
        title: "initial",
        parentSessionId: parent.id,
        turns: [],
      };
      store.conversations.push(child);
      return child;
    },
    changed() {},
  };
  let activate!: () => void, deactivate!: () => void;
  const ctx: any = {
    activeAccount: { id: "owner" },
    accountActivationIdentity: {},
    accountRetiring: false,
    store,
    engine,
    allowedFolder(folder: string) {
      assert.ok(
        folder === root || createdWorktrees.some((item) => item.cwd === folder),
      );
    },
    onAccountActivated(fn: () => void) {
      activate = fn;
    },
    onAccountDeactivating(fn: () => void) {
      deactivate = fn;
    },
  };
  registerCodeSessionHelpers(ctx);
  activate();
  try {
    const extension = extensions.find(
      (x) => x.reservedMcpServerNames[0] === "ccd_session",
    );
    await extension.loopbackMcpBridge.ready;
    const config = extension.builtinMcpServers({ conversation: parent })[0];
    const headers: Record<string, string> = {
      ...config.httpHeaders,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const post = (body: unknown) =>
      fetch(config.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    assert.equal(init.status, 200);
    headers["mcp-session-id"] = init.headers.get("mcp-session-id")!;
    const invoke = async (args: object, threadId = "thread") => {
      const result = await post({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "start_session", arguments: args, _meta: { threadId } },
      });
      const raw = await result.text();
      const match = raw.match(/^data: (.+)$/m);
      return JSON.parse(match ? match[1] : raw).result;
    };
    const args = {
      initiation: "user_asked",
      title: "Child",
      prompt: "Inspect the repository",
      background: "Background ".repeat(10),
    };
    assert.equal((await invoke(args, "wrong")).isError, true);
    assert.equal(input, undefined);
    assert.equal((await invoke({ ...args, cwd: "/elsewhere" })).isError, true);
    assert.equal(input, undefined);
    const result = await invoke(args);
    assert.equal(result.isError, undefined);
    const sent = sentInput();
    assert.equal(sent.cwd, root);
    assert.equal(sent.parentSessionId, "parent");
    assert.equal(sent.additionalFolders, undefined);
    assert.equal(store.conversations[1].title, "Child");
    assert.equal((await invoke({ ...args, model: "unknown" })).isError, true);
    assert.equal(
      (await invoke({ ...args, source_branch: "source" })).isError,
      true,
    );
    assert.equal(
      (await invoke({ ...args, use_worktree: true, source_branch: "missing" }))
        .isError,
      true,
    );
    const worktreeResult = await invoke({
      ...args,
      cwd: path.join(root, "."),
      use_worktree: true,
      source_branch: "source",
      branch_name: "child-branch",
      model: "other",
      effort: "low",
    });
    assert.equal(worktreeResult.isError, undefined);
    const worktreeInput = sentInput();
    assert.equal(worktreeInput.worktree, true);
    assert.equal(worktreeInput.worktreeBranch, sourceCommit);
    assert.equal(worktreeInput.worktreeBranchHint, "child-branch");
    assert.equal(worktreeInput.model, "other");
    assert.equal(worktreeInput.effort, "low");
    assert.equal(worktreeInput.codePermissionMode, "plan");
    assert.equal((await invoke({ ...args, effort: "ultra" })).isError, true);
    const createdWorktree = createdWorktrees.at(-1);
    assert.ok(createdWorktree);
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: createdWorktree.cwd,
        encoding: "utf8",
      }).trim(),
      sourceCommit,
    );
    assert.match(createdWorktree.worktree.branch, /^claude\/child-branch-/);
    parent.cwd = createdWorktree.cwd;
    parent.worktree = { origin: root, sourceBranch: "source" };
    assert.equal((await invoke(args)).isError, undefined);
    const defaultInput = sentInput();
    assert.equal(defaultInput.worktree, true);
    assert.equal(defaultInput.worktreeBranch, "source");
    assert.equal(defaultInput.cwd, root);
    assert.equal(
      (await invoke({ ...args, use_worktree: false })).isError,
      undefined,
    );
    const sharedInput = sentInput();
    assert.equal(sharedInput.worktree, false);
    assert.equal(sharedInput.cwd, createdWorktree.cwd);
    delete parent.worktree;
    parent.cwd = root;
    inAdapterScope(newAdapterScope("owner", root), () =>
      writeState("preferences", () => ({
        epitaxyPrefs: { sessionHelpers: false },
      })),
    );
    assert.equal((await invoke(args)).isError, true);
    assert.equal(
      extension.builtinMcpServers({ conversation: parent }),
      undefined,
    );
  } finally {
    deactivate();
    for (const createdWorktree of createdWorktrees) {
      try {
        git("worktree", "remove", "--force", createdWorktree.worktree.path);
      } catch {}
    }
    fs.rmSync(path.join(root, "..", `worktrees-${path.basename(root)}`), {
      recursive: true,
      force: true,
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
