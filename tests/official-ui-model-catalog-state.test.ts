import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import { deriveOfficialUiHostSubscriptionModule } from "../scripts/official-ui-host-subscription.mjs";
import { deriveOfficialModelCatalogStateModule, modelCatalogStateRules } from "../scripts/official-ui-model-catalog-state.mjs";

const root = process.env.CLAUDEX_OFFICIAL_UI_SOURCE ?? ".restore/archive-extracted/claude-frontend-4.4212.0";
const names = ["shared-1-B16QIYNI.js", "shared-8-B9DjIUqu.js"];
const input = names.map((name) => {
  const raw = fs.readFileSync(path.join(root, "src/cloud/assets/v1", name), "utf8");
  return deriveOfficialUiHostSubscriptionModule(name, brandedModule(raw));
});
const output = names.map((name, i) => deriveOfficialModelCatalogStateModule(name, input[i]));
const parse = (source: string) => ts.createSourceFile("original.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function declaration(source: string, name: string) {
  const ast = parse(source);
  const found = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(found, name);
  return found.getText(ast);
}
const recorded = JSON.parse(fs.readFileSync(path.join(root, "recovery/claudex-bootstrap-defaults.json"), "utf8"));
const defaults = recorded.org_growthbook.features["2973881027"].defaultValue;
function selection(source: string, conversationModel: string | undefined, selected: string | undefined) {
  const writes: string[] = [];
  const context = {
    Fj: () => conversationModel,
    ty: () => ({ entry: selected ? { model: selected } : undefined }),
    OV: (name: string, key: string) => {
      assert.equal(name, "console_default_model");
      return defaults[key];
    },
    DBq: (model: string) => writes.push(model),
    lN: {}, L_: {},
  };
  return { run: vm.runInNewContext(`(${declaration(source, "JD")})`, context) as (id?: string) => string, writes };
}

test("the original configuration lookup resolves the recorded console model and overwrites sticky selection", () => {
  const raw = fs.readFileSync(path.join(root, "src/cloud/assets/v1/shared-l-p-m-w-0-C_nAiu5o.js"), "utf8");
  const key = vm.runInNewContext(`(${declaration(raw, "D3")})`)("console_default_model");
  assert.equal(key, "2973881027");
  assert.equal(defaults.model, "claude-opus-5-5");
  const original = selection(input[0], undefined, "host-selected-model");
  assert.equal(original.run("loading-history"), "claude-opus-5-5");
  assert.deepEqual(original.writes, ["claude-opus-5-5"]);
});

test("account selection and existing conversation model replace the recorded default without sticky writes", () => {
  const fresh = selection(output[0], undefined, "host-selected-model");
  assert.equal(fresh.run(), "host-selected-model");
  assert.equal(fresh.run("loading-history"), "");
  assert.deepEqual(fresh.writes, []);
  const existing = selection(output[0], "history-model", "host-selected-model");
  assert.equal(existing.run("history"), "history-model");
  assert.deepEqual(existing.writes, []);
  assert.equal(selection(output[0], undefined, undefined).run(), "");
});

function pickerExpressions(source: string) {
  const ast = parse(source);
  let body: ts.Node | undefined;
  function find(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "Hw") body = node.initializer;
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(body);
  const values = new Map<string, ts.Expression>();
  function read(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.initializer)
      values.set(node.name.getText(ast), node.initializer);
    ts.forEachChild(node, read);
  }
  read(body);
  const text = (key: string) => {
    const node = values.get(key);
    assert.ok(node, key);
    return node.getText(ast);
  };
  const render = values.get("vt");
  assert.ok(render && ts.isConditionalExpression(render) && ts.isCallExpression(render.whenTrue));
  return { text, render: render.whenTrue.arguments.at(-1)!.getText(ast) };
}
const picker = pickerExpressions(output[1]);
function state(options: {
  conversation?: string; newConversation?: boolean; model?: string; initial?: string;
  context?: string; selected?: string; settled?: boolean; models?: string[];
}) {
  const models = options.models ?? ["host-selected-model", "history-model"];
  const context: Record<string, unknown> = {
    t: options.conversation, l: options.newConversation ?? false,
    n: options.initial, r: options.context, ne: options.selected ?? "host-selected-model",
    re: models[0], qe: selection(output[0], options.model, options.selected).run,
    ye: models, he: null, ie: options.settled ?? true, I: false,
  };
  for (const key of ["ae", "oe", "se", "ve", "xe", "Se"])
    context[key] = vm.runInNewContext(`(${picker.text(key)})`, context);
  const jsx = (type: string, props: unknown) => ({ type, props });
  const view = vm.runInNewContext(`(${picker.render})`, {
    ...context, ge: "Loading models…", _e: "Default model", gl: jsx, aC: jsx,
    H4: "spinner", pN: "original-model-label", Me: { model: context.ve },
    w: "chat", L: false, p: undefined, We: undefined, Ge: undefined, F: undefined,
  });
  return { ...context, view } as any;
}

