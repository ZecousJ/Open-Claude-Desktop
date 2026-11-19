import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installOfficialUi } from "../scripts/official-ui-install.mjs";

test("a failed second tree installation restores both previous trees", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-install-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const build = path.join(root, "build"), stage = path.join(build, "stage");
  fs.mkdirSync(stage, { recursive: true });
  for (const name of ["official-ui", "official-usercontent"]) {
    fs.writeFileSync(path.join(build, name), "old-" + name);
    fs.writeFileSync(path.join(stage, name), "new-" + name);
  }
  const rename = (from, to) => {
    if (from === path.join(stage, "official-usercontent")) throw Error("simulated install failure");
    fs.renameSync(from, to);
  };
  assert.throws(() => installOfficialUi(stage, build, rename), /simulated install failure/);
  for (const name of ["official-ui", "official-usercontent"])
    assert.equal(fs.readFileSync(path.join(build, name), "utf8"), "old-" + name);
});
