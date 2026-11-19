/** Inert bytes, synthetic account scopes and mocked authoritative attachment service only. */
import test, {after} from "node:test";
import fs from "node:fs";
import os from "node:os";
import {storeAttachment} from "../electron/engine/composer-files";
import {openPolicy} from "../shared/client-policy";
const roots:string[]=[];
after(()=>roots.forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import path from "node:path";
import {
  storeUpload,
  knownFile,
  learnAttachment,
  filesRoute,
  attachmentResponseHeaders,
} from "../electron/official-ui/api/files";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { organizationUuid } from "../electron/official-ui/api/context";
import { attachmentFileName } from "../electron/engine/composer-files";
import { attachmentKind } from "../shared/client-policy";
function uploadFixture() {
  const scope = newAdapterScope("synthetic-upload");
  let owner = "owner",
    activation = 1,
    root = fs.mkdtempSync(path.join(os.tmpdir(),"attachment-contract-")),
    retire = false,
    calls = 0;
  roots.push(root);
  let saved:any;
  let adjust: (v: any) => any = (v) => v;
  const ctx: any = {
    account: () => ({ id: owner }),
    stateDirectory: () => root,
    sessionIdentity: () => activation,
    image: { size: () => ({ width: 1, height: 1 }) },
    call: async (method: string, name: string, data: Uint8Array) => {
      assert.equal(method, "addAttachmentData");
      calls++;
      if (retire) activation++;
      saved ??= storeAttachment(path.join(root,"attachments"),name,data,openPolicy);
      return adjust(saved);
    },
  };
  return {
    ctx,
    scope,
    run: (
      name = "note.txt",
      data = new Uint8Array(Buffer.from("inert")),
      type?: string,
    ) => inAdapterScope(scope, () => storeUpload(ctx, name, data, type)),
    known: () => inAdapterScope(scope, () => knownFile(saved?.id ?? "attachment-id")),
    get calls() {
      return calls;
    },
    adjust: (fn: (v: any) => any) => (adjust = fn),
    retire: () => (retire = true),
  };
}
test("upload metadata comes from owned normalized store, not browser MIME", async () => {
  const f = uploadFixture();
  const file = await f.run("a?.txt", undefined, "text/html");
  assert.equal(file.name, "a_.txt");
  assert.equal(file.mediaType, "text/plain");
  assert.equal(file.kind, "blob");
  assert.equal(f.calls, 1);
  const pdf = uploadFixture();
  const document = await pdf.run(
    "inert.pdf",
    Buffer.from("%PDF-1.7 inert"),
    "image/png",
  );
  assert.equal(document.mediaType, "application/pdf");
  assert.equal(document.kind, "document");
});
test("malformed metadata, cross-root paths and repeated backend IDs never overwrite registry", async () => {
  for (const patch of [
    () => null,
    (v: any) => ({ ...v, size: 99 }),
    (v: any) => ({ ...v, id: "../other" }),
    (v: any) => ({ ...v, kind: "image" }),
    (v: any) => ({ ...v, name: "other.txt" }),
    (v: any) => ({
      ...v,
      path: "/other-account/attachments/attachment-id/note.txt",
    }),
    (v: any) => ({ ...v, path: undefined }),
  ]) {
    const f = uploadFixture();
    f.adjust(patch);
    await assert.rejects(
      () => f.run(),
      (e: any) => e.status === 503,
    );
    assert.equal(f.known(), undefined);
  }
  const f = uploadFixture();
  const first = await f.run();
  await assert.rejects(
    () => f.run(),
    (e: any) => e.status === 503,
  );
  assert.equal(f.known(), first);
});
test("unknown root, invalid UTF8/PDF/image and built-in bounds stop before attachment write", async () => {
  for (const [name, data] of [
    ["bad.pdf", Buffer.from("not PDF")],
    ["bad.txt", Buffer.from([255])],
    ["bad.txt", Buffer.from("a\0b")],
    ["bad.exe", Buffer.from("inert")],
    ["large.txt", Buffer.alloc(2 * 1024 * 1024 + 1)],
  ] as const) {
    const f = uploadFixture();
    await assert.rejects(
      () => f.run(name, data),
      (e: any) => [400, 413].includes(e.status),
    );
    assert.equal(f.calls, 0);
  }
  const image = uploadFixture();
  image.ctx.image.size = () => undefined;
  await assert.rejects(
    () => image.run("invalid.png"),
    (e: any) => e.status === 400,
  );
  assert.equal(image.calls, 0);
  const root = uploadFixture();
  root.ctx.stateDirectory = () => undefined;
  await assert.rejects(
    () => root.run(),
    (e: any) => e.status === 503,
  );
  assert.equal(root.calls, 0);
});
test("late upload cannot publish an attachment into a new activation", async () => {
  const f = uploadFixture();
  f.retire();
  await assert.rejects(
    () => f.run(),
    (e: any) => e.status === 409,
  );
  assert.equal(f.known(), undefined);
});
async function download(
  name: string,
  bytes: Buffer,
  method = "GET",
  variant = "contents",
  sourceError = false,
  image = false,
) {
  const scope = newAdapterScope("synthetic-download");
  inAdapterScope(scope, () =>
    learnAttachment(
      { id: "f", name, size: bytes.length, kind: image ? "image" : "text" } as any,
      "c",
    ),
  );
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => 1,
    image: image ? { thumbnail: (data: Buffer) => data } : undefined,
    call: async (m: string) => {
      assert.equal(m, "turnAttachment");
      if (sourceError) throw Error("private failure");
      return { data: new Uint8Array(bytes) };
    },
  };
  let status = 0,
    headers: any,
    body: any;
  const res: any = {
    writeHead: (s: number, h: any) => {
      status = s;
      headers = h;
    },
    end: (v: any) => (body = v),
  };
  await inAdapterScope(scope, () =>
    filesRoute(
      { method } as any,
      res,
      `/api/${organizationUuid("owner")}/files/f/${variant}`,
      ctx,
    ),
  );
  return { status, headers, body };
}
test("active HTML/XML and unknown Office/SVG are opaque downloads with original bytes on GET and safe HEAD", async () => {
  for (const name of [
    "inert.html",
    "inert.xml",
    "inert.svg",
    "inert.docx",
    'quote"\r\n中文.html',
  ]) {
    const bytes = Buffer.from("<p>Inert fixture only</p>");
    const r = await download(name, bytes);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, bytes);
    assert.equal(r.headers["Content-Type"], "application/octet-stream");
    assert.match(r.headers["Content-Disposition"], /^attachment; /);
    assert.doesNotMatch(r.headers["Content-Disposition"], /[\r\n]/);
    assert.match(r.headers["Content-Security-Policy"], /sandbox/);
    assert.doesNotMatch(
      r.headers["Content-Security-Policy"],
      /allow-scripts|allow-same-origin/,
    );
    assert.equal(r.headers["X-Content-Type-Options"], "nosniff");
    assert.match(r.headers["Cache-Control"], /no-store/);
    const head = await download(name, bytes, "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, undefined);
    assert.equal(head.headers["Content-Length"], bytes.length);
  }
});
test("PDF/plain contents and errors retain private no-store sandbox headers without claiming sanitization", async () => {
  for (const [name, bytes, type] of [
    ["inert.txt", Buffer.from("inert"), "text/plain"],
    ["inert.pdf", Buffer.from("%PDF-1.7 inert"), "application/pdf"],
  ] as const) {
    const r = await download(name, bytes);
    assert.equal(r.status, 200);
    assert.equal(r.headers["Content-Type"], type);
    assert.match(r.headers["Content-Security-Policy"], /sandbox/);
    assert.match(r.headers["Cache-Control"], /no-store/);
    const error = await download(name, bytes, "GET", "contents", true);
    assert.equal(error.status, 503);
    assert.match(error.headers["Cache-Control"], /no-store/);
    assert.doesNotMatch(error.body, /private failure/);
  }
});
test("cancelled upload after service completion cannot populate registry", async () => {
  const f = uploadFixture();
  const form = new FormData();
  form.append("file", new Blob(["inert"]), "note.txt");
  const request = new Request("http://fixture.invalid", {
    method: "POST",
    body: form,
  });
  const req: any = Readable.from([Buffer.from(await request.arrayBuffer())]);
  req.method = "POST";
  req.headers = { "content-type": request.headers.get("content-type") };
  const original = f.ctx.call;
  f.ctx.call = async (...args: any[]) => {
    const answer = await original(...args);
    req.aborted = true;
    return answer;
  };
  let status = 0;
  const res: any = { writeHead: (n: number) => (status = n), end: () => {} };
  await inAdapterScope(f.scope, () =>
    filesRoute(req, res, `/api/${organizationUuid("owner")}/upload`, f.ctx),
  );
  assert.equal(status, 409);
  assert.equal(f.known(), undefined);
});

