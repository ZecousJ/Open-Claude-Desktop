import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import type { AppEvent, Conversation } from "../shared/types";
import { registerGit } from "../electron/official-ui/native/git";

test("a finished terminal command refreshes Changes in sessions sharing its folder", async (t) => {
  const base = {
    title: "Fixture",
    mode: "code",
    cwd: "/workspace/project",
    providerId: "fixture",
    model: "fixture",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    turns: [],
  } satisfies Omit<Conversation, "id">;
  const conversations: Conversation[] = [
    { ...base, id: "owner" },
    { ...base, id: "shared", cwd: "/workspace/other", additionalFolders: [base.cwd] },
    { ...base, id: "unrelated", cwd: "/workspace/unrelated" },
    { ...base, id: "remote", environment: { kind: "ssh", hostId: "saved-host" } },
  ];
  const messages: unknown[] = [];
  let listener!: (event: AppEvent) => void;
  t.after(registerGit({
    ctx: {
      localListConversations: async () => conversations,
      onEvent: (fn: typeof listener) => {
        listener = fn;
        return () => {};
      },
    },
    on() {},
    emit(domain: string, name: string, message: unknown) {
      messages.push([domain, name, message]);
    },
  } as never));

  listener({ type: "terminal-busy", conversationId: "owner", id: "terminal", busy: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages, []);

  listener({ type: "terminal-busy", conversationId: "owner", id: "terminal", busy: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages, [
    ["LocalSessions", "onEvent", {
      type: "working_tree_changed", sessionId: "local_owner", workingTreeChangeCause: "terminal_command",
    }],
    ["LocalSessions", "onEvent", {
      type: "working_tree_changed", sessionId: "local_shared", workingTreeChangeCause: "other_session",
    }],
  ]);
});

test("staging a file refreshes Changes without switching branches", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "claudex-git-index-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init", "-b", "main");
  await fs.writeFile(path.join(cwd, "changed.txt"), "staged\n");
  const handlers = new Map<string, (id: string) => Promise<void>>();
  const events: unknown[] = [];
  const dispose = registerGit({
    ctx: {
      account: () => ({ id: "fixture" }),
      localCall: async (name: string) => name === "officialGitDirectory"
        ? path.join(cwd, ".git")
        : { cwd, branch: "main", conflicted: false },
      localLoadConversation: async () => ({ cwd, mode: "code" }),
      onEvent: () => () => {},
    },
    on(name: string, handler: (id: string) => Promise<void>) {
      handlers.set(name, handler);
    },
    emit(domain: string, _name: string, event: unknown) {
      if (domain === "LocalSessions") events.push(event);
    },
  } as never);
  t.after(async () => {
    dispose();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await handlers.get("LocalSessions.invalidateGitDiffCache")!("local_fixture");
  git("add", "changed.txt");
  for (let attempt = 0; attempt < 40 && !events.length; attempt++) await setTimeout(50);
  assert.deepEqual(events, [{ type: "git_state_changed", sessionId: "local_fixture" }]);
});
