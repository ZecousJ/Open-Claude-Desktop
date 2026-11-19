import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const unifiedChatFiles = [
  "shared-2-CuvP2TaI.js",
  "shared-5-DQLFfFYX.js",
  "shared-20-C2JgSgMH.js",
  "shared-22-Ciy9U3_0.js",
  "shared-46-BL5bnnMV.js",
  "cf4f70727-BebTa_1T.js",
  "cf400e6a4-B6JbCpjm.js",
  "ca768caa9-CxTsvCY0.js",
  "shared-1-B16QIYNI.js",
  "shared-23-xVessQLu.js",
  "shared-160-BGt89-ku.js",
  "cc011544b-Pr8E2gr7.js",
  "c2771e1f6-OQUR_HHd.js",
  "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js",
];

export const retiredChatPages = ["c71860c77-CH8nlfB6.js"];

function editNodes(file, source, visit) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  const replace = (node, value) => edits.push({ start: node.getStart(tree), end: node.end, value });
  const walk = node => {
    if (visit(node, tree, replace, edits)) return;
    ts.forEachChild(node, walk);
  };
  walk(tree);
  for (const edit of edits.sort((a, b) => b.start - a.start))
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
  return source;
}

function removeComponent(file, source, name) {
  let removed = 0;
  source = editNodes(file, source, (node, tree, replace, edits) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      replace(node, "");
      removed++;
      return true;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      const list = node.parent.declarations;
      const index = list.indexOf(node);
      if (list.length === 1) replace(node.parent.parent, "");
      else if (index < list.length - 1)
        edits.push({ start: node.getStart(tree), end: list[index + 1].getStart(tree), value: "" });
      else edits.push({ start: list[index - 1].end, end: node.end, value: "" });
      removed++;
      return true;
    }
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === name) {
      replace(node, "null");
      return true;
    }
  });
  if (removed !== 1) throw Error(`Expected one obsolete ${name} component in ${file}`);
  return source;
}

