/**
 * Lists, for one function's top-level statements, the names each reads that
 * a later statement declares, and where a run could end without a forward
 * reference past it (input for extract-region):
 *
 *   node --import tsx scripts/forward-refs.mts <file> <line inside the function>
 */
import fs from "node:fs";
import ts from "typescript";

const [file, lineArg] = process.argv.slice(2);
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
);
const line = Number(lineArg) - 1;
let holder: ts.FunctionLikeDeclaration | undefined;
const find = (node: ts.Node) => {
  const a = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
  const b = source.getLineAndCharacterOfPosition(node.end).line;
  if (
    a <= line &&
    b >= line &&
    ts.isFunctionLike(node) &&
    (node as ts.FunctionLikeDeclaration).body
  )
    holder = node as ts.FunctionLikeDeclaration;
  ts.forEachChild(node, find);
};
find(source);
if (!holder?.body || !ts.isBlock(holder.body)) throw new Error("no function");
const statements = holder.body.statements;
const declaredAt = new Map<string, number>();
const names = (s: ts.Statement): string[] => {
  if (ts.isVariableStatement(s)) {
    const out: string[] = [];
    const gather = (n: ts.BindingName) => {
      if (ts.isIdentifier(n)) out.push(n.text);
      else
        for (const e of n.elements)
          if (!ts.isOmittedExpression(e)) gather(e.name);
    };
    for (const d of s.declarationList.declarations) gather(d.name);
    return out;
  }
  if (ts.isFunctionDeclaration(s) && s.name) return [s.name.text];
  return [];
};
statements.forEach((s, i) => names(s).forEach((n) => declaredAt.set(n, i)));
const lineOf = (i: number) =>
  source.getLineAndCharacterOfPosition(statements[i].getStart(source)).line + 1;
// For each statement: the furthest later statement it reads from.
const reach = statements.map((s, i) => {
  let far = i;
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const at = declaredAt.get(n.text);
      if (at !== undefined && at > far) far = at;
    }
    ts.forEachChild(n, visit);
  };
  visit(s);
  return far;
});
// A run may end after statement i when nothing at or before i reads past i.
let far = 0;
const cuts: number[] = [];
statements.forEach((_, i) => {
  far = Math.max(far, reach[i]);
  if (far <= i) cuts.push(lineOf(i));
});
for (let i = 0; i < statements.length; i++)
  if (reach[i] > i)
    console.log(`${lineOf(i)} reads ahead to ${lineOf(reach[i])}`);
console.log(
  `clean ends (last line of statement starting at): ${cuts.join(" ")}`,
);
