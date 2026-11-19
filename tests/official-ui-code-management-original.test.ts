/** Fixed original functions in a VM, not a mounted UI or screenshot test. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
const root = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
function source(build: string, file: string, hash: string) {
  assert.ok(
    root,
    "Set CLAUDEX_ORIGINAL_CODE_ASSETS to the verified original src directory",
  );
  const text = fs.readFileSync(
    path.join(root, build, "assets/v1", file),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    hash,
    "Original asset changed; reverify contract",
  );
  return text;
}
for (const build of [
  {
    name: "renderer",
    file: "cef1e6037-DgIj2SyO.js",
    hash: "808f5c5f94962eb7efda306e8027ba7cf215a6ea3e62acea44bd6c9005cc5f89",
    native: "i",
    gate: "kr",
  },
  {
    name: "cloud",
    file: "cef1e6037-DIC2zPYg.js",
    hash: "892b640c3293b908fcade9ee420fe1ccf879c826e1ed720458d54ec021371408",
    native: "a",
    gate: "Hr",
  },
])
  for (const enabled of [false, true])
    test(`${build.name} exact original transport management options, feature=${enabled}`, async () => {
      const text = source(build.name, build.file, build.hash),
        start = text.indexOf("    async rename(e, t) {"),
        end = text.indexOf("    async fetchReportTranscript", start);
      assert.ok(start > 0 && end > start);
      const calls: any[] = [];
      let failure: Error | undefined;
      const native = Object.fromEntries(
        ["updateSession", "archive", "unarchive", "delete"].map((method) => [
          method,
          async (...args: any[]) => {
            calls.push([method, ...args]);
            if (failure) throw failure;
          },
        ]),
      );
      const scope: any = {
        [build.native]: native,
        [build.gate]: () => enabled,
      };
      vm.runInNewContext("this.api=({" + text.slice(start, end) + "});", scope);
      await scope.api.rename("local_one", "Title");
      await scope.api.archive("local_one", {
        forceWorktreeCleanup: false,
        discardChangesIn: [],
      });
      await scope.api.unarchive("local_one");
      await scope.api.delete("local_one", { discardChangesIn: [] });
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ["updateSession", "local_one", { title: "Title" }],
        [
          "archive",
          "local_one",
          {
            cleanupWorktree: true,
            forceWorktreeCleanup: false,
            ...(enabled ? { discardChangesIn: [] } : {}),
          },
        ],
        ["unarchive", "local_one"],
        ["delete", "local_one", ...(enabled ? [{ discardChangesIn: [] }] : [])],
      ]);
      failure = Error("unconfirmed");
      await assert.rejects(
        scope.api.delete("local_one", { discardChangesIn: [] }),
        /unconfirmed/,
      );
      assert.equal(
        calls.length,
        5,
        "Original transport does not retry a failed deletion",
      );
    });
test("exact original lifecycle event consumer updates and removes the list row", () => {
  const text = source(
    "renderer",
    "shared-8-BeJUm-0j.js",
    "daca99d8cc9311320d887b3487d6bfd5c166b0f5d892e4a3030bb37334554718",
  );
  const ast = ts.createSourceFile(
      "original.js",
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    matches: ts.ArrowFunction[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isArrowFunction(node) &&
      node.getText(ast).includes('case "deleted":')
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  matches.sort((a, b) => a.end - a.pos - (b.end - b.pos));
  assert.ok(matches.length);
  const rows = new Map<string, any>([
      ["local_one", { sessionId: "local_one", isArchived: false }],
      ["local_control", { sessionId: "local_control" }],
    ]),
    cleared: string[] = [];
  const scope: any = {
    bX: 0,
    xX: 0,
    yX: 0,
    kY: (row: any) => rows.set(row.sessionId, row),
    oX: (id: string) => (rows.get(id).isArchived = true),
    sX: (id: string) => (rows.get(id).isArchived = false),
    cX: (id: string) => rows.delete(id),
    sa: (fn: () => void) => fn(),
    yY: (id: string) => cleared.push(id),
  };
  vm.runInNewContext("this.accept=" + matches[0].getText(ast), scope);
  scope.accept({ type: "archived", sessionId: "local_one" });
  assert.equal(rows.get("local_one").isArchived, true);
  scope.accept({
    type: "unarchived",
    sessionId: "local_one",
    session: { sessionId: "local_one", isArchived: false, title: "Restored" },
  });
  assert.equal(rows.get("local_one").title, "Restored");
  scope.accept({ type: "deleted", sessionId: "local_one" });
  assert.equal(rows.has("local_one"), false);
  assert.equal(rows.has("local_control"), true);
  assert.deepEqual(cleared, ["local_one"]);
  assert.equal(scope.yX, 3);
});
test("original clean disposal options originate in the unchanged menu consumer", () => {
  const producer = source(
    "renderer",
    "c6b8adeaf-rr4RKt91.js",
    "fda3ee4b8360515f958796576d7e11580b50faf03889f46592a8d87ede3d1cb3",
  );
  const dialog = source(
    "renderer",
    "shared-42-DUwXdtg_.js",
    "40fc803b62537798ecdad4a779a1e87c4a1579b7a1daf6db6f9cc3a6a440dbb9",
  );
  assert.match(producer, /discardChangesIn: u/);
  assert.match(dialog, /discardChangesIn: \[\]/);
});
