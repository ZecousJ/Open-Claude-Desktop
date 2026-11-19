/**
 * Turns the attributes of the JSX element that starts on <line> into an
 * object declared just before its statement, `const <name> = { … };`, and
 * spreads it back (`<tag {...name} />`): the element's props are the same,
 * in the same order, and the object can then move (extract-region).
 *   node --import tsx scripts/jsx-props-object.mts <file> <line> <name>
 */
import fs from "node:fs";
import ts from "typescript";
const [file, lineArg, name] = process.argv.slice(2);
const text = fs.readFileSync(file, "utf8");
const source = ts.createSourceFile(
  file,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const line = Number(lineArg) - 1;
let element: ts.JsxSelfClosingElement | ts.JsxOpeningElement | undefined;
const find = (n: ts.Node) => {
  if (element) return;
  if (
    (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) &&
    source.getLineAndCharacterOfPosition(n.getStart(source)).line === line
  ) {
    element = n;
    return;
  }
  ts.forEachChild(n, find);
};
find(source);
if (!element) throw new Error(`No JSX element starts on line ${lineArg}.`);
let statement: ts.Node = element;
while (!ts.isBlock(statement.parent) && !ts.isSourceFile(statement.parent))
  statement = statement.parent;
const entries = element.attributes.properties.map((a) => {
  if (ts.isJsxSpreadAttribute(a)) return `...${a.expression.getText(source)}`;
  const key = a.name.getText(source);
  const quoted = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
  if (!a.initializer) return `${quoted}: true`;
  if (ts.isStringLiteral(a.initializer))
    return `${quoted}: ${a.initializer.getText(source)}`;
  const expression = (a.initializer as ts.JsxExpression).expression;
  if (!expression) throw new Error(`${key} has an empty expression.`);
  // Comments inside the braces stay with the value.
  const inner = text
    .slice(
      (a.initializer as ts.JsxExpression).getStart(source) + 1,
      a.initializer.end - 1,
    )
    .trim();
  return `${quoted}: ${inner}`;
});
const indent = " ".repeat(
  source.getLineAndCharacterOfPosition(statement.getStart(source)).character,
);
const declaration = `const ${name} = {\n${entries.map((e) => `${indent}  ${e},`).join("\n")}\n${indent}};\n${indent}`;
const attrs = element.attributes;
let next = text.slice(0, attrs.pos) + ` {...${name}}` + text.slice(attrs.end);
const at = statement.getStart(source);
next = next.slice(0, at) + declaration + next.slice(at);
fs.writeFileSync(file, next);
console.log(`${entries.length} attributes → ${name}`);
