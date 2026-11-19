/**
 * Moves top-level declarations out of a TypeScript module into another,
 * keeping every reference working:
 *
 *   node --import tsx scripts/extract-declarations.mts <source> <target> <name> [name …]
 *
 * - The named declarations (with their comments) move to <target> (created
 *   or appended to); a moved declaration that the source still uses, or that
 *   other files imported, is exported from the target.
 * - The target gets the imports its moved code needs (from the source's own
 *   imports, plus the source module itself for anything it still owns).
 * - The source imports what it still uses from the target.
 * - Other files that imported a moved name from the source import it from
 *   the target instead.
 * - Imports left unused by the move are removed from the files it touched.
 * Run tsc and the tests afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const [sourceArg, targetArg, ...names] = process.argv.slice(2);
if (!sourceArg || !targetArg || !names.length)
  throw new Error("usage: extract-declarations <source> <target> <name…>");
const root = process.cwd();
const sourcePath = path.resolve(sourceArg);
const targetPath = path.resolve(targetArg);
const wanted = new Set(names);

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")!;
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  root,
);

const read = (file: string) => fs.readFileSync(file, "utf8");
const parse = (file: string, text = read(file)) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

function declaredNames(statement: ts.Statement): string[] {
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isInterfaceDeclaration(statement) ||
    ts.isTypeAliasDeclaration(statement) ||
    ts.isEnumDeclaration(statement)
  )
    return statement.name ? [statement.name.text] : [];
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((d) =>
      ts.isIdentifier(d.name) ? [d.name.text] : [],
    );
  return [];
}
const isExported = (statement: ts.Statement) =>
  (ts.canHaveModifiers(statement) &&
    ts
      .getModifiers(statement)
      ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ??
  false;

const source = parse(sourcePath);
const moved: ts.Statement[] = [];
for (const statement of source.statements) {
  const declared = declaredNames(statement);
  if (declared.some((n) => wanted.has(n))) {
    if (!declared.every((n) => wanted.has(n)))
      throw new Error(`${declared.join(", ")} must move together`);
    moved.push(statement);
  }
}
const movedNames = new Set(moved.flatMap(declaredNames));
for (const n of wanted)
  if (!movedNames.has(n)) throw new Error(`not a top-level declaration: ${n}`);

/** Identifiers a node references (by text). */
function referenced(node: ts.Node, out = new Set<string>()) {
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    n.forEachChild(visit);
  };
  visit(node);
  return out;
}

const movedSet = new Set(moved);
const remaining = source.statements.filter((s) => !movedSet.has(s));
const usedByRemaining = new Set<string>();
for (const s of remaining)
  if (!ts.isImportDeclaration(s)) referenced(s, usedByRemaining);
const usedByMoved = new Set<string>();
for (const s of moved) referenced(s, usedByMoved);

// A statement that runs at the source's top level (not a declaration) and
// touches a moved name would no longer run with it; the caller moves it.
for (const s of remaining) {
  if (
    ts.isImportDeclaration(s) ||
    declaredNames(s).length ||
    ts.isInterfaceDeclaration(s) ||
    ts.isTypeAliasDeclaration(s) ||
    ts.isExportDeclaration(s)
  )
    continue;
  const touched = [...referenced(s)].filter((n) => movedNames.has(n));
  if (touched.length)
    console.warn(
      `warning: a top-level statement uses ${touched.join(", ")}: ${s.getText(source).slice(0, 80)}`,
    );
}

// Names still declared in the source that the moved code uses.
const sourceOwned = new Set(
  remaining.filter((s) => !ts.isImportDeclaration(s)).flatMap(declaredNames),
);
const needFromSource = [...sourceOwned].filter((n) => usedByMoved.has(n));

const relative = (from: string, to: string) => {
  let spec = path.relative(path.dirname(from), to).replace(/\.(tsx?|mts)$/, "");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
};

