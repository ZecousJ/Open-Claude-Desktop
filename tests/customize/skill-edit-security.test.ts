import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useElectronShim } from "../runner/runner-core-support.test";

useElectronShim();
const { registerSkillHandlers } = await import("../../electron/ipc/skills");

test("skill editing is account-bound and refuses a symlinked target", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claudex-skill-edit-")));
  const folder = path.join(root, "codex-home", "skills", "example");
  const skill = path.join(folder, "SKILL.md"), outside = path.join(root, "outside.txt");
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(skill, "before"); fs.writeFileSync(outside, "outside");
  const handlers = new Map<string, (...args: any[]) => any>();
  let currentRoot = root;
  const context = { store: { get root() { return currentRoot; }, settings: {}, flush() {} }, window: undefined,
    engine: { rpc: { call: async () => ({ data: [{ skills: [{ name: "example", path: skill, scope: "user" }] }] }) } } };
  registerSkillHandlers((name, handler) => handlers.set(name, handler), context as never);
  try {
    await handlers.get("editSkill")!(skill, "after");
    assert.equal(fs.readFileSync(skill, "utf8"), "after");
    fs.unlinkSync(skill); fs.symlinkSync(outside, skill);
    await assert.rejects(handlers.get("editSkill")!(skill, "tampered"), /cannot be edited|own files/);
    assert.equal(fs.readFileSync(outside, "utf8"), "outside");
    fs.unlinkSync(skill); fs.writeFileSync(skill, "after");
    let release!: (value: unknown) => void;
    context.engine.rpc.call = async () => new Promise((resolve) => { release = resolve; }) as never;
    const editing = handlers.get("editSkill")!(skill, "wrong account");
    await new Promise((resolve) => setImmediate(resolve));
    currentRoot = path.join(root, "another-account");
    release({ data: [{ skills: [{ name: "example", path: skill, scope: "user" }] }] });
    await assert.rejects(editing, /account changed/);
    assert.equal(fs.readFileSync(skill, "utf8"), "after");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a canonical runtime path can refer to the account's own aliased profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-skill-alias-"));
  const folder = path.join(root, "codex-home", "skills", "example");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "SKILL.md"), "before");
  const skill = fs.realpathSync(path.join(folder, "SKILL.md"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const context = { store: { root, settings: {}, flush() {} }, window: undefined,
    engine: { rpc: { call: async () => ({ data: [{ skills: [{ name: "example", path: skill, scope: "user" }] }] }) } } };
  registerSkillHandlers((name, handler) => handlers.set(name, handler), context as never);
  try {
    await handlers.get("editSkill")!(skill, "after");
    assert.equal(fs.readFileSync(skill, "utf8"), "after");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
