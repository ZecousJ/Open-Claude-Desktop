import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const modulePath = process.env.CLAUDEX_F070_SETTINGS_MODULE ??
  "build/official-ui/ui/assets/v1/c71860c77-S3armOsG.js";
const source = ts.createSourceFile(
  modulePath, fs.readFileSync(modulePath, "utf8"), ts.ScriptTarget.Latest, true,
);
const settings = source.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "Ca",
);
assert.ok(settings);
let setter: ts.ArrowFunction | undefined;
function findStartupSetter(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "K0") {
    const [, slot, callback] = node.arguments;
    if (slot?.getText(source) === "8" && callback && ts.isArrowFunction(callback)) {
      setter = callback;
    }
  }
  ts.forEachChild(node, findStartupSetter);
}
findStartupSetter(settings);
assert.ok(setter);
const startupSetter = setter.getText(source);

interface StartupState {
  value?: boolean;
  pending?: boolean;
  writeFailed?: string;
}

test("the official startup switch displays the OS readback after the write settles", async () => {
  let finishWrite: (() => void) | undefined;
  let enabled = false;
  let state: StartupState = { value: false };
  const setStartup = runInNewContext(startupSetter, {
    L: {
      setStartupOnLoginEnabled(value: boolean) {
        return new Promise<void>((resolve) => {
          finishWrite = () => { enabled = value; resolve(); };
        });
      },
      isStartupOnLoginEnabled: async () => enabled,
    },
    r(next: StartupState | ((current: StartupState) => StartupState)) {
      state = typeof next === "function" ? next(state) : next;
    },
  });
  const writing = setStartup(true);
  assert.equal(state.value, false);
  assert.equal(state.pending, true);
  assert.ok(finishWrite);
  finishWrite();
  await writing;
  assert.equal(state.value, true);
  assert.equal(!!state.pending, false);
  assert.equal(state.writeFailed, undefined);
});

test("a refused startup change keeps the OS state and displays the stock settings error", async () => {
  let state: StartupState = { value: false };
  const setStartup = runInNewContext(startupSetter, {
    L: {
      setStartupOnLoginEnabled: async () => { throw new Error("Requires approval"); },
      isStartupOnLoginEnabled: async () => false,
    },
    r(next: StartupState | ((current: StartupState) => StartupState)) {
      state = typeof next === "function" ? next(state) : next;
    },
  });
  await setStartup(true);
  assert.equal(state.value, false);
  assert.equal(!!state.pending, false);
  assert.equal(state.writeFailed, "refused");
});