export function deriveUnifiedChat(file, source) {
  file = path.basename(file);
  if (!unifiedChatFiles.includes(file)) return source;
  if (file === "shared-2-CuvP2TaI.js") {
    return editNodes(file, source, (node, tree, replace) => {
      if (!ts.isFunctionDeclaration(node) || node.name?.text !== "pU") return;
      replace(node, `let claudexRouteSkeleton;
export function claudexTakeRouteEntrance(uuid) {
  const shown = claudexRouteSkeleton === uuid;
  claudexRouteSkeleton = undefined;
  return shown;
}
function pU({ className, conversationUuid }) {
  const placeholder = LX(null);
  Zcg(() => {
    if (!conversationUuid) return;
    const frame = requestAnimationFrame(() => {
      if (placeholder.current?.checkVisibility({ visibilityProperty: true })) {
        claudexRouteSkeleton = conversationUuid;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [conversationUuid]);
  return UK("div", {
    ref: placeholder,
    "data-testid": "conversation-loading-placeholder",
    "aria-hidden": true,
    className: Tc("flex-col px-[var(--df-ceded-gutter,0px)]", className),
    children: [
      gl("div", { className: "h-frame-row shrink-0" }),
      gl("div", { className: Tc(aV, UH, "pt-1"), children: gl(xE, { hold: { none: "route" } }) }),
    ],
  });
}`);
      return true;
    });
  }
  if (file === "shared-160-BGt89-ku.js") {
    const placeholder = "{ stampFor: n, placeholderHold: _, onPresented: h.arm, onShownLate: h.cancel }";
    const entrance = "h = fW(t);\n  QD(s === \"rows\");";
    if (source.split(placeholder).length !== 2 || source.split(entrance).length !== 2) {
      throw Error("Expected one Chat transcript loading state");
    }
    return 'import { claudexTakeRouteEntrance } from "./shared-2-CuvP2TaI.js";\n' + source
      .replace(placeholder, placeholder.replace("onShownLate: h.cancel", "onShownLate: h.arm"))
      .replace(entrance, `h = fW(t);
  Uu(() => {
    if (s !== "pending" && claudexTakeRouteEntrance(t) && s === "rows" && !u && !i) h.arm();
  }, [t, s, u, i, h.arm]);
  QD(s === "rows");`);
  }
  if (file === "shared-23-xVessQLu.js") {
    source = removeComponent(file, source, "$V");
    source = source.replace(".connectors/$connectorId.cowork.data-privacy-controls", ".connectors/$connectorId.data-privacy-controls");
    return editNodes(file, source, (node, tree, replace, edits) => {
      if (!ts.isExportSpecifier(node) || node.name.text !== "$V") return;
      const list = node.parent.elements, index = list.indexOf(node);
      edits.push({start: node.getStart(tree), end: list[index + 1].getStart(tree), value: ""});
    });
  }
  if (file === "cc011544b-Pr8E2gr7.js") {
    let removed = 0;
    source = editNodes(file, source, (node, tree, replace, edits) => {
      if (!ts.isPropertyAssignment(node) || node.name.getText(tree) !== "cowork" ||
          !node.initializer.getText(tree).includes("c71860c77-CH8nlfB6.js")) return;
      const list = node.parent.properties, index = list.indexOf(node);
      edits.push({start: node.getStart(tree), end: list[index + 1].getStart(tree), value: ""});
      removed++; return true;
    });
    if (removed !== 1) throw Error("Expected the standalone Cowork settings loader");
    return source;
  }
  if (file === "f7dbf2189abc654956d1c9f6cd025ec23f575dea4a7d99d4-NBJlq7sJ.js")
    return removeComponent(file, source, "_pe");
  if (file === "c2771e1f6-OQUR_HHd.js") return source.replaceAll("new_task_nav", "new_conversation");
  if (file === "shared-1-B16QIYNI.js") {
    let removed = 0;
    source = editNodes(file, source, (node, tree, replace, edits) => {
      if (!ts.isPropertyAssignment(node) || node.name.getText(tree) !== "new_task_nav") return;
      const properties = node.parent.properties, index = properties.indexOf(node);
      edits.push({start: node.getStart(tree), end: properties[index + 1].getStart(tree), value: ""});
      removed++; return true;
    });
    if (removed !== 1) throw Error("Expected one standalone task command");
    return source;
  }
  if (file === "shared-5-DQLFfFYX.js") {
    for (const name of ["KB", "lc", "nZ", "Qu", "VF", "t3"])
      source = removeComponent(file, source, name);
    return editNodes(file, source, (node, tree, replace) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "X8") {
        replace(node, "function X8() { return tT(uO, {}); }");
        return true;
      }
    });
  }
  if (file === "shared-22-Ciy9U3_0.js") {
    source = source.replace("  Ox,\n", "").replace("    J = !j && !N && !B,\n", "");
    return editNodes(file, source, (node, tree, replace) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "gt" &&
          node.initializer?.getText(tree).includes("gl(Ox, {})")) {
        replace(node.initializer, 'q ? gl("div", { className: "df-peek-mode-switch mb-2 flex shrink-0", children: gl(bG, {}) }) : null');
        return true;
      }
    });
  }
  if (file === "shared-20-C2JgSgMH.js") {
    for (const name of ["A2", "pZ", "gw", "Ox", "YHt"]) source = removeComponent(file, source, name);
    let removed = 0;
    source = editNodes(file, source, (node, tree, replace) => {
      if (ts.isIfStatement(node) && node.expression.getText(tree) === "d && !k" && node.thenStatement.getText(tree).includes('href: "/settings/cowork"')) {
        replace(node, ""); removed++; return true;
      }
    });
    if (removed !== 1) throw Error("Expected one standalone Cowork settings entry");
    source = source.replace('  cowork: { mode: "cowork", icon: "Tasks", label: "Cowork" },\n', "").replace("  Ox,\n", "");
    source = editNodes(file, source, (node, tree, replace) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "ksn") {
        replace(node, "function ksn() { const modes = gW(); const peek = mH(); return modes.length > 1 && !peek; }");
        return true;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "oIz") {
        replace(node, "function oIz() { const modes = gW(); const peek = mH(); return modes.length > 1 && peek; }");
        return true;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "XD") {
        replace(node, "function XD() { return RB(); }");
        return true;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "e4") {
        replace(node, 'function e4() { const home = { mode: ZE(), icon: "Chats", label: "Claudex" }; return { chat: home, cowork: home, code: rJ.code }; }');
        return true;
      }
      if (ts.isFunctionDeclaration(node) && node.name?.text === "pQ") {
        replace(node, 'function pQ() { return "Claudex"; }');
        return true;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "rT")
        replace(node, "claudexNavigationModes()");
    });
    return source + '\nfunction claudexNavigationModes() { const modes = rT(); const home = modes.some(mode => mode === "chat" || mode === "cowork"); return [...(home ? [ZE()] : []), ...(modes.includes("code") ? ["code"] : [])]; }\n';
  }
  if (file === "shared-46-BL5bnnMV.js") {
    const placeholder = 'tT(pU, { className: "hidden h-full peer-empty:flex" })';
    if (source.split(placeholder).length !== 2) throw Error("Expected one Chat route loading state");
    source = source.replace(placeholder, 'tT(pU, { className: "hidden h-full peer-empty:flex", conversationUuid: t })');
    const before = 'yQ = Jl({ getParentRoute: () => R5, path: "task/new", component: C8 }),';
    if (source.split(before).length !== 2) throw Error("Expected the standalone task creation route");
    source = source.replace(before, 'yQ = Jl({ getParentRoute: () => R5, path: "task/new", beforeLoad: () => { throw Fy({ href: "/new", replace: !0 }); } }),');
    source = source.replace('throw Fy({ href: `/task/new${e.searchStr}`, replace: !0 });', 'throw Fy({ href: "/new", replace: !0 });');
    source = source.replace('function Ak({ location: e }) {', `function Ak({ location: e }) {
  if (e.pathname === "/settings/cowork") throw Fy({ href: "/settings/general", replace: !0 });
  const claudexSearch = new URLSearchParams(e.searchStr);
  if (/^\\/(?:task(?:\\/(?:new|examples))?|cowork(?:\\/new)?)\\/?$/.test(e.pathname) ||
      (e.pathname === "/new" && ["cowork", "task"].includes(claudexSearch.get("mode")))) {
    claudexSearch.delete("mode");
    claudexSearch.delete("surface");
    throw Fy({ href: "/new" + (claudexSearch.size ? "?" + claudexSearch : ""), replace: !0 });
  }`);
    source = removeComponent(file, source, "C8");
    return editNodes(file, source, (node, tree, replace, edits) => {
      if (!ts.isImportSpecifier(node) || node.name.text !== "$V") return;
      const list = node.parent.elements, index = list.indexOf(node);
      edits.push({start: node.getStart(tree), end: list[index + 1].getStart(tree), value: ""});
    });
  }
  let removed = 0;
  source = editNodes(file, source, (node, tree, replace, edits) => {
    if (!ts.isArrayLiteralExpression(node)) return;
    for (let i = 0; i < node.elements.length; i++) {
      const item = node.elements[i];
      if (!ts.isObjectLiteralExpression(item)) continue;
      const route = item.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(tree) === "path" && ts.isStringLiteral(p.initializer) && p.initializer.text === "cowork");
      if (!route) continue;
      const next = node.elements[i + 1];
      edits.push({start: item.getStart(tree), end: next ? next.getStart(tree) : item.end, value: ""});
      removed++;
    }
  });
  if (removed !== 1) throw Error(`Expected one standalone Cowork settings page in ${file}`);
  if (file === "cf400e6a4-B6JbCpjm.js") return removeComponent(file, source, "Kct");
  if (file === "ca768caa9-CxTsvCY0.js") return removeComponent(file, source, "sw");
  return source.replace('import nt from "./c71860c77-CH8nlfB6.js";\n', "");
}

export function applyUnifiedChat(directory) {
  for (const file of unifiedChatFiles) {
    const location = path.join(directory, file);
    fs.writeFileSync(location, deriveUnifiedChat(file, fs.readFileSync(location, "utf8")));
  }
  for (const file of retiredChatPages) fs.unlinkSync(path.join(directory, file));
  return true;
}
