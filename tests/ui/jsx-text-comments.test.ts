import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** A `//` line between JSX children is shown as text, not a comment. */
test("no JSX child text reads like a // comment", () => {
  const root = path.join(import.meta.dirname, "..", "..");
  const found: string[] = [];
  for (const dir of ["src", "src-web"]) {
    for (const file of fs.readdirSync(path.join(root, dir), {
      recursive: true,
    }) as string[]) {
      if (!file.endsWith(".tsx")) continue;
      const name = path.join(dir, file);
      const source = ts.createSourceFile(
        name,
        fs.readFileSync(path.join(root, name), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node) && /(^|\n)\s*\/\/\s/.test(node.text))
          found.push(
            `${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
          );
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  assert.deepEqual(found, []);
});
