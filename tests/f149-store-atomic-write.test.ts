import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Store } from "../electron/store/store";

test("Windows transient rename contention still commits the complete history", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.write("conversations.json", [{ title: "before" }]);
  const rename = fs.renameSync;
  let failures = 0;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to).endsWith("conversations.json") && failures++ < 2) {
      assert.deepEqual(JSON.parse(fs.readFileSync(to, "utf8")), [{ title: "before" }]);
      throw Object.assign(new Error("file is busy"), { code: "EPERM" });
    }
    rename(from, to);
  });
  store.write("conversations.json", [{ title: "after" }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "conversations.json"), "utf8")), [{ title: "after" }]);
  assert.equal(failures, 3);
});

test("exhausted Windows contention preserves history and direct writes throw", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.write("conversations.json", [{ title: "before" }]);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let attempts = 0;
  t.mock.method(fs, "renameSync", () => {
    attempts++;
    throw Object.assign(new Error("file is busy"), { code: "EBUSY" });
  });
  assert.throws(() => store.write("conversations.json", [{ title: "after" }]), /file is busy/);
  assert.equal(attempts, 6);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "conversations.json"), "utf8")), [{ title: "before" }]);
});

test("a failed scheduled flush reports the error and retries current state without another schedule", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.flush();
  const rename = fs.renameSync;
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let blocked = true;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (blocked && String(to).endsWith("conversations.json")) throw Object.assign(new Error("save failed"), { code: "EPERM" });
    rename(from, to);
  });
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { errors.push(args); });
  store.settings.name = "first";
  store.schedule();
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(errors.length, 1);
  blocked = false;
  store.settings.name = "latest";
  await new Promise(resolve => setTimeout(resolve, 1150));
  assert.equal(new Store(root).settings.name, "latest");
});

test("unrelated rename errors are not retried", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "store-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let attempts = 0;
  t.mock.method(fs, "renameSync", () => {
    attempts++;
    throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
  });
  assert.throws(() => store.write("conversations.json", []), /disk full/);
  assert.equal(attempts, 1);
});
