/**
 * For the function that starts on <line>, prints "<first> <last>": a run of
 * its top-level statements from a cut near the middle to the end (before
 * any closing return), such that nothing before the cut reads a name the
 * run declares later than the cut. Input for extract-region (result "-").
 *   node --import tsx scripts/pick-cut.mts <file> <line> [share=0.5]
 */
import fs from "node:fs";
import ts from "typescript";
const [file, lineArg, shareArg = "0.5"] = process.argv.slice(2);
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
);
const lineOf = (pos: number) =>
  source.getLineAndCharacterOfPosition(pos).line + 1;
let holder: ts.FunctionLikeDeclaration | undefined;
const find = (node: ts.Node) => {
  if (
    !holder &&
    ts.isFunctionLike(node) &&
    (node as ts.FunctionLikeDeclaration).body &&
    lineOf(node.getStart(source)) === Number(lineArg)
  )
    holder = node as ts.FunctionLikeDeclaration;
  ts.forEachChild(node, find);
};
find(source);
if (!holder?.body || !ts.isBlock(holder.body))
  throw new Error("no function there");
let statements = [...holder.body.statements];
// Stop before the first return (or if … return) at the top level.
const returns = (s: ts.Statement): boolean => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found || ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(s);
  return found;
};
const stop = statements.findIndex(returns);
const tail = stop >= 0 ? statements.slice(stop) : [];
if (stop >= 0) statements = statements.slice(0, stop);
// A let that the code after the run reads stays out of it, and so does
// everything from its declaration on.
const readAfter = new Set<string>();
for (const s of tail) {
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) readAfter.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(s);
}
const firstLetReadAfter = statements.findIndex(
  (s) =>
    ts.isVariableStatement(s) &&
    !(s.declarationList.flags & ts.NodeFlags.Const) &&
    s.declarationList.declarations.some(
      (d) => ts.isIdentifier(d.name) && readAfter.has(d.name.text),
    ),
);
if (firstLetReadAfter >= 0) statements = statements.slice(0, firstLetReadAfter);
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
const declaredAt = new Map<string, number>();
statements.forEach((s, i) => names(s).forEach((n) => declaredAt.set(n, i)));
const lets = new Set(
  statements.flatMap((s) =>
    ts.isVariableStatement(s) && !(s.declarationList.flags & ts.NodeFlags.Const)
      ? names(s)
      : [],
  ),
);
const reads = statements.map((s) => {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(s);
  return out;
});
const total =
  lineOf(statements.at(-1)!.end) - lineOf(statements[0].getStart(source));
const target =
  lineOf(statements[0].getStart(source)) + total * Number(shareArg);
let best: number | undefined;
for (let cut = 1; cut < statements.length; cut++) {
  // Statements before the cut must not read names declared at or after it,
  // and the run must not read a let declared before it.
  let ok = true;
  for (let i = 0; i < cut && ok; i++)
    for (const n of reads[i]) {
      const at = declaredAt.get(n);
      if (at !== undefined && at >= cut) {
        ok = false;
        break;
      }
    }
  for (let i = cut; i < statements.length && ok; i++)
    for (const n of reads[i]) {
      const at = declaredAt.get(n);
      if (at !== undefined && at < cut && lets.has(n)) {
        ok = false;
        break;
      }
    }
  if (!ok) continue;
  const line = lineOf(statements[cut].getStart(source));
  if (
    best === undefined ||
    Math.abs(line - target) <
      Math.abs(lineOf(statements[best].getStart(source)) - target)
  )
    best = cut;
}
if (best === undefined) throw new Error("no clean cut");
const first = statements[best];
const comments = ts.getLeadingCommentRanges(source.text, first.getFullStart());
const from = comments?.length ? comments[0].pos : first.getStart(source);
console.log(`${lineOf(from)} ${lineOf(statements.at(-1)!.end)}`);
