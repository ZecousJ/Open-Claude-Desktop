import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { locales, sourceLocale } from "../../shared/locales";

// The corner notices (toasts) show their sentence as it is written in the
// source, so each one needs an entry in every catalog.
const callees = new Set(["notify", "onNotify", "showToast"]);

function literals(node: ts.Node): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node.text];
  if (ts.isConditionalExpression(node))
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  return [];
}

function notices(dir: string): Set<string> {
  const found = new Set<string>();
  const visitDirectory = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visitDirectory(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = ts.createSourceFile(
          full,
          readFileSync(full, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && node.arguments[0]) {
            const callee = ts.isIdentifier(node.expression)
              ? node.expression.text
              : ts.isPropertyAccessExpression(node.expression)
                ? node.expression.name.text
                : "";
            if (callees.has(callee))
              for (const text of literals(node.arguments[0]))
                if (/\s/.test(text)) found.add(text);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  };
  visitDirectory(dir);
  return found;
}

test("every notice written in the source has a translation in each language", async () => {
  const messages = [...notices("src"), ...notices("src-web")].filter(
    (text) => !text.includes("/"),
  );
  assert.ok(messages.length > 40, "the scan finds the app's notices");
  for (const { id } of locales.filter((locale) => locale.id !== sourceLocale)) {
    const catalog = (await import(`../../shared/i18n/catalogs/${id}.ts`))
      .default as Record<string, string>;
    assert.deepEqual(
      messages.filter((text) => !Object.hasOwn(catalog, text)),
      [],
      id,
    );
  }
});
