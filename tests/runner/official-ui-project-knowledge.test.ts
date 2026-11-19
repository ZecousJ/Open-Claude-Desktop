import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import JSZip from "jszip";
import { Store } from "../../electron/store/store";
import { registerCollectionHandlers } from "../../electron/ipc/collections";
import { completeDocumentTextData } from "../../electron/workspace/document-text";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { createRunnerOfficialAdapter } from "../../runner/src/official-ui-adapter";
import { officialUiCapabilitiesPath, type OfficialUiReadRequest, type OfficialUiReadResponse } from "../../shared/official-ui-web";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { defaultGuardOptions } from "../../runner/src/method-guard";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { bindOfficialFrame } from "../../src-web/official/frame-lifecycle";
import { json, signedInBridge } from "../app/web-bridge-fakes.test.ts";
import { imageSizeFixtures } from "../fixtures/official-image-size-data";
import { createGeneratedOutputFixture } from "../support/generated-output-fixture";

function fixture(t: any, enabled = true, documentRuntime?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "web-project-knowledge-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), identity = {};
  const projectId = "22222222-2222-4222-8222-222222222222";
  store.projects = [{ id: projectId, kind: "chat", name: "Owned project", description: "", instructions: "", createdAt: 1 }];
  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerCollectionHandlers((name, handler) => handlers.set(name, handler), {
    store, onSettingsChanged() {}, onAccountActivated() {}, onAccountDeactivating() {},
  } as never);
  const calls: string[] = [];
  let failNextWrite = false;
  let loseUploadReply = false;
  const dispatch = async (method: string, args: unknown[]) => {
    calls.push(method);
    if (method === "snapshot") return { projects: store.projects, conversations: [] };
    if (failNextWrite && method === "addProjectKnowledgeText") {
      failNextWrite = false;
      throw Error("Fixture storage write failed");
    }
    const handler = handlers.get(method); assert.ok(handler, method);
    const result = await handler(...args);
    if (loseUploadReply && method === "addProjectKnowledgeFiles") {
      loseUploadReply = false;
      throw Error("Fixture upload reply lost after storage");
    }
    return result;
  };
  const adapter = createRunnerOfficialAdapter({
    account: () => ({ id: "owner", name: "Fixture", email: "fixture@example.test" }),
    settings: () => store.settings, sessionIdentity: () => identity,
    stateDirectory: () => root, onEvent: () => () => {}, appVersion: "test", log() {},
    allowProjectKnowledgeChanges: enabled, documentRuntime,
  } as never, dispatch, path.resolve("build/official-ui"), { modes: ["chat"] }, { allowTextActions: enabled });
  const base = `/api/organizations/${organizationUuid("owner")}/projects/${projectId}`;
  const run = (method: OfficialUiReadRequest["method"], suffix: string, body?: unknown) => adapter({
    method, path: base + suffix, acceptEncoding: "gzip",
    ...(body === undefined ? {} : { contentType: "application/json", body: Buffer.from(JSON.stringify(body)) }),
  });
  const json = (answer: OfficialUiReadResponse) => JSON.parse((answer.bodyEncoding === "gzip" ? gunzipSync(answer.body) : Buffer.from(answer.body)).toString());
  return { store, projectId, calls, adapter, base, run, json, dispatch, identity, failWrite: () => { failNextWrite = true; }, loseUploadReply: () => { loseUploadReply = true; } };
}

test("Web project text add, compact list, exact detail, overwrite and removal use the real owned store", async t => {
  const f = fixture(t);
  const added = await f.run("POST", "/docs", { file_name: "Notes", content: "First content" });
  assert.equal(added.status, 200);
  const doc = f.json(added);
  assert.equal(doc.file_name, "Notes.md");
  f.calls.length = 0;
  const list = f.json(await f.run("GET", "/docs?compact=true"));
  assert.equal(list.length, 1);
  assert.equal(list[0].content, "");
  assert.ok(!f.calls.includes("readProjectKnowledge"));
  assert.equal(f.json(await f.run("GET", "/docs/" + doc.uuid)).content, "First content");
  const updated = f.json(await f.run("POST", "/docs", { file_name: "Notes", content: "Replaced content" }));
  assert.equal(updated.uuid, doc.uuid);
  assert.equal(f.json(await f.run("GET", "/docs/" + doc.uuid)).content, "Replaced content");
  assert.equal((await f.run("DELETE", "/docs/" + doc.uuid)).status, 204);
  assert.equal(f.json(await f.run("GET", "/docs?compact=true")).length, 0);
  assert.equal((await f.run("GET", "/docs/" + doc.uuid)).status, 404);
});

