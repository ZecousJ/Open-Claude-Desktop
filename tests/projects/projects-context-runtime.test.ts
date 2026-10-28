import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import type { Project } from "../../shared/types";
import type { ProjectCapabilities } from "../../shared/project-access";
import { ProjectKnowledgeStore } from "../../electron/projects/project-knowledge";
import { ProjectKnowledgeUploads } from "../../electron/projects/project-knowledge-uploads";
import { knowledgeEncodings } from "../../shared/project-knowledge-encoding";

function fixture(context: test.TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "projects-b33-context-")),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project: Project & { capabilities?: ProjectCapabilities } = {
    id: "project",
    name: "Project",
    description: "",
    instructions: "",
    createdAt: 1,
  };
  const other = { ...project, id: "other" };
  let owner = {};
  const store = new ProjectKnowledgeStore(root, () => [project, other]);
  const create = () =>
    new ProjectKnowledgeUploads(store, { owner: () => owner });
  return {
    root,
    project,
    store,
    create,
    replaceOwner: () => {
      owner = {};
    },
    pendingFolder: path.join(root, "projects", "project", "knowledge-pending"),
  };
}
const legacy = Buffer.from([0x63, 0x61, 0x66, 0xe9]);

test("17/22: actual owned storage remains editable regardless of archive/visibility; explicit readonly capabilities reject every context mutation", (context) => {
  const env = fixture(context);
  env.project.archivedAt = 1;
  env.project.visibility = "unknown-sharing";
  env.store.add("project", [
    { name: "reference.txt", data: Buffer.from("Read-only reference") },
  ]);
  assert.equal(env.store.capabilities("project").canEditKnowledgeBase, true);
  env.project.capabilities = {
    canEditInstructions: false,
    canEditKnowledgeBase: false,
  };
  assert.equal(env.store.read("project", "reference.txt").kind, "text");
  assert.throws(
    () =>
      env.store.add("project", [{ name: "new.txt", data: Buffer.from("no") }]),
    /permission/,
  );
  assert.throws(
    () => env.store.remove("project", "reference.txt"),
    /permission/,
  );
  assert.throws(() => env.store.setSources("project", {}), /permission/);
  assert.deepEqual(
    env.store.list("project").files.map((file) => file.name),
    ["reference.txt"],
  );
});

test("20: invalid UTF8 is durably pending until explicit source-listed encoding confirmation; accepted UTF8 and PDFs reuse original storage", async (context) => {
  const env = fixture(context);
  let upload = env.create();
  const staged = await upload.stageFiles("project", [
    { name: "legacy.txt", data: legacy },
    { name: "normal.md", data: Buffer.from("UTF8 文本") },
    { name: "native.pdf", data: Buffer.from("%PDF-1.7\nNative document") },
  ]);
  assert.equal(staged.pending.length, 1);
  assert.equal(staged.pending[0].status, "encoding");
  assert.ok(
    !env.store.list("project").files.some((file) => file.name === "legacy.txt"),
  );
  upload = env.create();
  const id = upload.list("project").pending[0].id;
  assert.equal(
    upload.previewEncoding("project", id, "windows-1252").text,
    "café",
  );
  assert.equal(upload.previewEncoding("project", id, "utf-8").text, "caf�");
  const done = await upload.confirmEncoding("project", id, "windows-1252");
  assert.equal(done.pending.length, 0);
  assert.equal(env.store.read("project", "legacy.txt").kind, "text");
  const text = env.store.read("project", "legacy.txt");
  if (text.kind === "text") assert.equal(text.text, "café");
  assert.equal(env.store.read("project", "native.pdf").kind, "pdf");
  assert.equal(fs.existsSync(path.join(env.pendingFolder, `${id}.bin`)), false);
  const record = JSON.parse(
    fs.readFileSync(path.join(env.pendingFolder, "records.json"), "utf8"),
  ).records.find((entry: any) => entry.id === id);
  assert.equal(record.status, "completed");
  assert.equal(record.encoding, "windows-1252");
  assert.equal(
    (await env.create().confirmEncoding("project", id, "windows-1252")).pending
      .length,
    0,
    "same confirmation replay does not duplicate a file",
  );
});

