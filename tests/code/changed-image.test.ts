import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedImage } from "../../electron/artifacts/changed-image";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const png = (byte: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, byte]);

test("View image reads the before and after of an image file", async (t) => {
  const repo = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "claudex-img-")),
  );
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  fs.writeFileSync(path.join(repo, "logo.png"), png(1));
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "one");
  fs.writeFileSync(path.join(repo, "logo.png"), png(2));
  const scope = { kind: "uncommitted" as const };
  const before = await changedImage(repo, "logo.png", "before", scope);
  const after = await changedImage(repo, "logo.png", "after", scope);
  assert.equal(before, `data:image/png;base64,${png(1).toString("base64")}`);
  assert.equal(after, `data:image/png;base64,${png(2).toString("base64")}`);
  // Not an image, outside the folder, or missing: nothing.
  assert.equal(await changedImage(repo, "notes.txt", "after", scope), null);
  assert.equal(await changedImage(repo, "../x.png", "after", scope), null);
  assert.equal(await changedImage(repo, "gone.png", "before", scope), null);
});
