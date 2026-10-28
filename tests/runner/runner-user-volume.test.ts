import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DiskQuota, QuotaStatus } from "../../runner/src/sandbox/quota";
import { prepareUserVolume } from "../../runner/src/user-volume";

/** A volume stand-in: "mounting" hides what was in the folder, as mount does. */
function fakeQuota(opts: { failMount?: boolean } = {}) {
  const mounted = new Set<string>();
  const hidden = new Map<string, string>();
  const calls: string[] = [];
  const status = (mb: number): QuotaStatus => ({
    mode: "loop",
    limitBytes: mb * 1024 * 1024,
    usedBytes: 0,
    exceeded: false,
  });
  const quota: DiskQuota = {
    mode: "loop",
    prepare(dir, mb) {
      calls.push(`prepare ${path.basename(dir)}`);
      fs.mkdirSync(dir, { recursive: true });
      if (mounted.has(dir)) return status(mb);
      if (fs.readdirSync(dir).length)
        throw new Error(
          `${dir} is not empty; restore data after the quota volume is mounted.`,
        );
      if (opts.failMount) throw new Error("mount failed");
      mounted.add(dir);
      return status(mb);
    },
    status: (_dir, mb) => status(mb),
    release(dir) {
      calls.push(`release ${path.basename(dir)}`);
      mounted.delete(dir);
      hidden.delete(dir);
    },
  };
  return { quota, mounted, calls };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "uvol-"));

test("a user's existing data moves into their new volume", async () => {
  const root = tmp();
  const profile = path.join(root, "users", "7", "profile");
  fs.mkdirSync(path.join(profile, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(profile, "workspace", "notes.md"), "keep me");
  fs.symlinkSync("workspace/notes.md", path.join(profile, "link"));
  const { quota, mounted } = fakeQuota();
  await prepareUserVolume(quota, profile, 100);
  assert.ok(mounted.has(profile));
  assert.equal(
    fs.readFileSync(path.join(profile, "workspace", "notes.md"), "utf8"),
    "keep me",
  );
  assert.equal(
    fs.readlinkSync(path.join(profile, "link")),
    "workspace/notes.md",
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(profile)),
    ["profile"],
    "nothing left aside",
  );
  // Again: mounted already, prepared in place.
  await prepareUserVolume(quota, profile, 100);
});

test("a new user gets an empty volume; two tabs prepare it once", async () => {
  const root = tmp();
  const profile = path.join(root, "users", "8", "profile");
  const { quota, calls } = fakeQuota();
  await Promise.all([
    prepareUserVolume(quota, profile, 100),
    prepareUserVolume(quota, profile, 100),
  ]);
  assert.deepEqual(calls, ["prepare profile"]);
});

test("a failed volume puts the data back as it was", async () => {
  const root = tmp();
  const profile = path.join(root, "users", "9", "profile");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "store.json"), "{}");
  const { quota } = fakeQuota({ failMount: true });
  await assert.rejects(prepareUserVolume(quota, profile, 100), /mount failed/);
  assert.equal(fs.readFileSync(path.join(profile, "store.json"), "utf8"), "{}");
  assert.deepEqual(fs.readdirSync(path.dirname(profile)), ["profile"]);
});
