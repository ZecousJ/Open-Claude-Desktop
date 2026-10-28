import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";

const keys = [
  "This connector operation belongs to a retired account or connector. Open it again.",
  "The connector returned an invalid authentication result.",
  "The connector returned an invalid server list.",
  "The connector didn’t return a supported sign-in page.",
  "Checking connector sign-in…",
  "Reconnect {name}",
  "The connector configuration changed. Refresh and try again.",
  "Wait for the current task to finish before changing extension settings.",
  "Wait for the current task to finish before uninstalling an extension.",
  "Wait for extension maintenance to finish.",
];
for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: connector ownership, authentication and extension busy messages load through the real locale runtime`, async () => {
    const previous = currentLocale();
    try {
      await setLocale(id);
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      for (const key of keys) {
        assert.equal(typeof catalog[key], "string", key);
        assert.equal(t(key), catalog[key], key);
        assert.ok(t(key).trim(), key);
        assert.notEqual(t(key), key, key);
      }
      assert.notEqual(t(keys[1]), t(keys[2]));
      assert.notEqual(t(keys[7]), t(keys[8]));
      assert.notEqual(t(keys[8]), t(keys[9]));
      const literal = "Settings $& {owner} <原稿> / connector";
      assert.equal(t(keys[5]).split("{name}").length, 2);
      assert.equal(
        formatText(keys[5], { name: literal }),
        t(keys[5]).replace("{name}", () => literal),
      );
    } finally {
      await setLocale(previous);
    }
  });
}
test("new connector and extension catalog entries occur once and preserve the exact interpolation field", () => {
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const url = new URL(`../../shared/i18n/catalogs/${id}.ts`, import.meta.url);
    const source = ts.createSourceFile(
      url.pathname,
      readFileSync(url, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const entries = new Map<string, string[]>();
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isStringLiteral(node.name) || ts.isIdentifier(node.name)) &&
        ts.isStringLiteral(node.initializer)
      ) {
        const values = entries.get(node.name.text) ?? [];
        values.push(node.initializer.text);
        entries.set(node.name.text, values);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const key of keys)
      assert.equal(entries.get(key)?.length, 1, `${id}: ${key}`);
    assert.equal(entries.get(keys[5])![0].split("{name}").length, 2, id);
  }
});
test("source locale keeps the exact real UI errors and literal connector identity", async () => {
  const previous = currentLocale();
  try {
    await setLocale(sourceLocale);
    for (const key of keys) assert.equal(t(key), key);
    assert.equal(
      formatText(keys[5], { name: "Settings $& {raw}" }),
      "Reconnect Settings $& {raw}",
    );
  } finally {
    await setLocale(previous);
  }
});
