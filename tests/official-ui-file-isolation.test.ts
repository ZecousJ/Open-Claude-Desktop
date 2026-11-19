import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createApiAdapter } from "../electron/official-ui/api/index";
import { organizationUuid } from "../electron/official-ui/api/context";

test("scoped adapter does not serve another account's uploaded file", async () => {
  const previous = process.env.CLAUDEX_OFFICIAL_SCOPED_STATE;
  process.env.CLAUDEX_OFFICIAL_SCOPED_STATE = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-file-isolation-"));
  const file = path.join(root, "attachments", "account-a-file", "private.txt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "Account A private test data");
  const context = (id: string) => ({
    root: path.resolve("build/official-ui"), stateDirectory: () => root, sessionIdentity: () => id,
    account: () => ({ id, email: `${id}@example.invalid`, name: id }),
    call: async (method: string) => {
      if (method !== "addAttachmentData") throw Error(`Unexpected ${method}`);
      return { id: "account-a-file", name: "private.txt", path: file, size: Buffer.byteLength("Account A private test data"), kind: "text" };
    },
    log() {},
  });
  const a = createApiAdapter(context("a") as never), b = createApiAdapter(context("b") as never);
  const server = http.createServer((req, res) => {
    void (req.headers["x-test-account"] === "a" ? a(req, res) : b(req, res)).then((handled) => {
      if (!handled && !res.writableEnded) { res.statusCode = 404; res.end(); }
    }).catch((error) => { res.statusCode = 500; res.end(String(error)); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    const body = new FormData();
    body.append("file", new Blob(["Account A private test data"], { type: "text/plain" }), "private.txt");
    const upload = await fetch(`${base}/api/${organizationUuid("a")}/upload`, { method: "POST", headers: { "x-test-account": "a" }, body });
    assert.equal(upload.status, 200);
    const row = await upload.json() as { file_uuid: string };
    const other = await fetch(`${base}/api/${organizationUuid("b")}/files/${row.file_uuid}/contents`, { headers: { "x-test-account": "b" } });
    assert.equal(other.status, 404);
    const own = await fetch(`${base}/api/${organizationUuid("a")}/files/${row.file_uuid}/contents`, { headers: { "x-test-account": "a" } });
    assert.equal(own.status, 200);
    assert.equal(await own.text(), "Account A private test data");
    const forgedOrg = await fetch(`${base}/api/${organizationUuid("a")}/files/${row.file_uuid}/contents`, { headers: { "x-test-account": "b" } });
    assert.equal(forgedOrg.status, 403);
  } finally {
    server.close();
    // Wait for the adapter's delayed persistence before deleting its own temp root.
    await new Promise((resolve) => setTimeout(resolve, 650));
    fs.rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CLAUDEX_OFFICIAL_SCOPED_STATE;
    else process.env.CLAUDEX_OFFICIAL_SCOPED_STATE = previous;
  }
});

test("signed-out bootstrap does not read an unavailable account profile directory", async () => {
  const previous = process.env.CLAUDEX_OFFICIAL_SCOPED_STATE;
  process.env.CLAUDEX_OFFICIAL_SCOPED_STATE = "1";
  const adapter = createApiAdapter({ root: path.resolve("build/official-ui"), account: () => undefined,
    sessionIdentity: () => undefined, stateDirectory: () => { throw Error("No profile while signed out"); }, log() {} } as never);
  const server = http.createServer((req, res) => { void adapter(req, res).catch((error) => { res.statusCode = 500; res.end(String(error)); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const { port } = server.address() as { port: number };
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/account`)).status, 401);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.CLAUDEX_OFFICIAL_SCOPED_STATE; else process.env.CLAUDEX_OFFICIAL_SCOPED_STATE = previous;
  }
});
