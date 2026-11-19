// Prints the value (not type) names <file> imports from <module>:
//   node --import tsx scripts/value-imports.mts <file> <module path>
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const [file, target] = process.argv.slice(2);
const source = ts.createSourceFile(
  file,
  fs.readFileSync(file, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const wanted = path.resolve(target).replace(/\.tsx?$/, "");
const names: string[] = [];
for (const s of source.statements) {
  if (!ts.isImportDeclaration(s) || s.importClause?.isTypeOnly) continue;
  const spec = (s.moduleSpecifier as ts.StringLiteral).text;
  if (!spec.startsWith(".")) continue;
  if (path.resolve(path.dirname(file), spec).replace(/\.tsx?$/, "") !== wanted)
    continue;
  const b = s.importClause?.namedBindings;
  if (b && ts.isNamedImports(b))
    for (const e of b.elements)
      if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text);
}
console.log(names.join(" "));
