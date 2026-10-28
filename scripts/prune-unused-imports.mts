/**
 * Removes import specifiers that a file no longer uses:
 *
 *   node --import tsx scripts/prune-unused-imports.mts <file> [file …]
 *
 * Only imports change; unused locals elsewhere are reported by tsc, not touched.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = process.cwd();
const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")!;
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  root,
);
const touched = process.argv.slice(2).map((file) => path.resolve(file));
const unusedProgram = ts.createProgram(touched, {
  ...config.options,
  noUnusedLocals: true,
  noEmit: true,
});
for (const file of touched) {
  const sf = unusedProgram.getSourceFile(file);
  if (!sf) continue;
  const unused = new Set<number>();
  for (const d of unusedProgram.getSemanticDiagnostics(sf))
    if (
      (d.code === 6133 || d.code === 6192 || d.code === 6196) &&
      d.start !== undefined
    )
      unused.add(d.start);
  if (!unused.size) continue;
  let text = sf.text;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (unused.has(statement.getStart(sf))) {
      edits.push({
        start: statement.getFullStart(),
        end: statement.getEnd(),
        text: "",
      });
      continue;
    }
    const named = clause.namedBindings;
    const defaultUnused = clause.name && unused.has(clause.name.getStart(sf));
    if (named && ts.isNamedImports(named)) {
      const keep = named.elements.filter(
        (e) => !unused.has(e.getStart(sf)) && !unused.has(e.name.getStart(sf)),
      );
      if (keep.length === named.elements.length && !defaultUnused) continue;
      const def = clause.name && !defaultUnused ? clause.name.text : "";
      if (!keep.length && !def) {
        edits.push({
          start: statement.getFullStart(),
          end: statement.getEnd(),
          text: "",
        });
        continue;
      }
      const parts = [
        def,
        keep.length ? `{ ${keep.map((e) => e.getText(sf)).join(", ")} }` : "",
      ].filter(Boolean);
      edits.push({
        start: statement.getStart(sf),
        end: statement.getEnd(),
        text: `import ${clause.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${statement.moduleSpecifier.getText(sf)};`,
      });
    } else if (defaultUnused && !named) {
      edits.push({
        start: statement.getFullStart(),
        end: statement.getEnd(),
        text: "",
      });
    }
  }
  for (const e of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
  fs.writeFileSync(file, text);
}
console.log(`checked ${touched.length} file(s)`);