test("20/22: charset previews remain readable after edit rights change; confirm/remove require current project and cannot cross project boundaries", async (context) => {
  const env = fixture(context),
    upload = env.create();
  const staged = await upload.stageFiles("project", [
      { name: "legacy.txt", data: legacy },
    ]),
    id = staged.pending[0].id;
  env.project.capabilities = {
    canEditInstructions: true,
    canEditKnowledgeBase: false,
  };
  assert.equal(
    upload.previewEncoding("project", id, "windows-1252").text,
    "café",
  );
  await assert.rejects(
    upload.confirmEncoding("project", id, "windows-1252"),
    /permission/,
  );
  assert.throws(() => upload.removePending("project", id), /permission/);
  assert.throws(
    () => upload.previewEncoding("other", id, "windows-1252"),
    /no longer/,
  );
  env.project.capabilities.canEditKnowledgeBase = true;
  assert.equal(upload.removePending("project", id).pending.length, 0);
  assert.equal(fs.existsSync(path.join(env.pendingFolder, `${id}.bin`)), false);
});

test("20: actual bounded Office extraction writes real UTF8 text with a truthful .txt name and retains processing choice", async (context) => {
  const env = fixture(context),
    upload = env.create();
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Extracted actual slide.</a:t></a:r></a:p></p:sld>',
  );
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const result = await upload.stageFiles("project", [
    { name: "slides.pptx", data },
  ]);
  assert.equal(result.pending.length, 0);
  assert.ok(result.uploadCapabilities.documentExtraction);
  const read = env.store.read("project", "slides.pptx.txt");
  assert.equal(read.kind, "text");
  if (read.kind === "text")
    assert.ok(read.text.includes("Extracted actual slide."));
  const records = JSON.parse(
    fs.readFileSync(path.join(env.pendingFolder, "records.json"), "utf8"),
  ).records;
  assert.equal(records[0].encoding, "extract");
  assert.equal(records[0].status, "completed");
  assert.ok(
    !fs
      .readdirSync(env.pendingFolder)
      .some((name) => name.startsWith("extract-")),
  );
});

test("20: damaged documents retain failed status/error and original bytes across restart for retry or removal", async (context) => {
  const env = fixture(context);
  const result = await env
    .create()
    .stageFiles("project", [
      { name: "damaged.docx", data: Buffer.from("not an archive") },
    ]);
  assert.equal(result.files.length, 0);
  assert.equal(result.pending[0].status, "failed");
  assert.ok(result.pending[0].error);
  const upload = env.create(),
    id = result.pending[0].id;
  await assert.rejects(upload.confirmEncoding("project", id, "extract"));
  assert.equal(upload.list("project").pending[0].status, "failed");
  assert.equal(
    fs.readFileSync(path.join(env.pendingFolder, `${id}.bin`), "utf8"),
    "not an archive",
  );
  assert.equal(upload.removePending("project", id).pending.length, 0);
});

test("20: only the twelve source charsets are accepted, previews are bounded, and invalid names/IDs/oversized bytes never enter context", async (context) => {
  const env = fixture(context),
    upload = env.create();
  const big = Buffer.alloc(5000, 0xe9);
  const staged = await upload.stageFiles("project", [
      { name: "long.txt", data: big },
    ]),
    id = staged.pending[0].id;
  assert.equal(knowledgeEncodings.length, 12);
  assert.equal(
    upload.previewEncoding("project", id, "windows-1252").text.length,
    500,
  );
  assert.throws(
    () => upload.previewEncoding("project", id, "utf-16"),
    /supported/,
  );
  await assert.rejects(
    upload.confirmEncoding("project", id, "bogus"),
    /supported/,
  );
  assert.equal(upload.list("project").pending[0].status, "encoding");
  assert.throws(
    () => upload.previewEncoding("project", "../anything", "utf-8"),
    /no longer/,
  );
  await assert.rejects(
    upload.stageFiles("project", [
      { name: "../../escape.txt", data: Buffer.from("x") },
    ]),
    /file name/,
  );
  await assert.rejects(
    upload.stageFiles("project", [
      { name: "too-big.txt", data: Buffer.alloc(10000001) },
    ]),
    /10 MB/,
  );
  assert.equal(env.store.list("project").files.length, 0);
});