test("Web project multipart upload uses current file bytes and supports the explicit retry receipt", async t => {
  const f = fixture(t);
  async function upload(reuse: boolean) {
    const form = new FormData();
    form.set("file", new Blob(["Uploaded context\n"]), "context.txt");
    form.set("client_upload_id", "project-upload-fixture");
    if (reuse) form.set("reuse_first_upload", "true");
    const request = new Request("http://localhost", { method: "POST", body: form });
    return f.adapter({ method: "POST", path: f.base + "/upload", contentType: request.headers.get("content-type")!, body: new Uint8Array(await request.arrayBuffer()) });
  }
  const first = await upload(false); assert.equal(first.status, 200, Buffer.from(first.body).toString());
  const original = f.json(first);
  const retry = await upload(true); assert.equal(retry.status, 200);
  assert.equal(f.json(retry).file_uuid, original.file_uuid);
  assert.equal(f.calls.filter(method => method === "addProjectKnowledgeFiles").length, 1);
  assert.equal((await upload(false)).status, 409);
  const raw = await f.run("GET", "/knowledge/" + original.file_uuid);
  assert.equal(raw.status, 200);
  assert.equal(Buffer.from(raw.body).toString(), "Uploaded context\n");
});

async function webUploadFixture(t: test.TestContext) {
  const f = fixture(t);
  const limit = 31_457_280;
  const relayUploads = new Map<string, Buffer>();
  const started: number[] = [];
  const ctx = {
    store: f.store, userId: 7, activeAccount: { id: "owner" },
    officialSessionIdentity: () => f.identity,
    onEvent: () => () => {}, setAccessToken() {}, log() {},
  };
  const dispatcher = {
    options: {
      officialUiRoot: path.resolve("build/official-ui"), officialUiActions: true,
      link: {
        async request(op: string, user: number, data: { id: string; offset: number; length: number }) {
          assert.equal(op, "store.files.get");
          assert.equal(user, ctx.userId);
          const bytes = relayUploads.get(data.id);
          assert.ok(bytes);
          return { size: bytes.length, bytes: { $bytes: bytes.toString("base64", data.offset, data.offset + data.length) } };
        },
      },
    },
    guard: defaultGuardOptions, contextFor: async () => ctx, context: () => ctx, now: () => 1,
    run: (frame: { method: string; args: unknown[] }) => f.dispatch(frame.method, decodeWireValue(frame.args) as unknown[]),
  };
  const { bridge, tab } = await signedInBridge((method, args) =>
    method === "officialUiRead" || method === "officialUiAction"
      ? officialUiRead(dispatcher as never, { method, args: encodeWireValue(args), user: { id: ctx.userId, accessToken: "fixture" } } as never)
      : null,
  );
  t.after(() => bridge.dispose());
  tab.routes.unshift((request) => {
    const endpoint = new URL(request.url, tab.env.origin).pathname;
    if (endpoint.endsWith("/web/uploads")) {
      const { size } = request.body as { size: number };
      started.push(size);
      if (size > limit) return json({ ok: false, error: { message: "The file is too large." } }, 413);
      const id = "upload-" + started.length;
      relayUploads.set(id, Buffer.alloc(size));
      return json({ ok: true, value: { id } });
    }
    const piece = /\/uploads\/(upload-\d+)\/chunks\/(\d+)$/.exec(endpoint);
    if (piece) {
      const buffer = relayUploads.get(piece[1]);
      assert.ok(buffer && request.body instanceof Uint8Array);
      buffer.set(request.body, Number(piece[2]) * 1024 * 1024);
      return new Response(null, { status: 204 });
    }
    if (endpoint.endsWith("/complete")) return json({ ok: true });
  });
  const capability = f.json(await bridge.officialUiRead({ method: "GET", path: officialUiCapabilitiesPath }));
  const frame = bindOfficialFrame({
    read: bridge.officialUiRead,
    action: (request) => bridge.officialUiAction({ ...request, capabilityLease: capability.activationLease }),
    events: bridge.officialUiEvents,
  }, () => true, "/new", () => {});
  t.after(() => frame.dispose());
  const upload = createOfficialReadFetch(tab.env.origin, frame.bindings.read, async () => {
    throw Error("The upload must use the official Web bridge.");
  }, undefined, frame.bindings.action);
  const stored = path.join(f.store.root, "projects", f.projectId, "knowledge");
  return { ...f, limit, upload, started, stored };
}

