/** Pinned original React hook functions exercised in VM, not mounted UI. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
function setup(send: (value: any) => Promise<void>) {
  const root = process.env.CLAUDEX_ORIGINAL_CODE_ASSETS;
  assert.ok(root, "Set original source directory");
  const text = fs.readFileSync(
    path.join(root, "renderer/assets/v1/c6b8adeaf-rr4RKt91.js"),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    "fda3ee4b8360515f958796576d7e11580b50faf03889f46592a8d87ede3d1cb3",
  );
  const file = ts.createSourceFile(
    "original.js",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const functions = ["go", "Ja"]
    .map((name) => {
      const node = file.statements.find(
        (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
      );
      assert.ok(node);
      return node.getText(file);
    })
    .join("\n");
  const errors: any[] = [],
    scope: any = {
      J9: () => [],
      P: () => ({ formatMessage: (value: any) => value.defaultMessage }),
      mr:
        () =>
        (...args: any[]) =>
          errors.push(args),
      lo: () => ({ sendWithOutcome: send, isPending: false }),
      J4: () => true,
      K4: (...args: any[]) => args.at(-1),
      J2: () => true,
      K2: (...args: any[]) => args.at(-1),
      crypto: {
        randomUUID: (() => {
          let n = 0;
          return () => `id-${++n}`;
        })(),
      },
      at: () => false,
      R: () => false,
    };
  vm.runInNewContext(functions, scope);
  return { api: scope.go("code", "error"), classify: scope.Ja, errors };
}
test("original compact button sends literal compact with one distinct optimistic identity", async () => {
  const sent: any[] = [];
  const f = setup(async (value) => {
      sent.push(value);
    }),
    ref = { id: "local_fixture" };
  await f.api.sendCompact(ref);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { ref, text: "/compact", uuid: "id-1" },
  ]);
  assert.deepEqual(f.errors, []);
});
test("original failure displays an explicit retry callback, without automatic retry", async () => {
  let sends = 0;
  const f = setup(async () => {
    sends++;
    throw Error("unconfirmed");
  });
  await f.api.sendCompact({ id: "local_fixture" });
  assert.equal(sends, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(typeof f.errors[0][2], "function");
});
test("original compact classifier includes arguments; host must refuse unsupported argument syntax explicitly", () => {
  const f = setup(async () => {});
  assert.equal(f.classify(" /compact "), true);
  assert.equal(f.classify("/compact preserve files"), true);
  assert.equal(f.classify("/compactly"), false);
});
