import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory()
      ? stylesheets(full)
      : full.endsWith(".css")
        ? [full]
        : [];
  });
}

test("every font role a stylesheet reads is defined on :root", () => {
  const foundation = readFileSync("src/styles/00-foundation.css", "utf8");
  const defined = new Set(
    [...foundation.matchAll(/^\s+(--font-[a-z-]+):/gm)].map((m) => m[1]),
  );
  for (const role of ["--font-ui", "--font-sans", "--font-mono"])
    assert.ok(defined.has(role), role);
  for (const role of ["--font-ui-serif", "--font-serif"])
    assert.ok(defined.has(role), role);
  const unknown = new Set<string>();
  for (const file of stylesheets("src"))
    for (const match of readFileSync(file, "utf8").matchAll(
      /var\((--font-[a-z-]+)/g,
    ))
      if (!defined.has(match[1])) unknown.add(`${file} ${match[1]}`);
  // Roles that only the settings page sets on its own elements are not roles.
  assert.deepEqual(
    [...unknown].filter((entry) => !/--font-(system|dyslexia)/.test(entry)),
    [],
  );
});

test("a font shorthand never reads a role without a fallback in a family list it needs", () => {
  const blank = readFileSync("src/artifacts/blank-artifact.css", "utf8");
  assert.match(blank, /font: 16px\/1\.5 var\(--font-ui, system-ui\);/);
});
