/** Only self-created temp files, isolated adapter scope and mocked remote service. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesRoute, learnAttachment } from "../electron/official-ui/api/files";
import { organizationUuid } from "../electron/official-ui/api/context";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
function fixture(name = "a.txt", size = 5, filePath?: string, conversationId?: string) {
  const scope = newAdapterScope("file-read-fixture"); let generation = 1, status = 0, output: any;
  let source: any = async () => ({ data: new Uint8Array(Buffer.from("hello")) }); let calls = 0;
  inAdapterScope(scope, () => learnAttachment({ id: "f", name, path: filePath, size, kind: "text" } as any, conversationId));
  const ctx: any = { account: () => ({ id: "owner" }), sessionIdentity: () => generation,
    call: async () => { calls++; return source(); } };
  const res: any = { writeHead: (n: number) => status = n, end: (data: any) => output = data };
  return { run: (variant = "contents") => inAdapterScope(scope, () => filesRoute({ method: "GET" } as any, res,
    `/api/organizations/${organizationUuid("owner")}/files/f/${variant}`, ctx)),
    source: (fn: any) => source = fn, activate: () => generation++, get status() { return status; },
    get output() { return output; }, get calls() { return calls; } };
}
test("owned service failures differ from missing files and malformed bytes never become content", async () => {
  const h = fixture("a.txt", 5, undefined, "c");
  h.source(async () => { throw Error("private source failure"); }); await h.run(); assert.equal(h.status, 503);
  assert.doesNotMatch(h.output, /private source failure/);
  h.source(async () => null); await h.run(); assert.equal(h.status, 404);
  for (const data of ["hello", [1, 2], new Uint8Array([1])]) {
    h.source(async () => ({ data })); await h.run(); assert.equal(h.status, 503);
  }
  h.source(async () => ({ data: new Uint8Array(Buffer.from("hello")) }));
  await h.run(); assert.equal(h.status, 200); assert.equal(h.output.toString(), "hello");
});
test("late service bytes cannot be published into another activation", async () => {
  const h = fixture("a.txt", 5, undefined, "c"); let done!: (x: any) => void;
  h.source(() => new Promise(r => done = r)); const pending = h.run();
  h.activate(); done({ data: new Uint8Array(Buffer.from("hello")) }); await pending;
  assert.equal(h.status, 409); assert.doesNotMatch(h.output, /hello/);
});
test("local reads are bounded, size checked, and linked legacy rows require authoritative service", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-read-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "a.txt"), link = path.join(root, "link.txt"); fs.writeFileSync(file, "hello"); fs.symlinkSync(file, link);
  const good = fixture("a.txt", 5, file); await good.run(); assert.equal(good.status, 200);
  const mismatch = fixture("a.txt", 4, file); await mismatch.run(); assert.equal(mismatch.status, 503);
  const big = fixture("a.txt", 64 * 1024 * 1024 + 1, file); await big.run(); assert.equal(big.status, 413);
  const linked = fixture("a.txt", 5, link); await linked.run(); assert.equal(linked.status, 503); assert.equal(linked.calls, 0);
  const ownedLink = fixture("a.txt", 5, link, "c"); await ownedLink.run(); assert.equal(ownedLink.status, 200); assert.equal(ownedLink.calls, 1);
});
test("content preview is genuine UTF8 text; PDF route does not return original Office bytes", async () => {
  const text = fixture("a.txt", 5, undefined, "c"); await text.run("content_preview");
  assert.equal(text.status, 200); assert.equal(JSON.parse(text.output).content, "hello");
  for (const name of ["a.pdf", "a.docx", "a.png"]) {
    const h = fixture(name, 5, undefined, "c"); await h.run("content_preview"); assert.equal(h.status, 501);
    await h.run("document_pdf"); assert.equal(h.status, 501);
  }
  const invalid = fixture("a.txt", 1, undefined, "c"); invalid.source(async () => ({ data: new Uint8Array([255]) }));
  await invalid.run("content_preview"); assert.equal(invalid.status, 400);
  const pdfData = Buffer.from("%PDF-1.7\nfixture"), pdf = fixture("a.pdf", pdfData.length, undefined, "c");
  pdf.source(async () => ({ data: new Uint8Array(pdfData) })); await pdf.run("document_pdf");
  assert.equal(pdf.status, 200); assert.deepEqual(pdf.output, pdfData);
});
test("a local attachment growing during read never publishes its previous bytes as a confirmed file", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-change-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "a.txt"); fs.writeFileSync(file, "hello");
  const h = fixture("a.txt", 5, file); const read = fs.readSync; let changed = false;
  t.mock.method(fs, "readSync", (...args: any[]) => {
    const count = (read as any)(...args);
    if (!changed) { changed = true; fs.appendFileSync(file, "changed"); }
    return count;
  });
  await h.run(); assert.equal(h.status, 503); assert.doesNotMatch(h.output, /hello/);
});
