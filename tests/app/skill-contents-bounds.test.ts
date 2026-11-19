import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSkillContents } from "../../electron/ipc/collections";
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-list-bounds-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skill = path.join(root, "SKILL.md");
  fs.writeFileSync(skill, "---\nname: Test\n---\nBody");
  return { root, skill };
}
test("skill listing explicitly marks unvisited deep directories incomplete", (t) => {
  const f = fixture(t);
  const deep = path.join(f.root, "a/b/c/d/e");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "deep.txt"), "hidden by depth");
  const result = readSkillContents(f.skill);
  assert.equal(result.truncated, true);
  assert.equal(
    result.files.some((x) => x.path.endsWith("deep.txt")),
    false,
  );
});
test("skill listing reports read errors rather than a false complete empty directory", (t) => {
  const f = fixture(t);
  const blocked = path.join(f.root, "blocked");
  fs.mkdirSync(blocked);
  const original = fs.readdirSync;
  t.mock.method(fs, "readdirSync", ((dir: any, ...args: any[]) => {
    if (String(dir) === blocked)
      throw Object.assign(Error("denied"), { code: "EACCES" });
    return (original as any)(dir, ...args);
  }) as any);
  assert.equal(readSkillContents(f.skill).truncated, true);
});
test("oversized markdown is bounded and visibly incomplete; normal visible files remain complete", (t) => {
  const f = fixture(t);
  assert.equal(readSkillContents(f.skill).truncated, false);
  fs.writeFileSync(f.skill, "x".repeat(512 * 1024 + 1));
  const result = readSkillContents(f.skill);
  assert.equal(result.truncated, true);
  assert.equal(result.markdown.length, 512 * 1024);
  assert.equal(result.files[0].bytes, 512 * 1024 + 1);
});
test("hidden entries and symbolic links remain outside the documented visible-file listing", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, ".private"), "hidden");
  fs.symlinkSync(f.skill, path.join(f.root, "alias"));
  const result = readSkillContents(f.skill);
  assert.deepEqual(
    result.files.map((x) => x.path),
    ["SKILL.md"],
  );
  assert.equal(result.truncated, false);
});

test("skill file content reads are bounded and reject outside links", async (t) => {
  const { readSkillFileContents } =
    await import("../../electron/ipc/collections");
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "big.txt"), "y".repeat(256 * 1024 + 1));
  const big = readSkillFileContents(f.skill, "big.txt");
  assert.equal(big.text.length, 256 * 1024);
  assert.equal(big.truncated, true);
  fs.symlinkSync(f.skill, path.join(f.root, "inside.txt"));
  assert.match(readSkillFileContents(f.skill, "inside.txt").text, /name: Test/);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skill-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "secret"), "not permitted");
  fs.symlinkSync(
    path.join(outside, "secret"),
    path.join(f.root, "outside.txt"),
  );
  assert.throws(() => readSkillFileContents(f.skill, "outside.txt"), /outside/);
});
test("a file swapped for a symlink between validation and open is never read", async (t) => {
  const { readSkillFileContents } =
    await import("../../electron/ipc/collections");
  const f = fixture(t);
  const file = path.join(f.root, "value.txt");
  fs.writeFileSync(file, "owned");
  const original = fs.openSync;
  let once = false;
  t.mock.method(fs, "openSync", ((p: any, ...args: any[]) => {
    if (String(p) === file && !once) {
      once = true;
      fs.unlinkSync(file);
      fs.symlinkSync(f.skill, file);
    }
    return (original as any)(p, ...args);
  }) as any);
  assert.throws(() => readSkillFileContents(f.skill, "value.txt"));
});

test("a same-path inode replacement during a file read fails closed", async (t) => {
  const { readSkillFileContents } =
    await import("../../electron/ipc/collections");
  const f = fixture(t);
  const file = path.join(f.root, "value.txt");
  fs.writeFileSync(file, "owned");
  const original = fs.readSync;
  let once = false;
  t.mock.method(fs, "readSync", ((...args: any[]) => {
    const n = (original as any)(...args);
    if (!once) {
      once = true;
      fs.renameSync(file, file + ".old");
      fs.writeFileSync(file, "owned");
    }
    return n;
  }) as any);
  assert.throws(() => readSkillFileContents(f.skill, "value.txt"), /changed/);
});
test("large skill content never uses unbounded readFileSync", async (t) => {
  const { readSkillFileContents } =
    await import("../../electron/ipc/collections");
  const f = fixture(t);
  const file = path.join(f.root, "large.txt");
  fs.writeFileSync(file, "x".repeat(300000));
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((p: any, ...args: any[]) => {
    if (String(p) === file || String(p) === f.skill)
      throw Error("unbounded content read");
    return (original as any)(p, ...args);
  }) as any);
  assert.equal(readSkillContents(f.skill).markdown, "Body");
  assert.equal(readSkillFileContents(f.skill, "large.txt").truncated, true);
});