// Other files that import a moved exported name from the source.
const program = ts.createProgram(config.fileNames, config.options);
const importers: { file: string; text: string }[] = [];
/** The existing target, without its imports of what now moves into it. */
let targetBefore: string | undefined;
const movedExported = new Set(moved.filter(isExported).flatMap(declaredNames));
for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile || file.fileName === sourcePath) continue;
  if (file.fileName.includes("node_modules")) continue;
  let text = file.text;
  let hit = false;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      continue;
    const spec = statement.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec) || !spec.text.startsWith("."))
      continue;
    const resolved = ts.resolveModuleName(
      spec.text,
      file.fileName,
      config.options,
      ts.sys,
    ).resolvedModule?.resolvedFileName;
    if (!resolved || path.resolve(resolved) !== sourcePath) continue;
    const clause = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : statement.exportClause;
    if (!clause || !(ts.isNamedImports(clause) || ts.isNamedExports(clause)))
      continue;
    const keep = clause.elements.filter(
      (e) => !movedExported.has((e.propertyName ?? e.name).text),
    );
    const take = clause.elements.filter((e) =>
      movedExported.has((e.propertyName ?? e.name).text),
    );
    if (!take.length) continue;
    hit = true;
    const typeOnly = ts.isImportDeclaration(statement)
      ? statement.importClause?.isTypeOnly
      : statement.isTypeOnly;
    const verb = ts.isImportDeclaration(statement) ? "import" : "export";
    const print = (
      els: readonly ts.ImportSpecifier[] | readonly ts.ExportSpecifier[],
      to: string,
    ) =>
      `${verb} ${typeOnly ? "type " : ""}{ ${els.map((e) => e.getText(file)).join(", ")} } from "${to}";`;
    const hasDefault =
      ts.isImportDeclaration(statement) && statement.importClause?.name;
    let replacement = "";
    if (keep.length || hasDefault) {
      if (hasDefault && !keep.length)
        replacement = `import ${statement.importClause!.name!.text} from "${spec.text}";`;
      else if (hasDefault)
        replacement = `import ${statement.importClause!.name!.text}, { ${keep.map((e) => e.getText(file)).join(", ")} } from "${spec.text}";`;
      else replacement = print(keep as never, spec.text);
      replacement += "\n";
    }
    // The target itself gets the declarations, not an import of them.
    if (path.resolve(file.fileName) !== targetPath)
      replacement += print(
        take as never,
        // An importer that names ".ts" keeps doing so.
        spec.text.endsWith(".ts")
          ? `${relative(file.fileName, targetPath)}.ts`
          : relative(file.fileName, targetPath),
      );
    else replacement = replacement.replace(/\n$/, "");
    edits.push({
      start: statement.getStart(file),
      end: statement.getEnd(),
      text: replacement,
    });
  }
  if (!hit) continue;
  for (const e of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
  if (path.resolve(file.fileName) === targetPath) targetBefore = text;
  else importers.push({ file: file.fileName, text });
}

// The target: the source's imports (pruned later), what it needs from the
// source, then the moved code.
// Names an existing target already imports or declares: not imported again.
const alreadyBound = new Set<string>();
if (fs.existsSync(targetPath))
  for (const s of parse(targetPath).statements) {
    if (ts.isImportDeclaration(s)) {
      const clause = s.importClause;
      if (clause?.name) alreadyBound.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        alreadyBound.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const e of bindings.elements) alreadyBound.add(e.name.text);
    } else for (const n of declaredNames(s)) alreadyBound.add(n);
  }
const importBlock = source.statements
  .filter(ts.isImportDeclaration)
  .map((s) => {
    const spec = (s.moduleSpecifier as ts.StringLiteral).text;
    // Without leading comments: the source's file comment stays there.
    let text = s.getText(source);
    const clause = s.importClause;
    // A side-effect import (a stylesheet) goes only to a component file,
    // once.
    if (!clause) {
      if (!targetPath.endsWith(".tsx")) return "";
      if (fs.existsSync(targetPath) && read(targetPath).includes(text))
        return "";
      return text;
    }
    if (alreadyBound.size && clause) {
      const bindings = clause.namedBindings;
      const keepDefault = clause.name && !alreadyBound.has(clause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (alreadyBound.has(bindings.name.text)) return "";
      } else {
        const named =
          bindings && ts.isNamedImports(bindings)
            ? bindings.elements.filter((e) => !alreadyBound.has(e.name.text))
            : [];
        if (!keepDefault && !named.length) return "";
        const parts = [
          keepDefault ? clause.name!.text : "",
          named.length
            ? `{ ${named.map((e) => e.getText(source)).join(", ")} }`
            : "",
        ].filter(Boolean);
        text = `import ${clause.isTypeOnly ? "type " : ""}${parts.join(", ")} from ${s.moduleSpecifier.getText(source)};`;
      }
    }
    if (spec.startsWith(".")) {
      const absolute = path.resolve(path.dirname(sourcePath), spec);
      text = text.replace(
        JSON.stringify(spec),
        JSON.stringify(relative(targetPath, absolute)),
      );
    }
    return text;
  })
  .filter(Boolean)
  .join("\n");
