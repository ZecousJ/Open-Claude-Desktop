/**
 * Lists JSX elements of at least <min> lines that contain no other such
 * element and sit inside other JSX (not a value of their own), with a
 * suggested component name: candidates for extract-region --jsx.
 *   node --import tsx scripts/jsx-blocks.mts <file> [min=80]
 * Prints "<line> <lines> <Name>", last first (so earlier lines stay put).
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const [file, minArg = "80"] = process.argv.slice(2);
const min = Number(minArg);
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const lineOf = (pos: number) =>
  source.getLineAndCharacterOfPosition(pos).line + 1;
type El = ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment;
const big: El[] = [];
const visit = (n: ts.Node) => {
  if (
    (ts.isJsxElement(n) ||
      ts.isJsxSelfClosingElement(n) ||
      ts.isJsxFragment(n)) &&
    lineOf(n.end) - lineOf(n.getStart(source)) + 1 >= min
  )
    big.push(n);
  ts.forEachChild(n, visit);
};
visit(source);
const contains = (a: ts.Node, b: ts.Node) =>
  a !== b && a.getStart(source) <= b.getStart(source) && a.end >= b.end;
const leaves = big.filter((e) => !big.some((o) => contains(e, o)));
const insideJsx = (e: El) => {
  let p = e.parent;
  while (
    p &&
    (ts.isParenthesizedExpression(p) ||
      ts.isConditionalExpression(p) ||
      ts.isBinaryExpression(p))
  )
    p = p.parent;
  return (
    p && (ts.isJsxExpression(p) || ts.isJsxElement(p) || ts.isJsxFragment(p))
  );
};
const pascal = (s: string) =>
  s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
const base = pascal(
  path
    .basename(file)
    .replace(/\.tsx$/, "")
    .replace(/View$/, ""),
);
const used = new Set<string>();
const rows = leaves.filter(insideJsx).map((e, i) => {
  let name = "";
  const opening = ts.isJsxElement(e)
    ? e.openingElement
    : ts.isJsxSelfClosingElement(e)
      ? e
      : undefined;
  const cls = opening?.attributes.properties.find(
    (a) => ts.isJsxAttribute(a) && a.name.getText(source) === "className",
  );
  const text =
    cls && ts.isJsxAttribute(cls) && cls.initializer
      ? cls.initializer.getText(source).replace(/[`"{}]/g, " ")
      : "";
  const token = text.split(/\s+/).find((t) => /^[a-z][a-z0-9-]+$/.test(t));
  if (token) name = pascal(token);
  if (!name || used.has(name)) name = `${base}Part${i + 1}`;
  used.add(name);
  return {
    line: lineOf(e.getStart(source)),
    lines: lineOf(e.end) - lineOf(e.getStart(source)) + 1,
    name,
  };
});
for (const r of rows.sort((a, b) => b.line - a.line))
  console.log(`${r.line} ${r.lines} ${r.name}`);