test("an existing conversation waits for its model even after the catalog has loaded", () => {
  const pending = state({ conversation: "history", selected: "host-selected-model" });
  assert.equal(pending.xe, "loading");
  assert.equal(pending.Se, true);
  assert.equal(pending.view.props.children[1].props.children, "Loading models…");
  const ready = state({ conversation: "history", model: "history-model" });
  assert.equal(ready.xe, null);
  assert.equal(ready.view.props.model.model, "history-model");
});

test("new conversation identities and supplied models remain selectable", () => {
  for (const options of [
    { conversation: "new-id", newConversation: true, selected: "host-selected-model" },
    { conversation: "history", initial: "host-selected-model" },
    { conversation: "history", context: "host-selected-model" },
  ]) {
    const ready = state(options);
    assert.equal(ready.xe, null);
    assert.equal(ready.Se, false);
    assert.equal(ready.view.props.model.model, "host-selected-model");
  }
});

test("catalog loading and absence use original feedback; known history models stay visible", () => {
  const loading = state({ models: [], settled: false });
  assert.equal(loading.xe, "loading");
  assert.equal(loading.Se, true);
  const empty = state({ models: [] });
  assert.equal(empty.xe, "empty");
  assert.equal(empty.view.props.children, "Default model");
  const known = state({ conversation: "history", model: "history-model", models: [] });
  assert.equal(known.xe, null);
  assert.equal(known.view.props.model.model, "history-model");
});

test("the primary selector waits for an existing Chat record and keeps new/Cowork selection available", () => {
  const ast = parse(output[1]);
  let pending: ts.IfStatement | undefined;
  function find(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast).includes("claudexModelSource.sessionRecordLoaded")) pending = node;
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(pending && ts.isReturnStatement(pending.thenStatement));
  const condition = (value: object) => vm.runInNewContext(pending!.expression.getText(ast), { claudexModelSource: value });
  assert.equal(condition({ isNewConversation: false, sessionRecordLoaded: false, localSessionId: null }), true);
  assert.equal(condition({ isNewConversation: false, sessionRecordLoaded: true, localSessionId: null }), false);
  assert.equal(condition({ isNewConversation: true, sessionRecordLoaded: false, localSessionId: null }), false);
  assert.equal(condition({ isNewConversation: false, sessionRecordLoaded: false, localSessionId: "local-task" }), false);
  const rendered = vm.runInNewContext(pending.thenStatement.expression!.getText(ast), {
    gl: (component: string, props: object) => ({ component, props }), Hw: "original-selector",
    h: "history", t: "bottom", o: "footnote", l: true,
  });
  assert.equal(rendered.component, "original-selector");
  assert.equal(rendered.props.conversationUuid, "history");
  assert.equal(rendered.props.disabled, true);
  assert.equal(rendered.props.initialModel, undefined);
  assert.equal(rendered.props.contextModel, undefined);
  assert.equal(state({ conversation: rendered.props.conversationUuid }).xe, "loading");
});


test("the Chat composer keeps the dispatched first-turn model available before timeline readiness", () => {
  const rule = modelCatalogStateRules.find(rule => rule.name === "chat-model-loading-reaches-composer");
  assert.ok(rule);
  const raw = fs.readFileSync(path.join(root, "src/cloud/assets/v1", rule.file), "utf8");
  assert.equal(raw.split(rule.before).length, 2);
  const ast = parse(raw.replace(rule.before, rule.after));
  let ready: ts.Expression | undefined;
  function find(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(property =>
      ts.isPropertyAssignment(property) && property.name.getText(ast) === "isLoading" &&
      property.initializer.getText(ast) === "tD")) {
      const property = node.properties.find(property =>
        ts.isPropertyAssignment(property) && property.name.getText(ast) === "sessionRecordLoaded");
      if (property && ts.isPropertyAssignment(property)) ready = property.initializer;
    }
    ts.forEachChild(node, find);
  }
  find(ast);
  assert.ok(ready);
  const recordReady = (timelineReady: boolean, initialDraftModel?: string) =>
    vm.runInNewContext(ready!.getText(ast), { Z: { ready: timelineReady }, a: { initialDraftModel } });
  assert.equal(recordReady(false, "history-model"), true);
  assert.equal(recordReady(false), false);
  assert.equal(recordReady(true), true);
  const firstTurn = state({ conversation: "first-send", context: "history-model", selected: "host-selected-model" });
  assert.equal(firstTurn.view.props.model.model, "history-model");
  assert.equal(firstTurn.xe, null);
});
