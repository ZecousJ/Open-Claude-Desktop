// Lists a file's class members by size: node --import tsx scripts/class-members.mts <file> [count]
import ts from "typescript";
import fs from "node:fs";
const f = process.argv[2];
const s = ts.createSourceFile(
  f,
  fs.readFileSync(f, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const out: [number, string, number, string][] = [];
s.forEachChild((n) => {
  if (ts.isClassDeclaration(n))
    for (const m of n.members) {
      const a = s.getLineAndCharacterOfPosition(m.getStart()).line + 1,
        b = s.getLineAndCharacterOfPosition(m.end).line + 1;
      out.push([
        b - a + 1,
        m.name?.getText() ?? "ctor",
        a,
        ts.SyntaxKind[m.kind],
      ] as any);
    }
});
out.sort((x, y) => y[0] - x[0]);
for (const o of out.slice(0, Number(process.argv[3] ?? 40)))
  console.log(o.join("\t"));
console.log("members", out.length);
