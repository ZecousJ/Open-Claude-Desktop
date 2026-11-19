/** Inventory syntax, never infer runtime acceptance from a declaration. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import ts from "typescript";
import { coreMethods, domainMethods } from "../../shared/desktop-bridge.ts";
import { webMethodTable } from "../../shared/web-bridge-methods.ts";
import { webGoMethodRoutes } from "../../shared/web-protocol.ts";

const root = path.resolve(import.meta.dirname, "../..");
const frontendRequire = createRequire(path.join(root, "backend/frontend/package.json"));
const { parse: parseVue } = frontendRequire("vue/compiler-sfc");
const files = execFileSync(
  "git",
  ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .filter((file) => fs.existsSync(path.join(root, file)));
const ipc = [],
  symbols = [],
  transports = [];
for (const file of files.filter(
  (file) => file.startsWith("backend/frontend/src/") && file.endsWith(".vue"),
)) {
  symbols.push([
    path.basename(file, ".vue"),
    "Vue SFC",
    file,
    1,
    "组件源码已登记；逐状态运行核验未完成",
  ]);
}
const literal = (node) =>
  node && (ts.isStringLiteralLike(node) ? node.text : null);
for (const file of files.filter(
  (file) =>
    /^(electron|src|src-web|shared|runner\/src|server|backend\/frontend\/src)\//.test(
      file,
    ) &&
    /(?:\.[cm]?[jt]sx?|\.vue)$/.test(file) &&
    !/(?:\.test\.|\.spec\.|\.d\.ts$|\/__tests__\/)/.test(file),
)) {
  const original = fs.readFileSync(path.join(root, file), "utf8");
  let script = original;
  if (file.endsWith(".vue")) {
    const { descriptor, errors } = parseVue(original, { filename: file });
    if (errors.length) throw Error(`Cannot parse Vue source: ${file}: ${errors}`);
    // Preserve source offsets so every location still points into the SFC.
    const characters = original.split("").map((char) => char === "\n" || char === "\r" ? char : " ");
    for (const block of [descriptor.script, descriptor.scriptSetup].filter(Boolean)) {
      if (block.src) throw Error(`External Vue script needs inventory resolution: ${file}: ${block.src}`);
      for (let i = 0; i < block.content.length; i++)
        characters[block.loc.start.offset + i] = block.content[i];
    }
    script = characters.join("");
  }
  const source = ts.createSourceFile(
    file,
    script,
    ts.ScriptTarget.Latest,
    true,
  );
  if (source.parseDiagnostics.length)
    throw Error(`Cannot parse inventory source: ${file}: ${source.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText," ")).join("; ")}`);
  const location = (node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const declaration = (kind, node, name) =>
    symbols.push([
      name,
      kind,
      file,
      location(node),
      "源码定义已登记；逐状态运行核验未完成",
    ]);
  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      /^[A-Z]/.test(node.name.text)
    )
      declaration("function", node, node.name.text);
    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      /^[A-Z]/.test(node.name.text)
    )
      declaration("class", node, node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      /^[A-Z]/.test(node.name.text) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        ts.isCallExpression(node.initializer))
    )
      declaration("variable", node, node.name.text);
    if (ts.isCallExpression(node)) {
      const expression = node.expression,
        callee = expression.getText(source),
        first = node.arguments[0];
      if (first && file.startsWith("electron/")) {
        let kind;
        if (ts.isIdentifier(expression) && expression.text === "handle")
          kind = "handle";
        else if (/^ipcMain\.(handle|handleOnce|on|once)$/.test(callee))
          kind = callee;
        else if (
          /^ipcRenderer\.(invoke|send|sendSync|postMessage|on|once)$/.test(
            callee,
          )
        )
          kind = callee;
        else if (
          ts.isPropertyAccessExpression(expression) &&
          /^(send|sendToFrame|postMessage)$/.test(expression.name.text) &&
          /(?:webContents|contents)$/.test(
            expression.expression.getText(source),
          )
        )
          kind = `main.${expression.name.text}`;
        if (kind)
          ipc.push([
            kind,
            literal(first) ?? first.getText(source),
            file,
            location(node),
            "语法树登记；动态通道、调用链和端到端验收待核验",
          ]);
      }
      if (
        (ts.isPropertyAccessExpression(expression) &&
          /^(get|post|put|patch|delete|head|options|request|fetch|createServer)$/.test(
            expression.name.text,
          )) ||
        (ts.isIdentifier(expression) && expression.text === "fetch")
      ) {
        const httpCandidate =
          /fetch|(?:apiClient|client|axios|router|http|https|app)\./.test(
            callee,
          );
        if (httpCandidate)
          transports.push([
            callee,
            first
              ? ts.isArrowFunction(first) || ts.isFunctionExpression(first)
                ? `回调函数；见 ${file}:${location(first)}`
                : (literal(first) ?? first.getText(source))
              : "无路径参数",
            file,
            location(node),
            "HTTP 调用候选；需解析地址、注册关系与运行时结果",
          ]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
const methods = [
  ...new Map([["core", coreMethods], ...Object.entries(domainMethods)]),
].flatMap(([domain, names]) =>
  names.map((name) => ({
    name,
    domain,
    kind: webMethodTable.get(name),
    route: webGoMethodRoutes[name] ?? null,
  })),
);
if (new Set(methods.map((item) => item.name)).size !== methods.length)
  throw Error("Duplicate exposed bridge methods");
if (
  methods.length !== webMethodTable.size ||
  methods.some((item) => !item.kind)
)
  throw Error("Desktop/Web bridge registry mismatch");
process.stdout.write(
  JSON.stringify({ files, ipc, symbols, transports, methods }),
);
