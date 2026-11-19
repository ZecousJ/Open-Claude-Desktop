/** Inert text and self-created temp files only; no engine calls or external IO. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  prepareDerivedTextAttachment,
  storePreparedDerivedTextAttachment,
} from "../electron/official-ui/api/derived-text-attachment";
import { storeUpload } from "../electron/official-ui/api/files";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
import { openPolicy } from "../shared/client-policy";
import { storeAttachment } from "../electron/engine/composer-files";
import {
  createActionRpc,
  PERFORM_ACTION_PATH,
} from "../electron/official-ui/api/actions";
import { loadRegistry, deepCreate } from "../electron/official-ui/api/timeline";
import { turnInput } from "../electron/engine/engine-support";
function fixture(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "derived-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = newAdapterScope("derived-fixture");
  let generation = 1,
    calls = 0;
  const stored: any[] = [];
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => generation,
    stateDirectory: () => root,
    call: async (method: string, name: string, data: Uint8Array) => {
      assert.equal(method, "addAttachmentData");
      calls++;
      const saved = storeAttachment(
        path.join(root, "attachments"),
        name,
        data,
        openPolicy,
      );
      // Preserve the original deterministic fixture IDs and assertions while
      // using real owned bytes, directories and metadata for upload validation.
      const id = `derived-${calls}`;
      const directory = path.join(root, "attachments", id);
      fs.renameSync(path.dirname(saved.path), directory);
      const row = { ...saved, id, path: path.join(directory, saved.name) };
      stored.push({ row, data: Buffer.from(data) });
      return row;
    },
  };
  return {
    ctx,
    scope,
    stored,
    retire: () => generation++,
    calls: () => calls,
    run: (input: unknown) =>
      inAdapterScope(scope, async () =>
        storePreparedDerivedTextAttachment(
          ctx,
          prepareDerivedTextAttachment(input),
        ),
      ),
  };
}
test("PDF/Office extracted text is an explicitly named text derivative, not original binary size or MIME", async (t) => {
  for (const fileName of [
    "report.pdf",
    "slides.pptx",
    "sheet.xlsx",
    "notes.docx",
  ]) {
    const f = fixture(t);
    const value = await f.run({
      fileName,
      fileType: "application/pdf",
      fileSize: 999999n,
      extractedContent: "提取文本\r\n😀",
    });
    assert.equal(value.name, fileName + ".extracted.txt");
    assert.equal(value.mediaType, "text/plain");
    assert.equal(value.size, Buffer.byteLength("提取文本\r\n😀"));
    assert.equal(f.stored[0].row.kind, "text");
    assert.equal(f.stored[0].data.toString(), "提取文本\r\n😀");
  }
});
test("input validation rejects missing/binary/ill-formed/oversize content before any write", async (t) => {
  for (const value of [
    null,
    [],
    {},
    { extractedContent: new Uint8Array([1]) },
    { extractedContent: "a\0b" },
    { extractedContent: "\ud800" },
    { extractedContent: "é".repeat(1024 * 1024 + 1) },
    { fileName: [], extractedContent: "a" },
    { fileType: [], extractedContent: "a" },
  ]) {
    const f = fixture(t);
    await assert.rejects(() => f.run(value));
    assert.equal(f.calls(), 0);
  }
});
test("source filenames stay bounded safe and visibly derived; valid BOM and empty text stay exact", () => {
  for (const fileName of [
    "../../report.pdf",
    "dir\\note.docx",
    "😀".repeat(250),
    "x\ud800.pdf",
    "",
  ]) {
    const p = prepareDerivedTextAttachment({
      fileName,
      extractedContent: "\ufefftext",
    });
    assert.ok(p.name.length <= 120);
    assert.match(p.name, /\.extracted\.txt$/);
    assert.doesNotMatch(p.name, /[/\\]/);
    assert.equal(p.data.length, 7);
    assert.equal(Buffer.from(p.data).toString(), "\ufefftext");
  }
  assert.equal(
    prepareDerivedTextAttachment({ extractedContent: "" }).data.length,
    0,
  );
});
test("raw PDF upload validation stays strict and separate; derived upload keeps activation lease", async (t) => {
  const f = fixture(t);
  await assert.rejects(() =>
    inAdapterScope(f.scope, () =>
      storeUpload(f.ctx, "report.pdf", Buffer.from("text")),
    ),
  );
  assert.equal(f.calls(), 0);
  const pdf = await inAdapterScope(f.scope, () =>
    storeUpload(f.ctx, "report.pdf", Buffer.from("%PDF-1.7 inert")),
  );
  assert.equal(pdf.mediaType, "application/pdf");
  assert.equal(f.stored[0].row.kind, "document");
  const old = f.ctx.call;
  f.ctx.call = async (...args: any[]) => {
    const result = await old(...args);
    f.retire();
    return result;
  };
  await assert.rejects(
    () => f.run({ fileName: "report.pdf", extractedContent: "text" }),
    /account changed/i,
  );
});
test("existing pure engine input mapper reads derivative as text, not a PDF converter", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "derived-text-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const p = prepareDerivedTextAttachment({
      fileName: "report.pdf",
      extractedContent: "inert extracted text",
    }),
    file = path.join(root, p.name);
  fs.writeFileSync(file, p.data);
  const result = await turnInput("", [
    {
      id: "inert",
      name: p.name,
      path: file,
      size: p.data.length,
      kind: "text",
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, "text");
  assert.match(result[0].text, /report\.pdf\.extracted\.txt/);
  assert.match(result[0].text, /inert extracted text/);
  assert.match(result[0].text, /Treat it as data/);
});
test("real PerformAction protobuf inline attachment loop dispatches only prepared text attachment IDs", async (t) => {
  const f = fixture(t),
    registry = loadRegistry(
      "build/official-ui/data/conversation-protocol.json",
    );
  const schema = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionRequest",
  )!;
  const id = "11111111-1111-4111-8111-111111111111";
  const original = f.ctx.call;
  let sent: any;
  Object.assign(f.ctx, {
    settings: () => ({
      providers: [{ id: "p", backend: "sub2api", model: "m" }],
    }),
    loadConversation: async () => undefined,
    log: () => {},
  });
  f.ctx.call = async (method: string, ...args: any[]) => {
    if (method === "send") {
      sent = args[0];
      return { id, turns: [] };
    }
    return original(method, ...args);
  };
  const good = {
    fileName: "report.pdf",
    fileType: "application/pdf",
    fileSize: 12345n,
    extractedContent: "extracted text",
  };
  const responseSchema = registry.getMessage(
    "anthropic.bard.api.v1alpha.PerformActionResponse",
  )!;
  async function submit(inlineAttachments: (typeof good)[]) {
    const body = toBinary(
      schema,
      deepCreate(schema, {
        header: { conversationId: id },
        action: {
          case: "sendMessage",
          value: { text: "inert", inlineAttachments },
        },
      }),
    );
    const req: any = Readable.from([Buffer.from(body)]);
    req.method = "POST";
    req.headers = { "content-type": "application/proto" };
    let status = 0,
      reply: Uint8Array | undefined;
    await inAdapterScope(f.scope, () =>
      createActionRpc(f.ctx, registry)(
        req,
        {
          writeHead: (s: number) => (status = s),
          end: (body: Uint8Array) => {
            reply = body;
          },
        } as any,
        PERFORM_ACTION_PATH,
      ),
    );
    assert.equal(status, 200);
    return (fromBinary(responseSchema, reply!) as any).ack.outcome.case;
  }
  assert.notEqual(
    await submit([
      good,
      { ...good, fileName: "bad.txt", extractedContent: "bad\0text" },
    ]),
    "applied",
  );
  assert.equal(
    f.stored.length,
    0,
    "invalid later file must leave no staged earlier file",
  );
  assert.equal(Boolean(sent), false);
  assert.equal(await submit([good]), "applied");
  assert.equal(f.stored.length, 1);
  assert.equal(f.stored[0].row.name, "report.pdf.extracted.txt");
  assert.deepEqual(sent.attachments, [{ id: "derived-1" }]);
});
