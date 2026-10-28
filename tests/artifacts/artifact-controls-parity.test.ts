import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { ArtifactData } from "../../electron/artifacts/artifact-data";
import { artifactDownloadGuard } from "../../electron/artifacts/artifact-download";
import {
  artifactDownloadError,
  artifactDownloadLimit,
} from "../../shared/artifact-download";
import {
  artifactDataMessage,
  artifactDataResult,
} from "../../shared/artifact-data";
import { htmlDocument } from "../../src/artifacts/preview-document";
import { webMethodKind } from "../../shared/web-bridge-methods";

test("native downloads reject oversized and concurrent requests and release the dialog guard", async () => {
  const download = artifactDownloadGuard();
  let finish!: (value: string | null) => void;
  const pending = download(
    1,
    () =>
      new Promise<string | null>((resolve) => {
        finish = resolve;
      }),
  );
  await assert.rejects(
    download(1, async () => "other"),
    /busy/,
  );
  finish(null);
  assert.equal(await pending, null);
  await assert.rejects(
    download(artifactDownloadLimit + 1, async () => "large"),
    /too_large/,
  );
  await assert.rejects(
    download(1, async () => {
      throw new Error("disk full");
    }),
    /disk full/,
  );
  assert.equal(
    await download(artifactDownloadLimit, async () => "saved"),
    "saved",
  );
  assert.equal(
    artifactDownloadError(new Error("too_large")),
    "This artifact is too large to download.",
  );
  assert.equal(
    artifactDownloadError(new Error("busy")),
    "Couldn’t download while a dialog is open. Close it and try again.",
  );
  assert.equal(
    artifactDownloadError(new Error("disk full")),
    "Couldn’t download this artifact. Try again.",
  );
  assert.equal(artifactDownloadError(new Error("declined")), null);
  assert.equal(artifactDownloadError(new Error("unbound")), null);
});

test("artifact data persists across store instances and stays scoped to account and artifact", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-data-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactData(root);
  assert.equal(store.usage("one").bytes, 0);
  assert.deepEqual(
    store.request("one", { method: "set", key: "__proto__", value: "saved" }),
    { key: "__proto__", value: "saved" },
  );
  store.request("one", { method: "set", key: "notes/1", value: "hello" });
  assert.deepEqual(
    new ArtifactData(root).request("one", { method: "get", key: "__proto__" }),
    { key: "__proto__", value: "saved" },
  );
  assert.equal(store.request("two", { method: "get", key: "notes/1" }), null);
  assert.equal(
    new ArtifactData(path.join(root, "another-account")).request("one", {
      method: "get",
      key: "notes/1",
    }),
    null,
  );
  assert.deepEqual(store.request("one", { method: "list", prefix: "notes/" }), {
    keys: ["notes/1"],
    prefix: "notes/",
  });
  const before = store.usage("one");
  assert.throws(
    () =>
      store.request("one", {
        method: "set",
        key: "big",
        value: "x".repeat(before.maxBytes),
      }),
    /Artifact storage limit reached/,
  );
  assert.deepEqual(store.usage("one"), before);
  assert.throws(() => store.request("one", { method: "run", sql: "anything" }));
  assert.deepEqual(store.request("one", { method: "delete", key: "notes/1" }), {
    key: "notes/1",
    deleted: true,
  });
  assert.equal(webMethodKind("artifactData"), "remote-runner");
  assert.equal(webMethodKind("artifactDataUsage"), "remote-runner");
  assert.equal(webMethodKind("requestArtifactStorageLimit"), "remote-runner");
  assert.equal(webMethodKind("setArtifactShareAccess"), "remote-runner");
});

test("sandbox storage accepts only its parent replies and forwards validated operations to the account host", async () => {
  const scripts = [
    ...htmlDocument("<p>Storage</p>").matchAll(/<script>([\s\S]*?)<\/script>/g),
  ];
  const script = scripts.find((match) =>
    match[1].includes("window.storage="),
  )![1];
  let listener!: (event: unknown) => void;
  const sent: any[] = [];
  const parent = { postMessage: (message: unknown) => sent.push(message) };
  const window: any = {};
  vm.runInNewContext(script, {
    window,
    parent,
    Map,
    Error,
    setTimeout,
    clearTimeout,
    addEventListener: (_: string, callback: typeof listener) => {
      listener = callback;
    },
  });
  const pending = window.storage.set("notes", "hello");
  assert.equal(sent[0].type, artifactDataMessage);
  assert.deepEqual(JSON.parse(JSON.stringify(sent[0].request)), {
    method: "set",
    key: "notes",
    value: "hello",
  });
  listener({
    source: {},
    data: { type: artifactDataResult, id: sent[0].id, error: "spoof" },
  });
  listener({
    source: parent,
    data: {
      type: artifactDataResult,
      id: sent[0].id,
      result: { key: "notes", value: "hello" },
    },
  });
  assert.deepEqual(await pending, { key: "notes", value: "hello" });
  const file = window.storage.files.set("photo.png", "image-data");
  assert.deepEqual(JSON.parse(JSON.stringify(sent[1].request)), {
    method: "set",
    resource: "files",
    key: "photo.png",
    value: "image-data",
  });
  listener({
    source: parent,
    data: {
      type: artifactDataResult,
      id: sent[1].id,
      result: { key: "photo.png", value: "image-data" },
    },
  });
  assert.deepEqual(await file, { key: "photo.png", value: "image-data" });
});
