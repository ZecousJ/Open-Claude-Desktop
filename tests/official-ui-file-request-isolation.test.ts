/** Local streams and real attachment bytes in temporary synthetic profiles only. */
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeAttachment } from "../electron/engine/composer-files";
import { openPolicy } from "../shared/client-policy";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { filesRoute, knownFile } from "../electron/official-ui/api/files";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-request-isolation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let storedId = "not-stored";
  let generation = 1,
    calls = 0,
    status = 0,
    result = "",
    retireOnStore = false;
  const req: any = Object.assign(new EventEmitter(), {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=bound" },
  });
  const scope = newAdapterScope("owner");
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => generation,
    stateDirectory: () => root,
    loadConversation: async () => undefined,
    call: async (method: string, name: string, data: Uint8Array) => {
      assert.equal(method, "addAttachmentData");
      calls++;
      const stored = storeAttachment(path.join(root, "attachments"), name, data, openPolicy);
      storedId = stored.id;
      if (retireOnStore) generation++;
      return stored;
    },
  };
  const res: any = {
    writeHead: (n: number) => {
      status = n;
    },
    end: (s: string) => {
      result = s;
    },
  };
  return {
    req,
    ctx,
    get status() {
      return status;
    },
    get calls() {
      return calls;
    },
    get result() {
      return result;
    },
    retire: () => generation++,
    retireOnStore: () => {
      retireOnStore = true;
    },
    known: () => inAdapterScope(scope, () => knownFile(storedId)),
    run: (suffix = "upload", org = organizationUuid("owner")) =>
      inAdapterScope(scope, () =>
        filesRoute(
          req as http.IncomingMessage,
          res,
          suffix === "upload"
            ? `/api/${org}/upload`
            : `/api/organizations/${org}/${suffix}`,
          ctx,
        ),
      ),
    body: (type = "text/plain", text = "hello 中文") => {
      req.emit(
        "data",
        Buffer.from(
          `--bound\r\nContent-Disposition: form-data; name="file"; filename="test.txt"\r\nContent-Type: ${type}\r\n\r\n${text}\r\n--bound--\r\n`,
        ),
      );
      req.emit("end");
    },
  };
}
test("foreign organization, unknown session and readonly uploads make zero writes", async (t) => {
  const foreign = fixture(t);
  await foreign.run("upload", "foreign");
  assert.equal(foreign.status, 403);
  assert.equal(foreign.calls, 0);
  const unknown = fixture(t);
  await unknown.run("conversations/missing/wiggle/upload-file");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.calls, 0);
  const readonly = fixture(t);
  readonly.ctx.readOnly = true;
  await readonly.run();
  assert.equal(readonly.status, 501);
  assert.equal(readonly.calls, 0);
});
test("declared oversized upload and old activation body do not reach attachment service", async (t) => {
  const big = fixture(t);
  big.req.headers["content-length"] = String(64 * 1024 * 1024 + 65537);
  await big.run();
  assert.equal(big.status, 413);
  assert.equal(big.calls, 0);
  big.req.emit("end");
  const stale = fixture(t),
    pending = stale.run();
  stale.retire();
  stale.body();
  await pending;
  assert.equal(stale.status, 409);
  assert.equal(stale.calls, 0);
});
test("successful owned upload records metadata but late service completion cannot publish it", async (t) => {
  const good = fixture(t),
    p = good.run();
  good.body();
  await p;
  assert.equal(good.status, 200);
  assert.equal(good.calls, 1);
  assert.equal(good.known()?.name, "test.txt");
  const stale = fixture(t);
  stale.retireOnStore();
  const late = stale.run();
  stale.body();
  await late;
  assert.equal(stale.status, 409);
  assert.equal(stale.known(), undefined);
});
test("document conversion accepts genuine text, not binary passed through as UTF8", async (t) => {
  const good = fixture(t),
    p = good.run("convert_document");
  good.body();
  await p;
  assert.equal(good.status, 200);
  assert.equal(JSON.parse(good.result).extracted_content, "hello 中文");
  const binary = fixture(t),
    q = binary.run("convert_document");
  binary.body("application/pdf", "%PDF inert");
  await q;
  assert.equal(binary.status, 415);
  assert.equal(binary.calls, 0);
  const nul = fixture(t),
    r = nul.run("convert_document");
  nul.body("text/plain", "bad\0binary");
  await r;
  assert.equal(nul.status, 400);
});

test("readonly text transformation remains a pure read while upload is denied", async (t) => {
  const f = fixture(t);
  f.ctx.readOnly = true;
  const done = f.run("convert_document");
  f.body();
  await done;
  assert.equal(f.status, 200);
  assert.equal(f.calls, 0);
});
