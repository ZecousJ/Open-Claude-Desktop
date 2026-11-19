import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import { deriveOfficialUiHostCodeTakebackModule } from "../scripts/official-ui-host-code-takeback.mjs";

const assets = path.resolve(
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ?? ".restore/archive-extracted/claude-frontend-4.4212.0",
  "src/cloud/assets/v1",
);
const target = "ce96f5751-COTRMpp4.js";
const input = brandedModule(fs.readFileSync(path.join(assets, target), "utf8"));
const output = deriveOfficialUiHostCodeTakebackModule(target, input);
function functions(source, names) {
  const ast = ts.createSourceFile("original.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return names.map(name => {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(fn, `Original function ${name} exists`);
    return fn.getText(ast);
  }).join("\n");
}
const classifiers = functions(
  fs.readFileSync(path.join(assets, "shared-m-0-DnMCTYBX.js"), "utf8"),
  ["Zu", "HI", "Wl"],
);
function projector(source) {
  return vm.runInNewContext(`${classifiers}\nconst y=Zu,b=HI,x=Wl,R=6;\n${functions(source, ["N", "P", "z"])}\nz`);
}
const project = projector(output);
const summary = {
  model: "gpt-5.4",
  totalTokens: 134100,
  rawMaxTokens: 258400,
  percentage: 52,
  detail: "summary",
  categories: [
    { name: "Context", kind: "used", tokens: 134100 },
    { name: "Free space", kind: "free", tokens: 124300 },
  ],
  memoryFiles: [],
  mcpTools: [],
  agents: [],
};

for (const liveTokens of [34100, 150000, 0, 300000, null]) {
  test(`aggregate context card keeps its rows and meter consistent with live tokens ${liveTokens}`, () => {
    const cached = structuredClone(summary);
    const result = project(cached, { liveTokens });
    const used = liveTokens ?? 134100;
    assert.equal(result.usedTokens, used);
    assert.equal(result.usedPct, used / 258400 * 100);
    assert.deepEqual(Array.from(result.legend, row => [row.name, row.tokens]), [
      ["Context", used], ["Free space", Math.max(0, 258400 - used)],
    ]);
    assert.equal(result.meterValues["used-0"], used);
    assert.equal(result.barTotal, Math.max(258400, used));
    assert.equal(result.meterCategories.length, 1);
    assert.deepEqual(cached, summary);
  });
}

test("verified detailed categories retain the original live delta and compaction buffer behavior", () => {
  const usage = {
    ...summary,
    detail: "full",
    categories: [
      { name: "Messages", kind: "conversation", tokens: 100000 },
      { name: "System prompt", tokens: 34100 },
      { name: "Autocompact buffer", kind: "buffer", tokens: 20000 },
      { name: "Free space", kind: "free", tokens: 104300 },
    ],
  };
  const original = projector(input);
  for (const liveTokens of [null, 134100, 150000, 34100]) {
    assert.deepEqual(
      JSON.parse(JSON.stringify(project(usage, { liveTokens }))),
      JSON.parse(JSON.stringify(original(usage, { liveTokens }))),
    );
  }
});
