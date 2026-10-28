import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgeList } from "../../src/collections/projects/KnowledgeList";
import {
  groupKnowledge,
  knowledgeMatches,
  knowledgeRows,
  selectKnowledge,
} from "../../src/collections/projects/knowledge-tree";
import { ProjectKnowledgeStore } from "../../electron/projects/project-knowledge";
import {
  knowledgeRepositories,
  knowledgeRepositoryFiles,
  readKnowledgeRepositoryFiles,
} from "../../electron/projects/project-knowledge-github";
import type { GhRunner } from "../../electron/git/github-cli";
import type { Project } from "../../shared/types";

const file = (name: string) => ({ name, bytes: 12, addedAt: 1 });
const files = [
  file("z.md"),
  file("docs/chapter10.md"),
  file("docs/chapter2.md"),
  file("docs/deep/notes.md"),
  file("a.md"),
];
const noop = () => {};

test("context groups nested paths, counts descendants and naturally sorts folders before files", () => {
  const tree = groupKnowledge(files);
  assert.deepEqual(
    tree.map((node) => node.name),
    ["docs", "a.md", "z.md"],
  );
  const docs = tree[0];
  assert.equal(docs.kind, "folder");
  if (docs.kind !== "folder") return;
  assert.equal(docs.fileCount, 3);
  assert.deepEqual(
    docs.children.map((node) => node.name),
    ["deep", "chapter2.md", "chapter10.md"],
  );
  assert.deepEqual(
    knowledgeRows(tree, new Set()).map(({ node }) => node.name),
    ["docs", "a.md", "z.md"],
  );
  assert.deepEqual(
    knowledgeRows(tree, new Set(["docs"])).map(({ node }) => node.name),
    ["docs", "deep", "chapter2.md", "chapter10.md", "a.md", "z.md"],
  );
});

test("search expands only matching ancestor folders and treats spaces, hyphens and underscores alike", () => {
  const rows = knowledgeRows(groupKnowledge(files), new Set(), "NOTES");
  assert.deepEqual(
    rows.map(({ node, depth, expanded }) => [node.name, depth, expanded]),
    [
      ["docs", 0, true],
      ["deep", 1, true],
      ["notes.md", 2, undefined],
    ],
  );
  assert.equal(
    knowledgeRows(groupKnowledge(files), new Set(), "missing").length,
    0,
  );
  assert.ok(knowledgeMatches("docs/my_file-name.md", "my file name"));
  assert.ok(knowledgeMatches("docs/[draft].md", "[draft]"));
  assert.equal(knowledgeMatches("docs/draft.md", "[draft]"), false);
});

test("selection toggles files and supports shift ranges without mutating previous selection", () => {
  const scope = ["a.md", "b.md", "c.md", "d.md"];
  const before = new Set(["a.md"]);
  assert.deepEqual(
    [...selectKnowledge(before, "c.md", scope, "a.md", true)],
    scope.slice(0, 3),
  );
  assert.deepEqual([...before], ["a.md"]);
  assert.deepEqual(
    [...selectKnowledge(before, "a.md", scope, null, false)],
    [],
  );
  assert.deepEqual(
    [...selectKnowledge(new Set(), "b.md", scope, "missing", true)],
    ["b.md"],
  );
});

test("context rows expose folder controls, per-file menus, selection and upload states", () => {
  const props = { files, busy: false, onPick: noop, onRemove: noop };
  const html = renderToStaticMarkup(createElement(KnowledgeList, props));
  assert.match(html, /aria-label="Open folder docs" aria-expanded="false"/);
  assert.match(html, /3 items/);
  assert.match(html, /aria-label="More options for a.md"/);
  assert.doesNotMatch(html, /aria-label="Remove a.md"|chapter2/);
  const selected = renderToStaticMarkup(
    createElement(KnowledgeList, {
      ...props,
      query: "chapter2",
      selected: new Set(["docs/chapter2.md"]),
    }),
  );
  assert.match(selected, /aria-label="Select chapter2.md"[^>]*checked/);
  assert.match(selected, /data-selected="true"/);
  assert.doesNotMatch(selected, /More options for/);
  const pending = renderToStaticMarkup(
    createElement(KnowledgeList, {
      ...props,
      files: [],
      pending: [file("upload.md")],
    }),
  );
  assert.match(pending, /aria-busy="true"/);
  assert.match(pending, /Uploading\.\.\./);
  assert.doesNotMatch(pending, /More options/);
  const empty = renderToStaticMarkup(
    createElement(KnowledgeList, { ...props, query: "no matches" }),
  );
  assert.match(empty, /No matching files\./);
});

