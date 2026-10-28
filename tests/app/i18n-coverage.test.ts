import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";
import requiredMessages from "../fixtures/i18n-required-messages.json";

// Inspect source literals rather than relying only on equal catalog sizes.
// Non-UI code, identifiers and examples are intentionally not guessed as copy.
function declaredMessages(directory: string): Set<string> {
  const found = new Set<string>();
  function visitDirectory(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "catalogs") visitDirectory(path);
      } else if (/\.tsx?$/.test(entry.name)) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node) {
          if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            ["t", "tf", "formatText"].includes(node.expression.text)
          ) {
            const key = node.arguments[0];
            if (key && ts.isStringLiteral(key)) found.add(key.text);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  visitDirectory(directory);
  return found;
}

test("all declared source messages and audited sharing/settings/consent templates exist in every locale", async () => {
  const sourceKeys = new Set([
    ...declaredMessages("src"),
    ...declaredMessages("src-web"),
    ...requiredMessages,
  ]);
  assert.ok(
    sourceKeys.size > 100,
    "source extraction should inspect the real UI",
  );
  for (const { id } of locales.filter(({ id }) => id !== sourceLocale)) {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    for (const key of sourceKeys)
      assert.ok(
        Object.hasOwn(catalog, key),
        `${id}: missing UI message ${key}`,
      );
  }
});

test("all catalogs have no duplicate source keys", () => {
  for (const { id } of locales.filter(({ id }) => id !== sourceLocale)) {
    const path = `shared/i18n/catalogs/${id}.ts`;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const names = new Set<string>();
    function visit(node: ts.Node) {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
      ) {
        assert.ok(
          !names.has(node.name.text),
          `${id}: duplicate ${node.name.text}`,
        );
        names.add(node.name.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
