#!/usr/bin/env node
/**
 * Keeps Node and Electron code out of the web app (web plan §2, W-ARCH
 * "W-V"). Walks the import graph the browser would load, from web.html's
 * entry (src-web/main.tsx) through every static and dynamic import of our
 * own source, and fails on:
 *
 * - a file under electron/, server/, runner/, scripts/ or backend/;
 * - the `electron` package, or a Node built-in (`fs`, `node:path`, …).
 *
 * `import type` and `export type` are erased at build time and are allowed.
 * Packages in node_modules are not walked: the bundle check
 * (check-web-bundle.mjs) inspects what they bring in.
 *
 * Usage: `node scripts/check-web-imports.mjs` (exit code 1 on a violation).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Folders of this repository whose code never runs in a browser. */
export const nodeOnlyFolders = Object.freeze([
  "electron",
  "server",
  "runner",
  "scripts",
  "backend",
]);

const builtins = new Set(
  builtinModules.flatMap((name) => [name, name.split("/")[0]]),
);
const extensions = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const sourceFile = /\.(m?[jt]sx?)$/;

/** Why a bare specifier is not allowed in the web app, or null. */
export function forbiddenPackage(specifier) {
  if (specifier === "electron" || specifier.startsWith("electron/"))
    return "the electron package";
  if (specifier.startsWith("node:")) return "a Node built-in";
  const name = specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
  if (builtins.has(name) || builtins.has(specifier)) return "a Node built-in";
  return null;
}

/** Runtime imports of one file: `[{ specifier, line }]`. */
export function runtimeImports(fileName, text) {
  const kind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    false,
    kind,
  );
  const found = [];
  const add = (node, literal) =>
    found.push({
      specifier: literal.text,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const typeOnly =
        clause?.isTypeOnly ||
        (clause &&
          !clause.name &&
          clause.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly) add(node, node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (!node.isTypeOnly) add(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node, node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      add(node, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function isFile(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A relative specifier as a file, the way Vite resolves it, or null. */
export function resolveRelative(fromFile, specifier) {
  const bare = specifier.split(/[?#]/)[0];
  const base = path.resolve(path.dirname(fromFile), bare);
  const candidates = [base];
  // "./x.js" may name "./x.ts" (TypeScript's convention).
  const swapped = base.replace(/\.(m?)js(x?)$/, ".$1ts$2");
  if (swapped !== base) candidates.push(swapped);
  for (const extension of extensions) candidates.push(base + extension);
  for (const extension of extensions)
    candidates.push(path.join(base, `index${extension}`));
  return candidates.find(isFile) ?? null;
}

/** The entry scripts a page names. */
export function pageEntries(htmlFile) {
  const html = readFileSync(htmlFile, "utf8");
  return [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(
    ([, src]) =>
      src.startsWith("/")
        ? path.join(repoRoot, src)
        : path.resolve(path.dirname(htmlFile), src),
  );
}

/**
 * Walks the graph from `entries` (absolute file names). Returns the files
 * visited and the violations, each `{ file, line, specifier, reason }`.
 */
export function checkWebImports({
  entries = pageEntries(path.join(repoRoot, "web.html")),
  root = repoRoot,
} = {}) {
  const visited = new Set();
  const violations = [];
  const pending = [...entries];
  const relative = (file) =>
    path.relative(root, file).split(path.sep).join("/");
  for (const entry of entries)
    if (!existsSync(entry))
      violations.push({
        file: "web.html",
        line: 0,
        specifier: relative(entry),
        reason: "the entry script does not exist",
      });
  while (pending.length) {
    const file = pending.pop();
    if (visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    if (!sourceFile.test(file)) continue; // stylesheets, JSON, assets
    const text = readFileSync(file, "utf8");
    for (const { specifier, line } of runtimeImports(file, text)) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        const target = specifier.startsWith("/")
          ? resolveRelative(path.join(root, "index"), `.${specifier}`)
          : resolveRelative(file, specifier);
        if (!target) {
          violations.push({
            file: relative(file),
            line,
            specifier,
            reason: "the import does not resolve to a file",
          });
          continue;
        }
        const top = relative(target).split("/")[0];
        if (
          nodeOnlyFolders.includes(top) ||
          relative(target).startsWith("..")
        ) {
          violations.push({
            file: relative(file),
            line,
            specifier,
            reason: relative(target).startsWith("..")
              ? "a file outside the repository"
              : `Node-only code (${top}/)`,
          });
          continue;
        }
        pending.push(target);
        continue;
      }
      const reason = forbiddenPackage(specifier);
      if (reason)
        violations.push({ file: relative(file), line, specifier, reason });
    }
  }
  return { files: [...visited].map(relative).sort(), violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { files, violations } = checkWebImports();
  if (violations.length) {
    for (const { file, line, specifier, reason } of violations)
      console.error(`✗ ${file}:${line} imports "${specifier}": ${reason}.`);
    console.error(
      "The web app runs in a browser: move this code behind the bridge (src-web/) or import it with `import type`.",
    );
    process.exit(1);
  }
  console.log(
    `✓ Web import graph: ${files.length} files, no Node or Electron imports.`,
  );
}
