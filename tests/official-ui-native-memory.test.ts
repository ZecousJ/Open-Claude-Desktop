import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerCoworkMemory } from "../electron/official-ui/native/memory";
import { registerMemoryHandlers } from "../electron/ipc/memory";
import { CoworkMemoryFiles } from "../electron/memory/cowork-files";

test("all seven official Cowork memory operations use the real account file handlers", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-native-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = new Map<string, (...args: any[]) => any>();
  const native = new Map<string, (...args: any[]) => any>();
  const settings = { coworkInstructions: "Original" };
  registerMemoryHandlers((name, fn) => local.set(name, fn), {
    store: { root, settings, projects: [], flush() {} },
    onAccountActivated() {},
    onAccountDeactivating() {},
    onEvent() {},
    push() {},
    settingsChanged() {},
  } as never);
  const files = new CoworkMemoryFiles(root);
  assert.equal(files.save("preference.md", "Uses metric"), true);
  registerCoworkMemory({
    ctx: {
      account: () => ({ id: "test" }),
      localCall: async (name: string, ...args: unknown[]) =>
        local.get(name)!(...args),
    },
    on: (name: string, fn: any) => native.set(name, fn),
  } as never);
  const call = (name: string, ...args: unknown[]) =>
    native.get("CoworkMemory." + name)!(...args);
  assert.equal(native.size, 7);
  assert.equal(await call("readGlobalMemory"), "Original");
  assert.equal(await call("writeGlobalMemory", "Updated"), true);
  assert.equal(settings.coworkInstructions, "Updated");
  const list = await call("listAccountMemories", false);
  assert.equal(list.length, 1);
  assert.equal(list[0].content, undefined);
  assert.equal(
    (await call("readAccountMemory", "preference.md")).content,
    "Uses metric",
  );
  assert.equal(
    await call("writeAccountMemory", "preference.md", "Uses concise replies"),
    true,
  );
  assert.equal(
    new CoworkMemoryFiles(root).read("preference.md")!.content,
    "Uses concise replies",
  );
  assert.equal(
    await call(
      "writeAccountMemory",
      "new-file.md",
      "Cannot create through edit",
    ),
    false,
  );
  fs.writeFileSync(path.join(root, "outside.md"), "Outside");
  fs.symlinkSync(
    path.join(root, "outside.md"),
    path.join(files.directory, "linked.md"),
  );
  assert.equal(files.read("linked.md"), null); // Legacy callers retain their permissive read contract.
  await assert.rejects(call("readAccountMemory", "linked.md"), /could not be read/);
  assert.equal(await call("writeAccountMemory", "linked.md", "Changed"), false);
  assert.equal(await call("deleteAccountMemory", "linked.md"), false);
  assert.equal(
    fs.readFileSync(path.join(root, "outside.md"), "utf8"),
    "Outside",
  );
  await assert.rejects(call("listAccountMemories"), /could not be read/);
  fs.unlinkSync(path.join(files.directory, "linked.md"));
  assert.equal(await call("deleteAccountMemory", "preference.md"), true);
  assert.deepEqual(await call("listAccountMemories"), []);
  assert.equal(await call("resetMemories"), true);
  assert.deepEqual(await call("listAccountMemories"), []);
  for (const [name, args] of [
    ["listAccountMemories", ["yes"]],
    ["writeGlobalMemory", [1]],
    ["writeAccountMemory", ["file.md", {}]],
    ["readAccountMemory", [""]],
  ] as const)
    assert.throws(() => call(name, ...args));
});

test("native memory refuses signed-out, restricted or stale account reads", async () => {
  const methods = new Map<string, (...args: any[]) => any>();
  let identity = {};
  let owner: { id: string } | undefined = { id: "one" };
  let release!: (value: string) => void;
  const pending = new Promise<string>((resolve) => (release = resolve));
  const ctx = {
    account: () => owner,
    sessionIdentity: () => identity,
    localCall: () => pending,
    readOnly: false,
  };
  registerCoworkMemory({
    ctx,
    on: (name: string, fn: any) => methods.set(name, fn),
  } as never);
  const read = () => methods.get("CoworkMemory.readGlobalMemory")!();
  const started = read();
  identity = {};
  release("Private");
  await assert.rejects(started, /account changed/);
  owner = undefined;
  assert.throws(read, /Sign in/);
  owner = { id: "two" };
  ctx.readOnly = true;
  assert.throws(read, /not available/);
});