test("Web project upload retry confirms an existing file through the guarded runner", async t => {
  const f = await webUploadFixture(t);
  const send = (reuse: boolean) => {
    const form = new FormData();
    form.set("file", new Blob(["Recovered upload"]), "retry.txt");
    form.set("client_upload_id", "pending-retry");
    if (reuse) form.set("reuse_first_upload", "true");
    return f.upload(f.base + "/upload", { method: "POST", body: form });
  };
  f.loseUploadReply();
  assert.equal((await send(false)).status, 503);
  assert.equal((await send(true)).status, 200);
  assert.equal(f.calls.filter(method => method === "addProjectKnowledgeFiles").length, 1);
  assert.equal(f.calls.filter(method => method === "confirmProjectKnowledgeUpload").length, 1);
  assert.equal(fs.readFileSync(path.join(f.stored, "retry.txt"), "utf8"), "Recovered upload");
});

test("Web project multipart uploads preserve 30 MiB and reject one extra byte before storage", async t => {
  const { base, limit, upload, started, stored } = await webUploadFixture(t);
  const csv = Buffer.alloc(limit + 1, "name,1\n");
  const send = (name: string, bytes: Uint8Array<ArrayBuffer>) => {
    const form = new FormData();
    form.set("file", new Blob([bytes], { type: "text/csv" }), name);
    return upload(base + "/upload", { method: "POST", body: form });
  };
  const accepted = await send("table.csv", csv.subarray(0, limit));
  assert.equal(accepted.status, 200, await accepted.text());
  assert.ok(fs.readFileSync(path.join(stored, "table.csv")).equals(csv.subarray(0, limit)));
  const refused = await send("too-large.csv", csv);
  assert.equal(refused.status, 413);
  assert.deepEqual(started, [limit, limit]);
  assert.deepEqual(fs.readdirSync(stored), ["table.csv"]);
});

test("Web project text uploads preserve 30 MiB after JSON escaping and reject one extra byte", async t => {
  const { base, limit, upload, started, stored } = await webUploadFixture(t);
  const line = '\x1b[m"\\\n';
  const content = line.repeat(limit / Buffer.byteLength(line));
  const send = (file_name: string, value: string) => {
    const body = JSON.stringify({ file_name, content: value });
    return {
      size: Buffer.byteLength(body),
      reply: upload(base + "/docs", {
        method: "POST", headers: { "content-type": "application/json" }, body,
      }),
    };
  };
  const uploadedSizes = () => started.splice(0).sort((a, b) => a - b);
  const first = send("notes.txt", content);
  const accepted = await first.reply;
  assert.equal(accepted.status, 200);
  assert.ok((await accepted.json()).content === content);
  assert.ok(fs.readFileSync(path.join(stored, "notes.txt"), "utf8") === content);
  assert.deepEqual(uploadedSizes(), [first.size - 2 * limit, limit, limit]);
  const oversized = send("too-large.txt", content + "a");
  const refused = await oversized.reply;
  assert.equal(refused.status, 413);
  assert.deepEqual(uploadedSizes(), [oversized.size - 2 * limit, limit, limit]);
  assert.deepEqual(fs.readdirSync(stored), ["notes.txt"]);
});

test("large supported project text is preserved through compressed responses", async t => {
  const f = fixture(t);
  const content = "1\n".repeat(5_000_000);
  const added = await f.run("POST", "/docs", { file_name: "large.csv", content });
  assert.equal(added.status, 200);
  assert.equal(added.bodyEncoding, "gzip");
  assert.ok(f.json(added).content === content);
  const detail = await f.run("GET", "/docs/" + f.json(added).uuid);
  assert.equal(detail.status, 200);
  assert.ok(f.json(detail).content === content);
});

