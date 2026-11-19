import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoworkMemoryFiles } from "../electron/memory/cowork-files";
import { registerMemoryHandlers } from "../electron/ipc/memory";
import test from "node:test";
import assert from "node:assert/strict";
import { registerCoworkMemory } from "../electron/official-ui/native/memory";
function setup() {
  const handlers = new Map<string, any>(), calls: any[] = [];
  let identity = 1, active = true;
  let source: any = async () => true;
  registerCoworkMemory({ ctx: { account: () => ({ id: "a" }), sessionIdentity: () => identity, isCurrent: () => active,
    localCall: (name: string, ...args: any[]) => { calls.push([name, ...args]); return source(name, ...args); } },
    on: (name: string, fn: any) => handlers.set(name, fn) } as never);
  return { calls, call: (name: string, ...args: any[]) => handlers.get("CoworkMemory." + name)(...args),
    source: (fn: any) => source = fn, retire: () => active = false, reactivate: () => identity++ };
}
test("memory mutation rejects path aliases/reserved index and UTF8 byte overflow before backend", () => {
  const h = setup();
  for (const name of ["../real.md", "/real.md", "a/real.md", "a\\real.md", "MEMORY.md", "bad\0.md", "bad\n.md"])
    for (const method of ["readAccountMemory", "writeAccountMemory", "deleteAccountMemory"])
      assert.throws(() => h.call(method, name, "replacement"));
  assert.throws(() => h.call("writeAccountMemory", "real.md", "中".repeat(100000)), /byte limit/);
  assert.equal(h.calls.length, 0);
});
test("memory source must return exact valid rows/identity and boolean mutation acknowledgements", async () => {
  const h = setup();
  for (const row of [{ path: "../wrong.md", content: "x", updatedAt: new Date().toISOString() },
    { path: "other.md", content: "x", updatedAt: new Date().toISOString() },
    { path: "a.md", updatedAt: new Date().toISOString() }]) {
    h.source(async () => row); await assert.rejects(h.call("readAccountMemory", "a.md"));
  }
  h.source(async () => undefined); await assert.rejects(h.call("writeAccountMemory", "a.md", "x"));
  h.source(async () => false); assert.equal(await h.call("deleteAccountMemory", "a.md"), false);
  const row = { path: "a.md", content: "x", updatedAt: new Date().toISOString() };
  h.source(async () => [row, row]); await assert.rejects(h.call("listAccountMemories"), /inventory/);
  h.source(async () => [{ path: "a.md", updatedAt: row.updatedAt }]);
  await assert.rejects(h.call("listAccountMemories"), /content/);
  assert.equal((await h.call("listAccountMemories", false)).length, 1);
});
test("retired late memory read rejects and cannot invoke new mutations", async () => {
  const h = setup(); let done!: (x: any) => void;
  h.source(() => new Promise(r => done = r)); const pending = h.call("readGlobalMemory");
  h.retire(); done("private"); await assert.rejects(pending, /retired/);
  assert.throws(() => h.call("resetMemories"), /retired/); assert.equal(h.calls.length, 1);
});
test("memory mutation lease rejects overlap and old activation finally cannot unlock new mutation", async () => {
  const h = setup(); const releases: ((x: any) => void)[] = [];
  h.source(() => new Promise(r => releases.push(r)));
  const first = h.call("writeAccountMemory", "a.md", "one");
  await assert.rejects(h.call("resetMemories"), /pending/);
  h.reactivate(); const second = h.call("writeAccountMemory", "a.md", "two");
  releases[0](true); await assert.rejects(first, /account changed/);
  await assert.rejects(h.call("resetMemories"), /pending/);
  releases[1](true); assert.equal(await second, true);
  h.source(async () => true); assert.equal(await h.call("resetMemories"), true);
});
test("strict file reads distinguish missing from invalid encoding/oversize, legacy behavior unchanged", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-strict-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new CoworkMemoryFiles(root); files.save("a.md", "hello");
  assert.equal(files.read("missing.md", true), null);
  fs.writeFileSync(path.join(files.directory, "bad.md"), Buffer.from([0xff]));
  assert.throws(() => files.read("bad.md", true), /could not be read/);
  assert.ok(files.read("bad.md"));
  fs.writeFileSync(path.join(files.directory, "big.md"), "x".repeat(262145));
  assert.throws(() => files.read("big.md", true), /could not be read/);
  assert.equal(files.read("big.md"), null);
  assert.throws(() => files.list(true, true), /could not be read/);
});
test("strict reset preflights all account/project stores and does not remove anything on known invalid directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-reset-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new CoworkMemoryFiles(root); files.save("keep.md", "keep");
  const project = new CoworkMemoryFiles(root, "p"); project.save("keep.md", "project");
  fs.rmSync(project.directory, { recursive: true }); fs.symlinkSync(files.directory, project.directory);
  const methods = new Map<string, any>();
  registerMemoryHandlers((name, fn) => methods.set(name, fn), { store: { root, projects: [{ id: "p" }], settings: {} },
    onAccountActivated() {}, onAccountDeactivating() {}, onEvent() {}, push() {} } as never);
  assert.throws(() => methods.get("resetMemories")({ strict: true }), /regular directory/);
  assert.equal(files.read("keep.md")?.content, "keep");
  fs.unlinkSync(project.directory);
  assert.equal(methods.get("resetMemories")({ strict: true }), true);
  assert.deepEqual(files.list(), []); assert.deepEqual(project.list(), []);
});
test("strict reset reports partial execution failure rather than successful account-only reset", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-partial-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new CoworkMemoryFiles(root); files.save("a.md", "account");
  const project = new CoworkMemoryFiles(root, "p"); project.save("p.md", "project");
  const reset = CoworkMemoryFiles.prototype.reset;
  t.mock.method(CoworkMemoryFiles.prototype, "reset", function(this: CoworkMemoryFiles, strict?: boolean) {
    if (this.directory === project.directory) throw Error("simulated project reset failure");
    return reset.call(this, strict);
  });
  const methods = new Map<string, any>();
  registerMemoryHandlers((name, fn) => methods.set(name, fn), { store: { root, projects: [{ id: "p" }], settings: {} },
    onAccountActivated() {}, onAccountDeactivating() {}, onEvent() {}, push() {} } as never);
  assert.throws(() => methods.get("resetMemories")({ strict: true }), /incomplete; some files may already/);
  assert.equal(files.read("a.md"), null); assert.equal(project.read("p.md")?.content, "project");
});
