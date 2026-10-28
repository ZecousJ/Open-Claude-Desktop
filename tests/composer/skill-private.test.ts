import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSkillPathPrivate,
  assertSkillsFolderPrivate,
} from "../../electron/skills/skill-private";

function profile() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-skills-"));
  const mine = path.join(base, "users", "1", "profile");
  const other = path.join(base, "users", "2", "profile");
  for (const dir of [mine, other])
    fs.mkdirSync(path.join(dir, "codex-home", "skills", "notes"), {
      recursive: true,
    });
  fs.writeFileSync(
    path.join(other, "codex-home", "skills", "notes", "SKILL.md"),
    "secret of user 2",
  );
  fs.writeFileSync(
    path.join(mine, "codex-home", "skills", "notes", "SKILL.md"),
    "mine",
  );
  return { base, mine, other };
}
const web = (root: string) => ({ store: { root }, window: undefined });
const desktop = (root: string) => ({ store: { root }, window: {} });

test("on the web a skill must be inside the user's own profile", () => {
  const { base, mine, other } = profile();
  try {
    const own = path.join(mine, "codex-home", "skills", "notes", "SKILL.md");
    assert.doesNotThrow(() => assertSkillPathPrivate(web(mine), own));
    assert.throws(
      () =>
        assertSkillPathPrivate(
          web(mine),
          path.join(other, "codex-home", "skills", "notes", "SKILL.md"),
        ),
      /own files/,
    );
    // The agent swaps the skills folder for a link into another user's.
    fs.rmSync(path.join(mine, "codex-home", "skills"), { recursive: true });
    fs.symlinkSync(
      path.join(other, "codex-home", "skills"),
      path.join(mine, "codex-home", "skills"),
    );
    const through = path.join(
      mine,
      "codex-home",
      "skills",
      "notes",
      "SKILL.md",
    );
    assert.throws(
      () => assertSkillPathPrivate(web(mine), through),
      /own files/,
    );
    assert.throws(() => assertSkillsFolderPrivate(web(mine)), /can't be used/);
    // The desktop trusts its one user's file system.
    assert.doesNotThrow(() => assertSkillPathPrivate(desktop(mine), through));
    assert.doesNotThrow(() => assertSkillsFolderPrivate(desktop(mine)));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a missing skills folder is fine: it is created later, as a real folder", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-skills-"));
  try {
    fs.mkdirSync(path.join(base, "codex-home"));
    assert.doesNotThrow(() => assertSkillsFolderPrivate(web(base)));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
