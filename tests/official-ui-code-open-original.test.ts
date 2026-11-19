/** Exact functions extracted from separately supplied original frontend assets.
 * Source-function/host contract verification, not rendered UI acceptance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";

const root = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
const builds = [
  {
    name: "renderer",
    warm: "c9543da06-l4QBFWtF.js",
    opened: "shared-140-DCtcR9Ju.js",
    counter: "Gp",
    disabled: "b",
    bridge: "r",
  },
  {
    name: "cloud",
    warm: "c2319015e-DAPw5w9h.js",
    opened: "shared-140-D6FnSjbS.js",
    counter: "eR",
    disabled: "aL",
    bridge: "pi",
  },
];
const hashes: Record<string, string> = {
  "c9543da06-l4QBFWtF.js":
    "cd9fa97a7949b137b1304d7b0f0b1f7f853e3dd9d0829da4ad12abb45f7b983c",
  "shared-140-DCtcR9Ju.js":
    "42c62eae48b01c9b2029b841e7cab4af38d4f5eb14a48649c4aeb2d2a0011554",
  "c2319015e-DAPw5w9h.js":
    "0d0208dfc1e5749f5756e151dcfc81772a68b52166717562b9c12bf3a6bdd4e9",
  "shared-140-D6FnSjbS.js":
    "b654298293cb7064ff8ef0abeea9fd12b674d3302fabb6303ef209af5dbc21ed",
};
function extract(build: string, filename: string, needle: string) {
  const source = fs.readFileSync(
    path.join(root!, build, "assets", "v1", filename),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    hashes[filename],
    "Original asset changed; verify its new contract before repinning",
  );
  const ast = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = ast.statements.filter(
    (node) =>
      ts.isFunctionDeclaration(node) && node.getText(ast).includes(needle),
  );
  assert.equal(functions.length, 1, "Expected one original top-level consumer");
  return functions[0].getText(ast);
}
function native() {
  const handlers = new Map<string, any>(),
    calls: any[] = [];
  const c: any = {
    id: "one",
    mode: "code",
    cwd: "/inert",
    unread: true,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      localLoadConversation: async () => structuredClone(c),
      onEvent: () => () => {},
      localCall: async (method: string, id: string, patch: any) => {
        calls.push([method, id, patch]);
        assert.equal(method, "updateConversation");
        Object.assign(c, {
          unread: false,
          readStateRevision: patch.unread.expected.readStateRevision + 1,
        });
        return structuredClone(c);
      },
    },
    on: (name: string, fn: any) => handlers.set(name, fn),
    emit() {},
  } as never);
  return {
    c,
    calls,
    run: (name: string, id: string) =>
      handlers.get("LocalSessions." + name)(id),
  };
}
for (const build of builds) {
  test(
    `${build.name} original model switch reports next-start, never a false warm restart`,
    { skip: !root },
    async () => {
      const original = vm.runInNewContext(
        "(" + extract(build.name, build.warm, "await e.warmSession") + ")",
      );
      const h = native(),
        trace: string[] = [];
      const result = await original(
        {
          stop: async () => trace.push("stop"),
          setModel: async () => trace.push("setModel"),
          warmSession: (id: string) => h.run("warmSession", id),
        },
        "local_one",
        "m",
      );
      assert.equal(result, "applies_on_next_start");
      assert.deepEqual(trace, ["stop", "setModel"]);
      assert.deepEqual(h.calls, []);
      assert.equal(h.c.unread, true);
    },
  );
  for (const [kind, nesting, disabled, expected] of [
    ["local", 0, false, 1],
    ["remote", 0, false, 0],
    ["local", 1, false, 0],
    ["local", 0, true, 0],
  ] as const)
    test(
      `${build.name} original open notification respects ${kind}/${nesting}/${disabled}`,
      { skip: !root },
      async () => {
        const h = native();
        let operation: Promise<void> | undefined;
        const original = vm.runInNewContext(
          "(" + extract(build.name, build.opened, "personOpenedSession") + ")",
          {
            [build.counter]: nesting,
            [build.disabled]: () => disabled,
            [build.bridge]: {
              personOpenedSession: (id: string) =>
                (operation = h.run("personOpenedSession", id)),
            },
          },
        );
        original({ type: kind, id: "local_one" });
        await operation;
        assert.equal(h.calls.length, expected);
        assert.equal(h.c.unread, expected === 0);
      },
    );
}
