import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeUpload } from "../electron/official-ui/api/files";
import { inAdapterScope, newAdapterScope } from "../electron/official-ui/api/scope";
import { storeAttachment } from "../electron/engine/composer-files";
import { openPolicy } from "../shared/client-policy";

function fixture(t: any, size: () => unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-size-await-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scope = newAdapterScope("synthetic-image-size");
  let identity: unknown = {}, writes = 0;
  const ctx: any = {
    account: () => ({ id: "synthetic-image-size" }), sessionIdentity: () => identity,
    stateDirectory: () => root, image: { size },
    call: async (method: string, name: string, bytes: Uint8Array) => {
      assert.equal(method, "addAttachmentData"); writes++;
      return storeAttachment(path.join(root, "attachments"), name, bytes, openPolicy);
    },
  };
  return {
    run: (data = Buffer.from("synthetic-image-bytes")) => inAdapterScope(scope, () => storeUpload(ctx, "self.gif", data)),
    retire: () => { identity = {}; }, get writes() { return writes; },
  };
}

test("upload waits for asynchronous image decode before writing and records dimensions", async t => {
  let release!: (size: { width: number; height: number }) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = f.run();
  assert.equal(f.writes, 0);
  release({ width: 37, height: 23 });
  const image = await pending;
  assert.equal(f.writes, 1);
  assert.equal(image.width, 37); assert.equal(image.height, 23);
  assert.equal(image.mediaType, "image/gif");
});

test("retirement during image decoding rejects before storage", async t => {
  let release!: (size: { width: number; height: number }) => void;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = f.run(); f.retire(); release({ width: 37, height: 23 });
  await assert.rejects(pending, (error: any) => error.status === 409);
  assert.equal(f.writes, 0);
});

test("failed asynchronous image decoding rejects before storage", async t => {
  for (const size of [undefined, { width: 0, height: 23 }, { width: 37.5, height: 23 }]) {
    const f = fixture(t, async () => size);
    await assert.rejects(f.run(), (error: any) => error.status === 400);
    assert.equal(f.writes, 0);
  }
});

test("synchronous image adapters remain supported", async t => {
  const f = fixture(t, () => ({ width: 37, height: 23 }));
  const image = await f.run(); assert.equal(image.width, 37); assert.equal(f.writes, 1);
});

test("oversized image is refused before decoder or storage", async t => {
  let decodes = 0;
  const f = fixture(t, async () => { decodes++; return { width: 37, height: 23 }; });
  await assert.rejects(f.run(Buffer.alloc(20 * 1024 * 1024 + 1)), (error: any) => error.status === 413);
  assert.equal(decodes, 0); assert.equal(f.writes, 0);
});