test("knowledge writes do not enable read-only hosts or bypass project edit rights", async t => {
  const disabled = fixture(t, false);
  assert.equal((await disabled.run("POST", "/docs", { file_name: "Denied", content: "No" })).status, 501);
  assert.deepEqual(disabled.calls, []);
  const f = fixture(t);
  f.store.projects[0].capabilities = { canEditInstructions: true, canEditKnowledgeBase: false };
  assert.equal((await f.run("POST", "/docs", { file_name: "Denied", content: "No" })).status, 403);
  assert.ok(!f.calls.includes("addProjectKnowledgeText"));
});

test("initial text upload failure can be retried without losing the other project files", async t => {
  const f = fixture(t);
  assert.equal((await f.run("POST", "/docs", { file_name: "kept.txt", content: "Keep this context" })).status, 200);
  const input = { file_name: "retry.txt", content: "Retry this context" };
  f.failWrite();
  assert.ok((await f.run("POST", "/docs", input)).status >= 500);
  assert.equal(f.json(await f.run("GET", "/docs?compact=true")).length, 1);
  assert.equal((await f.run("POST", "/docs", input)).status, 200);
  const docs = f.json(await f.run("GET", "/docs?compact=true"));
  assert.equal(docs.length, 2);
  for (const doc of docs)
    assert.equal(f.json(await f.run("GET", "/docs/" + doc.uuid)).content,
      doc.file_name === "kept.txt" ? "Keep this context" : input.content);
});

test("project PDF upload exposes its original bytes through the preview URL and supports removal", async t => {
  const f = fixture(t);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const form = new FormData();
  form.set("file", new Blob([pdf], { type: "application/pdf" }), "project.pdf");
  form.set("client_upload_id", "project-pdf-fixture");
  const request = new Request("http://localhost", { method: "POST", body: form });
  const uploaded = await f.adapter({ method: "POST", path: f.base + "/upload",
    contentType: request.headers.get("content-type")!, body: new Uint8Array(await request.arrayBuffer()) });
  assert.equal(uploaded.status, 200);
  const initialFile = f.json(uploaded);
  const contentsPath = f.base.split("/projects/")[0] + "/files/" + initialFile.file_uuid + "/contents";
  const initialPreview = await f.adapter({ method: "GET", path: contentsPath });
  assert.equal(initialPreview.status, 200, "the original uploader can preview its returned identity before a files-list request");
  assert.deepEqual(initialPreview.body, Buffer.from(pdf));
  const files = f.json(await f.run("GET", "/files"));
  assert.equal(files.length, 1);
  assert.equal(files[0].file_kind, "document");
  const preview = await f.adapter({ method: "GET", path: files[0].document_asset.url });
  assert.equal(preview.status, 200);
  assert.equal(preview.contentType, "application/pdf");
  assert.deepEqual(preview.body, Buffer.from(pdf));
  assert.equal((await f.run("POST", "/files/delete_many", { file_uuids: [files[0].file_uuid] })).status, 200);
  assert.deepEqual(f.json(await f.run("GET", "/files")), []);
});

test("tabular upload identities remain files after relisting and generic reads support the project file limit", async t => {
  const f = fixture(t);
  const csv = "name,value\n中文,retained\n";
  const pdf = "%PDF-1.4\n" + " ".repeat(5_000_000) + "\n%%EOF";
  for (const [name, content] of [["table.csv", csv], ["large.pdf", pdf]]) {
    const form = new FormData();
    form.set("file", new Blob([content]), name);
    const request = new Request("http://localhost", { method: "POST", body: form });
    const added = await f.adapter({ method: "POST", path: f.base + "/upload", acceptEncoding: "gzip",
      contentType: request.headers.get("content-type")!, body: new Uint8Array(await request.arrayBuffer()) });
    assert.equal(added.status, 200);
    const file = f.json(added);
    const alias = f.base.split("/projects/")[0] + "/files/" + file.file_uuid + "/contents";
    const read = await f.adapter({ method: "GET", path: alias, acceptEncoding: "gzip" });
    assert.equal(read.status, 200);
    const bytes = read.bodyEncoding === "gzip" ? gunzipSync(read.body) : Buffer.from(read.body);
    assert.ok(bytes.equals(Buffer.from(content)));
    const listed = f.json(await f.run("GET", "/files"));
    assert.equal(listed.find((row: any) => row.file_uuid === file.file_uuid)?.size_bytes, Buffer.byteLength(content));
  }
  assert.deepEqual(f.json(await f.run("GET", "/docs?compact=true")), []);
});