test("nested knowledge persists and bulk removal validates all names before deleting anything", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-context-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ProjectKnowledgeStore(root, () => [
    { id: "p1" } as Project,
  ]);
  store.add("p1", [
    { name: "docs/one.md", data: Buffer.from("one") },
    { name: "docs/deep/two.md", data: Buffer.from("two") },
  ]);
  assert.equal(store.list("p1").bytes, 6);
  assert.throws(() => store.remove("p1", ["docs/one.md", "missing.md"]));
  assert.equal(store.list("p1").files.length, 2);
  assert.deepEqual(
    store.remove("p1", ["docs/one.md", "docs/deep/two.md"]).files,
    [],
  );
  assert.equal(fs.existsSync(path.join(store.folder("p1"), "docs")), false);
  for (const name of [
    "../escape.md",
    "docs/../../escape.md",
    "/absolute.md",
    "docs/.hidden.md",
  ])
    assert.throws(() => store.add("p1", [{ name, data: Buffer.from("no") }]));
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(store.folder("p1"), "linked"));
  assert.throws(() =>
    store.add("p1", [{ name: "linked/escape.md", data: Buffer.from("no") }]),
  );
  assert.equal(fs.existsSync(path.join(outside, "escape.md")), false);
  assert.throws(() =>
    store.add("p1", [
      { name: "parent.md", data: Buffer.from("parent") },
      { name: "parent.md/child.md", data: Buffer.from("child") },
    ]),
  );
  assert.equal(store.list("p1").files.length, 0);
});

test("GitHub entry is gated by usable authentication and repository files exclude symlinks and unsupported types", async () => {
  assert.deepEqual(
    await knowledgeRepositories(async () => ({
      code: 1,
      stdout: "",
      stderr: "",
      missing: true,
    })),
    [],
  );
  const replies = ["", JSON.stringify([[{ full_name: "owner/repo" }]])];
  assert.deepEqual(
    await knowledgeRepositories(async () => ({
      code: 0,
      stdout: replies.shift()!,
      stderr: "",
    })),
    ["owner/repo"],
  );
  const sha = "a".repeat(40);
  const tree: GhRunner = async (args) => {
    assert.deepEqual(args, [
      "api",
      "repos/owner/repo/git/trees/feature%2Fdocs?recursive=1",
    ]);
    return {
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        tree: [
          {
            path: "docs/readme.md",
            sha,
            type: "blob",
            mode: "100644",
            size: 3,
          },
          { path: "link.md", sha, type: "blob", mode: "120000", size: 3 },
          { path: "program.exe", sha, type: "blob", mode: "100644", size: 3 },
        ],
      }),
    };
  };
  const listed = await knowledgeRepositoryFiles(
    "owner/repo",
    "feature/docs",
    tree,
  );
  assert.deepEqual(listed, [{ name: "docs/readme.md", sha, bytes: 3 }]);
  const loaded = await readKnowledgeRepositoryFiles(
    "owner/repo",
    listed,
    async (args, outputLimit) => {
      assert.deepEqual(args, ["api", `repos/owner/repo/git/blobs/${sha}`]);
      assert.ok(outputLimit! > (10_000_000 * 4) / 3);
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          encoding: "base64",
          content: Buffer.from("doc").toString("base64"),
          size: 3,
        }),
      };
    },
  );
  assert.deepEqual(loaded, [
    { name: "owner/repo/docs/readme.md", data: Buffer.from("doc") },
  ]);
  await assert.rejects(knowledgeRepositoryFiles("../bad", "HEAD", tree));
  await assert.rejects(
    readKnowledgeRepositoryFiles("owner/repo", [
      { name: "x.md", sha: "--help", bytes: 1 },
    ]),
  );
});
