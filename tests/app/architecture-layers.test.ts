import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The layers: shared/ is the bottom and imports from no other layer; the main
 * process, the runner and the provider service never import the page (src/,
 * src-web/); the page never imports the main process, runner or service code.
 */
const forbidden: Record<string, string[]> = {
  shared: ["src", "src-web", "electron", "runner", "server"],
  electron: ["src", "src-web"],
  runner: ["src", "src-web"],
  server: ["src", "src-web"],
  src: ["electron", "runner", "server"],
};

const specifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bdeclare\s+module\s+)["'](\.{1,2}\/[^"']+)["']/g;

test("no layer imports from a layer above it", () => {
  const files = execFileSync(
    "git",
    ["ls-files", "--", ...Object.keys(forbidden)],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => /\.(ts|tsx|mts)$/.test(file));
  const offences: string[] = [];
  for (const file of files) {
    const layer = file.split("/")[0];
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(specifier)) {
      const target = path
        .normalize(path.join(path.dirname(file), match[1]))
        .split(path.sep)[0];
      if (forbidden[layer]?.includes(target))
        offences.push(`${file} → ${match[1]}`);
    }
  }
  assert.deepEqual(offences, []);
});
