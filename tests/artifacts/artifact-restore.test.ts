import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  artifactVersion,
  restoredArtifact,
} from "../../electron/artifacts/artifact-versions";
import { localWorkspaceFs } from "../../electron/workspace/workspace-fs";
import { registerArtifactLibraryHandlers } from "../../electron/ipc/artifact-library";
import type { Conversation, GeneratedFile } from "../../shared/types";
import type { AppContext } from "../../electron/app/app-context";
import type { ArtifactLibrary } from "../../electron/artifacts/artifact-library";

test("restore only accepts intact snapshots belonging to this artifact", () => {
  const content = "<title>Previous</title>";
  const digest = createHash("sha256").update(content).digest("hex");
  const file: GeneratedFile = {
    id: "file",
    path: "/workspace/card.html",
    name: "card.html",
    content,
    digest,
    language: "html",
    operation: "create",
    state: "ready",
  };
  const conversation = {
    turns: [{ items: [{ generatedFiles: [file] }] }],
  } as Conversation;
  assert.equal(
    artifactVersion(
      conversation,
      file.path,
      digest,
      "/unused",
    )?.bytes.toString(),
    content,
  );
  assert.equal(
    artifactVersion(conversation, "/other.html", digest, "/unused"),
    undefined,
  );
  assert.equal(
    artifactVersion(conversation, file.path, "a".repeat(64), "/unused"),
    undefined,
  );
  const restored = restoredArtifact(file, 42);
  assert.notEqual(restored.id, file.id);
  assert.equal(restored.operation, "update");
  assert.equal(restored.capturedAt, 42);
  file.content = "tampered";
  assert.equal(
    artifactVersion(conversation, file.path, digest, "/unused"),
    undefined,
  );
});

test("workspace restore refuses escapes, aliases and revoked authorization", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-restore-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  fs.mkdirSync(cwd);
  const target = path.join(cwd, "card.html");
  const outside = path.join(root, "outside.html");
  fs.writeFileSync(target, "current");
  fs.writeFileSync(outside, "outside");
  const bytes = Buffer.from("restored");
  await localWorkspaceFs.writeFileInside!(cwd, target, bytes);
  assert.equal(fs.readFileSync(target, "utf8"), "restored");
  await assert.rejects(localWorkspaceFs.writeFileInside!(cwd, outside, bytes));
  fs.symlinkSync(outside, path.join(cwd, "link.html"));
  await assert.rejects(
    localWorkspaceFs.writeFileInside!(cwd, "link.html", bytes),
  );
  fs.linkSync(outside, path.join(cwd, "hardlink.html"));
  await assert.rejects(
    localWorkspaceFs.writeFileInside!(cwd, "hardlink.html", bytes),
  );
  await assert.rejects(
    localWorkspaceFs.writeFileInside!(
      cwd,
      target,
      Buffer.from("denied"),
      () => {
        throw Error("revoked");
      },
    ),
  );
  assert.equal(fs.readFileSync(target, "utf8"), "restored");
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.ok(
    !fs.readdirSync(cwd).some((name) => name.startsWith(".claudex-restore-")),
  );
});

test("artifact restore IPC writes a new version and refuses an active turn", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-restore-ipc-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "card.html");
  fs.writeFileSync(filename, "latest");
  const content = "previous";
  const digest = createHash("sha256").update(content).digest("hex");
  const file: GeneratedFile = {
    id: "file",
    name: "card.html",
    path: filename,
    language: "html",
    operation: "create",
    state: "ready",
    content,
    digest,
  };
  const conversation = {
    id: "conversation",
    mode: "code",
    cwd: root,
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [{ type: "fileChange", generatedFiles: [file] }],
      },
    ],
  } as Conversation;
  const handlers = new Map<string, (...args: any[]) => any>();
  let flushed = 0;
  let pushed = 0;
  registerArtifactLibraryHandlers(
    (name, handler) => handlers.set(name, handler),
    () => ({}) as ArtifactLibrary,
    () => {},
    {
      store: {
        root,
        conversations: [conversation],
        conversation: () => conversation,
        flush: () => flushed++,
      },
      engines: { all: () => [] },
      services: {},
      allowedFolder: () => {},
      push: () => pushed++,
    } as unknown as AppContext,
  );
  assert.equal(
    await handlers.get("restoreArtifactVersion")!(
      conversation.id,
      filename,
      digest,
    ),
    true,
  );
  assert.equal(fs.readFileSync(filename, "utf8"), content);
  assert.equal(conversation.turns[0].items.length, 2);
  assert.equal(flushed, 1);
  assert.equal(pushed, 1);
  conversation.turns[0].status = "inProgress";
  assert.equal(
    await handlers.get("restoreArtifactVersion")!(
      conversation.id,
      filename,
      digest,
    ),
    false,
  );
});
