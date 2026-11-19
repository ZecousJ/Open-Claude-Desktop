import { verifyOfficialWebAssets } from "../scripts/official-web-assets.mjs";
import { modelPreferenceFeedbackInput, modelPreferenceFeedbackTarget } from "../scripts/official-ui-model-preference-feedback.mjs";
import { regenerationErrorInput, regenerationErrorTarget } from "../scripts/official-ui-regeneration-error.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import {
  deriveOfficialEditRetry,
  deriveOfficialEditRetryModule,
  applyOfficialEditRetry,
  verifyOfficialEditRetryManifest,
  editRetryRevision,
  editRetryInputHashes,
  editRetryMain,
  editRetryHub,
  editRetryMainBefore,
  editRetryMainAfter,
  editRetryHubBefore,
  editRetryHubAfter,
} from "../scripts/official-ui-edit-retry.mjs";
const resourceRoot = path.resolve(process.env.CLAUDEX_F008_ORIGINAL_RESOURCES ?? "build/official-ui/ui/assets/v1");
const sources = {};
const sha = (s) => createHash("sha256").update(s).digest("hex");
verifyOfficialWebAssets(process.cwd(), {
  officialUi: path.resolve(resourceRoot, "../../.."),
  onEditRetryInput: (name, source) => { sources[name] = source; },
});
assert.deepEqual(Object.keys(sources).sort(), Object.keys(editRetryInputHashes).sort());
const derived = deriveOfficialEditRetry(sources);
const finalHashes = Object.fromEntries([editRetryMain, editRetryHub].map(file => [file, sha(derived[file])]));
const parse = (source) =>
  ts.createSourceFile(
    "original.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
const hub = parse(sources[editRetryHub]),
  shared = parse(sources["shared-0-BgsOqC85.js"]),
  shared3 = parse(sources["shared-3-f8anTwq9.js"]);
function fn(tree, name) {
  const n = tree.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  assert(n, name);
  return n.getText(tree);
}
function decl(tree, name) {
  for (const stmt of tree.statements)
    if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (d.name.getText(tree) === name)
          return "var " + d.getText(tree) + ";";
  assert.fail(name);
}
const originalFunctions = [
  ...["SN", "DS", "OS", "CN", "m5", "B5", "wN", "Sne", "gS", "I_"].map((n) =>
    fn(hub, n),
  ),
  fn(shared, "cz"),
  fn(shared, "S6"),
].join("\n");
const oldRows = [
  { id: "first", role: 1, parentMessageId: "" },
  { id: "a1", role: 2, parentMessageId: "first" },
  { id: "later", role: 1, parentMessageId: "a1" },
  { id: "a2", role: 2, parentMessageId: "later" },
];
function fixture(change = {}) {
  const context = {
    Y: { USER: 1 },
    TI: { USER: 1 },
    Map,
    Set,
    console,
    ...change,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      decl(hub, "Lte"),
      decl(hub, "jb"),
      decl(hub, "Mb"),
      originalFunctions,
      "this.BT=m5;this.$D=CN;this.uk=Sne;this.Xh=S6;this.Ko=cz;this.uM=SN;",
    ].join("\n"),
    context,
  );
  const press = {
    parentMessageId: "",
    pressedMessageId: "first",
    pressKind: "edit",
  };
  // Original B5 associates a failed row with the original in-memory send-id map.
  context.R = { pressParents: new Map([["failed", press]]) };
  context.I = vm.runInContext(
    `({id:'failed',text:'Self-authored edited text',code:'api_error',retryable:true,displayMessage:'Recorded failure',...B5(R,'failed')})`,
    context,
  );
  context.Z = {
    conversation: { id: "self" },
    messages: new Map(oldRows.map((r) => [r.id, { ...r }])),
    activePathMessages: oldRows,
    contentBlocks: new Map(),
    textFor: (id) => "Self-authored " + id,
    activeLeafId: "a2",
  };
  Object.assign(context, {
    M: undefined,
    j: true,
    e: "self",
    Wh: ["editMessage"],
    Sa: { current: new Set() },
    toasts: [],
    je: { formatMessage: (m) => m.defaultMessage },
    Kx: {
      noKnownParent: { defaultMessage: "Original no-known-parent message" },
    },
  });
  context.wr = (...args) => context.toasts.push(args);
  context.ae = {
    parentMessageId: vm.runInContext("wN(undefined,Z.activeLeafId)", context),
  };
  return context;
}
function run(context, after = true) {
  return vm.runInContext(
    `(()=>{${after ? editRetryMainAfter : editRetryMainBefore}\nlet le=M === void 0 ? (B?.parentMessageId ?? ae.parentMessageId) : void 0; return {parent:le,pressed:B?.pressedMessageId,kind:B?.pressKind};})()`,
    context,
  );
}
function flag(entry, after = true, extra = {}) {
  const tree = parse((after ? derived : sources)[editRetryHub]);
  let expr;
  const rm = tree.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "RM",
  );
  assert(rm);
  function walk(n) {
    if (
      ts.isSpreadAssignment(n) &&
      n.getText(tree).includes("m.noRetry === !0") &&
      n.getText(tree).includes("sendFailedNoRetry")
    )
      expr = n.expression.getText(tree);
    ts.forEachChild(n, walk);
  }
  walk(rm);
  assert(expr);
  const projected = vm.runInNewContext(`({...(${expr})})`, {
    m: entry,
    _: false,
    ...extra,
  });
  // Exact original button predicate. No fake onClick/DOM is executed.
  return vm.runInNewContext(`(${fn(shared3, "Ye")})`)(projected);
}
test("red contract: root edit with later messages loses original parent before fix; true retry retains it after fix", () => {
  const c = fixture();
  assert.equal(run(c, false).parent, undefined);
  const fixed = run(c);
  assert.equal(fixed.parent, "");
  assert.equal(fixed.pressed, "first");
  assert.equal(fixed.kind, "edit");
  assert.equal(c.toasts.length, 0);
});
test("actual false/missing/null retry classification hides original Retry and blocks stale handler calls", () => {
  for (const retryable of [false, undefined, null]) {
    const c = fixture();
    c.I.retryable = retryable;
    assert.equal(flag(c.I, false), true);
    assert.equal(flag(c.I), false);
    assert.equal(run(c), "blocked_busy");
    assert.equal(c.toasts[0][0], "Recorded failure");
  }
});
test("unknown mutation outcome never retries even if an inconsistent true flag is present", () => {
  for (const retryable of [true, false, undefined]) {
    const c = fixture();
    Object.assign(c.I, { retryable, code: "mutation_unconfirmed" });
    assert.equal(flag(c.I), false);
    assert.equal(run(c), "blocked_busy");
  }
});
test("true retry validates current conversation, active user, unchanged parent, and original edit capability", () => {
  const mutations = [
    (c) => (c.j = false),
    (c) => (c.e = "other"),
    (c) => (c.Z.conversation.id = "other"),
    (c) => (c.M = {}),
    (c) => (c.Z.activePathMessages = oldRows.slice(2)),
    (c) => c.Z.messages.delete("first"),
    (c) => (c.Z.messages.get("first").role = 2),
    (c) => (c.Z.messages.get("first").parentMessageId = "other"),
    (c) => c.Sa.current.add("editMessage"),
    (c) => {
      c.Z.conversation.extras = [{ typeUrl: c.Mb }];
      c.Sa.current.add("branchFromEarlierTurn");
    },
    (c) => (c.I.invalidRequest = true),
    (c) => (c.I.pressParent.pressedMessageId = ""),
  ];
  for (const mutate of mutations) {
    const c = fixture();
    mutate(c);
    assert.equal(run(c), "blocked_busy");
    assert.equal(c.toasts.length, 1);
  }
});
test("eligible latest edit and explicit root parent survive; no ordinary send or assistant retry reclassification", () => {
  const latest = fixture();
  latest.I.pressParent = {
    parentMessageId: "a1",
    pressedMessageId: "later",
    pressKind: "edit",
  };
  assert.equal(run(latest).parent, "a1");
  const ordinary = fixture();
  delete ordinary.I.pressParent;
  assert.deepEqual(
    JSON.parse(JSON.stringify(run(ordinary))),
    JSON.parse(JSON.stringify(run(ordinary, false))),
  );
  assert.equal(flag(ordinary.I), true);
  const retry = fixture();
  retry.I.pressParent.pressKind = "retry";
  retry.I.retryable = false;
  assert.deepEqual(
    JSON.parse(JSON.stringify(run(retry))),
    JSON.parse(JSON.stringify(run(retry, false))),
  );
  assert.equal(flag(retry.I), true);
});
test("original noRetry, discarded/held flags and unknown code restrictions remain intact", () => {
  for (const extra of [
    { noRetry: true },
    { shelved: true },
    { unsent: true },
  ]) {
    const c = fixture();
    delete c.I.pressParent;
    Object.assign(c.I, extra);
    assert.equal(flag(c.I), false);
  }
  const c = fixture();
  assert.equal(flag(c.I), true);
  c.I.code = "ccrproxy_rewind_target_gone";
  assert.equal(run(c).parent, "");
  c.I.retryable = false;
  assert.equal(run(c), "blocked_busy");
});
test("pinning, single-use derivation and syntax guard exact resources; no unrelated bytes changed", () => {
  for (const [file, hash] of Object.entries(editRetryInputHashes))
    assert.equal(sha(sources[file]), hash);
  assert.equal(
    derived[editRetryMain].replace(editRetryMainAfter, editRetryMainBefore),
    sources[editRetryMain],
  );
  assert.equal(
    derived[editRetryHub].replace(editRetryHubAfter, editRetryHubBefore),
    sources[editRetryHub],
  );
  for (const source of Object.values(derived))
    assert.equal(parse(source).parseDiagnostics.length, 0);
  assert.throws(
    () =>
      deriveOfficialEditRetry({
        ...sources,
        [editRetryMain]: sources[editRetryMain] + " ",
      }),
    /pinned input/,
  );
  assert.throws(() => deriveOfficialEditRetry(derived), /pinned input/);
  assert.equal(
    deriveOfficialEditRetryModule("unrelated.js", "original"),
    "original",
  );
});
test("explicit isolated application writes only the two target modules and returns exact hashes", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "f008-edit-retry-"));
  try {
    for (const [f, s] of Object.entries(sources))
      fs.writeFileSync(path.join(dir, f), s);
    const result = applyOfficialEditRetry(dir);
    assert.equal(result.modules.length, 2);
    for (const row of result.modules)
      assert.equal(
        row.outputSha256,
        sha(fs.readFileSync(path.join(dir, row.file))),
      );
    for (const f of Object.keys(sources).filter(
      (f) => f !== editRetryMain && f !== editRetryHub,
    ))
      assert.equal(fs.readFileSync(path.join(dir, f), "utf8"), sources[f]);
    assert.throws(() => applyOfficialEditRetry(dir), /pinned input/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("new manifest validates exact reconstructed outputs and rejects missing/tampered dependencies", () => {
  const outputs = Object.fromEntries(
    [editRetryMain, editRetryHub].map((f) => [f, sha(derived[f])]),
  );
  const manifest = {
    revision: editRetryRevision,
    dependencies: Object.entries(editRetryInputHashes).map(
      ([file, inputSha256]) => ({ file, inputSha256 }),
    ),
    modules: [editRetryMain, editRetryHub].map((file) => ({
      file,
      inputSha256: editRetryInputHashes[file],
      outputSha256: outputs[file],
    })),
  };
  const files = Object.entries(derived).map(([file, s]) => ({
    path: "assets/v1/" + file,
    sha256: sha(s),
  }));
  verifyOfficialEditRetryManifest(manifest, files, outputs);
  assert.throws(
    () =>
      verifyOfficialEditRetryManifest(
        { ...manifest, revision: "wrong" },
        files,
        outputs,
      ),
    /manifest/,
  );
  assert.throws(
    () => verifyOfficialEditRetryManifest(manifest, files.slice(1), outputs),
    /dependency/,
  );
  assert.throws(
    () => verifyOfficialEditRetryManifest(manifest, files, {}),
    /output missing/,
  );
  assert.throws(
    () =>
      verifyOfficialEditRetryManifest(
        { ...manifest, unknown: true },
        files,
        outputs,
      ),
    /manifest/,
  );
});
test("formal wiring follows star derivation, binds manifest/cache, preserves old metadata and refuses invalid new field", () => {
  const scriptDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../scripts",
  );
  const build = fs.readFileSync(
    path.join(scriptDir, "build-official-ui.mjs"),
    "utf8",
  );
  const gate = fs.readFileSync(
    path.join(scriptDir, "official-web-assets.mjs"),
    "utf8",
  );
  assert(
    build.indexOf("applyOfficialEditRetry(modulesDir)") >
      build.indexOf("applyOfficialChatStarReconcile(modulesDir)"),
  );
  assert.equal(build.split("      hostEditRetry,").length, 2);
  assert.equal(
    gate.split("      hostEditRetry: meta.hostEditRetry ?? null,").length,
    2,
  );
  assert(
    gate.indexOf("deriveOfficialEditRetryModule(name, chatStarAware)") >
      gate.indexOf(
        "deriveOfficialChatStarReconcileModule(name, codeFeedbackAware)",
      ),
  );
  assert(gate.includes("sha256: expectedEditRetryInputs.get(editRetryMain)"));
  // Both later transforms must expose their exact predecessor to F008,
  // without changing final-byte checks or unrelated rows.
  const verifyStart = gate.indexOf("  const preStopFiles ="),
    verifyEnd = gate.indexOf(
      "  if (meta.hostRegenerationError) verify",
      verifyStart,
    );
  assert(verifyStart >= 0 && verifyEnd > verifyStart);
  const verification = gate.slice(verifyStart, verifyEnd);
  const files = [
    { path: "assets/v1/" + regenerationErrorTarget, sha256: "final-hub" },
    {
      path: "assets/v1/" + modelPreferenceFeedbackTarget,
      sha256: "final-shared",
    },
    { path: "assets/v1/" + editRetryMain, sha256: "unchanged-main" },
  ];
  for (const hasStop of [false, true])
  for (const hasRegeneration of [false, true])
    for (const hasPreference of [false, true]) {
      let checked;
      vm.runInNewContext(verification, {
        meta: {
          hostEditRetry: { revision: editRetryRevision },
          hostStopFeedback: hasStop ? {} : null,
          hostRegenerationError: hasRegeneration ? {} : null,
          hostModelPreferenceFeedback: hasPreference ? {} : null,
          hostCodeElicitation: null,
        },
        files,
        beforeLegacyFiles: files,
        regenerationErrorTarget,
        modelPreferenceFeedbackTarget,
        expectedStopFeedbackInputs: new Map([[regenerationErrorTarget, "pre-stop-hub"], [editRetryMain, "pre-stop-main"]]),
        expectedRegenerationInput: regenerationErrorInput,
        expectedModelPreferenceFeedbackInput: modelPreferenceFeedbackInput,
        expectedEditRetryOutputs: finalHashes,
        verifyOfficialEditRetryManifest: (manifest, priorFiles, outputs) => {
          assert.equal(manifest.revision, editRetryRevision);
          assert.equal(outputs, finalHashes);
          checked = priorFiles;
        },
      });
      assert.deepEqual(JSON.parse(JSON.stringify(checked)), [
        {
          ...files[0],
          sha256: hasRegeneration ? regenerationErrorInput : hasStop ? "pre-stop-hub" : "final-hub",
        },
        {
          ...files[1],
          sha256: hasPreference ? modelPreferenceFeedbackInput : "final-shared",
        },
        {...files[2], sha256: hasStop ? "pre-stop-main" : "unchanged-main"},
      ]);
      if (!hasStop && !hasRegeneration && !hasPreference) assert.equal(checked, files);
    }
  const start = gate.indexOf("  if (meta.hostEditRetry != null"),
    end = gate.indexOf("  const expectedEditRetryInputs", start);
  assert(start >= 0 && end > start);
  const guard = gate.slice(start, end);
  for (const hostEditRetry of [false, 0, "", {}, [], { revision: "wrong" }])
    assert.throws(
      () =>
        vm.runInNewContext(guard, {
          meta: { hostEditRetry, hostChatStarReconcile: {} },
          editRetryRevision,
        }),
      /Unsupported/,
    );
  for (const hostEditRetry of [undefined, null])
    vm.runInNewContext(guard, { meta: { hostEditRetry }, editRetryRevision });
  assert.throws(
    () =>
      vm.runInNewContext(guard, {
        meta: { hostEditRetry: { revision: editRetryRevision } },
        editRetryRevision,
      }),
    /complete Chat star/,
  );
  vm.runInNewContext(guard, {
    meta: {
      hostEditRetry: { revision: editRetryRevision },
      hostChatStarReconcile: {},
    },
    editRetryRevision,
  });
});
