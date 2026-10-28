import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

// The server's per-user capacity refusal reaches the composer as English
// text, so every shipped catalog carries it.
test("every catalog translates the per-user capacity refusal", async () => {
  const phrase =
    "You already have as many runs going as your account allows. Wait for one to finish, then try again.";
  const dir = new URL("../../shared/i18n/catalogs/", import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts"));
  assert.ok(files.length >= 11);
  for (const name of files) {
    const { default: catalog } = (await import(new URL(name, dir).href)) as {
      default: Record<string, string>;
    };
    assert.ok(catalog[phrase]?.trim() && catalog[phrase] !== phrase, name);
  }
});
