import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ResumeSessions,
  resumeTurns,
} from "../../electron/engine/resume-sessions";
import {
  filterResumeSessions,
  resumeFolder,
  type ResumableSession,
} from "../../shared/resume-sessions";
import type { Conversation } from "../../shared/types";
import { webMethodKind } from "../../shared/web-bridge-methods";

const row = (
  handle: string,
  extra: Partial<ResumableSession> = {},
): ResumableSession => ({
  handle,
  title: "Fix login",
  cwd: "/repo/app",
  gitBranch: "fix/login",
  lastActivityAt: 1000,
  liveness: "closed",
  ...extra,
});

test("resume searches every word across title, folder and branch, excludes running sessions, scopes by path boundaries", () => {
  const sessions = [
    row("one"),
    row("two", { cwd: "/repo/application" }),
    row("running", { liveness: "running" }),
    row("unknown", { liveness: "unknown" }),
  ];
  assert.deepEqual(
    filterResumeSessions(sessions, "LOGIN app").map((entry) => entry.handle),
    ["one", "two", "unknown"],
  );
  assert.deepEqual(
    filterResumeSessions(sessions, "", "folder", "/repo/app/").map(
      (entry) => entry.handle,
    ),
    ["one", "unknown"],
  );
  assert.deepEqual(
    filterResumeSessions(sessions, "", "branch", "/repo/app", "fix/login").map(
      (entry) => entry.handle,
    ),
    ["one", "unknown"],
  );
  assert.equal(
    filterResumeSessions(sessions, "", "branch", "/repo/app", "main").length,
    0,
  );
  assert.equal(
    filterResumeSessions(sessions, "", "folder", "/REPO/APP", undefined, true)
      .length,
    2,
  );
  assert.equal(
    resumeFolder("/repo/app/.claude/worktrees/fix-login"),
    "app › fix-login",
  );
  assert.equal(resumeFolder("C:\\repo\\app"), "app");
});

test("native discovery pages results, uses opaque handles, skips owned threads, and rechecks liveness and folder existence", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-resume-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let status = "notLoaded";
  let scope = "account-one";
  let trusted = true;
  const conversations: Conversation[] = [{ threadId: "owned" } as Conversation];
  const native = (id: string) => ({
    id,
    name: `Title ${id}`,
    cwd: root,
    createdAt: 1,
    updatedAt: 2,
    status: { type: status },
    turns: [],
  });
  const requests: string[] = [];
  const discovery = new ResumeSessions({
    scope: () => scope,
    conversations: () => conversations,
    allowFolder: () => {
      if (!trusted) throw new Error("not trusted");
    },
    request: async (method, params: any) => {
      requests.push(method);
      if (method === "thread/read") return { thread: native(params.threadId) };
      return params.cursor
        ? {
            data: [{ ...native("missing"), cwd: path.join(root, "gone") }],
            nextCursor: null,
          }
        : {
            data: [
              native("owned"),
              native("candidate"),
              { ...native("busy"), status: { type: "active" } },
            ],
            nextCursor: "page-two",
          };
    },
  });
  const sessions = await discovery.list();
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0].handle, "candidate");
  assert.equal(sessions[1].folderMissing, true);
  assert.equal(sessions[0].lastActivityAt, 2000);
  const handle = sessions[0].handle;
  assert.equal((await discovery.read(handle, true)).id, "candidate");
  trusted = false;
  await assert.rejects(discovery.read(handle), /not trusted/);
  trusted = true;
  status = "active";
  await assert.rejects(discovery.read(handle, true), /Couldn’t resume/);
  status = "other";
  await assert.rejects(
    discovery.read(handle, true),
    /Can’t confirm it’s closed/,
  );
  status = "notLoaded";
  fs.rmSync(root, { recursive: true });
  await assert.rejects(discovery.read(handle, true), /Folder not found/);
  scope = "account-two";
  const count = requests.length;
  await assert.rejects(discovery.read(handle), /Couldn’t resume/);
  assert.equal(requests.length, count);
});

test("resuming retains native turn IDs, user prompts and assistant/tool items; web calls run on the account runner", () => {
  const turns = resumeTurns({
    id: "native",
    cwd: "/repo",
    createdAt: 1,
    updatedAt: 2,
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [
          {
            id: "user",
            type: "userMessage",
            content: [{ type: "text", text: "Continue work" }],
          },
          { id: "assistant", type: "agentMessage", text: "Done" },
        ],
      },
    ],
  });
  assert.equal(turns[0].id, "turn");
  assert.equal(turns[0].prompt, "Continue work");
  assert.equal(turns[0].items[0].text, "Done");
  for (const method of [
    "listResumableSessions",
    "previewResumeSession",
    "resumeSession",
  ])
    assert.equal(webMethodKind(method), "remote-runner");
});
