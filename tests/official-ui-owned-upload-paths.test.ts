/** Real files under a synthetic parent alias; no account, model or network. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { filesRoute, storeUpload } from "../electron/official-ui/api/files";
import { organizationUuid } from "../electron/official-ui/api/context";
import {
  newAdapterScope,
  inAdapterScope,
} from "../electron/official-ui/api/scope";

function fixture(t: any) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "owned-upload-path-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const parent = path.join(temp, "real"),
    alias = path.join(temp, "alias");
  fs.mkdirSync(parent);
  fs.symlinkSync(
    parent,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const root = path.join(alias, "profile");
  fs.mkdirSync(root);
  let identity = {},
    owner = "synthetic-owner",
    uploads = 0;
  const scope = newAdapterScope(owner);
  const ctx: any = {
    account: () => ({ id: owner }),
    sessionIdentity: () => identity,
    stateDirectory: () => root,
    isCurrent: () => true,
    call: async (method: string, name: string, data: Uint8Array) => {
      assert.equal(method, "addAttachmentData");
      const id = `file-${++uploads}`,
        file = path.join(root, "attachments", id, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
      return { id, name, path: file, size: data.byteLength, kind: "text" };
    },
  };
  const run = <T>(fn: () => T) => inAdapterScope(scope, fn);
  const upload = () =>
    run(() =>
      storeUpload(ctx, "owned.txt", new TextEncoder().encode("original")),
    );
  const read = async (id: string) => {
    let status = 0,
      body: any;
    await run(() =>
      filesRoute(
        { method: "GET" } as any,
        {
          writeHead(s: number) {
            status = s;
          },
          end(b: any) {
            body = b;
          },
        } as any,
        `/api/${organizationUuid(owner)}/files/${id}/contents`,
        ctx,
      ),
    );
    return { status, body };
  };
  return {
    temp,
    parent,
    alias,
    root,
    upload,
    read,
    reactivate() {
      identity = {};
    },
    switchAccount() {
      owner = "other";
    },
  };
}

test("a stable parent alias permits owned upload and exact byte read", async (t) => {
  const f = fixture(t);
  assert.notEqual(fs.realpathSync(f.root), f.root);
  const file = await f.upload();
  const result = await f.read(file.id);
  assert.equal(result.status, 200);
  assert.equal(result.body.toString(), "original");
});

test("retargeting the parent alias cannot replace an already verified upload root", async (t) => {
  const f = fixture(t),
    file = await f.upload();
  const other = path.join(f.temp, "other");
  const target = path.join(other, "profile", "attachments", file.id, file.name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "original"); // Even identical bytes do not authorize a different store.
  fs.unlinkSync(f.alias);
  fs.symlinkSync(
    other,
    f.alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await f.read(file.id);
  assert.equal(result.status, 503);
  assert.doesNotMatch(String(result.body), /original/);
});

test("replaced directories, linked attachment files, and changed same-size bytes remain refused", async (t) => {
  for (const scenario of ["directory", "file-link", "bytes"]) {
    const f = fixture(t),
      file = await f.upload();
    const filePath = file.path;
    assert.ok(filePath);
    if (scenario === "directory") {
      const dir = path.dirname(filePath);
      fs.renameSync(dir, dir + "-old");
      fs.mkdirSync(dir);
      fs.writeFileSync(filePath, "original");
    } else if (scenario === "file-link") {
      const outside = path.join(f.temp, "outside.txt");
      fs.writeFileSync(outside, "original");
      fs.unlinkSync(filePath);
      fs.symlinkSync(outside, filePath);
    } else fs.writeFileSync(filePath, "modified");
    const result = await f.read(file.id);
    assert.equal(result.status, 503, scenario);
    assert.doesNotMatch(String(result.body), /original|modified/);
  }
});

test("alias support never retains read authority after account or activation changes", async (t) => {
  for (const change of ["reactivate", "switchAccount"] as const) {
    const f = fixture(t),
      file = await f.upload();
    f[change]();
    const result = await f.read(file.id);
    assert.equal(result.status, 409);
    assert.doesNotMatch(String(result.body), /original/);
  }
});
