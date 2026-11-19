/** Exact pinned original preload method execution, not rendered UI acceptance. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";

const original = process.env.CLAUDEX_ORIGINAL_NATIVE_PRELOAD;
function method(name: string) {
  const text = fs.readFileSync(original!, "utf8");
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    "9657e430fa1f2000239cf943d8edb9003b78de0758908711f4fef6ec1b944465",
  );
  const source = ts.createSourceFile(
    "original.cjs",
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const matches: ts.MethodDeclaration[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(source) === name &&
      node.getText(source).includes(`"LocalSessions_$_${name}"`)
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(
    matches.length,
    1,
    "Expected exactly one original LocalSessions method",
  );
  return matches[0].getText(source);
}

for (const [name, args, reply] of [
  [
    "forkSession",
    ["local_parent", "local_request", "message", "/approved"],
    { sessionId: "local_child" },
  ],
  [
    "forkSession",
    ["local_parent", undefined, undefined, undefined],
    { sessionId: "local_child" },
  ],
  [
    "rewindV2",
    ["local_session", "message"],
    { prefill: "draft", assistantUuid: "assistant" },
  ],
  ["undoRewind", ["local_session"], { transcript: [], prefill: "draft" }],
  ["importAllCliSessions", [], undefined],
  ["probeImportableCliSessions", [], { count: 2 }],
  ["listCliSessions", [200], []],
  ["listResumableCliSessions", [undefined], []],
  ["readCliTranscript", ["opaque", 20, 40], { messages: [], totalMessages: 0 }],
  [
    "previewCliResume",
    ["opaque"],
    { resumable: false, reason: "folder_missing" },
  ],
  ["resumeCliSession", ["opaque"], { ok: true, sessionId: "local_session" }],
] as const) {
  test(
    `original preload ${name} passes exact positional arguments and preserves return/rejection (${args.length})`,
    {
      skip: !original,
    },
    async () => {
      const calls: unknown[][] = [];
      const result = Promise.resolve(reply);
      let fail = false;
      const error = new Error("inert transport failure");
      const bridge = vm.runInNewContext(
        `({${method(name)}})`,
        {
          Y: "verified-prefix:",
          t: {
            ipcRenderer: {
              invoke: (...values: unknown[]) => {
                calls.push(values);
                return fail ? Promise.reject(error) : result;
              },
            },
          },
        },
        { timeout: 1000 },
      );
      const pending = bridge[name](...args);
      assert.equal(
        pending,
        result,
        "Original method must return the transport promise unchanged",
      );
      assert.deepEqual(await pending, reply);
      assert.deepEqual(calls, [
        [`verified-prefix:LocalSessions_$_${name}`, ...args],
      ]);
      fail = true;
      await assert.rejects(
        bridge[name](...args),
        (actual: unknown) => actual === error,
      );
    },
  );
}
