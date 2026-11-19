/**
 * Moves a run of statements out of a function body into a function of its
 * own in another module, keeping the code working:
 *
 *   node --import tsx scripts/extract-region.mts <source> <first line> <last line> <target> <function> <result>
 *
 * - Lines first..last (1-based, whole statements inside one function body)
 *   must end with the declaration of `result` (`const card = …`); the run
 *   becomes `export function <function>(kit: <Function>Kit) { …; return result; }`
 *   in <target>, and the source gets `const result = <function>({ … });`.
 * - Every name the run reads that the enclosing function declares becomes a
 *   member of the kit, typed from the checker; module-level names and imports
 *   are imported into the target (from their original module, or from the
 *   source for its own top-level declarations, which are then exported).
 * - Types in the kit are printed with import("…") references made relative.
 * Run prettier and tsc afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// JSX mode: `--jsx <source> <line> <target> <Component>` moves the JSX
// element that starts on that line into a component of its own; the names
// it reads become props (typed as narrowed where it reads them).
const jsxMode = process.argv[2] === "--jsx";
const args = process.argv.slice(jsxMode ? 3 : 2);
const [sourceArg, firstArg, lastArg, targetArg, fnName, resultName] = jsxMode
  ? [args[0], args[1], args[1], args[2], args[3], "-"]
  : args;
if (!sourceArg || !firstArg || !lastArg || !targetArg || !fnName || !resultName)
  throw new Error(
    "usage: extract-region <source> <first> <last> <target> <function> <result>\n" +
      "       extract-region --jsx <source> <line> <target> <Component>",
  );
const root = process.cwd();
const sourcePath = path.resolve(sourceArg);
const targetPath = path.resolve(targetArg);
const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json")!;
const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  root,
);
const program = ts.createProgram({
  rootNames: [sourcePath],
  options: config.options,
});
const checker = program.getTypeChecker();
(globalThis as { __checker?: ts.TypeChecker }).__checker = checker;
declare global {
  var __checker: ts.TypeChecker;
}
const source = program.getSourceFile(sourcePath)!;
const text = source.getFullText();
const lineStarts = source.getLineStarts();
const first = Number(firstArg) - 1;
const last = Number(lastArg) - 1;
const regionStart = lineStarts[first];
const regionEnd =
  last + 1 < lineStarts.length ? lineStarts[last + 1] : text.length;

// The statements in the region, and the function that holds them.
let holder: ts.FunctionLikeDeclaration | undefined;
const statements: ts.Statement[] = [];
function findStatements(node: ts.Node) {
  if (
    (ts.isBlock(node) || ts.isSourceFile(node)) &&
    node.pos <= regionStart &&
    node.end >= regionEnd
  ) {
    const inside = node.statements.filter(
      (statement) =>
        statement.getStart(source) >= regionStart && statement.end <= regionEnd,
    );
    if (inside.length) {
      statements.splice(0, statements.length, ...inside);
      if (ts.isBlock(node) && ts.isFunctionLike(node.parent))
        holder = node.parent as ts.FunctionLikeDeclaration;
    }
  }
  ts.forEachChild(node, findStatements);
}
let element:
  ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment | undefined;
if (jsxMode) {
  const find = (node: ts.Node) => {
    if (element) return;
    if (
      (ts.isJsxElement(node) ||
        ts.isJsxSelfClosingElement(node) ||
        ts.isJsxFragment(node)) &&
      source.getLineAndCharacterOfPosition(node.getStart(source)).line === first
    ) {
      element = node;
      return;
    }
    ts.forEachChild(node, find);
  };
  find(source);
  if (!element) throw new Error(`No JSX element starts on line ${firstArg}.`);
  // The outermost function around it: names from enclosing callbacks
  // (a list's map) are props too.
  let up: ts.Node | undefined = element.parent;
  let outer: ts.Node | undefined;
  while (up && !ts.isSourceFile(up)) {
    if (ts.isFunctionLike(up)) outer = up;
    up = up.parent;
  }
  if (!outer) throw new Error("The element is not inside a function.");
  holder = outer as ts.FunctionLikeDeclaration;
  statements.push(element as unknown as ts.Statement);
} else findStatements(source);
if (!statements.length || !holder)
  throw new Error("The lines are not whole statements inside a function.");
const result = statements.at(-1)!;
if (
  !jsxMode &&
  resultName !== "-" &&
  (!ts.isVariableStatement(result) ||
    !result.declarationList.declarations.some(
      (d) => ts.isIdentifier(d.name) && d.name.text === resultName,
    ))
)
  throw new Error(`The last statement must declare ${resultName}.`);
const runStart = jsxMode
  ? statements[0].getStart(source)
  : statements[0].getFullStart();
const runEnd = result.end;

// Names the run reads and where they are declared.
const kit = new Map<string, ts.Symbol>();
const firstUse = new Map<string, ts.Node>();
const moduleNames = new Map<string, ts.Symbol>();
const declaredInRun = (decl: ts.Node) =>
  decl.pos >= runStart && decl.end <= runEnd;
const insideHolder = (decl: ts.Node) =>
  decl.pos >= holder!.pos && decl.end <= holder!.end;
function visit(node: ts.Node) {
  if (ts.isIdentifier(node)) {
    const parent = node.parent;
    const property =
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isJsxAttribute(parent) && parent.name === node) ||
      ts.isQualifiedName(parent);
    if (!property) {
      let symbol = ts.isShorthandPropertyAssignment(parent)
        ? checker.getShorthandAssignmentValueSymbol(parent)
        : checker.getSymbolAtLocation(node);
      if (
        symbol &&
        symbol.flags & ts.SymbolFlags.Alias &&
        !symbol.declarations?.some(insideHolder)
      )
        moduleNames.set(node.text, symbol);
      else if (symbol?.declarations?.length) {
        const decl = symbol.declarations[0];
        if (decl.getSourceFile() === source && !declaredInRun(decl)) {
          if (insideHolder(decl)) {
            kit.set(node.text, symbol);
            // The first read at the run's own level (not in a closure)
            // carries the narrowing the run relies on.
            let up: ts.Node = node.parent;
            while (up !== holder && !ts.isFunctionLike(up)) up = up.parent;
            if (up === holder && !firstUse.has(node.text))
              firstUse.set(node.text, node);
          } else if (!ts.isParameter(decl) || !insideHolder(decl))
            moduleNames.set(node.text, symbol);
        }
      }
    }
  }
  ts.forEachChild(node, visit);
}
statements.forEach(visit);

// A `let` the run reads would reach it as a copy: later assignments outside
// (or inside) would no longer be seen on the other side.
for (const [name, symbol] of kit) {
  const decl = symbol.valueDeclaration;
  if (
    decl &&
    ts.isVariableDeclaration(decl) &&
    !(decl.parent.flags & ts.NodeFlags.Const)
  )
    throw new Error(
      `The run reads ${name}, a let of the enclosing function; it cannot be passed by value.`,
    );
}

// Names the run declares that the holder still reads after it: returned.
const runDeclared = new Map<
  ts.Symbol,
  ts.VariableDeclarationList | undefined
>();
for (const statement of statements) {
  if (ts.isVariableStatement(statement))
    for (const d of statement.declarationList.declarations) {
      const names: ts.Identifier[] = [];
      const gather = (name: ts.BindingName) => {
        if (ts.isIdentifier(name)) names.push(name);
        else
          for (const e of name.elements)
            if (!ts.isOmittedExpression(e)) gather(e.name);
      };
      gather(d.name);
      for (const name of names) {
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol) runDeclared.set(symbol, statement.declarationList);
      }
    }
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    const symbol = checker.getSymbolAtLocation(statement.name);
    if (symbol) runDeclared.set(symbol, undefined);
  }
}
const outputs = new Set<string>();
// Code before the run may read them too, inside closures that run later.
const afterRun = (node: ts.Node) => {
  if ((node.pos >= runEnd || node.end <= runStart) && ts.isIdentifier(node)) {
    const parent = node.parent;
    const symbol = ts.isShorthandPropertyAssignment(parent)
      ? checker.getShorthandAssignmentValueSymbol(parent)
      : checker.getSymbolAtLocation(node);
    if (symbol && runDeclared.has(symbol)) {
      const list = runDeclared.get(symbol);
      if (list && !(list.flags & ts.NodeFlags.Const))
        throw new Error(
          `${node.text} is a let the code after the run still uses.`,
        );
      outputs.add(node.text);
    }
  }
  if (node.end <= runStart || node.pos >= runEnd || node.end > runEnd)
    ts.forEachChild(node, afterRun);
};
if (!jsxMode) afterRun(holder!.body!);
if (resultName !== "-") outputs.delete(resultName);
const returned = resultName !== "-" ? [resultName, ...outputs] : [...outputs];
// A run that only acts (fills an object, registers something) returns nothing.
const returnText =
  resultName !== "-" && !outputs.size
    ? resultName
    : `{ ${returned.join(", ")} }`;

// Kit member types, with import("abs") made relative to the target.
const targetDir = path.dirname(targetPath);
function relativeModule(file: string) {
  let spec = path.relative(targetDir, file).replace(/\.(d\.)?tsx?$/, "");
  if (!spec.startsWith(".")) spec = `./${spec}`;
  return spec;
}
// Statement mode: each kit name as narrowed where the run starts, read from
// a copy of the source with a probe `;[a, b, …];` inserted there.
const probed = new Map<string, ts.Type>();
let probeChecker = checker;
if (!jsxMode && kit.size) {
  const names = [...kit.keys()];
  const probeText =
    text.slice(0, runStart) +
    `\n;[${names.join(", ")}];` +
    text.slice(runStart);
  const host = ts.createCompilerHost(config.options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError, create) =>
    path.resolve(fileName) === sourcePath
      ? ts.createSourceFile(fileName, probeText, language, true)
      : getSourceFile(fileName, language, onError, create);
  const probeProgram = ts.createProgram({
    rootNames: [sourcePath],
    options: config.options,
    host,
  });
  probeChecker = probeProgram.getTypeChecker();
  const probeSource = probeProgram.getSourceFile(sourcePath)!;
  const at = runStart + 2;
  const find = (node: ts.Node): ts.ArrayLiteralExpression | undefined =>
    node.getStart(probeSource) <= at + 1 && node.end > at
      ? ts.isArrayLiteralExpression(node) && node.getStart(probeSource) === at
        ? node
        : ts.forEachChild(node, find)
      : undefined;
  const array = find(probeSource);
  if (array)
    array.elements.forEach((element, index) =>
      probed.set(names[index], probeChecker.getTypeAtLocation(element)),
    );
}
function typeOf(name: string, symbol: ts.Symbol) {
  const decl = symbol.valueDeclaration ?? symbol.declarations![0];
  const checker = probed.has(name) ? probeChecker : globalThis.__checker;
  const type = probed.has(name)
    ? probed.get(name)!
    : firstUse.has(name)
      ? checker.getTypeAtLocation(firstUse.get(name)!)
      : checker.getTypeOfSymbolAtLocation(symbol, decl);
  const flags =
    ts.NodeBuilderFlags.NoTruncation |
    ts.NodeBuilderFlags.UseFullyQualifiedType |
    ts.NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope |
    ts.NodeBuilderFlags.NoTypeReduction;
  const node = checker.typeToTypeNode(type, undefined, flags);
  const printed = node
    ? ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, source)
    : checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation);
  return (
    printed
      // React's node type, as the checker spells it out.
      .replace(
        /string \| number \| bigint \| boolean \| Iterable<React\.ReactNode> \| Promise<AwaitedReactNode> \| React\.JSX\.Element \| null \| undefined/g,
        "React.ReactNode",
      )
      .replace(/import\("([^"]+)"\)/g, (_m, file: string) => {
        if (!path.isAbsolute(file)) return `import("${file}")`;
        const resolved =
          fs.existsSync(`${file}.ts`) ||
          fs.existsSync(`${file}.tsx`) ||
          fs.existsSync(`${file}.d.ts`)
            ? file
            : file;
        return `import("${relativeModule(resolved)}")`;
      })
  );
}

// Imports for module-level names.
const importLines: string[] = [];
const exportFromSource = new Set<string>();
const sourceSpec = relativeModule(sourcePath);
for (const [name, symbol] of moduleNames) {
  const decl = symbol.declarations![0];
  if (
    ts.isImportSpecifier(decl) ||
    ts.isImportClause(decl) ||
    ts.isNamespaceImport(decl)
  ) {
    const importDecl = ts.isImportSpecifier(decl)
      ? decl.parent.parent.parent
      : ts.isImportClause(decl)
        ? decl.parent
        : decl.parent.parent;
    const spec = (importDecl.moduleSpecifier as ts.StringLiteral).text;
    const absolute = spec.startsWith(".")
      ? path.resolve(path.dirname(sourcePath), spec)
      : undefined;
    const from = absolute ? relativeModule(absolute) : spec;
    const typeOnly =
      importDecl.importClause?.isTypeOnly ||
      (ts.isImportSpecifier(decl) && decl.isTypeOnly);
    if (ts.isImportSpecifier(decl)) {
      const imported = decl.propertyName
        ? `${decl.propertyName.text} as ${name}`
        : name;
      importLines.push(
        `import ${typeOnly ? "type " : ""}{ ${imported} } from "${from}";`,
      );
    } else if (ts.isImportClause(decl))
      importLines.push(
        `import ${typeOnly ? "type " : ""}${name} from "${from}";`,
      );
    else importLines.push(`import * as ${name} from "${from}";`);
  } else if (decl.getSourceFile() === source) {
    exportFromSource.add(name);
    const typeOnly =
      ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl);
    importLines.push(
      `import ${typeOnly ? "type " : ""}{ ${name} } from "${sourceSpec}";`,
    );
  }
}

const kitName = jsxMode
  ? `${fnName}Props`
  : `${fnName[0].toUpperCase()}${fnName.slice(1)}Kit`;
const members = [...kit.keys()].sort();
const memberTypes = new Map(
  members.map((name) => [name, typeOf(name, kit.get(name)!)]),
);

// Type names the printed kit uses: imported as types from where the source
// gets them (or from the source itself for its own top-level types).
const typeImports = new Map<string, string>();
const scope = holder!.body ?? holder!;
for (const printed of memberTypes.values())
  for (const match of printed.matchAll(/(?<![.\w$"'])([A-Za-z_$][\w$]*)/g)) {
    const name = match[1];
    if (typeImports.has(name) || moduleNames.has(name)) continue;
    const symbol = checker.resolveName(
      name,
      scope,
      ts.SymbolFlags.Type | ts.SymbolFlags.Namespace,
      false,
    );
    const decl = symbol?.declarations?.[0];
    if (!decl) continue;
    if (ts.isImportSpecifier(decl) || ts.isImportClause(decl)) {
      const importDecl = ts.isImportSpecifier(decl)
        ? decl.parent.parent.parent
        : decl.parent;
      const spec = (importDecl.moduleSpecifier as ts.StringLiteral).text;
      const from = spec.startsWith(".")
        ? relativeModule(path.resolve(path.dirname(sourcePath), spec))
        : spec;
      const imported =
        ts.isImportSpecifier(decl) && decl.propertyName
          ? `${decl.propertyName.text} as ${name}`
          : name;
      typeImports.set(
        name,
        ts.isImportClause(decl)
          ? `import type ${name} from "${from}";`
          : `import type { ${imported} } from "${from}";`,
      );
    } else if (decl.getSourceFile() === source && decl.parent === source) {
      exportFromSource.add(name);
      typeImports.set(name, `import type { ${name} } from "${sourceSpec}";`);
    }
  }
// Types reached only through inference (declared in other modules).
const declared = new Map<string, ts.Declaration>();
function collect(type: ts.Type, depth: number, seen: Set<ts.Type>) {
  if (seen.has(type) || depth > 8) return;
  seen.add(type);
  for (const symbol of [type.aliasSymbol, type.getSymbol()])
    if (
      symbol?.declarations?.length &&
      symbol.flags &
        (ts.SymbolFlags.Interface |
          ts.SymbolFlags.TypeAlias |
          ts.SymbolFlags.Class |
          ts.SymbolFlags.Enum)
    )
      declared.set(symbol.name, symbol.declarations[0]);
  for (const argument of type.aliasTypeArguments ?? [])
    collect(argument, depth + 1, seen);
  if (type.isUnionOrIntersection())
    for (const member of type.types) collect(member, depth, seen);
  if (type.flags & ts.TypeFlags.Object) {
    const object = type as ts.ObjectType;
    if (object.objectFlags & ts.ObjectFlags.Reference)
      for (const argument of checker.getTypeArguments(
        object as ts.TypeReference,
      ))
        collect(argument, depth + 1, seen);
    if (
      object.objectFlags & ts.ObjectFlags.Anonymous ||
      !type.getSymbol()?.declarations?.length
    ) {
      for (const property of type.getProperties()) {
        const decl = property.valueDeclaration ?? property.declarations?.[0];
        if (decl)
          collect(
            checker.getTypeOfSymbolAtLocation(property, decl),
            depth + 1,
            seen,
          );
      }
    }
    for (const signature of type.getCallSignatures()) {
      for (const parameter of signature.getParameters()) {
        const decl = parameter.valueDeclaration ?? parameter.declarations?.[0];
        if (decl)
          collect(
            checker.getTypeOfSymbolAtLocation(parameter, decl),
            depth + 1,
            seen,
          );
      }
      collect(signature.getReturnType(), depth + 1, seen);
    }
  }
}
for (const name of members) {
  const symbol = kit.get(name)!;
  const decl = symbol.valueDeclaration ?? symbol.declarations![0];
  collect(checker.getTypeOfSymbolAtLocation(symbol, decl), 0, new Set());
}
const printedTypes = [...memberTypes.values()].join("\n");
for (const [name, decl] of declared) {
  if (typeImports.has(name) || moduleNames.has(name)) continue;
  if (!new RegExp(`(?<![.\\w$])${name}(?![\\w$])`).test(printedTypes)) continue;
  const file = decl.getSourceFile();
  if (program.isSourceFileDefaultLibrary(file)) continue;
  // A global type (DOM Element, Event…) needs no import.
  const global = checker.resolveName(name, source, ts.SymbolFlags.Type, false);
  if (
    global?.declarations?.some((d) =>
      program.isSourceFileDefaultLibrary(d.getSourceFile()),
    )
  )
    continue;
  if (file.isDeclarationFile && file.fileName.includes("node_modules")) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file.fileName);
    if (match && !match[1].startsWith("@types/typescript"))
      typeImports.set(
        name,
        `import type { ${name} } from "${match[1].replace(/^@types\//, "")}";`,
      );
    continue;
  }
  if (file === source) {
    exportFromSource.add(name);
    typeImports.set(name, `import type { ${name} } from "${sourceSpec}";`);
  } else if (
    ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export ||
    !ts.isSourceFile(decl.parent)
  )
    typeImports.set(
      name,
      `import type { ${name} } from "${relativeModule(file.fileName)}";`,
    );
}
// Names still unknown: the one project module that exports a type so named.
const knownNames = new Set([
  ...typeImports.keys(),
  ...moduleNames.keys(),
  ...members,
]);
for (const match of printedTypes.matchAll(/(?<![.\w$"'])([A-Z][\w$]*)/g)) {
  const name = match[1];
  if (knownNames.has(name)) continue;
  knownNames.add(name);
  if (
    checker.resolveName(name, scope, ts.SymbolFlags.Type, false) &&
    !checker
      .resolveName(name, scope, ts.SymbolFlags.Type, false)!
      .declarations?.some((d) => d.getSourceFile() !== source)
  )
    continue;
  const exporters = program
    .getSourceFiles()
    .filter(
      (file) =>
        !file.isDeclarationFile &&
        !file.fileName.includes("node_modules") &&
        file.statements.some(
          (st) =>
            (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) &&
            st.name.text === name &&
            st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
        ),
    );
  if (exporters.length === 1 && exporters[0] !== source)
    typeImports.set(
      name,
      `import type { ${name} } from "${relativeModule(exporters[0].fileName)}";`,
    );
}
importLines.push(...typeImports.values());
const run = text.slice(runStart, runEnd);
for (const name of members)
  if (jsxMode && (name === "key" || name === "ref"))
    throw new Error(
      `The element reads ${name}, which a component cannot take as a prop.`,
    );
const keyAttribute =
  element && !ts.isJsxFragment(element)
    ? (ts.isJsxElement(element)
        ? element.openingElement
        : element
      ).attributes.properties.find(
        (a) => ts.isJsxAttribute(a) && a.name.getText(source) === "key",
      )
    : undefined;
const body = jsxMode
  ? [
      `/** What ${fnName} needs from ${path.basename(sourcePath)}. */`,
      `export interface ${kitName} {`,
      ...members.map((name) => `  ${name}: ${memberTypes.get(name)};`),
      `}`,
      ``,
      `export function ${fnName}(${members.length ? `{ ${members.join(", ")} }: ${kitName}` : ""}) {`,
      `  return (`,
      run,
      `  );`,
      `}`,
      ``,
    ].join("\n")
  : [
      `/** What ${fnName} needs from ${path.basename(sourcePath)}. */`,
      `export interface ${kitName} {`,
      ...members.map((name) => `  ${name}: ${memberTypes.get(name)};`),
      `}`,
      ``,
      `export function ${fnName}(kit: ${kitName}) {`,
      members.length ? `  const { ${members.join(", ")} } = kit;` : ``,
      run.replace(/^\n+/, ""),
      returned.length
        ? `  return ${returnText === resultName ? returnText : `${returnText} as const`};`
        : ``,
      `}`,
      ``,
    ].join("\n");
const existing = fs.existsSync(targetPath)
  ? fs.readFileSync(targetPath, "utf8")
  : "";
// Names an existing target already has: not imported again.
const bound = new Set<string>();
if (existing)
  for (const s of ts.createSourceFile(
    targetPath,
    existing,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ).statements) {
    if (ts.isImportDeclaration(s)) {
      const clause = s.importClause;
      if (clause?.name) bound.add(clause.name.text);
      const b = clause?.namedBindings;
      if (b && ts.isNamespaceImport(b)) bound.add(b.name.text);
      if (b && ts.isNamedImports(b))
        for (const e of b.elements) bound.add(e.name.text);
    } else if (
      (ts.isFunctionDeclaration(s) ||
        ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) ||
        ts.isClassDeclaration(s)) &&
      s.name
    )
      bound.add(s.name.text);
    else if (ts.isVariableStatement(s))
      for (const d of s.declarationList.declarations)
        if (ts.isIdentifier(d.name)) bound.add(d.name.text);
  }
const localName = (specifier: string) =>
  specifier
    .split(/\s+as\s+/)
    .pop()!
    .trim();
// One import per module (values and types apart).
const merged = new Map<string, Set<string>>();
const plain: string[] = [];
for (const line of new Set(importLines)) {
  const match = /^import (type )?\{ (.+) \} from "(.+)";$/.exec(line);
  if (!match) {
    const name = /^import (?:type )?(?:\* as )?(\w+)/.exec(line)?.[1];
    if (!name || !bound.has(name)) plain.push(line);
    continue;
  }
  if (bound.has(localName(match[2]))) continue;
  const key = `${match[1] ? "type " : ""}${match[3]}`;
  if (!merged.has(key)) merged.set(key, new Set());
  merged.get(key)!.add(match[2]);
}
const importText = [
  ...plain,
  ...[...merged].map(([key, names]) => {
    const typeOnly = key.startsWith("type ");
    const from = typeOnly ? key.slice(5) : key;
    return `import ${typeOnly ? "type " : ""}{ ${[...names].join(", ")} } from "${from}";`;
  }),
].join("\n");
fs.writeFileSync(targetPath, `${importText}\n${existing}\n${body}`);

// The source: the call in place of the run, an import, exported names.
let out =
  text.slice(0, runStart) +
  (jsxMode
    ? `<${fnName}${keyAttribute ? ` ${keyAttribute.getText(source)}` : ""}${members.map((m) => ` ${m}={${m}}`).join("")} />`
    : returned.length
      ? `\n  const ${returnText} = ${fnName}({ ${members.join(", ")} });`
      : `\n  ${fnName}({ ${members.join(", ")} });`) +
  text.slice(runEnd);
for (const name of exportFromSource) {
  const pattern = new RegExp(
    `^(const|let|function|async function|class|type|interface|enum) ${name}\\b`,
    "m",
  );
  out = out.replace(pattern, (m) => `export ${m}`);
}
const targetSpec = relativeModule(targetPath).replace(/^\.\/\.\.\//, "../");
const fromSource = path
  .relative(path.dirname(sourcePath), targetPath)
  .replace(/\.(tsx?)$/, "");
const spec = fromSource.startsWith(".") ? fromSource : `./${fromSource}`;
out = out.replace(
  /^(import [^;]+;\n)(?!import)/m,
  `$1import { ${fnName} } from "${spec}";\n`,
);
void targetSpec;
fs.writeFileSync(sourcePath, out);
console.log(
  `moved lines ${firstArg}–${lastArg} → ${fnName} in ${path.relative(root, targetPath)} (${members.length} kit members, ${importLines.length} imports)`,
);