test("missing session identity cannot authorize upload and error responses remain uncached", async () => {
  const f = uploadFixture();
  f.ctx.sessionIdentity = undefined;
  await assert.rejects(
    () => f.run(),
    (e: any) => e.status === 503,
  );
  assert.equal(f.calls, 0);
  const denied = await download(
    "inert.html",
    Buffer.from("<p>inert</p>"),
    "DELETE",
  );
  assert.equal(denied.status, 405);
  assert.match(denied.headers["Cache-Control"], /no-store/);
  assert.equal(denied.headers["X-Content-Type-Options"], "nosniff");
});

test("download filename encoding handles Unicode boundaries, invalid surrogates and header delimiters", () => {
  for (const name of ["a".repeat(199) + "😀.html", "lone\ud800.html", "lone\udc00.html", 'dir\\quote"\r\n.html', "dir/path.html"]) {
    const headers = attachmentResponseHeaders({ name } as any, "text/html");
    assert.ok("Content-Disposition" in headers);
    const disposition = headers["Content-Disposition"];
    assert.doesNotMatch(disposition, /[\r\n]/);
    assert.match(disposition, /^attachment; filename="attachment";/);
    const decoded = decodeURIComponent(disposition.split("UTF-8''")[1]);
    assert.doesNotMatch(decoded, /[\r\n/\\]/);
    if (name.startsWith("a".repeat(199))) assert.equal(decoded, "a".repeat(199) + "😀");
  }
});
test("inert PNG bytes preserve image metadata and private GET/HEAD thumbnail responses", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK9sAAAAASUVORK5CYII=", "base64");
  const f = uploadFixture();
  const file = await f.run("pixel.png", png);
  assert.equal(file.kind, "image");
  assert.equal(file.mediaType, "image/png");
  assert.equal(file.width, 1);
  assert.equal(file.height, 1);
  for (const variant of ["contents", "thumbnail"]) for (const method of ["GET", "HEAD"]) {
    const result = await download("pixel.png", png, method, variant, false, true);
    assert.equal(result.status, 200);
    assert.equal(result.headers["Content-Type"], "image/png");
    assert.equal(result.headers["Cache-Control"], "private, no-store");
    assert.equal(result.headers["X-Content-Type-Options"], "nosniff");
    assert.deepEqual(result.body, method === "GET" ? png : undefined);
  }
});
test("unrelated routes fall through without any response mutation; recognized HEAD errors stay private", async () => {
  for (const url of ["/static/inert.js", `/api/${organizationUuid("owner")}/unrelated`]) {
    let writes = 0;
    const res: any = { writeHead: () => writes++, end: () => writes++, setHeader: () => writes++ };
    const handled = await filesRoute({ method: "GET" } as any, res, url, {} as any);
    assert.equal(handled, false);
    assert.equal(writes, 0);
  }
  const failed = await download("inert.txt", Buffer.from("inert"), "HEAD", "contents", true);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers["Cache-Control"], "private, no-store");
  assert.equal(failed.headers["X-Content-Type-Options"], "nosniff");
});