test("raw project uploads expose original raster, workbook and ZIP bytes and keep receipt identity", async t => {
  const f = fixture(t);
  const raster = imageSizeFixtures.map(({ name, base64 }) => {
    const extension = path.extname(name).slice(1);
    return {
      name,
      type: `image/${extension === "jpg" ? "jpeg" : extension}`,
      kind: "image",
      bytes: Buffer.from(base64, "base64"),
    };
  });
  const { bytes: workbook } = await createGeneratedOutputFixture(path.join(f.store.root, "assets"));
  const zip = new JSZip().file("notes.txt", "Project archive contents.");
  const archive = await zip.generateAsync({ type: "nodebuffer" });
  const csv = Buffer.from("\ufeffName,Value\nAlpha,1\n");
  const utf16 = Buffer.from("Name,Value\nAlpha,1\n", "utf16le");
  const sources = [
    ...raster,
    { name: "workbook.xlsx", type: "application/octet-stream", kind: "blob", bytes: workbook },
    { name: "archive.zip", type: "application/octet-stream", kind: "blob", bytes: archive },
    { name: "table.csv", type: "text/csv", kind: "blob", bytes: csv },
    { name: "table-le.csv", type: "text/csv", kind: "blob", bytes: utf16 },
    { name: "table-be.csv", type: "text/csv", kind: "blob", bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(utf16).swap16()]) },
  ];
  const upload = async (name: string, bytes: Buffer, reuse = false) => {
    const form = new FormData();
    form.set("file", new Blob([Uint8Array.from(bytes)]), name);
    form.set("client_upload_id", "raw-" + name);
    if (reuse) form.set("reuse_first_upload", "true");
    const request = new Request("http://localhost", { method: "POST", body: form });
    return f.adapter({
      method: "POST", path: f.base + "/upload",
      contentType: request.headers.get("content-type")!,
      body: new Uint8Array(await request.arrayBuffer()),
    });
  };
  const listed = [];
  for (const source of sources) {
    const response = await upload(source.name, source.bytes);
    assert.equal(response.status, 200, Buffer.from(response.body).toString());
    const row = f.json(response);
    assert.equal(row.file_kind, source.kind);
    if (source.kind === "image") {
      assert.equal(row.preview_asset.image_width, 37);
      assert.equal(row.preview_asset.image_height, 23);
    }
    const alias = f.base.split("/projects/")[0] + "/files/" + row.file_uuid + "/contents";
    const read = await f.adapter({ method: "GET", path: alias });
    assert.equal(read.status, 200);
    assert.equal(read.contentType, source.type);
    assert.deepEqual(Buffer.from(read.body), source.bytes);
    if (source.type === "application/octet-stream") {
      assert.equal(row.preview_url, null);
      assert.match(read.contentDisposition ?? "", /^attachment;/);
    }
    assert.equal((await upload(source.name, source.bytes, true)).status, 200);
    listed.push(source.name);
  }
  assert.equal(f.calls.filter(method => method === "addProjectKnowledgeFiles").length, sources.length);
  for (const file of raster)
    assert.equal((await upload(file.name, file.bytes.subarray(0, -8), true)).status, 400, file.name);
  assert.equal((await upload("plain.xlsx", Buffer.from("not a workbook"))).status, 400);
  assert.equal((await upload("workbook.txt", workbook)).status, 400);
  assert.equal((await upload("workbook.csv", workbook)).status, 400);
  assert.equal((await upload("supported.webp", raster[0].bytes, true)).status, 400);
  const stored = path.join(f.store.root, "projects", f.projectId, "knowledge");
  const changed = Buffer.from(workbook);
  changed[50] ^= 1;
  fs.writeFileSync(path.join(stored, "workbook.xlsx"), changed);
  assert.equal((await upload("workbook.xlsx", workbook, true)).status, 409);
  assert.deepEqual(fs.readFileSync(path.join(stored, "workbook.xlsx")), changed);
  assert.deepEqual(f.json(await f.run("GET", "/files")).map((row: { file_name: string }) => row.file_name).sort(), listed.sort());
  assert.deepEqual(f.json(await f.run("GET", "/docs?compact=true")), []);
});

const officeRuntime = process.env.CLAUDEX_RUNNER_DOCUMENT_RUNTIME ??
  (process.platform === "linux" ? "/usr/lib/libreoffice" :
    path.resolve("build", process.platform === "win32" ? "document-runtime-win" : "document-runtime"));
