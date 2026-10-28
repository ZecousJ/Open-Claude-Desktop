import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GeneratedFile, Item, Turn } from "../../shared/types";
import {
  captureGeneratedFiles,
  captureOutputFiles,
} from "../../electron/artifacts/generated-files";
import {
  artifactVersions,
  versionIdOf,
  versionLabel,
  versionNumber,
} from "../../src/artifacts/artifact-versions";

function write(
  digest: string,
  content: string | undefined,
  path = "/w/page.html",
): GeneratedFile {
  return {
    id: `file-${digest}`,
    name: path.split("/").at(-1)!,
    path,
    language: "html",
    operation: "update",
    state: content === undefined ? "unavailable" : "ready",
    content,
    digest,
  };
}

function turn(createdAt: number, files: GeneratedFile[]): Turn {
  return {
    id: `turn-${createdAt}`,
    prompt: "",
    attachments: [],
    status: "completed",
    createdAt,
    items: [
      { id: `item-${createdAt}`, type: "fileChange", generatedFiles: files },
    ],
  } as unknown as Turn;
}

test("a rewritten file has one version per readable write, oldest first", () => {
  const turns = [
    turn(1, [write("a", "<p>1</p>"), write("x", "other", "/w/other.md")]),
    turn(2, [write("a", "<p>1</p>")]),
    turn(3, [write("b", undefined)]),
    turn(4, [write("c", "<p>3</p>")]),
  ];
  const versions = artifactVersions(turns, "/w/page.html");
  assert.deepEqual(
    versions.map((value) => [
      value.sourceDigest,
      value.content,
      value.updatedAt,
    ]),
    [
      ["a", "<p>1</p>", 1],
      ["c", "<p>3</p>", 4],
    ],
  );
  assert.equal(versionNumber(versions, versionIdOf(versions[1])), 2);
  assert.equal(versionNumber(versions, "zzz"), undefined);
});

test("A → B → A retains independent write IDs despite identical first and last digests", () => {
  const turns = ["a", "b", "a"].map((digest, index) =>
    turn(index + 1, [
      { ...write(digest, `<p>${digest}</p>`), id: `write-${index + 1}` },
    ]),
  );
  const versions = artifactVersions(turns, "/w/page.html");
  assert.equal(versions.length, 3);
  assert.equal(versions[0].sourceDigest, versions[2].sourceDigest);
  assert.notEqual(versions[0].id, versions[2].id);
  assert.deepEqual(
    versions.map((version) => versionNumber(versions, versionIdOf(version))),
    [1, 2, 3],
  );
});

test("the switcher reads v{n} · Latest on the newest version only", () => {
  assert.equal(versionLabel(3, 3), "v3 · Latest");
  assert.equal(versionLabel(1, 3), "v1");
});

for (const capture of ["fileChange", "outputFiles"] as const) {
  test(`${capture}: production captures keep independent writes for a same-timestamp A → B → A`, () => {
    const cwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "claudex-version-capture-"),
    );
    const filename = path.join(cwd, "page.html");
    const now = Date.now;
    Date.now = () => 1234;
    try {
      const turns = ["a", "b", "a"].map((content, index) => {
        fs.writeFileSync(filename, `<p>${content}</p>`);
        const item: Item = {
          id: `patch-${index + 1}`,
          type: "fileChange",
          status: "completed",
          changes: [{ path: filename, kind: { type: "update" }, diff: "" }],
        };
        const files =
          capture === "fileChange"
            ? captureGeneratedFiles(item, cwd)
            : captureOutputFiles(
                cwd,
                0,
                new Set(),
                undefined,
                `outputs-turn-${index + 1}`,
                new Set([".html"]),
              );
        assert.equal(files.length, 1);
        assert.equal(
          files[0].id,
          capture === "fileChange"
            ? `${item.id}:0`
            : `outputs-turn-${index + 1}:0`,
        );
        assert.equal(files[0].capturedAt, 1234);
        return turn(index + 1, files);
      });
      const versions = artifactVersions(turns, filename);
      assert.equal(versions.length, 3);
      assert.equal(versions[0].sourceDigest, versions[2].sourceDigest);
      assert.notEqual(versions[0].id, versions[2].id);
      assert.deepEqual(
        versions.map((version) =>
          versionNumber(versions, versionIdOf(version)),
        ),
        [1, 2, 3],
      );
    } finally {
      Date.now = now;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
}

test("real fileChange captures with repeated file IDs, digest and timestamp retain each turn's write identity", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-version-id-"));
  const filename = path.join(cwd, "page.html");
  const now = Date.now;
  Date.now = () => 1234;
  try {
    const turns = ["a", "b", "a"].map((content, index) => {
      fs.writeFileSync(filename, `<p>${content}</p>`);
      // The renderer/store have no cross-turn item-ID uniqueness contract.
      const item: Item = {
        id: "same-item-id",
        type: "fileChange",
        status: "completed",
        changes: [{ path: filename, kind: { type: "update" }, diff: "" }],
      };
      const files = captureGeneratedFiles(item, cwd);
      assert.equal(files[0].id, "same-item-id:0");
      assert.equal(files[0].capturedAt, 1234);
      const value = turn(index + 1, files);
      value.items[0].id = item.id;
      return value;
    });
    const versions = artifactVersions(turns, filename);
    assert.equal(versions.length, 3);
    assert.equal(versions[0].id, versions[2].id);
    assert.equal(versions[0].sourceDigest, versions[2].sourceDigest);
    assert.equal(versions[0].updatedAt, versions[2].updatedAt);
    assert.deepEqual(
      versions.map((version) => version.versionId),
      [
        '["turn-1","same-item-id",0]',
        '["turn-2","same-item-id",0]',
        '["turn-3","same-item-id",0]',
      ],
    );
    assert.deepEqual(
      versions.map((version) => versionNumber(versions, versionIdOf(version))),
      [1, 2, 3],
    );
    assert.deepEqual(artifactVersions(turns, filename), versions);
  } finally {
    Date.now = now;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("version helpers retain legacy callers' artifact IDs when no history key exists", () => {
  const versions = ["first", "last"].map((id) => ({
    id,
    name: "Legacy",
    language: "html",
    content: "<p>a</p>",
  }));
  assert.equal(versionIdOf(versions[0]), "first");
  assert.equal(versionNumber(versions, "first"), 1);
  assert.equal(versionNumber(versions, "last"), 2);
});
