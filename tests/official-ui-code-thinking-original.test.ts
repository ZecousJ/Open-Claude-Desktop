/** Executes exact original desktop/cloud hook bodies, not a mounted DOM or UI screenshot. */
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
    hook: "c66fe388e-DyBpwT6U.js",
    state: "c03935b01-CVtxe4l6.js",
    hookHash:
      "eafbf82ba3619b9d026559cba9ff64fd4858804bcc5cdb3578609c0efaf54fa2",
    stateHash:
      "4a603907610574523efa45fe83bac3e9d27b2ccec1f4f4e282fa1a4b2dc3b26a",
    bridge: "e",
    store: "b",
    wanted: "O",
    mapping: "Vo",
  },
  {
    name: "cloud",
    hook: "c66fe388e-EuGgL-ZK.js",
    state: "c03935b01-C5mJBQhH.js",
    hookHash:
      "7efd25aa147494697936d68aa1c67bc79941481182b79ce0ff0ed20ccac131b7",
    stateHash:
      "934dfa7404090695c4fc1a3683c49c1f2ac4656df2469be21247fd6a0cf70af0",
    bridge: "s",
    store: "O",
    wanted: "F",
    mapping: "zo",
  },
];
function extract(
  build: string,
  file: string,
  hash: string,
  matches: (node: ts.FunctionDeclaration, ast: ts.SourceFile) => boolean,
) {
  const source = fs.readFileSync(
    path.join(root!, build, "assets/v1", file),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    hash,
    "Original asset changed; reverify before repinning",
  );
  const ast = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const nodes = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && matches(node, ast),
  );
  assert.equal(nodes.length, 1);
  return nodes[0].getText(ast);
}
function setup(
  build: (typeof builds)[number],
  initial: Record<string, unknown> = {},
) {
  const native = new Map<string, any>(),
    calls: any[] = [],
    pending: Promise<unknown>[] = [];
  const c: any = {
    id: "one",
    mode: "code",
    cwd: "/inert",
    createdAt: 1,
    turns: [],
  };
  let fail = false;
  registerExperimentalCodeSessions({
    ctx: {
      account: () => ({ id: "owner" }),
      sessionIdentity: () => 1,
      isCurrent: () => true,
      localLoadConversation: async () => structuredClone(c),
      onEvent: () => () => {},
      localCall: async (method: string, id: string, patch: any) => {
        calls.push([method, id, patch]);
        if (fail) throw Error("save failed");
        assert.equal(method, "updateConversation");
        c.thinkingSummariesWanted = patch.thinkingSummariesWanted.wanted;
        return structuredClone(c);
      },
    },
    on: (name: string, fn: any) => native.set(name, fn),
    emit() {},
  } as never);
  const state = {
    currentSessionId: "local_one",
    ownerStarting: false,
    transcriptMode: "normal",
    host: undefined,
    ...initial,
  };
  let subscriber: ((state: any) => void) | undefined,
    cleanup: (() => void) | undefined;
  const listeners = new Map<string, () => void>();
  const originalMapping = vm.runInNewContext(
    "(" +
      extract(
        build.name,
        build.state,
        build.stateHash,
        (node) => node.name?.text === build.mapping,
      ) +
      ")",
  );
  const hook = vm.runInNewContext(
    "(" +
      extract(build.name, build.hook, build.hookHash, (node, ast) =>
        node.getText(ast).includes("setThinkingSummariesWanted"),
      ) +
      ")",
    {
      J9: () => [],
      J1: () => true,
      K2: () => {},
      a: (effect: () => (() => void) | undefined) => {
        cleanup = effect();
      },
      [build.store]: () => ({
        getState: () => state,
        subscribe: (fn: any) => {
          subscriber = fn;
          return () => {
            subscriber = undefined;
          };
        },
      }),
      [build.wanted]: originalMapping,
      [build.bridge]: {
        setThinkingSummariesWanted: (id: string, wanted: boolean) => {
          const operation = native.get(
            "LocalSessions.setThinkingSummariesWanted",
          )(id, wanted);
          pending.push(operation);
          return operation;
        },
      },
      c: (id: string) => id.startsWith("local_"),
      window: {
        addEventListener: (name: string, fn: () => void) =>
          listeners.set(name, fn),
        removeEventListener: (name: string) => listeners.delete(name),
      },
    },
  );
  hook();
  return {
    calls,
    c,
    state,
    update: (patch: Record<string, unknown> = {}) => {
      Object.assign(state, patch);
      subscriber?.(state);
    },
    focus: () => listeners.get("focus")?.(),
    fail: (value: boolean) => {
      fail = value;
    },
    settle: async () => {
      await Promise.allSettled(pending);
      await Promise.resolve();
    },
    close: () => {
      cleanup?.();
    },
  };
}
for (const build of builds) {
  test(
    `${build.name} original Normal/Thinking/Verbose hook updates and deduplicates native preference`,
    { skip: !root },
    async () => {
      const h = setup(build);
      await h.settle();
      h.update({ transcriptMode: "thinking" });
      await h.settle();
      h.update({ transcriptMode: "verbose" });
      await h.settle();
      assert.equal(
        h.calls.length,
        2,
        "thinking and verbose share the same wanted state",
      );
      h.update({ transcriptMode: "normal" });
      await h.settle();
      assert.deepEqual(
        h.calls.map((x) => x[2].thinkingSummariesWanted.wanted),
        [false, true, false],
      );
      assert.equal(h.c.thinkingSummariesWanted, false);
      h.focus();
      await h.settle();
      assert.equal(
        h.calls.length,
        4,
        "focus reaffirms preference after reconnect",
      );
      h.close();
      h.focus();
      h.update({ transcriptMode: "thinking" });
      await h.settle();
      assert.equal(
        h.calls.length,
        4,
        "unmount removes subscription and focus listener",
      );
    },
  );
  test(
    `${build.name} original hook retries failed writes on later state notification`,
    { skip: !root },
    async () => {
      const h = setup(build);
      await h.settle();
      h.fail(true);
      h.update({ transcriptMode: "thinking" });
      await h.settle();
      assert.equal(h.c.thinkingSummariesWanted, false);
      h.fail(false);
      h.update();
      await h.settle();
      assert.equal(h.c.thinkingSummariesWanted, true);
      assert.equal(h.calls.length, 3);
      h.close();
    },
  );
  for (const [name, initial] of [
    ["owner starting", { ownerStarting: true }],
    ["no session", { currentSessionId: null }],
    ["remote session", { currentSessionId: "remote_one" }],
    ["bridged popout", { host: { kind: "popout", composer: "bridged" } }],
  ] as const)
    test(
      `${build.name} original hook skips ${name}`,
      { skip: !root },
      async () => {
        const h = setup(build, initial);
        await h.settle();
        h.focus();
        await h.settle();
        assert.deepEqual(h.calls, []);
        h.close();
      },
    );
}
