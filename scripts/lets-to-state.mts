/**
 * Gathers a module's top-level `let` variables into one exported state
 * object, so functions that read or assign them can move to other modules:
 *
 *   node --import tsx scripts/lets-to-state.mts <source> <target> <object>
 *
 * - Every top-level `let` (with its comments) becomes a member of
 *   `export const <object> = { … }` in <target>, typed as it was declared.
 * - Every use in <source> reads or assigns `<object>.<name>` instead.
 * - <target> gets <source>'s imports (prune them afterwards).
 * Run prune-unused-imports, prettier and tsc afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const [sourceArg, targetArg, objectName] = process.argv.slice(2);
if (!sourceArg || !targetArg || !objectName)
  throw new Error("usage: lets-to-state <source> <target> <object>");
const root = process.cwd();
const sourcePath = path.resolve(sourceArg);
const targetPath = path.resolve(targetArg);
if (fs.existsSync(targetPath)) throw new Error(`${targetArg} exists.`);

const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")!;
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  root,
);
const program = ts.createProgram({
  rootNames: config.fileNames.includes(sourcePath)
    ? config.fileNames
    : [...config.fileNames, sourcePath],
  options: config.options,
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(sourcePath)!;
const text = source.getFullText();

const relative = (from: string, to: string) => {
  let spec = path
    .relative(path.dirname(from), to)
    .replace(/\.(d\.)?tsx?$/, "")
    .split(path.sep)
    .join("/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
};

interface Member {
  name: string;
  symbol: ts.Symbol;
  comment: string;
  type: string;
  value: string;
}
const members: Member[] = [];
const statementsToDrop: ts.VariableStatement[] = [];
const ownNames = new Set<ts.Symbol>();
for (const statement of source.statements) {
  for (const name of declaredNames(statement)) {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) ownNames.add(symbol);
  }
}
function declaredNames(statement: ts.Statement): ts.Identifier[] {
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations
      .map((d) => d.name)
      .filter(ts.isIdentifier);
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
    statement.name
  )
    return [statement.name];
  return [];
}

function printType(type: ts.Type, at: ts.Node) {
  const printed = checker.typeToString(
    type,
    at,
    ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseFullyQualifiedType,
  );
  return printed.replace(/import\("([^"]+)"\)/g, (_m, file: string) =>
    path.isAbsolute(file)
      ? `import("${relative(targetPath, file)}")`
      : `import("${file}")`,
  );
}

for (const statement of source.statements) {
  if (
    !ts.isVariableStatement(statement) ||
    !(statement.declarationList.flags & ts.NodeFlags.Let)
  )
    continue;
  statementsToDrop.push(statement);
  const comment = text
    .slice(statement.getFullStart(), statement.getStart(source))
    .replace(/^\s*\n/, "")
    .replace(/\s+$/, "");
  statement.declarationList.declarations.forEach((d, index) => {
    if (!ts.isIdentifier(d.name))
      throw new Error(`Destructured let at ${d.getStart(source)}.`);
    const symbol = checker.getSymbolAtLocation(d.name)!;
    if (d.initializer) {
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
          const used = checker.getSymbolAtLocation(node);
          if (used && ownNames.has(used))
            throw new Error(
              `${d.name.getText(source)} starts from ${node.text}, which stays in the source.`,
            );
        }
        ts.forEachChild(node, visit);
      };
      visit(d.initializer);
    }
    const declaredType = d.type
      ? d.type.getText(source)
      : printType(checker.getTypeAtLocation(d.name), d.name);
    const value = d.initializer
      ? ts.isArrowFunction(d.initializer) ||
        ts.isFunctionExpression(d.initializer) ||
        ts.isConditionalExpression(d.initializer) ||
        ts.isBinaryExpression(d.initializer)
        ? `(${d.initializer.getText(source)}) as ${declaredType}`
        : `${d.initializer.getText(source)} as ${declaredType}`
      : checker.getTypeAtLocation(d.name).flags & ts.TypeFlags.Undefined ||
          (checker.getTypeAtLocation(d.name).isUnion() &&
            (checker.getTypeAtLocation(d.name) as ts.UnionType).types.some(
              (t) => t.flags & ts.TypeFlags.Undefined,
            ))
        ? `undefined as ${declaredType}`
        : `undefined as unknown as ${declaredType}`;
    members.push({
      name: d.name.text,
      symbol,
      comment: index === 0 ? comment : "",
      type: declaredType,
      value,
    });
  });
}
if (!members.length) throw new Error("No top-level let.");
const bySymbol = new Map(members.map((m) => [m.symbol, m]));

const edits: { start: number; end: number; text: string }[] = [];
for (const statement of statementsToDrop)
  edits.push({ start: statement.getFullStart(), end: statement.end, text: "" });
const visit = (node: ts.Node) => {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const isDeclaration =
      ts.isVariableDeclaration(parent) && parent.name === node;
    const shorthand = ts.isShorthandPropertyAssignment(parent);
    const symbol = shorthand
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);
    const member = symbol && bySymbol.get(symbol);
    if (member && !isDeclaration) {
      const access = `${objectName}.${member.name}`;
      edits.push({
        start: node.getStart(source),
        end: node.end,
        text: shorthand ? `${member.name}: ${access}` : access,
      });
    }
  }
  ts.forEachChild(node, visit);
};
for (const statement of source.statements)
  if (!statementsToDrop.includes(statement as ts.VariableStatement))
    visit(statement);

const lastImport = [...source.statements]
  .reverse()
  .find(ts.isImportDeclaration);
const importAt = lastImport ? lastImport.end : 0;
edits.push({
  start: importAt,
  end: importAt,
  text: `\nimport { ${objectName} } from "${relative(sourcePath, targetPath)}";`,
});
edits.sort((a, b) => b.start - a.start);
let next = text;
for (const edit of edits)
  next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
fs.writeFileSync(sourcePath, next);

const imports = source.statements
  .filter(ts.isImportDeclaration)
  .map((statement) => {
    const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
    const retargeted = spec.startsWith(".")
      ? relative(targetPath, path.resolve(path.dirname(sourcePath), spec))
      : spec;
    return statement
      .getText(source)
      .replace(/(["'])[^"']+\1;?$/, `"${retargeted}";`);
  });
const body = members
  .map(
    (m) =>
      `${m.comment ? `${m.comment.replace(/^/gm, "  ").replace(/^  $/gm, "")}\n` : ""}  ${m.name}: ${m.value},`,
  )
  .join("\n");
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(
  targetPath,
  `${imports.join("\n")}\n\n/** The state ${path.basename(sourcePath)} keeps while the app runs. */\nexport const ${objectName} = {\n${body}\n};\n`,
);
console.log(
  `${members.length} lets → ${objectName} in ${path.relative(root, targetPath)}: ${members.map((m) => m.name).join(", ")}`,
);
