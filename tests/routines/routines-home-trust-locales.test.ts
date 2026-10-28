import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";

const keys = [
  "The built-in Browser is unavailable for this scheduled task.",
  "{count} websites",
  "The Browser returned an invalid approval list.",
  "This scheduled task is read-only.",
  "This scheduled Browser run is no longer active.",
  "Browser approvals are unavailable.",
  "Browser tools are unavailable in this conversation.",
  "Browser approval is required again.",
  "Use an approved website address to navigate this scheduled run.",
  "Invalid Browser approval.",
  "All websites",
  "Connector tools aren’t available yet.",
  "Conversation-specific tool loading isn’t supported by this host.",
  "Voice input",
  "Voice mode",
  "Remove trusted device?",
  "Remove this device’s trusted access to this computer.",
];
const reuse = ["Dictate", "Back", "Device", "Added"];
for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: real runtime translates Browser grants, Home tools/voice and trust removal without collapsing states`, async () => {
    const previous = currentLocale();
    try {
      await setLocale(id);
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      for (const key of [...keys, ...reuse]) {
        assert.equal(typeof catalog[key], "string", key);
        assert.ok(catalog[key].trim(), key);
        assert.equal(t(key), catalog[key], key);
        assert.notEqual(t(key), key, key);
      }
      for (const [a, b] of [
        [0, 5],
        [2, 9],
        [3, 4],
        [5, 7],
        [11, 12],
        [13, 14],
        [15, 16],
      ])
        assert.notEqual(t(keys[a]), t(keys[b]), `${keys[a]} / ${keys[b]}`);
      for (const count of [0, 1, 200, "Settings $& {count} <原稿>"]) {
        const result = formatText(keys[1], { count });
        assert.equal(
          result,
          catalog[keys[1]].replace("{count}", () => String(count)),
        );
        assert.ok(result.includes(String(count)));
      }
    } finally {
      await setLocale(previous);
    }
  });
}
test("all 11 B35 catalog deltas contain each real key once and preserve exact placeholders", () => {
  const fields = (value: string) =>
    [...value.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).sort();
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
    for (const key of keys) {
      assert.equal(entries.get(key)?.length, 1, `${id}: ${key}`);
      assert.deepEqual(
        fields(entries.get(key)![0]),
        fields(key),
        `${id}: ${key}`,
      );
    }
  }
});
test("English retains exact B35 source copy and literal website counts", async () => {
  const previous = currentLocale();
  try {
    await setLocale(sourceLocale);
    for (const key of [...keys, ...reuse]) assert.equal(t(key), key);
    assert.equal(formatText(keys[1], { count: 200 }), "200 websites");
    assert.equal(
      formatText(keys[1], { count: "$& {count} <raw>" }),
      "$& {count} <raw> websites",
    );
  } finally {
    await setLocale(previous);
  }
});
