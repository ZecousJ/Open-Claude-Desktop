// Lists a module's top-level declarations by size:
//   node --import tsx scripts/top-level.mts <file> [count]
import fs from "node:fs";
import ts from "typescript";
const [file, count = "12"] = process.argv.slice(2);
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
);
const line = (pos: number) =>
  source.getLineAndCharacterOfPosition(pos).line + 1;
const rows = source.statements
  .filter((s) => !ts.isImportDeclaration(s))
  .map((s) => {
    const name =
      (ts.isVariableStatement(s) &&
        s.declarationList.declarations
          .map((d) => d.name.getText(source))
          .join(",")) ||
      ((s as { name?: ts.Node }).name?.getText(source) ??
        ts.SyntaxKind[s.kind]);
    return {
      name,
      from: line(s.getStart(source)),
      lines: line(s.end) - line(s.getStart(source)) + 1,
    };
  })
  .sort((a, b) => b.lines - a.lines)
  .slice(0, Number(count));
for (const r of rows)
  console.log(`${String(r.lines).padStart(5)}  ${r.from}  ${r.name}`);
