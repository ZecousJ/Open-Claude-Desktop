import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

// A template's holes become named groups when the interface is translated
// (src/i18n setLocale), so a name used twice ("{count} of {count}") throws
// and stops every translation. Each hole in a key, and the same holes in its
// translation, must therefore be named once.
const dir = join(import.meta.dirname, "../../shared/i18n/catalogs");

test("catalog templates name each placeholder once and keep the key's placeholders", async () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const catalog: Record<string, string> = (await import(join(dir, file)))
      .default;
    for (const [key, value] of Object.entries(catalog)) {
      const holes = [...key.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      assert.equal(
        new Set(holes).size,
        holes.length,
        `${file}: "${key}" repeats a placeholder`,
      );
      const translated = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      assert.deepEqual(
        [...new Set(translated)].sort(),
        [...new Set(holes)].sort(),
        `${file}: "${key}" → "${value}" changes its placeholders`,
      );
    }
  }
});
