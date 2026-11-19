import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import { deriveOfficialUiHostCapabilityModule } from "../scripts/official-ui-host-capabilities.mjs";

const root = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
assert.ok(root, "Set CLAUDEX_ORIGINAL_CODE_ASSETS to the pinned source directory");
const name = "cc183b3ab-Dq3NZ8k1.js";
const raw = fs.readFileSync(path.join(root, "cloud/assets/v1", name), "utf8");
const parsed = ts.createSourceFile(name, deriveOfficialUiHostCapabilityModule(name, brandedModule(raw)), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function originalFunction(name: string) {
  const node = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `Pinned original function ${name}`);
  return node.getText(parsed);
}

test("the original menu requests the active folder for a draft and the session id for an existing session", async () => {
  const scopes: unknown[] = [];
  const command = { name: "lint", kind: "skill", description: "Lint", argumentHint: "[path]" };
  const query = vm.runInNewContext(`${originalFunction("Pe")}\n${originalFunction("K")}\nK`, {
    a: { getSupportedCommands(scope: { cwd?: string; sessionId?: string }) {
      scopes.push({ ...scope });
      if (scope.cwd === "/unavailable") throw Error("The skill catalog is offline.");
      return scope.cwd || scope.sessionId ? [command] : [];
    } },
  });
  assert.deepEqual(await query(null, null), []);
  assert.deepEqual(await query("/fixture", null), [command]);
  assert.deepEqual(await query("/fixture", "local_fixture"), [command]);
  await assert.rejects(query("/unavailable", null), /catalog is offline/);
  assert.deepEqual(scopes, [
    { cwd: undefined, sessionId: undefined },
    { cwd: "/fixture", sessionId: undefined },
    { cwd: undefined, sessionId: "local_fixture" },
    { cwd: "/unavailable", sessionId: undefined },
  ]);
});

test("the original Code registry supplies saved-only commands and aliases independently of the local skill list", () => {
  const declaration = parsed.statements.flatMap((node) => ts.isVariableStatement(node) ? [...node.declarationList.declarations] : [])
    .find((node) => node.name.getText(parsed) === "E");
  assert.ok(declaration?.initializer);
  const code = ["S", "C", "w", "T"].map(originalFunction).join("\n");
  const registry = vm.runInNewContext(`${code}\n${declaration.initializer.getText(parsed)}`, {
    x: {}, ne: {}, te: {}, v: "send-to-project", y: "", oe: "",
  }) as { name: string; aliases?: string[]; argumentHint?: string; gate: (capabilities: object) => boolean }[];
  const draft = { hostInterceptSurface: true, isLocalSession: false, hasSession: false, ipc: {} };
  const saved = { ...draft, hasSession: true, isLocalSession: true, canForkSession: true, subtaskCommand: false, ipc: { applyFlagSettings: true } };
  const find = (name: string) => {
    const command = registry.find((entry) => entry.name === name);
    assert.ok(command);
    return command;
  };
  assert.equal(find("model").gate(draft), true);
  assert.equal(find("model").argumentHint, "[model-id]");
  assert.equal(find("permissions").aliases?.includes("allowed-tools"), true);
  for (const name of ["rename", "status", "copy", "autocompact", "output-style"]) {
    assert.equal(find(name).gate(draft), false);
    assert.equal(find(name).gate(saved), true);
  }
  assert.equal(find("subtask").gate(saved), false);
});