test("20/22: pending metadata and blobs cannot follow symlinks outside the authenticated account/project", async (context) => {
  const env = fixture(context),
    upload = env.create();
  const staged = await upload.stageFiles("project", [
      { name: "legacy.txt", data: legacy },
    ]),
    id = staged.pending[0].id;
  const outside = path.join(env.root, "outside.txt");
  fs.writeFileSync(outside, "secret");
  fs.unlinkSync(path.join(env.pendingFolder, `${id}.bin`));
  fs.symlinkSync(outside, path.join(env.pendingFolder, `${id}.bin`));
  assert.throws(() => upload.previewEncoding("project", id, "windows-1252"));
  assert.equal(fs.readFileSync(outside, "utf8"), "secret");
  const contextFolder = env.store.folder("other");
  fs.mkdirSync(path.dirname(contextFolder), { recursive: true });
  fs.symlinkSync(env.root, contextFolder);
  assert.throws(
    () =>
      env.store.add("other", [{ name: "escape.txt", data: Buffer.from("no") }]),
    /cannot be used/,
  );
  assert.equal(fs.existsSync(path.join(env.root, "escape.txt")), false);
});

test("21: actual disk byte quota stays separate from an unavailable token/context budget", async (context) => {
  const env = fixture(context),
    upload = env.create();
  const knowledge = await upload.stageFiles("project", [
    { name: "one.txt", data: Buffer.from("四 bytes? true UTF8") },
  ]);
  assert.equal(knowledge.bytes, Buffer.byteLength("四 bytes? true UTF8"));
  assert.equal(knowledge.limit, 100000000);
  assert.equal((knowledge as any).maxKbTokens, undefined);
  assert.equal((knowledge as any).tokens, undefined);
});

test("17/22: malformed explicit stored capabilities deny editing while a missing legacy capability remains owned", (context) => {
  const env = fixture(context);
  for (const capabilities of [
    null,
    {},
    { canEditInstructions: "true", canEditKnowledgeBase: "true" },
  ]) {
    env.project.capabilities = capabilities as never;
    assert.deepEqual(env.store.capabilities("project"), {
      canEditInstructions: false,
      canEditKnowledgeBase: false,
    });
    assert.throws(
      () =>
        env.store.add("project", [
          { name: "blocked.txt", data: Buffer.from("no") },
        ]),
      /permission/,
    );
  }
  delete env.project.capabilities;
  assert.equal(env.store.capabilities("project").canEditKnowledgeBase, true);
});

test("20/22: actual asynchronous Office extraction cannot commit after the account/lease is retired", async (context) => {
  const env = fixture(context),
    upload = env.create(),
    zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    "<a:p><a:t>Old account document</a:t></a:p>",
  );
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const pending = upload.stageFiles("project", [{ name: "old.pptx", data }]);
  env.replaceOwner();
  await assert.rejects(pending, /account changed/);
  assert.equal(env.store.list("project").files.length, 0);
  assert.throws(() => upload.list("project"), /account changed/);
  const fresh = env.create();
  assert.equal(fresh.list("project").pending.length, 1);
  assert.equal(fresh.list("project").pending[0].status, "failed");
  assert.match(fresh.list("project").pending[0].error!, /interrupted/);
  const done = await fresh.confirmEncoding(
    "project",
    fresh.list("project").pending[0].id,
    "extract",
  );
  assert.equal(done.pending.length, 0);
  assert.equal(done.files[0].name, "old.pptx.txt");
});

test("20: failed pending-journal writes leave prior pending bytes intact and clean the new uncommitted spool", async (context) => {
  const env = fixture(context),
    upload = env.create();
  const first = await upload.stageFiles("project", [
    { name: "first.txt", data: legacy },
  ]);
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(to) === path.join(env.pendingFolder, "records.json"))
      throw Error("Journal disk failure");
    rename(from, to);
  }) as typeof rename;
  try {
    await assert.rejects(
      upload.stageFiles("project", [{ name: "second.txt", data: legacy }]),
      /Journal disk failure/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.deepEqual(
    upload.list("project").pending.map((file) => file.id),
    first.pending.map((file) => file.id),
  );
  assert.equal(
    fs.readdirSync(env.pendingFolder).filter((name) => name.endsWith(".bin"))
      .length,
    1,
  );
  assert.equal(
    fs.existsSync(path.join(env.pendingFolder, "records.json.tmp")),
    false,
  );
});

test("20: actual live extraction reports extracting until the parser finishes, then removes the pending row", async (context) => {
  const env = fixture(context),
    upload = env.create(),
    zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    "<a:p><a:t>Actual live extraction</a:t></a:p>",
  );
  const data = await zip.generateAsync({ type: "nodebuffer" });
  const work = upload.stageFiles("project", [{ name: "live.pptx", data }]);
  const live = upload.list("project").pending[0];
  assert.equal(live.status, "extracting");
  assert.equal(live.error, undefined);
  const done = await work;
  assert.equal(done.pending.length, 0);
  assert.equal(done.files[0].name, "live.pptx.txt");
});
