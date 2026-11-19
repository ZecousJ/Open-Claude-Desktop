import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { filesRoute } from "../electron/official-ui/api/files";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  createDocumentPreviewService,
  documentPreviewMaxBytes,
  nativeDocumentPreviewMaxBytes,
} from "../electron/official-ui/document-preview";

const mime =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255]);
test("conversion token route checks the requested organization and desktop capability", async () => {
  let available = true,
    issued = 0;
  const ctx = {
    account: () => ({ id: "document-account" }),
    get documentPreviewToken() {
      return available
        ? () => {
            issued++;
            return "local-token";
          }
        : undefined;
    },
  };
  const server = http.createServer((req, res) => {
    void filesRoute(req, res, req.url!, ctx as never).then((found) => {
      if (!found) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const route =
    "/api/organizations/" +
    organizationUuid("document-account") +
    "/convert_pdf_token";
  try {
    assert.equal((await fetch(base + route)).status, 405);
    assert.equal(
      (
        await fetch(
          base + route.replace(organizationUuid("document-account"), "other"),
          { method: "POST" },
        )
      ).status,
      403,
    );
    assert.equal(issued, 0);
    assert.deepEqual(
      await fetch(base + route, { method: "POST" }).then((r) => r.json()),
      { token: "local-token" },
    );
    available = false;
    assert.equal((await fetch(base + route, { method: "POST" })).status, 503);
  } finally {
    server.close();
  }
});
const request = (token: string, body: Uint8Array = data, type = mime) =>
  new Request("https://www.claudeusercontent.com/api/convert-pdf", {
    method: "POST",
    headers: { "x-convert-pdf-token": token, "content-type": type },
    body: new Uint8Array(body),
  });

test("official conversion requires a live account token, bounds input, and returns original PDF bytes", async () => {
  let session: object | undefined = {};
  let calls = 0;
  const pdf = Buffer.from("%PDF-1.7\nconverted");
  const service = createDocumentPreviewService({
    currentSession: () => session,
    convert: async (bytes, ext) => {
      calls++;
      assert.deepEqual(bytes, Buffer.from(data));
      assert.equal(ext, "docx");
      return pdf;
    },
  });
  const token = service.issueToken();
  assert.equal((await service.handle(request("invalid"))).status, 401);
  assert.equal(
    (await service.handle(request(token, data, "text/html"))).status,
    415,
  );
  assert.equal(
    (
      await service.handle(
        request(token, new Uint8Array(documentPreviewMaxBytes + 1)),
      )
    ).status,
    413,
  );
  assert.equal(
    (await service.handle(request(token, new Uint8Array([0, 1, 2, 3])))).status,
    422,
  );
  assert.equal(calls, 0);
  const response = await service.handle(request(token));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf);
  session = {};
  assert.equal((await service.handle(request(token))).status, 401);
  session = undefined;
  assert.throws(() => service.issueToken(), /Sign in/);
});

test("the native Files converter accepts documents larger than the Web conversion limit", async () => {
  const session = {};
  const pdf = Buffer.from("%PDF-1.7\nconverted");
  const document = new Uint8Array(documentPreviewMaxBytes + 1);
  document.set(data);
  const service = createDocumentPreviewService({
    currentSession: () => session,
    maxBytes: nativeDocumentPreviewMaxBytes,
    convert: async (bytes) => {
      assert.equal(bytes.length, document.length);
      return pdf;
    },
  });
  const token = service.issueToken();
  const converted = await service.handle(request(token, document));
  assert.equal(converted.status, 200);
  assert.deepEqual(Buffer.from(await converted.arrayBuffer()), pdf);
  const oversized = request(token);
  oversized.headers.set("Content-Length", String(nativeDocumentPreviewMaxBytes + 1));
  assert.equal((await service.handle(oversized)).status, 413);
});

test("conversion never returns a prior account's result and failures release capacity", async () => {
  let session: object = {};
  let release: () => void = () => {};
  const service = createDocumentPreviewService({
    currentSession: () => session,
    convert: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Buffer.from("%PDF-1.7");
    },
  });
  const pending = service.handle(request(service.issueToken()));
  await new Promise((resolve) => setImmediate(resolve));
  session = {};
  release();
  assert.equal((await pending).status, 401);
  const failing = createDocumentPreviewService({
    currentSession: () => session,
    convert: async () => {
      throw Error("private path must not leak");
    },
  });
  for (let i = 0; i < 4; i++) {
    const response = await failing.handle(request(failing.issueToken()));
    assert.equal(response.status, 422);
    assert.ok(!(await response.text()).includes("private path"));
  }
});
