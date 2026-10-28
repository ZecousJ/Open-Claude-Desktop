import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { exportSessionArchive } from "../../electron/conversations/session-export";
import { sessionExport } from "../../shared/session-export";
import type { Conversation } from "../../shared/types";

const conversation: Conversation = {
  id: "session",
  title: "Fix the build",
  mode: "code",
  model: "test-model",
  providerId: "private-provider",
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 2,
  turns: [
    {
      id: "turn",
      prompt: "  preserve whitespace\n",
      attachments: [],
      status: "completed",
      createdAt: 1,
      items: [
        {
          id: "command",
          type: "commandExecution",
          command: "npm test",
          aggregatedOutput: "ok",
        },
        { id: "reply", type: "agentMessage", text: "Tests passed." },
      ],
    },
  ],
};

test("local export writes a private Downloads ZIP with transcript.jsonl and metadata.json, without overwriting", async () => {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-export-"));
  try {
    const file = exportSessionArchive(conversation, downloads, 100);
    assert.equal(file, path.join(downloads, "session-export-100.zip"));
    const bytes = fs.readFileSync(file);
    const archive = await JSZip.loadAsync(bytes);
    assert.deepEqual(Object.keys(archive.files).sort(), [
      "metadata.json",
      "transcript.jsonl",
    ]);
    const transcript = await archive.file("transcript.jsonl")!.async("string");
    assert.ok(transcript.endsWith("\n"));
    const messages = transcript
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(messages[0].message.content, conversation.turns[0].prompt);
    assert.equal(messages[1].item.command, "npm test");
    assert.equal(messages[1].item.aggregatedOutput, "ok");
    assert.equal(messages[2].item.text, "Tests passed.");
    const metadata = JSON.parse(
      await archive.file("metadata.json")!.async("string"),
    );
    assert.equal(metadata.id, conversation.id);
    assert.equal(metadata.title, conversation.title);
    assert.equal(metadata.exportedAt, new Date(100).toISOString());
    assert.equal(metadata.session_context.model, conversation.model);
    assert.equal(metadata.providerId, undefined);
    const second = exportSessionArchive(conversation, downloads, 100);
    assert.notEqual(file, second);
    assert.deepEqual(fs.readFileSync(file), bytes);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
  }
});

test("metadata is allowlisted, not a dump of private session configuration or previous branches", () => {
  const payload = sessionExport(
    {
      ...conversation,
      customOutputStyles: { secret: { name: "secret", prompt: "private" } },
      apiKey: "secret",
    } as unknown as Conversation,
    100,
  );
  assert.equal(JSON.stringify(payload).includes("secret"), false);
  assert.equal(payload.messages.length, 3);
  assert.equal(payload.session.updated_at, new Date(2).toISOString());
});

test("empty sessions still contain a transcript and write failures are surfaced", async () => {
  const downloads = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-export-"));
  try {
    const archive = await JSZip.loadAsync(
      fs.readFileSync(
        exportSessionArchive({ ...conversation, turns: [] }, downloads),
      ),
    );
    assert.equal(await archive.file("transcript.jsonl")!.async("string"), "");
    assert.throws(
      () => exportSessionArchive(conversation, path.join(downloads, "missing")),
      /ENOENT/,
    );
  } finally {
    fs.rmSync(downloads, { recursive: true, force: true });
  }
});
