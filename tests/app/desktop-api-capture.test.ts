import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/** Every renderer source file, recursively. */
function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? files(full)
      : /\.tsx?$/.test(entry.name)
        ? [full]
        : [];
  });
}

test("no module keeps window.desktop from load time (the web bridge installs it later)", () => {
  const offenders = files("src").filter((file) =>
    /^(export )?const \w+ = window\.desktop;?$/m.test(
      fs.readFileSync(file, "utf8"),
    ),
  );
  assert.deepEqual(offenders, []);
});
