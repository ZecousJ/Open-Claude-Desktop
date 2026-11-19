import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import ts from "typescript";
import { brandedModule } from "../scripts/official-web-assets.mjs";
import { deriveOfficialUiHostWorkspaceTrustModule } from "../scripts/official-ui-host-workspace-trust.mjs";
import { deriveOfficialUiLaunchDraftModule } from "../scripts/official-ui-host-launch-draft.mjs";
import {
  applyOfficialUiHostCodeTakeback,
  deriveOfficialUiHostCodeTakebackModule as derive,
  hostCodeTakebackTarget as target,
  hostCodeTakebackInputHashes as inputs,
  hostCodeTakebackOriginalHashes as originals,
  hostCodeTakebackHelper as helper,
  hostCodeTakebackRules as rules,
} from "../scripts/official-ui-host-code-takeback.mjs";

const sourceRoot = path.resolve(
  process.env.CLAUDEX_OFFICIAL_UI_SOURCE ??
    ".restore/archive-extracted/claude-frontend-4.4212.0",
);
const assets = path.join(sourceRoot, "src/cloud/assets/v1");
const raw = fs.readFileSync(path.join(assets, target), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
assert.equal(sha(raw), originals[target]);
const input = deriveOfficialUiLaunchDraftModule(
  target,
  deriveOfficialUiHostWorkspaceTrustModule(target, brandedModule(raw)),
);
assert.equal(sha(input), inputs[target]);
const output = derive(target, input);
const mergeSource = fs
  .readFileSync(path.join(assets, "c9180c9af-DxsZfBPE.js"), "utf8")
  .replace(/export \{ e as t \};/, "this.kT = e;");
const callbacks = new Map<string, string>();
for (const [version, source] of [
  ["before", input],
  ["after", output],
]) {
  const parsed = ts.createSourceFile(
    target,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  function visit(node: ts.Node) {
    if (
      ts.isVariableDeclaration(node) &&
      ["Xc", "h_", "Lv"].includes(node.name.getText(parsed)) &&
      node.initializer &&
      ts.isConditionalExpression(node.initializer)
    ) {
      const expr = node.initializer.whenTrue;
      if (
        ts.isCallExpression(expr) &&
        /J[45]\(\$, (366|1032|1126),/.test(node.initializer.condition.getText(parsed))
      )
        callbacks.set(
          version + ":" + node.name.getText(parsed),
          expr.arguments.at(-1)!.getText(parsed),
        );
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
}
assert.equal(
  callbacks.size,
  6,
  "Pinned takeback and usage callbacks must be extracted",
);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("the original Code usage action opens the existing settings pane for the signed-in Claudex account", () => {
  const pane: string[] = [], routes: string[] = [], rows: unknown[] = [];
  let mounted = true;
  const account = {
    uuid: "account",
    claudex_host_authentication: { version: 1, status: "authenticated", account_uuid: "account" },
    claudex_usage_summary: { version: 1, read_only: true, account_uuid: "account", organization_uuid: "org" },
  };
  const ctx = {
    account,
    organization: { uuid: "org" },
    q: { id: "local_fixture" },
    lA: () => false,
    T9: true,
    Fl: "fixture-",
    Ik: { getState: () => ({ buckets: {}, injectClientRows: (...args: unknown[]) => rows.push(args) }) },
    or: { getState: () => ({ mounted, open: (tab: string) => pane.push(tab) }) },
    R: { push: (route: string) => routes.push(route) },
    Wn: false,
    y() {},
  };
  const capability = vm.runInNewContext(`${helper}\n__claudexHasUsage`, ctx);
  const action = (org: { uuid: string }) => vm.runInNewContext(`(${callbacks.get("after:Lv")})`, {
    ...ctx,
    claudexCodeUsage: { current: capability(account, org) },
    or: { getState: () => ({ mounted, open: (tab: string) => pane.push(tab) }) },
  });
  action({ uuid: "org" })("/usage");
  mounted = false;
  action({ uuid: "org" })("/stats");
  assert.deepEqual(pane, ["usage"]);
  assert.deepEqual(routes, ["/settings/usage"]);
  assert.deepEqual(rows, []);
  action({ uuid: "other" })("/usage");
  assert.equal(rows.length, 1);
});

function fixture(
  version = "after",
  original = "failed\nfollow-up",
  draft = original,
  sessionId = "local_owned",
) {
  let text = draft,
    cancelled = 0,
    focus = 0,
    removals = 0;
  let cancel = () => Promise.resolve(true);
  const notices: unknown[] = [],
    errors: unknown[] = [];
  const entry = { id: "held", items: [] };
  const editor = {
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
    hasDraft: () => text.length > 0,
    isBashMode: () => false,
    scheduleFocus: () => {
      focus++;
    },
  };
  const box: any = {
    wi: false,
    Oo: { current: editor },
    Vo: {
      current: { removeSnippet() {}, restoreSnippets() {}, addImageFiles() {} },
    },
    Bo: { current: new Set() },
    q: { type: "local", id: sessionId },
    J: sessionId,
    r: "scope",
    na: undefined,
    Yr: { has: () => false, store: { getState: () => ({ pending: [] }) } },
    Xr: () => false,
    Oi: () => {
      cancelled++;
      return cancel();
    },
    nj: () => false,
    tj: () => [],
    cj: ({ cancelNeedsConfirm, hasDraft, isBashMode, restagesImages }: any) =>
      !cancelNeedsConfirm && hasDraft && !isBashMode && !restagesImages,
    aj: () => ({ text: original, pills: [], shellTurn: false }),
    mr: () => true,
    io() {},
    as() {},
    Dt: () => 1,
    A: { formatMessage: (m: any) => m.defaultMessage },
    M: (v: any) => notices.push(v),
    I: (v: any) => notices.push(v),
    bw: 1,
    dwe: (e: any) => errors.push(e),
    fh: {
      getState: () => ({
        bySession: { [sessionId]: [{ uuid: "held", text: original }] },
      }),
    },
    i_: [entry],
    f_: () => {
      removals++;
      return true;
    },
    sc() {},
    pCe: (v: any) => v,
    fCe: (v: any) => v,
    sQ: () => ({ images: [], undecodable: [] }),
    y() {},
  };
  vm.createContext(box);
  vm.runInContext(mergeSource + helper, box);
  vm.runInContext(
    "this.queued=(" +
      callbacks.get(version + ":Xc") +
      ");this.parked=(" +
      callbacks.get(version + ":h_") +
      ");",
    box,
  );
  return {
    box,
    entry,
    editor,
    notices,
    errors,
    text: () => text,
    counts: () => ({ cancelled, focus, removals }),
    setCancel(fn: typeof cancel) {
      cancel = fn;
    },
    queued: () => box.queued(entry, true, undefined, { mergeOverDraft: true }),
    parked: () => box.parked("held", { takeBack: true }),
  };
}

test("actual original queued and parked callbacks reproduce duplicate restored draft", async () => {
  for (const kind of ["queued", "parked"] as const) {
    const f = fixture("before");
    f[kind]();
    await tick();
    assert.equal(f.text(), "failed\nfollow-up\n\nfailed\nfollow-up");
  }
});

test("actual patched queued and parked takeback keep one exact restored multiline draft", async () => {
  for (const kind of ["queued", "parked"] as const) {
    const f = fixture();
    f[kind]();
    await tick();
    assert.equal(f.text(), "failed\nfollow-up");
    assert.equal(f.errors.length, 0);
    assert.equal(f.counts().focus, 1);
    assert.equal(
      kind === "queued" ? f.counts().cancelled : f.counts().removals,
      1,
    );
  }
});

test("different drafts and whitespace remain unchanged by the narrow equality rule", async () => {
  for (const kind of ["queued", "parked"] as const)
    for (const draft of ["new work", "failed\nfollow-up ", "failed", ""]) {
      const f = fixture("after", "failed\nfollow-up", draft);
      f[kind]();
      await tick();
      assert.equal(
        f.text(),
        ["failed\nfollow-up", draft].filter(Boolean).join("\n\n"),
      );
    }
});

test("non-native session IDs retain original equal-text merge behavior", async () => {
  for (const kind of ["queued", "parked"] as const)
    for (const id of ["remote_owned", "vendor-session"]) {
      const f = fixture("after", "same", "same", id);
      f[kind]();
      await tick();
      assert.equal(f.text(), "same\n\nsame");
    }
});

test("actual cancellation refusal and rejection restore prior draft without dropping later user typing", async () => {
  for (const rejected of [false, true])
    for (const changed of [false, true]) {
      const f = fixture("after", "held", "different draft");
      let finish!: (v?: any) => void;
      f.setCancel(
        () =>
          new Promise((resolve, reject) => {
            finish = rejected ? reject : resolve;
          }),
      );
      assert.equal(f.queued(), true);
      assert.equal(f.text(), "held\n\ndifferent draft");
      if (changed) f.editor.setText("typed while waiting");
      finish(rejected ? Error("cancel failed") : false);
      await tick();
      assert.equal(
        f.text(),
        changed ? "typed while waiting" : "different draft",
      );
      assert.equal(f.counts().cancelled, 1);
    }
});

test("repeated equal-text takeback does not compound restored draft", async () => {
  const f = fixture();
  f.queued();
  await tick();
  f.setCancel(() => Promise.resolve(false));
  f.queued();
  await tick();
  assert.equal(f.text(), "failed\nfollow-up");
});

test("original bash and image-restaging guards still refuse merging over existing input", () => {
  for (const kind of ["queued", "parked"] as const)
    for (const reason of ["bash", "images"]) {
      const f = fixture();
      if (reason === "bash") f.editor.isBashMode = () => true;
      else f.box.tj = () => [{}];
      f[kind]();
      assert.equal(f.text(), "failed\nfollow-up");
      assert.equal(f.notices.length, 1);
      assert.equal(f.counts().cancelled + f.counts().removals, 0);
    }
});

test("hash-pinned composer transform applies its declared rules and helper", () => {
  let expected = input;
  for (const rule of rules.filter((entry) => entry.file === target)) {
    assert.equal(expected.split(rule.before).length, 2);
    expected = expected.replace(rule.before, rule.after);
  }
  assert.equal(output, helper + expected);
  assert.equal(derive("unrelated.js", "unchanged"), "unchanged");
  assert.throws(() => derive(target, input + "\n"), /input mismatch/);
  assert.throws(() => derive(target, output), /input mismatch/);
});

test("application writes a checked assembled copy and refuses recovered source or symlink output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-takeback-"));
  try {
    const file = path.join(root, target);
    fs.writeFileSync(file, input);
    for (const asset of Object.keys(inputs).filter((name) => name !== target))
      fs.writeFileSync(path.join(root, asset), brandedModule(fs.readFileSync(path.join(assets, asset), "utf8")));
    const manifest = applyOfficialUiHostCodeTakeback(root);
    assert.equal(fs.readFileSync(file, "utf8"), output);
    assert.equal(manifest.modules[0].outputSha256, sha(output));
    assert.throws(() => applyOfficialUiHostCodeTakeback(assets), /immutable/);
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(assets, target), file);
    assert.throws(() => applyOfficialUiHostCodeTakeback(root), /regular/);
    assert.equal(
      sha(fs.readFileSync(path.join(assets, target), "utf8")),
      originals[target],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pinned waiting rows lock only acknowledged local steering", () => {
  const name = "c06cf64bb-CcaN03HG.js";
  const source = derive(name, fs.readFileSync(path.join(assets, name), "utf8"));
  const projection = source.slice(source.indexOf("function Fy("), source.indexOf("function Iy("));
  const project = vm.runInNewContext(projection + "\nFy", { rd: (rows: unknown[]) => rows });
  const entry = [{ id: "fixture" }];
  assert.equal(project(entry, [], "steer", "local_fixture")[0].waitingLocked, true);
  assert.equal(project(entry, [], "queued", "local_fixture")[0].waitingLocked, undefined);
  assert.equal(project(entry, [], "steer", "session_fixture")[0].waitingLocked, undefined);
});

test("derived original ESM graph links without executing UI modules", async () => {
  assert.equal(
    typeof vm.SourceTextModule,
    "function",
    "Run with --experimental-vm-modules",
  );
  const cache = new Map<string, vm.SourceTextModule>();
  function load(file: string): vm.SourceTextModule {
    file = path.resolve(file);
    assert.ok(file.startsWith(assets + path.sep));
    let found = cache.get(file);
    if (found) return found;
    found = new vm.SourceTextModule(
      path.basename(file) === target ? output : Object.hasOwn(inputs, path.basename(file))
        ? derive(path.basename(file), brandedModule(fs.readFileSync(file, "utf8")))
        : fs.readFileSync(file, "utf8"),
      { identifier: file },
    );
    cache.set(file, found);
    return found;
  }
  const entry = load(path.join(assets, target));
  await entry.link((specifier, parent) => {
    assert.ok(specifier.startsWith("./") || specifier.startsWith("../"));
    return load(path.resolve(path.dirname(parent.identifier), specifier));
  });
  assert.equal(entry.status, "linked");
  assert.ok(cache.size > 20);
});

test("assembly and offline verifier declare the takeback stage after launch-draft and retain predecessor hash", () => {
  const build = fs.readFileSync("scripts/build-official-ui.mjs", "utf8"),
    verify = fs.readFileSync("scripts/official-web-assets.mjs", "utf8");
  assert.ok(
    build.indexOf("applyOfficialUiHostCodeTakeback(modulesDir)") >
      build.indexOf("applyOfficialUiHostLaunchDraft(modulesDir)"),
  );
  assert.ok(
    verify.includes(
      "deriveOfficialUiHostCodeTakebackModule(name, launchDraftAware)",
    ),
  );
  assert.ok(
    verify.includes(
      "meta.hostCodeTakeback && manifest === meta.hostLaunchDraft",
    ),
  );
  assert.ok(verify.includes("hostCodeTakeback: meta.hostCodeTakeback ?? null"));
});

test("This computer remains selectable from WSL", () => {
  const source = ts.createSourceFile(target, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const expressions: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "ve" &&
        node.initializer?.getText(source).includes('ue !== "wsl"'))
      expressions.push(node.initializer.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(expressions.length, 1);
  const selected = (envType: string, overrides: Record<string, boolean> = {}) =>
    vm.runInNewContext(expressions[0], { u: true, ue: envType, de: false, f: false, h: false, q: false, ...overrides });
  assert.equal(selected("local"), true);
  assert.equal(selected("wsl"), false);
  assert.equal(selected("local", { h: true }), false);
});
