import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliSessions } from "../../electron/conversations/cli-sessions";
import type { Conversation } from "../../shared/types";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-cli-import-"));
  const cwd = path.join(root, "workspace");
  const project = path.join(root, "projects", "project");
  fs.mkdirSync(cwd);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(root, "sessions"));
  const sessionId = "test-cli-session";
  const filename = path.join(project, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filename,
    [
      {
        sessionId,
        cwd,
        uuid: "user",
        timestamp: "2026-10-01T00:00:00Z",
        message: { role: "user", content: "Fix the tests" },
      },
      {
        sessionId,
        cwd,
        uuid: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Done" },
            { type: "tool_use", name: "shell" },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  let scope = "first";
  const conversations: Conversation[] = [];
  const sessions = new CliSessions({
    configDir: root,
    scope: () => scope,
    conversations: () => conversations,
    allowFolder: (folder) => assert.equal(folder, cwd),
    processAlive: () => true,
  });
  return {
    root,
    cwd,
    filename,
    sessionId,
    conversations,
    sessions,
    switchAccount: () => {
      scope = "second";
    },
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("CLI sessions use account-scoped opaque handles and inert transcripts", async () => {
  const current = fixture();
  try {
    const rows = await current.sessions.list();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].handle, current.filename);
    const transcript = await current.sessions.read(rows[0].handle, true);
    assert.equal(transcript.cwd, current.cwd);
    assert.equal(transcript.turns[0].prompt, "Fix the tests");
    assert.deepEqual(
      transcript.turns[0].items.map((entry) => entry.type),
      ["agentMessage"],
    );
    current.switchAccount();
    await assert.rejects(current.sessions.read(rows[0].handle));
    const fresh = await current.sessions.list();
    current.conversations.push({
      importedCliSessionId: current.sessionId,
    } as Conversation);
    assert.deepEqual(await current.sessions.list(), []);
    await assert.rejects(current.sessions.read(fresh[0].handle));
  } finally {
    current.close();
  }
});

test("live, aliased and replaced CLI transcripts cannot be imported", async () => {
  const current = fixture();
  try {
    const row = (await current.sessions.list())[0];
    fs.renameSync(current.filename, `${current.filename}.old`);
    fs.copyFileSync(`${current.filename}.old`, current.filename);
    await assert.rejects(current.sessions.read(row.handle));
    fs.linkSync(current.filename, `${current.filename}.hardlink`);
    assert.deepEqual(await current.sessions.list(), []);
    fs.unlinkSync(`${current.filename}.hardlink`);
    fs.writeFileSync(
      path.join(current.root, "sessions", "1234.json"),
      JSON.stringify({ pid: 1234, sessionId: current.sessionId }),
    );
    assert.deepEqual(await current.sessions.list(), []);
    fs.writeFileSync(
      path.join(current.root, "sessions", "1234.json"),
      "invalid",
    );
    assert.deepEqual(await current.sessions.list(), []);
  } finally {
    current.close();
  }
});

test("runner CLI discovery follows the active account's private config directory", async () => {
  const first = fixture(),
    second = fixture();
  let current = first;
  const sessions = new CliSessions({
    configDir: () => current.root,
    scope: () => current.root,
    conversations: () => [],
    allowFolder: (cwd) => assert.equal(cwd, current.cwd),
  });
  try {
    const row = (await sessions.list())[0];
    assert.equal((await sessions.read(row.handle)).cwd, first.cwd);
    current = second;
    await assert.rejects(sessions.read(row.handle));
    const next = (await sessions.list())[0];
    assert.notEqual(next.handle, row.handle);
    assert.equal((await sessions.read(next.handle)).cwd, second.cwd);
  } finally {
    first.close();
    second.close();
  }
});
