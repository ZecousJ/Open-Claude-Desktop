import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Engine } from "../../electron/engine/engine";
import { Store } from "../../electron/store/store";
import {
  GeneratedBlobs,
  collectGeneratedSnapshots,
} from "../../electron/artifacts/generated-blobs";
import { conversationDigests } from "../../electron/workspace/storage-usage";
import { removeConversation } from "../../electron/workspace/storage-cleanup";
import type { Conversation } from "../../shared/types";

test("fork keeps input attachments, output snapshots and screenshots after source deletion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "f106-files-"));
  const store = new Store(root),
    id = randomUUID(),
    attachmentId = randomUUID(),
    screenshotId = randomUUID();
  const attachmentPath = path.join(
    root,
    "attachments",
    attachmentId,
    "input.txt",
  );
  const screenshotPath = path.join(
    root,
    "computer-use",
    "screenshots",
    id,
    screenshotId + ".jpg",
  );
  fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  fs.writeFileSync(attachmentPath, "F106_INPUT");
  fs.writeFileSync(screenshotPath, "F106_SCREENSHOT");
  const digest = "a".repeat(64),
    blobs = new GeneratedBlobs(root);
  blobs.put(digest, Buffer.from("F106_OUTPUT"));
  const source: Conversation = {
    id,
    title: "File history",
    mode: "code",
    providerId: "default",
    model: "m",
    cwd: root,
    threadId: "source",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "one",
        prompt: "Input",
        status: "completed",
        createdAt: 1,
        attachments: [
          {
            id: attachmentId,
            name: "input.txt",
            path: attachmentPath,
            kind: "text",
            size: 10,
          },
        ],
        items: [
          {
            id: "tool",
            type: "agentMessage",
            text: "claudex-screenshot://" + screenshotId,
            generatedFiles: [
              {
                id: "output",
                name: "output.pdf",
                path: path.join(root, "output.pdf"),
                language: "pdf",
                operation: "create",
                state: "ready",
                digest,
                blob: true,
                bytes: 11,
              },
            ],
          },
        ],
      },
    ],
  };
  store.conversations.push(source);
  const engine = new Engine(
    store,
    "unused",
    () => "",
    () => {},
  );
  engine.ensure = async () => {};
  engine.rpc = { call: async () => ({ thread: { id: "child" } }) } as never;
  try {
    const child = await engine.forkConversation(id, "one");
    await removeConversation({ root, store }, source, []);
    const restored = new Store(root).conversation(child.id);
    assert.equal(
      fs.readFileSync(restored.turns[0].attachments[0].path, "utf8"),
      "F106_INPUT",
    );
    const references = new Set(conversationDigests(JSON.stringify(restored)));
    collectGeneratedSnapshots(root, references, Date.now() + 60 * 60 * 1000);
    assert.equal(
      blobs
        .read(restored.turns[0].items[0].generatedFiles![0].digest!)
        .toString(),
      "F106_OUTPUT",
    );
    assert.equal(fs.existsSync(screenshotPath), false);
    assert.equal(
      fs.readFileSync(
        path.join(
          root,
          "computer-use",
          "screenshots",
          child.id,
          screenshotId + ".jpg",
        ),
        "utf8",
      ),
      "F106_SCREENSHOT",
    );
  } finally {
    engine.rpc = undefined;
    store.flush();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
