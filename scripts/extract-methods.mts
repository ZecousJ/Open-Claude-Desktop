/**
 * Moves methods out of a class into a module of plain functions, keeping
 * every call working:
 *
 *   node --import tsx scripts/extract-methods.mts <source> <class> <target> <method> [method …]
 *
 * - Each named method (with its comments) becomes
 *   `export [async] function name(this: Class, …)` in <target>; its body
 *   is unchanged, so `this` still means the instance.
 * - The source imports the target as a namespace, declares the moved
 *   methods on the class through interface merging, and installs them on
 *   the prototype (non-enumerable, like class methods), so
 *   `Object.create(Class.prototype)` and prototype stubs keep working.
 * - Members the moved code reaches through `this` lose `private`, since a
 *   function outside the class body cannot see private members.
 * - The target gets the source's imports (pruned afterwards) and
 *   `import type { Class }`; types at the source's top level that the moved
 *   code uses are exported from the source and imported as types. A value
 *   there is refused: move it to a support module first, since a value
 *   import back into the source is a cycle.
 * Run prettier, prune-unused-imports, tsc and the tests afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const [sourceArg, className, targetArg, ...names] = process.argv.slice(2);
if (!sourceArg || !className || !targetArg || !names.length)
  throw new Error("usage: extract-methods <source> <class> <target> <method…>");
const sourcePath = path.resolve(sourceArg);
const targetPath = path.resolve(targetArg);
const text = fs.readFileSync(sourcePath, "utf8");
const source = ts.createSourceFile(
  sourcePath,
  text,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const klass = source.statements.find(
  (s): s is ts.ClassDeclaration =>
    ts.isClassDeclaration(s) && s.name?.text === className,
);
if (!klass) throw new Error(`No class ${className} in ${sourceArg}.`);

if (fs.existsSync(targetPath))
  throw new Error(`${targetArg} exists; move all of its methods in one run.`);
const wanted = new Set(names);
const methods = klass.members.filter(
  (m): m is ts.MethodDeclaration =>
    ts.isMethodDeclaration(m) &&
    ts.isIdentifier(m.name) &&
    wanted.has(m.name.text),
);
for (const name of wanted) {
  const found = methods.filter((m) => (m.name as ts.Identifier).text === name);
  if (found.length !== 1)
    throw new Error(
      `${name}: expected one method with a body, found ${found.length}.`,
    );
  if (!found[0].body) throw new Error(`${name} has no body (overload?).`);
  if (found[0].modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword))
    throw new Error(`${name} is static.`);
}

// A moved method named like one of the source's imports would clash with
// that import in the target.
for (const statement of source.statements)
  if (ts.isImportDeclaration(statement))
    statement.importClause?.namedBindings?.forEachChild((specifier) => {
      if (ts.isImportSpecifier(specifier) && wanted.has(specifier.name.text))
        throw new Error(
          `${specifier.name.text} is also imported by the source; alias that import first.`,
        );
    });

const moduleName = (() => {
  const base = path.basename(targetPath).replace(/\.tsx?$/, "");
  return base.replace(/[-.](\w)/g, (_, c: string) => c.toUpperCase());
})();
// A module that names its relative imports with ".ts" (run by Node's own
// type stripping) keeps doing so.
const tsExtensions = /from "\.{1,2}\/[^"]+\.ts"/.test(text);
const relative = (from: string, to: string) => {
  let spec = path
    .relative(path.dirname(from), to)
    .replace(/\.tsx?$/, "")
    .split(path.sep)
    .join("/");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return tsExtensions ? `${spec}.ts` : spec;
};

// Names the moved code reaches through `this`, and identifiers it uses.
const thisMembers = new Set<string>();
const identifiers = new Set<string>();
for (const method of methods) {
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ThisKeyword
    )
      thisMembers.add(node.name.text);
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(method);
}

// The class itself as a value (`new Class`, a static) would be an import
// cycle; such a method stays.
for (const method of methods) {
  const visit = (node: ts.Node) => {
    if (
      ts.isIdentifier(node) &&
      node.text === className &&
      !ts.isTypeReferenceNode(node.parent) &&
      !ts.isExpressionWithTypeArguments(node.parent)
    )
      throw new Error(
        `${(method.name as ts.Identifier).text} uses ${className} as a value; leave it in the class.`,
      );
    ts.forEachChild(node, visit);
  };
  if (method.body) visit(method.body);
}

// Top-level names of the source (other than imports and the class) that
// the moved code uses: exported from the source, imported by the target.
const sourceOwned: string[] = [];
const needExport: ts.Statement[] = [];
for (const statement of source.statements) {
  if (ts.isImportDeclaration(statement) || statement === klass) continue;
  const declared: string[] = [];
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name
  )
    declared.push(statement.name.text);
  if (ts.isVariableStatement(statement))
    for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name)) declared.push(d.name.text);
  const used = declared.filter(
    (name) =>
      identifiers.has(name) &&
      name !== className &&
      !sourceOwned.includes(name),
  );
  if (!used.length) continue;
  // A value the moved code imports back from the source would make an
  // import cycle, and a bundle can then install the methods before their
  // module has run.
  if (
    !ts.isInterfaceDeclaration(statement) &&
    !ts.isTypeAliasDeclaration(statement)
  )
    throw new Error(
      `The moved methods use ${used.join(", ")} from the source; move them to a support module first (extract-declarations).`,
    );
  sourceOwned.push(...used);
  const exported = statement.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
  if (!exported) needExport.push(statement);
}

const edits: { start: number; end: number; text: string }[] = [];

// The moved methods become functions.
const functions: string[] = [];
for (const method of methods) {
  const name = (method.name as ts.Identifier).text;
  const start = method.getFullStart();
  const leading = text.slice(start, method.getStart(source));
  const comments = leading.replace(/^\s*\n/, "").replace(/[ \t]+$/, "");
  const isAsync = method.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.AsyncKeyword,
  );
  const typeParams = method.typeParameters
    ? `<${method.typeParameters.map((p) => p.getText(source)).join(", ")}>`
    : "";
  const params = [
    `this: ${className}`,
    ...method.parameters.map((p) => p.getText(source)),
  ].join(", ");
  const returns = method.type ? `: ${method.type.getText(source)}` : "";
  const star = method.asteriskToken ? "*" : "";
  const body = method.body!.getText(source);
  const dedented = (comments + "\u0000" + body)
    .split("\n")
    .map((line) => line.replace(/^  /, ""))
    .join("\n");
  const [comment, code] = dedented.split("\u0000");
  functions.push(
    `${comment}export ${isAsync ? "async " : ""}function${star} ${name}${typeParams}(${params})${returns} ${code}`,
  );
  edits.push({ start, end: method.end, text: "" });
}

// Private members the moved code reaches lose `private`.
const relaxed: string[] = [];
const relax = (
  node: ts.ClassElement | ts.ParameterDeclaration,
  name: string,
) => {
  if (!thisMembers.has(name)) return;
  const modifier = ts
    .getModifiers(node as ts.HasModifiers)
    ?.find((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
  if (!modifier) return;
  const others = ts
    .getModifiers(node as ts.HasModifiers)!
    .filter((m) => m !== modifier);
  const replacement = ts.isParameter(node) && !others.length ? "public " : "";
  let end = modifier.end;
  while (text[end] === " ") end++;
  edits.push({ start: modifier.getStart(source), end, text: replacement });
  relaxed.push(name);
};
for (const member of klass.members) {
  if (methods.includes(member as ts.MethodDeclaration)) continue;
  if (member.name && ts.isIdentifier(member.name))
    relax(member, member.name.text);
  if (ts.isConstructorDeclaration(member))
    for (const param of member.parameters)
      if (ts.isIdentifier(param.name)) relax(param, param.name.text);
}

for (const statement of needExport)
  edits.push({
    start: statement.getStart(source),
    end: statement.getStart(source),
    text: "export ",
  });

// The source: namespace import, interface merge and prototype install.
const lastImport = [...source.statements]
  .reverse()
  .find(ts.isImportDeclaration);
const importAt = lastImport ? lastImport.end : 0;
const installerSpec = relative(
  sourcePath,
  path.join(path.dirname(sourcePath), "install-methods.ts"),
);
const hasInstaller = text.includes(`from "${installerSpec}"`);
edits.push({
  start: importAt,
  end: importAt,
  text:
    `\nimport * as ${moduleName} from "${relative(sourcePath, targetPath)}";` +
    (hasInstaller
      ? ""
      : `\nimport { installMethods } from "${installerSpec}";`),
});
// Without its `this` parameter, so a Pick of the class still types it.
const subclassed = ts.sys
  .readDirectory(process.cwd(), [".ts", ".tsx"], ["node_modules", "dist*"])
  .some((file) =>
    new RegExp(`\\bextends ${className}\\b`).test(
      fs.readFileSync(file, "utf8"),
    ),
  );
const merged = methods
  .map((method) => {
    const name = (method.name as ts.Identifier).text;
    const type = `typeof ${moduleName}.${name}`;
    // A class something extends gets method signatures, which a subclass
    // may override; others a one-line property.
    return method.typeParameters
      ? `  ${name}: ${type};`
      : subclassed
        ? `  ${name}(...args: Parameters<${type}>): ReturnType<${type}>;`
        : `  ${name}: OmitThisParameter<${type}>;`;
  })
  .join("\n");
edits.push({
  start: klass.end,
  end: klass.end,
  text:
    `\n\nexport interface ${className} {\n${merged}\n}\n` +
    `installMethods(${className}.prototype, ${moduleName});`,
});

edits.sort((a, b) => b.start - a.start);
let next = text;
for (const edit of edits)
  next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
fs.writeFileSync(sourcePath, next);

// The target: the source's imports (retargeted), the class type and the
// source's own top-level names.
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
const ownSpec = relative(targetPath, sourcePath);
imports.push(`import type { ${className} } from "${ownSpec}";`);
if (sourceOwned.length)
  imports.push(`import type { ${sourceOwned.join(", ")} } from "${ownSpec}";`);
fs.writeFileSync(
  targetPath,
  `${imports.join("\n")}\n\n${functions.join("\n\n")}\n`,
);

// The installer, once per directory.
const installerPath = path.join(path.dirname(sourcePath), "install-methods.ts");
if (!fs.existsSync(installerPath))
  fs.writeFileSync(
    installerPath,
    `/** Puts functions that take \`this\` on a prototype the way class methods sit there. */
export function installMethods(prototype: object, methods: object) {
  for (const [name, value] of Object.entries(methods))
    if (typeof value === "function")
      Object.defineProperty(prototype, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: false,
      });
}
`,
  );

console.log(
  `moved ${names.join(", ")} → ${path.relative(process.cwd(), targetPath)}` +
    (relaxed.length ? `; no longer private: ${relaxed.join(", ")}` : "") +
    (needExport.length ? `; now exported: ${sourceOwned.join(", ")}` : ""),
);