const officeExecutable = path.join(officeRuntime, process.platform === "darwin"
  ? "LibreOffice.app/Contents/MacOS/soffice"
  : process.platform === "win32" ? "program/soffice.exe" : "program/soffice");

test("project XLS previews preserve every sheet and downloads preserve the original", { skip: !fs.existsSync(officeExecutable) }, async t => {
  const f = fixture(t, true, officeRuntime);
  const xls = fs.readFileSync(new URL("../../docs/acceptance/evidence/f026-linux-20261109/fixtures/regions.xls", import.meta.url));
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(xls)]), "regions.xls");
  form.set("client_upload_id", "legacy-workbook");
  const request = new Request("http://localhost", { method: "POST", body: form });
  const uploaded = await f.adapter({
    method: "POST", path: f.base + "/upload",
    contentType: request.headers.get("content-type")!,
    body: new Uint8Array(await request.arrayBuffer()),
  });
  assert.equal(uploaded.status, 200, Buffer.from(uploaded.body).toString());
  const row = f.json(uploaded);
  assert.equal(row.file_name, "regions.xls");
  const alias = f.base.split("/projects/")[0] + "/files/" + row.file_uuid;
  const preview = await f.adapter({ method: "GET", path: alias + "/preview" });
  assert.equal(preview.status, 200, Buffer.from(preview.body).toString());
  assert.equal(preview.contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(
    await completeDocumentTextData(Buffer.from(preview.body), "xlsx", new AbortController().signal),
    "## Sheet: First\n华东\n\n## Sheet: Second\n华南\n\n## Sheet: 汇总\n合计\t42",
  );
  const original = await f.adapter({ method: "GET", path: alias + "/contents" });
  assert.equal(original.status, 200);
  assert.match(original.contentDisposition ?? "", /^attachment;.*regions\.xls/);
  assert.deepEqual(Buffer.from(original.body), xls);
  assert.deepEqual(fs.readFileSync(path.join(f.store.root, "projects", f.projectId, "knowledge", "regions.xls")), xls);
});

test("the first project file list reads original raster dimensions from disk", async t => {
  const f = fixture(t);
  const folder = path.join(f.store.root, "projects", f.projectId, "knowledge");
  fs.mkdirSync(folder, { recursive: true });
  for (const { name, base64 } of imageSizeFixtures) {
    const bytes = Buffer.from(base64, "base64");
    if (name === "supported.jpeg") {
      const afterJfif = 4 + bytes.readUInt16BE(4);
      const comment = Buffer.concat([
        Buffer.from([0xff, 0xfe, 0xff, 0xff]),
        Buffer.alloc(65_533, 0x61),
      ]);
      fs.writeFileSync(path.join(folder, name), Buffer.concat([
        bytes.subarray(0, afterJfif), comment, bytes.subarray(afterJfif),
      ]));
    } else {
      fs.writeFileSync(path.join(folder, name), bytes);
    }
  }
  fs.writeFileSync(path.join(folder, "tiny.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgEpEDAABoAD1UCKP3AAAAAElFTkSuQmCC",
    "base64",
  ));
  fs.writeFileSync(path.join(folder, "table.csv"), "name,value\nAlpha,1\n");
  const response = await f.run("GET", "/files");
  assert.equal(response.status, 200);
  assert.ok(!f.calls.includes("readProjectKnowledge"));
  const rows = f.json(response);
  assert.equal(rows.length, imageSizeFixtures.length + 2);
  for (const row of rows) {
    if (row.file_name === "table.csv") {
      assert.equal(row.file_kind, "blob");
      assert.equal(row.preview_asset, undefined);
      continue;
    }
    const [width, height] = row.file_name === "tiny.png" ? [1, 1] : [37, 23];
    assert.equal(row.file_kind, "image", row.file_name);
    for (const asset of [row.thumbnail_asset, row.preview_asset]) {
      assert.equal(asset.image_width, width, row.file_name);
      assert.equal(asset.image_height, height, row.file_name);
    }
    const imageTokens = Math.min(1600, Math.ceil(row.preview_asset.image_width * row.preview_asset.image_height / 700));
    assert.equal(imageTokens, row.file_name === "tiny.png" ? 1 : 2, row.file_name);
  }
});