const exportNeeded = new Set<string>(
  [...movedNames].filter((n) => usedByRemaining.has(n) || movedExported.has(n)),
);
const movedText = moved
  .map((s) => {
    let text = s.getFullText(source).replace(/^\s*\n/, "");
    const names = declaredNames(s);
    if (!isExported(s) && names.some((n) => exportNeeded.has(n)))
      text = text.replace(
        /^(\s*(?:\/\*\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*)/,
        "$1export ",
      );
    return text;
  })
  .join("\n\n");
/** Whether a name is used by the moved code only where a type is expected. */
function typeOnly(name: string) {
  let value = false;
  const visit = (n: ts.Node, inType: boolean) => {
    if (ts.isIdentifier(n) && n.text === name && !inType) value = true;
    n.forEachChild((c) =>
      visit(c, inType || ts.isTypeNode(n) || ts.isHeritageClause(n)),
    );
  };
  for (const s of moved)
    visit(s, ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
  return !value;
}
const typeNames = needFromSource.filter(
  (n) => typeOnly(n) && !alreadyBound.has(n),
);
const valueNames = needFromSource.filter(
  (n) => !typeOnly(n) && !alreadyBound.has(n),
);
// A module that names its relative imports with ".ts" (run by Node's own
// type stripping) keeps doing so.
const tsExtensions = /from "\.{1,2}\/[^"]+\.ts"/.test(source.text);
const withExtension = (spec: string) =>
  tsExtensions && !spec.endsWith(".ts") ? `${spec}.ts` : spec;
const sourceSpec = withExtension(relative(targetPath, sourcePath));
const fromSource =
  (valueNames.length
    ? `import { ${valueNames.join(", ")} } from "${sourceSpec}";\n`
    : "") +
  (typeNames.length
    ? `import type { ${typeNames.join(", ")} } from "${sourceSpec}";\n`
    : "");
const existing =
  targetBefore ?? (fs.existsSync(targetPath) ? read(targetPath) : "");
const targetText = existing
  ? `${importBlock}\n${fromSource}${existing}\n\n${movedText}\n`
  : `${importBlock}\n${fromSource}\n${movedText}\n`;

// The source: without the moved code, importing what it still uses.
let sourceText = source.text;
for (const s of [...moved].sort((a, b) => b.getFullStart() - a.getFullStart()))
  sourceText =
    sourceText.slice(0, s.getFullStart()) + sourceText.slice(s.getEnd());
const stillUsed = [...movedNames].filter((n) => usedByRemaining.has(n));
for (const n of needFromSource) {
  // The source must export what the target imports from it.
  const decl = remaining.find((s) => declaredNames(s).includes(n));
  if (decl && !isExported(decl)) {
    const start = decl.getStart(source);
    const offset = sourceText.indexOf(decl.getText(source).slice(0, 60));
    if (offset >= 0)
      sourceText =
        sourceText.slice(0, offset) + "export " + sourceText.slice(offset);
    void start;
  }
}
if (stillUsed.length) {
  const lastImport = [...parse(sourcePath, sourceText).statements]
    .filter(ts.isImportDeclaration)
    .pop();
  const at = lastImport ? lastImport.getEnd() : 0;
  sourceText =
    sourceText.slice(0, at) +
    `\nimport { ${stillUsed
      .map((n) => {
        const decl = moved.find((m) => declaredNames(m).includes(n));
        return decl &&
          (ts.isInterfaceDeclaration(decl) || ts.isTypeAliasDeclaration(decl))
          ? `type ${n}`
          : n;
      })
      .join(
        ", ",
      )} } from "${withExtension(relative(sourcePath, targetPath))}";` +
    sourceText.slice(at);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, targetText);
fs.writeFileSync(sourcePath, sourceText);
for (const i of importers) fs.writeFileSync(i.file, i.text);

// Remove imports left unused in the touched files.
const touched = [sourcePath, targetPath, ...importers.map((i) => i.file)];
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
console.log(
  `moved ${[...movedNames].join(", ")} → ${path.relative(root, targetPath)}; updated ${importers.length} importer(s)`,
);
