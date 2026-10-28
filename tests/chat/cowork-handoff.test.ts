import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  exportCoworkTask,
  importCoworkTask,
  assertLinkableTask,
} from "../../electron/workspace/cowork-handoff";
import type { Conversation } from "../../shared/types";
import { CoworkFolderGrants } from "../../electron/workspace/cowork-folders";

const thread = "12345678-1234-1234-1234-123456789abc";
const rollout = `rollout-2026-10-16T10-00-00-${thread}.jsonl`;
const task = (part: Partial<Conversation> = {}) =>
  ({
    id: "task-1",
    title: "Task",
    mode: "cowork",
    providerId: "test",
    model: "test",
    createdAt: 1,
    updatedAt: 1,
    turns: [],
    ...part,
  }) as Conversation;
function temporary(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-handoff-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("handoff carries native context, workspace and binary outputs to the local engine", (t) => {
  const root = temporary(t);
  const source = path.join(root, "cloud");
  const target = path.join(root, "desktop");
  const cwd = path.join(source, "workspace");
  const sessions = path.join(
    source,
    "codex-home",
    "sessions",
    "2026",
    "10",
    "16",
  );
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(
    path.join(sessions, rollout),
    JSON.stringify({ type: "session_meta", payload: { id: thread, cwd } }) +
      "\n",
  );
  fs.writeFileSync(path.join(cwd, "report.txt"), "Report");
  const attachment = path.join(source, "attachments", "image", "photo.png");
  fs.mkdirSync(path.dirname(attachment), { recursive: true });
  fs.writeFileSync(attachment, "image bytes");
  fs.symlinkSync("/etc/passwd", path.join(cwd, "outside"));
  const bytes = Buffer.from("binary output");
  const digest = createHash("sha256").update(bytes).digest("hex");
  fs.mkdirSync(path.join(source, "generated-files"));
  fs.writeFileSync(path.join(source, "generated-files", digest), bytes);
  const conversation = task({
    cwd,
    threadId: thread,
    environment: { kind: "space", spaceId: "cloud" },
    turns: [
      {
        id: "turn",
        status: "completed",
        attachments: [
          {
            id: "image",
            name: "photo.png",
            path: attachment,
            kind: "image",
            size: 11,
          },
        ],
        items: [
          {
            id: "file",
            type: "message",
            generatedFiles: [
              {
                id: "output",
                name: "report.txt",
                path: path.join(cwd, "report.txt"),
                language: "text",
                operation: "create",
                state: "ready",
                digest,
                blob: true,
              },
            ],
          },
        ],
      } as never,
    ],
  });
  const payload = exportCoworkTask(conversation, source);
  assert.equal(payload.files?.length, 2);
  assert.equal(conversation.linkedToComputer, undefined);
  const linked = importCoworkTask(payload, target);
  assert.deepEqual(linked.environment, { kind: "local" });
  assert.equal(linked.linkedToComputer, true);
  assert.equal(linked.threadId, thread);
  assert.equal(
    new CoworkFolderGrants(target).access(linked.cwd!).state,
    "default",
  );
  assert.equal(
    fs.readFileSync(linked.turns[0].attachments[0].path, "utf8"),
    "image bytes",
  );
  assert.equal(
    fs.readFileSync(path.join(linked.cwd!, "report.txt"), "utf8"),
    "Report",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(target, "generated-files", digest)),
    bytes,
  );
  assert.equal(
    linked.turns[0].items[0].generatedFiles![0].path,
    path.join(linked.cwd!, "report.txt"),
  );
  const context = fs.readFileSync(
    path.join(target, "codex-home", "sessions", "2026", "10", "16", rollout),
    "utf8",
  );
  assert.equal(JSON.parse(context).payload.cwd, linked.cwd);
});

test("handoff relocates the runner's sandbox cwd to the granted default workspace", (t) => {
  const root = temporary(t);
  const linked = importCoworkTask(
    {
      conversation: Buffer.from(
        JSON.stringify(task({ cwd: "/cloud/workspace", threadId: thread })),
      ),
      rollouts: [
        {
          name: rollout,
          data: Buffer.from(
            JSON.stringify({
              type: "session_meta",
              payload: { cwd: "/workspace" },
            }),
          ),
        },
      ],
    },
    root,
  );
  assert.equal(linked.cwd, path.join(root, "workspace", "linked", "task-1"));
  const context = fs.readFileSync(
    path.join(root, "codex-home", "sessions", "2026", "10", "16", rollout),
    "utf8",
  );
  assert.equal(JSON.parse(context).payload.cwd, linked.cwd);
});

test("handoff refuses unsupported, scheduled and busy tasks without losing context", () => {
  assert.throws(
    () => assertLinkableTask(task({ mode: "chat" })),
    /kind of task/,
  );
  assert.throws(
    () => assertLinkableTask(task({ scheduledTaskId: "schedule" })),
    /scheduled task/,
  );
  assert.throws(
    () =>
      assertLinkableTask(task({ turns: [{ status: "inProgress" } as never] })),
    /middle of a step/,
  );
});

test("handoff rejects path traversal, symlink destinations, forged blobs and missing native context before writes", (t) => {
  const root = temporary(t);
  const payload = {
    conversation: Buffer.from(JSON.stringify(task())),
    rollouts: [],
    files: [{ name: "../escape", data: Buffer.from("bad") }],
  };
  assert.throws(() => importCoworkTask(payload, root), /Couldn’t link/);
  assert.equal(fs.existsSync(path.join(root, "workspace")), false);
  payload.files[0].name = "file";
  fs.mkdirSync(path.join(root, "workspace"));
  fs.symlinkSync(root, path.join(root, "workspace", "linked"));
  assert.throws(() => importCoworkTask(payload, root), /Couldn’t link/);
  fs.unlinkSync(path.join(root, "workspace", "linked"));
  assert.throws(
    () =>
      importCoworkTask(
        {
          ...payload,
          blobs: [{ name: "0".repeat(64), data: Buffer.from("forged") }],
        },
        root,
      ),
    /Couldn’t link/,
  );
  assert.throws(
    () =>
      importCoworkTask(
        {
          ...payload,
          conversation: Buffer.from(JSON.stringify(task({ threadId: thread }))),
        },
        root,
      ),
    /can’t be carried over/,
  );
});
