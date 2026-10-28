import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import { currentLocale, setLocale, t, formatText } from "../../src/i18n";

const keys = [
  "Server stderr captured on this computer. Credentials are redacted before storage; older logs are rotated.",
  "Server stderr",
  "MCP server stderr",
  "Waiting for this server’s stderr capture.",
  "Server stderr capture is unavailable for this configuration.",
  "No stderr has been captured for this server yet.",
  "Showing the most recent server output.",
  "Connection events",
  "Customize {serverName}",
  "Allow access to connectors and tools",
  "{count} of {total}",
  "Disable all tools",
  "Enable all tools",
  "No tools matching “{search}”",
  "This connector isn’t available.",
  "This tool isn’t available.",
  "Disabled in connector settings",
  "Update conversation tools separately.",
  "Start a new incognito chat to change its tools.",
  "The MCP configuration mirror is unavailable.",
  "The MCP configuration mirror receipt is invalid.",
];
const interpolation: [string, Record<string, string>][] = [
  [keys[8], { serverName: "Settings $& {owner} <原稿> / mcp" }],
  [keys[10], { count: "3", total: "17" }],
  [keys[13], { search: "Settings $& {search} <raw>" }],
];
for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
  test(`${id}: actual stderr, ToolPicker and mirror errors load with distinct states and literal data`, async () => {
    const previous = currentLocale();
    try {
      await setLocale(id);
      const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
        .default as Record<string, string>;
      for (const key of keys) {
        assert.equal(typeof catalog[key], "string", key);
        assert.equal(t(key), catalog[key], key);
        assert.ok(t(key).trim());
        assert.notEqual(t(key), key, key);
      }
      for (const key of keys.slice(0, 6))
        assert.ok(t(key).includes("stderr"), key);
      for (const key of [keys[2], keys[19], keys[20]])
        assert.ok(t(key).includes("MCP"), key);
      for (const [a, b] of [
        [3, 4],
        [4, 5],
        [1, 7],
        [11, 12],
        [14, 15],
        [17, 18],
        [19, 20],
      ])
        assert.notEqual(t(keys[a]), t(keys[b]), `${keys[a]} / ${keys[b]}`);
      for (const [key, values] of interpolation) {
        let expected = t(key);
        for (const [field, value] of Object.entries(values))
          expected = expected.replace(`{${field}}`, () => value);
        assert.equal(formatText(key, values), expected);
        for (const value of Object.values(values))
          assert.ok(formatText(key, values).includes(value));
      }
    } finally {
      await setLocale(previous);
    }
  });
}
test("the final B34 catalog delta has one entry per real key and exact placeholder identifiers", () => {
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
test("English tool and diagnostic copy keeps the exact source keys", async () => {
  const previous = currentLocale();
  try {
    await setLocale(sourceLocale);
    for (const key of keys) assert.equal(t(key), key);
    assert.equal(formatText(keys[10], { count: 3, total: 17 }), "3 of 17");
  } finally {
    await setLocale(previous);
  }
});
