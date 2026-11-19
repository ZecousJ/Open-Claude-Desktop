import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import os from "node:os";
import path from "node:path";
import {
  protocolPredicateSource,
  hostCompletionRules,
  hostCompletionSourceHashes,
  deriveOfficialUiHostCompletionModule,
  applyOfficialUiHostCompletion,
} from "../../scripts/official-ui-host-completion.mjs";
const root = path.join(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
  "claude-frontend-4.4212.0/src/cloud/assets/v1",
);
const file = "shared-4-Kt-jV-IU.js";
const original = fs.readFileSync(path.join(root, file), "utf8");
const derived = deriveOfficialUiHostCompletionModule(file, original);
const descriptor = {
  version: 1,
  account_uuid: "owner",
  organization_uuid: "org",
  protocol: "text-chat-v1",
  surface: "chat",
  completion_path: "/chat_conversations/:id/completion",
  automatic_client_tools: "unsupported",
};
const host = () => ({
  account: {
    uuid: "owner",
    settings: {},
    claudex_frontend_completion_protocol: { ...descriptor },
  },
  activeOrganization: { uuid: "org" },
});
function extract(source, name) {
  const at = source.indexOf("function " + name + "(");
  assert.notEqual(at, -1);
  const end = source.indexOf("\nfunction ", at + 1);
  return source.slice(at, end < 0 ? source.length : end);
}
function produce(source, kind, state, options = {}) {
  const added = options.initial ?? [];
  const box = {
    state,
    options,
    __claudexChatPathname: () => options.path ?? "/new",
    a4: () => state,
    CX: () => [],
    il: () => false,
    RS: () => ({ blocksMcp: false, blocksWebSearch: false }),
    $t: (f) =>
      f({ IframeParentTools: options.iframe ?? [], integrationName: null }),
    TI: (f) => f({ active: false }),
    ib: () => options.extra ?? [],
    Rq: () => ({ tools: options.plugin ?? [] }),
    YF: () => false,
    n0: () => false,
    vQ: () => new Set(),
    Iy: () => options.dynamic ?? [],
    Iq: () => () => true,
    Ar: () => true,
    b7: (f) => f,
    fU: () => added.slice(),
    G9: new Set(),
    EZ: { OfferScheduleV0: "schedule" },
    jQ: ["default_widget", "schedule"],
    bB: [],
    hZ: () => options.selected ?? [],
    YR: (e) => ({ value: e?.enabled_artifacts_attachments ?? true }),
    zZ: () => !!options.project,
    Ll: () => ({ hideAskUserInput: false }),
    k5: {},
    WU: new Set(),
  };
  vm.createContext(box);
  vm.runInContext(
    protocolPredicateSource +
      "\n" +
      extract(source, kind) +
      "\nresult=" +
      kind +
      "(options.settings);",
    box,
  );
  return JSON.parse(JSON.stringify(box.result(options.settings)));
}
test("descriptor is strictly account/org/protocol/surface bound; unmarked behavior stays original", () => {
  for (const state of [
    undefined,
    {},
    { account: { uuid: "owner" } },
    { ...host(), activeOrganization: { uuid: "other" } },
    { ...host(), activeOrganization: {} },
    (() => {
      const s = host();
      s.activeOrganization = {};
      delete s.account.claudex_frontend_completion_protocol.organization_uuid;
      return s;
    })(),
    { ...host(), activeOrganization: { uuid: "" } },
    ...[
      "version",
      "account_uuid",
      "protocol",
      "surface",
      "completion_path",
      "automatic_client_tools",
    ].map((k) => {
      const s = host();
      s.account.claudex_frontend_completion_protocol[k] = "wrong";
      return s;
    }),
  ])
    for (const kind of ["bN", "HK"])
      assert.deepEqual(
        produce(derived, kind, state),
        produce(original, kind, state),
      );
});
test("both Chat producers suppress only automatic defaults", () => {
  for (const kind of ["bN", "HK"]) {
    assert.deepEqual(produce(derived, kind, host()), []);
    const explicit = {
      initial: [{ name: "mcp" }],
      iframe: [{ name: "iframe", description: "test", input_schema: {} }],
      settings: {
        enabled_web_search: true,
        enabled_artifacts_attachments: true,
      },
      dynamic: ["default_widget", "selected_widget"],
      selected: ["chosen"],
      extra: [{ name: "extra" }],
      plugin: [{ name: "plugin" }],
    };
    const names = produce(derived, kind, host(), explicit).map((x) => x.name);
    for (const name of [
      "mcp",
      "iframe",
      "web_search",
      "repl",
      "default_widget",
      "selected_widget",
      "chosen",
      "extra",
      "plugin",
    ])
      assert.ok(names.includes(name), kind + ":" + name);
    assert.ok(!names.includes("artifacts"));
    const state = host();
    state.account.settings.enabled_artifacts_attachments = true;
    assert.ok(
      produce(derived, kind, state).some((x) => x.name === "repl"),
      "saved explicit REPL remains rejected rather than silently erased",
    );
  }
  assert.ok(
    produce(derived, "HK", host(), { project: true }).some(
      (x) => x.name === "project_knowledge_search",
    ),
  );
});
test("supported Compare panels use the owned text Chat declarations", () => {
  const state = host();
  state.account.claudex_comparison_supported = true;
  for (const kind of ["bN", "HK"]) {
    assert.deepEqual(produce(derived, kind, state, { path: "/comparison" }), []);
    assert.deepEqual(
      produce(derived, kind, state, { path: "/comparison/", initial: [{ name: "mcp" }] }),
      [{ name: "mcp" }],
    );
    assert.deepEqual(
      produce(derived, kind, host(), { path: "/comparison" }),
      produce(original, kind, host(), { path: "/comparison" }),
    );
  }
});
test("unknown and native Code/Cowork descriptors do not change declaration semantics", () => {
  for (const surface of ["code.native", "cowork.native", "code", "cowork"]) {
    const state = host();
    state.account.claudex_frontend_completion_protocol.surface = surface;
    for (const kind of ["bN", "HK"])
      assert.deepEqual(
        produce(derived, kind, state),
        produce(original, kind, state),
      );
  }
  assert.equal(
    deriveOfficialUiHostCompletionModule(
      "native-code.js",
      "native Code original",
    ),
    "native Code original",
  );
});
test("source hashes and unique anchors are immutable; all files validate before writes", (t) => {
  assert.throws(
    () => deriveOfficialUiHostCompletionModule(file, original + "\n"),
    /hash mismatch/,
  );
  assert.throws(
    () => deriveOfficialUiHostCompletionModule(file, derived),
    /hash mismatch/,
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-completion-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of Object.keys(hostCompletionSourceHashes))
    fs.copyFileSync(path.join(root, name), path.join(dir, name));
  fs.appendFileSync(path.join(dir, "c71860c77-DL-7pM_e.js"), "\n");
  assert.throws(() => applyOfficialUiHostCompletion(dir), /hash mismatch/);
  assert.equal(fs.readFileSync(path.join(dir, file), "utf8"), original);
  const protectedDir = path.join(dir, ".restore", "assets");
  fs.mkdirSync(protectedDir, { recursive: true });
  for (const name of Object.keys(hostCompletionSourceHashes))
    fs.copyFileSync(path.join(root, name), path.join(protectedDir, name));
  assert.throws(() => applyOfficialUiHostCompletion(protectedDir), /immutable/);
  if (process.env.CLAUDEX_OFFICIAL_EXTRACTED)
    assert.throws(() => applyOfficialUiHostCompletion(root), /immutable/);
});
test("settings read-only controls preserve saved checked values and automatic effect is account-aware", () => {
  const source = deriveOfficialUiHostCompletionModule(
    "c71860c77-DL-7pM_e.js",
    fs.readFileSync(path.join(root, "c71860c77-DL-7pM_e.js"), "utf8"),
  );
  assert.ok(source.includes("checked: C, disabled: true"));
  assert.ok(source.includes("label: y, description: S, control:"));
  assert.ok(!source.includes("Saved preferences are unchanged"));
  assert.ok(source.includes("if (!c || __limited) return;"));
  assert.ok(source.includes("$[13] !== __limited"));
  assert.ok(source.includes("[c, r, s, __limited]"));
  for (const rule of hostCompletionRules.filter((r) =>
    r.name.endsWith("hook-dependencies"),
  ))
    assert.ok(
      rule.after.includes("__limited") && rule.after.includes("__explicitRepl"),
    );
});
test("actual extracted settings effect never writes host preferences; visible read-only branch has no mutation callback", () => {
  const settingsFile = "c71860c77-DL-7pM_e.js";
  const source = deriveOfficialUiHostCompletionModule(
    settingsFile,
    fs.readFileSync(path.join(root, settingsFile), "utf8"),
  );
  const ft = extract(source, "ft"),
    start = ft.indexOf("(l = () => {") + "(l = ".length,
    end = ft.indexOf("\n        }),", start) + 10;
  const callback = ft.slice(start, end);
  for (const limited of [true, false]) {
    const writes = [],
      settings = Object.freeze({
        enabled_monkeys_in_a_barrel: true,
        preview_feature_uses_artifacts: false,
        enabled_artifacts_attachments: true,
      });
    const box = {
      __limited: limited,
      c: settings,
      s: false,
      a: { current: false },
      r: (v) => writes.push(v),
    };
    vm.createContext(box);
    vm.runInContext("(" + callback + ")()", box);
    assert.equal(writes.length, limited ? 0 : 2);
    assert.equal(settings.preview_feature_uses_artifacts, false);
  }
  const mt = extract(source, "mt"),
    branch = mt.slice(
      mt.indexOf("  if (__limited"),
      mt.indexOf("  return J3($, 36"),
    );
  for (const checked of [true, false])
    for (const key of [
      "enabled_artifacts_attachments",
      "preview_feature_uses_artifacts",
    ]) {
      const box = {
        __limited: true,
        t: key,
        y: "Label",
        S: "Original description",
        C: checked,
        w: "id",
        L: "row",
        x: "switch",
        u: (type, props) => ({ type, props }),
      };
      vm.createContext(box);
      vm.runInContext("result=(function(){" + branch + "})()", box);
      assert.equal(box.result.props.children.props.description, "Original description");
      assert.equal(box.result.props.children.props.control.props.checked, checked);
      assert.equal(box.result.props.children.props.control.props.disabled, true);
      assert.equal(box.result.props.children.props.control.props.onCheckedChange, undefined);
    }
});
test("both original composer variants remain byte-identical with no persistent host note or wrapper", () => {
  const name = "shared-9-B15zSG0N.js";
  const source = fs.readFileSync(path.join(root, name), "utf8");
  const output = deriveOfficialUiHostCompletionModule(name, source);
  assert.equal(output, source);
  for (const variant of ["IJ", "D$"]) assert.equal(extract(output, variant), extract(source, variant));
  assert.equal(Object.hasOwn(hostCompletionSourceHashes, name), false);
  assert.equal(hostCompletionRules.some(rule => rule.file === name), false);
  assert.ok(!output.includes("__claudexCompletionComposer"));
  assert.ok(!output.includes("This Claudex Chat frontend currently supports text responses only."));
});
test("known Chat paths retain exact text-only declaration guards without changing composer layout", () => {
  for (const pathname of ["/new", "/new/", "/chat/33333333-3333-4333-8333-333333333333", "/code/local/id", "/cowork/id", "/project/id", "/projects", "/chat/not-id", "/settings", "/new/child"]) {
    const supported = pathname === "/new" || pathname === "/new/" || pathname.includes("33333333");
    for (const kind of ["bN", "HK"])
      assert.deepEqual(produce(derived, kind, host(), {path: pathname}), supported ? [] : produce(original, kind, host(), {path: pathname}));
  }
  assert.ok(derived.includes("JN as __claudexChatPathname"));
});
