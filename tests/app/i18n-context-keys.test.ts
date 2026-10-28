import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import zh from "../../shared/i18n/catalogs/zh-CN";

/*
 * Every literal tc("context", "text") names a catalog line "context|text".
 * Invoices once passed "billing|Total" as the context, asked for
 * "billing|Total|Total", got English back, and the page translator then gave
 * "Total" its generic Chinese ("总耗时", a length of time) under an amount.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every literal context translation names a line of the zh-CN catalog", () => {
  const catalog = zh as Record<string, string>;
  const missing: string[] = [];
  let seen = 0;
  for (const file of sources("src")) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /\btc\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g,
    )) {
      seen++;
      const key = `${match[1]}|${match[2]}`;
      if (!(key in catalog)) missing.push(`${file}: ${key}`);
    }
  }
  assert.ok(seen > 10, "the scan found the context translations");
  assert.deepEqual(missing, []);
});
