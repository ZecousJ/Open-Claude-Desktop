import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactLibrary } from "../../electron/artifacts/artifact-library";
import { artifactIdentity } from "../../src/artifacts/artifact-metadata";
import { sameArtifact } from "../../src/artifacts/ArtifactCard";
import { collectArtifacts } from "../../src/artifacts/artifact-collection";
import type { Conversation } from "../../shared/types";
import { sharedArtifactToken } from "../../shared/shared-artifact-import";
import { webMethodKind } from "../../shared/web-bridge-methods";

test("shared artifacts import once and refresh the same account copy without granting tools", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "claudex-imported-artifact-"),
  );
  try {
    const library = new ArtifactLibrary(root);
    const token = "artifact_token1234567890";
    const input = {
      name: "Shared card",
      language: "html",
      content: "<h1>one</h1>",
    };
    const first = library.importShared(token, input).artifact;
    assert.equal(first.name, input.name);
    assert.equal(
      library.importShared(token, { ...input, content: "two" }).artifact
        .content,
      input.content,
    );
    const updated = library.importShared(
      token,
      { ...input, content: "two" },
      true,
    ).artifact;
    assert.equal(updated.libraryId, first.libraryId);
    assert.equal(updated.content, "two");
    const persisted = new ArtifactLibrary(root).list();
    assert.equal(persisted.copies.length, 1);
    assert.equal(persisted.copies[0].sharedArtifactToken, token);
    assert.equal(collectArtifacts([], [], persisted)[0].sharedWithYou, true);
    assert.equal(
      sharedArtifactToken(`https://share.example/s/${token}`),
      token,
    );
    assert.equal(
      sharedArtifactToken(`claudex://cowork/shared-artifact?token=${token}`),
      token,
    );
    assert.equal(
      sharedArtifactToken(`https://user:pass@share.example/s/${token}`),
      undefined,
    );
    assert.equal(
      sharedArtifactToken(`https://share.example/other/${token}`),
      undefined,
    );
    assert.equal(sharedArtifactToken("not a link"), undefined);
    for (const method of ["importSharedArtifact", "refreshImportedArtifact"])
      assert.equal(webMethodKind(method), "remote-runner");
    assert.throws(() => library.importShared("bad", input));
    assert.equal(library.list().copies.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact copies are independent account-scoped snapshots and pinned order persists", () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-artifact-lib-a-"));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-artifact-lib-b-"));
  try {
    const first = new ArtifactLibrary(a, () => 123),
      other = new ArtifactLibrary(b);
    const input = {
      name: "Synthetic card",
      language: "html",
      content: "<h1>one</h1>",
      originConversationId: "conversation",
    };
    const one = first.duplicate(input).artifact;
    const two = first.duplicate(input).artifact;
    assert.notEqual(one.libraryId, two.libraryId);
    assert.equal(one.content, input.content);
    input.content = "<h1>two</h1>";
    assert.equal(
      new ArtifactLibrary(a).list().copies[0].content,
      "<h1>one</h1>",
    );
    assert.deepEqual(other.list().copies, []);
    const oneArtifact = {
      id: one.libraryId,
      libraryId: one.libraryId,
      name: one.name,
      language: one.language,
      content: one.content,
    };
    const twoArtifact = {
      ...oneArtifact,
      id: two.libraryId,
      libraryId: two.libraryId,
    };
    assert.notEqual(
      artifactIdentity(oneArtifact),
      artifactIdentity(twoArtifact),
    );
    assert.equal(sameArtifact(oneArtifact, twoArtifact), false);
    first.pin(artifactIdentity(twoArtifact), true);
    const rows = collectArtifacts([], [], new ArtifactLibrary(a).list());
    assert.deepEqual(
      rows.map((row) => row.libraryId),
      [two.libraryId, one.libraryId],
    );
    assert.equal(rows[0].pinned, true);
    first.pin(artifactIdentity(oneArtifact), true);
    assert.deepEqual(
      collectArtifacts([], [], new ArtifactLibrary(a).list()).map(
        (row) => row.libraryId,
      ),
      [one.libraryId, two.libraryId],
    );
    first.pin(artifactIdentity(oneArtifact), false);
    first.pin(artifactIdentity(twoArtifact), false);
    assert.equal(new ArtifactLibrary(a).list().pinned.length, 0);
    first.pin(artifactIdentity(oneArtifact), true);
    const remaining = first.deleteCopy(one.libraryId);
    assert.deepEqual(
      remaining.copies.map((copy) => copy.libraryId),
      [two.libraryId],
    );
    assert.deepEqual(remaining.pinned, []);
    assert.deepEqual(new ArtifactLibrary(a).list(), remaining);
    assert.throws(() => first.deleteCopy(one.libraryId), /not found/);
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test("source Artifact can be pinned without mutating conversation; corrupt library remains untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-artifact-lib-"));
  try {
    const source: Conversation = {
      id: "conversation",
      title: "Synthetic",
      mode: "chat",
      providerId: "mock",
      model: "fixture",
      createdAt: 1,
      updatedAt: 1,
      pinned: false,
      archived: false,
      turns: [
        {
          id: "turn",
          prompt: "",
          attachments: [],
          createdAt: 1,
          status: "completed",
          items: [
            {
              id: "message",
              type: "agentMessage",
              text: "```html\n<h1>card</h1>\n```",
            },
          ],
        },
      ],
    };
    const library = new ArtifactLibrary(root);
    const item = collectArtifacts([source], [], library.list())[0];
    library.pin(artifactIdentity(item), true);
    assert.equal(
      collectArtifacts([source], [], new ArtifactLibrary(root).list())[0]
        .pinned,
      true,
    );
    assert.equal(source.turns[0].items[0].text, "```html\n<h1>card</h1>\n```");
    const filename = path.join(root, "artifact-library.json");
    fs.writeFileSync(filename, "{broken");
    assert.throws(() => new ArtifactLibrary(root), /cannot be read/);
    assert.equal(fs.readFileSync(filename, "utf8"), "{broken");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
