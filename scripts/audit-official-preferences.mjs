import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";

const nativeMain =
  process.argv[2] ??
  ".restore/archive-extracted/claude-frontend-4.4212.0/reference/desktop-main/index.chunk-m4oMImJ-.js";
const native = fs.readFileSync(nativeMain, "utf8");
assert.equal(
  createHash("sha256").update(native).digest("hex"),
  "365f4e4dd0a1a8ab54a4cfaabec01a27a188fd2dd8ff6f6251142844355cab6d",
  "Expected the pinned native main source",
);

function declaration(source, filename, symbol) {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const matches = file.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === symbol);
  assert.equal(
    matches.length,
    1,
    `Expected a single ${symbol} declaration in ${filename}`,
  );
  return matches[0].initializer;
}

function properties(object) {
  assert.ok(ts.isObjectLiteralExpression(object));
  return object.properties.map((node) => {
    assert.ok(ts.isPropertyAssignment(node) && ts.isIdentifier(node.name));
    return node.name.text;
  });
}

const schema = declaration(native, nativeMain, "u_");
assert.ok(ts.isCallExpression(schema));
const keys = properties(schema.arguments[0]);
assert.equal(keys.length, 131);
assert.equal(new Set(keys).size, keys.length);
const mainOnly = declaration(native, nativeMain, "j9a");
assert.ok(ts.isNewExpression(mainOnly));
const split = mainOnly.arguments[0];
assert.ok(
  ts.isCallExpression(split) && ts.isPropertyAccessExpression(split.expression),
);
assert.equal(split.expression.name.text, "split");
assert.ok(ts.isStringLiteral(split.expression.expression));
const mainKeys = new Set(split.expression.expression.text.split("."));
const boundary = "electron/official-ui/native/preferences-main-only.ts";
const blocked = declaration(
  fs.readFileSync(boundary, "utf8"),
  boundary,
  "mainOnlyPreferences",
);
assert.ok(
  ts.isNewExpression(blocked) &&
    ts.isArrayLiteralExpression(blocked.arguments[0]),
);
const blockedKeys = blocked.arguments[0].elements.map((node) => {
  assert.ok(ts.isStringLiteral(node));
  return node.text;
});
assert.deepEqual(blockedKeys.sort(), [...mainKeys].sort());
const adapter = "electron/official-ui/native/preferences.ts";
const computer = "electron/official-ui/native/computer-use.ts";
const mapped = new Set(
  properties(declaration(fs.readFileSync(adapter, "utf8"), adapter, "mapped")),
);
mapped.add("bypassPermissionsOptInByAccount");
mapped.add("coworkModelAutoFallbackByAccount");
const computerKeys = new Set(
  properties(
    declaration(
      fs.readFileSync(computer, "utf8"),
      computer,
      "computerUsePreferenceKeys",
    ).expression,
  ),
);
for (const key of [...mapped, ...computerKeys, ...mainKeys])
  assert.ok(keys.includes(key), key);
const unavailable = new Set(keys.filter(key => key.startsWith("wakeScheduler")));
const rows = keys.map((key) => ({
  key,
  authority: mapped.has(key)
    ? "settings"
    : computerKeys.has(key)
      ? "computer-use"
      : mainKeys.has(key)
        ? "main-only"
        : unavailable.has(key) ? "unavailable" : "adapter-state",
}));
console.log(JSON.stringify(rows, null, 2));
