/** Executes hash-pinned original permission-key functions, not React or real UI acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import { permissionKeys } from "../electron/official-ui/api/connectors";
import type {
  McpServerState,
  McpToolState,
} from "../shared/settings-desktop-api";
const original = process.env.CLAUDEX_ORIGINAL_MCP_PERMISSIONS;
let reader:
  | { rp(tool: unknown): string; u7(server: string, tool: string): string }
  | undefined;
function originalKeys() {
  if (reader) return reader;
  const text = fs.readFileSync(original!, "utf8");
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    "d2516d18fe7a55d34c9d10af835560e8246361e8e7b3807176ae23b245624a95",
  );
  const source = ts.createSourceFile(
    "original.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = ["n8", "rp", "Bl", "u7"];
  const functions = names.map((name) => {
    const matches = source.statements.filter(
      (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.equal(matches.length, 1);
    return matches[0].getText(source);
  });
  const declarations: string[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === "_8" &&
      node.initializer
    )
      declarations.push(node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(declarations.length, 1);
  // Supply imported Zod/MD5 primitives. Every contract function and schema
  // declaration above is the unchanged original code, not a reimplementation.
  reader = vm.runInNewContext(
    `const _8 = ${declarations[0]};\n${functions.join("\n")}\n({rp,u7})`,
    {
      m2: z.object,
      P_: z.string,
      jA: (text: string) => createHash("md5").update(text).digest("hex"),
    },
    { timeout: 1000 },
  );
  return reader!;
}
const cases: [string, Record<string, unknown> | undefined][] = [
  ["no schema", undefined],
  ["empty schema", {}],
  [
    "parameter description",
    { properties: { query: { type: "string", description: "Search text" } } },
  ],
  [
    "sort order",
    {
      properties: {
        zeta: { description: "Last" },
        alpha: { description: "First" },
      },
    },
  ],
  [
    "unicode parameter",
    {
      properties: { 查询: { description: "文字" }, query: { type: "string" } },
    },
  ],
  [
    "invalid property fields",
    {
      properties: {
        arrayType: { type: ["string", "null"], description: "Ignored" },
        boolean: false,
        null: null,
      },
    },
  ],
  ["empty description", { properties: { query: { description: "" } } }],
  [
    "unknown property keys",
    { properties: { query: { description: "Kept", future: "metadata" } } },
  ],
];
for (const [name, inputSchema] of cases)
  test(
    `F041 original permission-key contract: ${name}`,
    { skip: !original },
    () => {
      const server = { name: "wiki" } as McpServerState;
      const tool: McpToolState = {
        name: "lookup",
        description: "Find a fact",
        enabled: true,
        ...(inputSchema ? { definition: { name: "lookup", inputSchema } } : {}),
      };
      const keys = permissionKeys(server, tool),
        original = originalKeys();
      const uuid = keys.enabled.slice(0, keys.enabled.indexOf(":"));
      assert.equal(original.u7(uuid, tool.name), keys.enabled);
      assert.equal(
        original.rp({
          name: tool.name,
          description: tool.description,
          inputSchema,
          enabledKey: keys.enabled,
        }),
        keys.approved,
      );
    },
  );
