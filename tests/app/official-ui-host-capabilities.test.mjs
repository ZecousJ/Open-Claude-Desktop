import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import {
  deriveOfficialUiHostCapabilityModule,
  hostCapabilityRules,
  prepareOfficialUiHostCapabilities,
} from "../../scripts/official-ui-host-capabilities.mjs";
import { brandedModule } from "../../scripts/official-web-assets.mjs";
import { deriveOfficialCodeModes } from "../../scripts/official-ui-host-code-modes.mjs";
const extractedCodeUi = path.join(
  process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted",
  "claude-frontend-4.4212.0/dist/assets/v1",
);
const fixtures = (anchor = (rule) => rule.before) => {
  const sources = new Map();
  for (const rule of hostCapabilityRules)
    sources.set(rule.file, `${sources.get(rule.file) ?? ""}\n${anchor(rule)}`);
  return sources;
};
test("SSH draft menus keep the selected host's command names", () => {
  const modules = prepareOfficialUiHostCapabilities(fixtures());
  const merge = vm.runInNewContext(
    modules.get("cc183b3ab-Dq3NZ8k1.js") + "\nIe",
  );
  const local = [{ name: "desktop-skill", description: "Desktop skill" }];
  const remote = [{ name: "remote-skill" }, { name: "example" }];
  assert.deepEqual(Array.from(merge(local, remote), ({ name }) => name), [
    "example",
    "remote-skill",
  ]);
  assert.equal(merge(local, undefined).length, 0);
});
test("SSH drafts honor the remote model below user choices and above the account fallback", () => {
  const name = "c2319015e-DAPw5w9h.js";
  const raw = fs.readFileSync(
    path.join(extractedCodeUi, name),
    "utf8",
  );
  const module = deriveOfficialCodeModes(name, raw);
  const from = module.indexOf("  const storedDraftModel =");
  const to = module.indexOf("\n    zn = Vr(t, Q),", from);
  assert.ok(from >= 0 && to > from);
  const choose = (input) => vm.runInNewContext(
    module.slice(from, to - 1) + ";\nQ",
    {
      $: [], t: null, a: "ssh", De: "default", G: "account", Ge: "remote",
      Je: null, Xe: {}, $e: undefined, Vt: "account", Y: null, X: null,
      kn: (model) => model !== null, zt: () => false, Cr: () => null,
      J1: () => true, J2: () => true, J5: () => true,
      K1: (...args) => args.at(-1), K2: (...args) => args.at(-1),
      K5: (...args) => args.at(-1), ...input,
    },
  );
  assert.equal(choose({}), "remote");
  assert.equal(choose({ De: "user_setting", G: "saved" }), "saved");
  assert.equal(choose({ X: "picked" }), "picked");
  assert.equal(choose({ t: { type: "local", id: "session" }, Y: "session-model" }), "session-model");
  assert.equal(choose({ a: "local" }), "account");
  assert.equal(choose({ Ge: null }), "account");
});
test("Code disables Send while an SSH draft's permission mode is loading", () => {
  const name = "cc43287c9-BDrqHHqn.js";
  const raw = fs.readFileSync(
    path.join(extractedCodeUi, name),
    "utf8",
  );
  const module = deriveOfficialCodeModes(name, raw);
  const from = module.indexOf("      sshPermissionPending =");
  const to = module.indexOf("\n      Qi =", from);
  assert.ok(from >= 0 && to > from);
  const isSendDisabled = (envType, startIntent, input = {}) => vm.runInNewContext(
    "const" + module.slice(from, to - 1) + ";\nZi",
    { Y: { envType, startIntent }, vn: "draft", a: false, Mt: false, _: false, c: false, l: false, ...input },
  );
  const pending = { kind: "local", permissionDefaultPending: true };
  assert.equal(isSendDisabled("ssh", pending), true);
  assert.equal(isSendDisabled("ssh", { kind: "local" }), false);
  assert.equal(isSendDisabled("ssh", { kind: "blocked", code: "no_folder" }), false);
  assert.equal(isSendDisabled("ssh", pending, { vn: "active" }), false);
  assert.equal(isSendDisabled("local", pending), false);
  assert.equal(isSendDisabled("wsl", pending), false);
  assert.equal(isSendDisabled("bridge", { kind: "bridge-spawn", permissionDefaultPending: true }), false);
  assert.equal(isSendDisabled("anthropic_cloud", { kind: "cloud" }), false);
  assert.equal(isSendDisabled("ssh", { kind: "local" }, { l: true }), true);
});
test("reopening an active local Code turn uses its start time before the new prompt arrives", () => {
  const name = "c06cf64bb-CcaN03HG.js";
  const raw = fs.readFileSync(path.join(extractedCodeUi, name), "utf8");
  const module = deriveOfficialCodeModes(name, raw);
  const from = module.indexOf("      armResumedTurn(");
  const to = module.indexOf("      clearMetaArmedTurn(", from);
  const scan = module.slice(module.indexOf("function Ch("), module.indexOf("function wh("));
  const now = 1_800_000_000_000;
  const startedAt = now - 2_000;
  const previousPrompt = { type: "user", timestamp: new Date(now - 25 * 60_000).toISOString() };
  const newPrompt = { type: "user", timestamp: new Date(startedAt).toISOString() };
  const assistantUpdate = { type: "assistant", message: { content: "working" } };
  const resume = (messages) => {
    const updates = [];
    const bucket = { pendingTurn: null, messages: { getSnapshot: () => messages } };
    const store = vm.runInNewContext(scan + "({" + module.slice(from, to) + "})", {
      Date: { now: () => now }, Sh: () => false, An: () => false, ir: () => false,
      bh: (message) => Date.parse(message.timestamp),
      J: () => bucket,
      K: { seedFromTail: (_id, rows) => updates.push(Array.from(rows)) },
      Y: (_id, change) => Object.assign(bucket, change(bucket)),
    });
    store.armResumedTurn("session", startedAt);
    return { runningFor: now - bucket.pendingTurn.startTime, seeded: updates[0] };
  };

  assert.deepEqual(resume([previousPrompt]), { runningFor: 2_000, seeded: [] });
  assert.deepEqual(resume([previousPrompt, newPrompt, assistantUpdate]), {
    runningFor: 2_000,
    seeded: [assistantUpdate],
  });
});
test("all pinned anchors are required; duplicate/missing/already transformed inputs fail closed", () => {
  const input = fixtures();
  assert.deepEqual(
    [...prepareOfficialUiHostCapabilities(input).keys()],
    [...input.keys()],
  );
  assert.deepEqual(input, fixtures(), "preparation never edits source inputs");
  for (const rule of hostCapabilityRules) {
    const missing = fixtures();
    missing.delete(rule.file);
    assert.throws(
      () => prepareOfficialUiHostCapabilities(missing),
      /Missing pinned/,
    );
    const duplicate = fixtures((entry) =>
      entry === rule ? entry.before + entry.before : entry.before,
    );
    assert.throws(
      () => prepareOfficialUiHostCapabilities(duplicate),
      /anchor mismatch/,
    );
    const changed = fixtures((entry) =>
      entry === rule ? entry.before.slice(1) : entry.before,
    );
    assert.throws(
      () => prepareOfficialUiHostCapabilities(changed),
      /anchor mismatch/,
    );
  }
  assert.throws(
    () =>
      prepareOfficialUiHostCapabilities(
        prepareOfficialUiHostCapabilities(input),
      ),
    /anchor mismatch/,
  );
});
test("readonly marker fixes personal ownership without granting edit/remove or overriding real org policy", () => {
  const rule = hostCapabilityRules.find(
    (rule) => rule.name === "separate-skill-ownership-from-edit-capability",
  );
  const Sm = vm.runInNewContext(`${rule.after}; Sm`, {
    Ye: (e) => e.canEdit === true,
    Ke: (e) => e.source === "plugin",
  });
  const base = {
    source: "custom",
    creatorType: "user",
    partitionBy: "account",
    canEdit: false,
    canRemove: false,
  };
  assert.equal(Sm(base), "org", "unmarked upstream behavior untouched");
  assert.equal(Sm({ ...base, claudexReadOnly: true }), "you");
  assert.equal(Sm({ ...base, claudexReadOnly: "true" }), "org");
  assert.equal(
    Sm({ ...base, claudexReadOnly: true, partitionBy: "organization" }),
    "org",
  );
  assert.equal(Sm({ ...base, claudexReadOnly: true, isShared: true }), "org");
  assert.equal(
    Sm({ ...base, claudexReadOnly: true, creatorType: "anthropic" }),
    "anthropic",
  );
  assert.equal(base.canEdit, false);
  assert.equal(base.canRemove, false);
});
test("only marked personal skill readonly gets host explanation; all other restrictions remain upstream", () => {
  const rule = hostCapabilityRules.find(
    (rule) =>
      rule.name ===
      "explain-personal-skill-host-readonly-without-fake-org-policy",
  );
  const wD = vm.runInNewContext(
    `${rule.after}\n return 'original-policy'; }\nwD`,
  );
  const base = {
    claudexReadOnly: true,
    source: "custom",
    creatorType: "user",
    partitionBy: "account",
    canRemove: false,
  };
  assert.equal(wD(base), "host_read_only");
  for (const change of [
    { claudexReadOnly: false },
    { claudexReadOnly: "true" },
    { partitionBy: "organization" },
    { isShared: true },
    { backingPluginRequired: true },
    { source: "plugin" },
    { canRemove: true },
  ])
    assert.equal(wD({ ...base, ...change }), "original-policy");
});

test("full pinned derivation rejects a forged module even with a matching anchor", async () => {
  const { deriveOfficialUiHostCapabilityModule, hostCapabilityInputHashes } =
    await import("../../scripts/official-ui-host-capabilities.mjs");
  for (const rule of hostCapabilityRules) {
    assert.match(hostCapabilityInputHashes[rule.file], /^[a-f0-9]{64}$/);
    assert.throws(
      () => deriveOfficialUiHostCapabilityModule(rule.file, rule.before),
      /checksum mismatch/,
    );
  }
  assert.equal(
    deriveOfficialUiHostCapabilityModule("unrelated.js", "unchanged"),
    "unchanged",
  );
});

test("normalizer preserves boolean host capabilities independently of upstream edit access", () => {
  const rule = hostCapabilityRules.find(
    (rule) => rule.name === "preserve-skill-host-capabilities",
  );
  const normalize = vm.runInNewContext(`(e) => ({${rule.after}})`);
  for (const marker of [true, false, "true", undefined]) {
    const result = normalize({
      viewer: {
        installed: {
          claudex_read_only: marker,
          claudex_can_edit_contents: marker,
          can_edit: false,
        },
      },
    });
    assert.equal(result.claudexReadOnly, marker === true);
    assert.equal(result.claudexCanEditContents, marker === true);
    assert.equal(result.canEdit, false);
  }
});

test("host readonly wording is narrow and unknown/upstream reasons retain their branch", () => {
  const rule = hostCapabilityRules.find(
    (rule) => rule.name === "display-skill-host-readonly-reason",
  );
  const render = vm.runInNewContext(
    `${rule.after}\n default: return 'original-reason'; } }\n rt`,
  );
  assert.equal(
    render({}, "host_read_only"),
    "Read-only in this Web connection",
  );
  assert.equal(render({}, "required"), "original-reason");
  assert.equal(render({}, null), "original-reason");
});

test("readonly control mapping uses existing neutral reason without enabling removal", () => {
  const rule = hostCapabilityRules.find(
    (rule) => rule.name === "preserve-neutral-readonly-control-reason",
  );
  const map = vm.runInNewContext(
    `${rule.after}\n default: return 'upstream'; } }\n _s`,
  );
  assert.equal(map("host_read_only"), "other");
  assert.equal(map("org_required"), "upstream");
});

const originalAssets = process.env.CLAUDEX_ORIGINAL_SKILL_ASSETS;

test(
  "original Contents editor accepts the host contents grant independently of vendor access",
  { skip: !originalAssets },
  () => {
    const file = "c24c8737b-5PJBZo1Q.js";
    const source = fs.readFileSync(path.join(originalAssets, file), "utf8");
    const detail = deriveOfficialUiHostCapabilityModule(file, brandedModule(source));
    const editorAvailable = detail
      .slice(detail.indexOf("    Oe = J4($, 23,"), detail.indexOf("    ke = J2($, 28,"))
      .trim().slice(0, -1);
    const editAccess = detail
      .slice(detail.indexOf("    ut = J4($, 69,"), detail.indexOf("    dt = vn(ut"))
      .trim().slice(0, -1);
    const contentsEditor = vm.runInNewContext(
      `(J, De, Ee, m = null) => {
        const ${editorAvailable}, ${editAccess};
        return ut;
      }`,
      {
        $: [],
        J4: () => true,
        K4: (...args) => args.at(-1),
        _e: (skill) => skill.canEdit === true,
        ve: (skill) => skill.canEdit === true,
        Ce() {},
        pe() {},
      },
    );
    const own = { source: "custom", creatorType: "user", partitionBy: "account", canEdit: false };
    const granted = { ...own, claudexCanEditContents: true };
    assert.equal(contentsEditor(granted, false, false)?.skill, granted);
    assert.equal(contentsEditor(own, false, false), undefined);
    assert.equal(contentsEditor(granted, false, false, "wrapped-plugin"), undefined);
    const upstream = { ...own, canEdit: true };
    assert.equal(contentsEditor(upstream, true, true)?.skill, upstream);
    assert.equal(contentsEditor(upstream, false, true), undefined);
    assert.equal(contentsEditor(upstream, true, false), undefined);
  },
);

test("original list and detail show the switch only for skills the host allows to toggle", { skip: !originalAssets }, () => {
  const read = (file) => fs.readFileSync(path.join(originalAssets, file), "utf8");
  const toggleModule = "c8cba5cdc-B45Vl3wA.js";
  const toggle = deriveOfficialUiHostCapabilityModule(toggleModule, read(toggleModule))
    .match(/function \$e\(e\) \{[\s\S]*?\n\}/)[0];
  const list = read("c979ed9d0-C-llIJ0y.js")
    .match(/function ni\(e, t, n\) \{[\s\S]*?\n\}/)[0];
  const detail = read("cfaabd194-B0CE4rOW.js");
  const availability = detail.match(/    Be = J2\(\$, 48, e, ze\)[^\n]+/)[0].trim().slice(0, -1);
  const switchElement = detail
    .slice(detail.indexOf("    Zn = J5($, 165,"), detail.indexOf("    Qn;")).trim().slice(0, -1);
  const context = {
    J9: () => [],
    J2: () => true,
    J4: () => true,
    J5: () => true,
    K2: (...args) => args.at(-1),
    I2: (...args) => args[2],
    K4: (...args) => args.at(-1),
    K5: (...args) => args.at(-1),
    Ln: () => false,
    Vt: () => false,
    s: (type, props) => ({ type, ...props }),
    o: { formatMessage: ({ defaultMessage }) => defaultMessage },
    ie: ({ skillName }) => skillName,
    E: "switch",
    ze: true,
    hn() {},
    z: false,
    q: false,
    je: null,
    X: false,
    zn: null,
    N: false,
    $: [],
  };
  const { listControl, detailControl } = vm.runInNewContext(
    `${toggle}\n${list}
      const Bt = $e, Kt = $e;
      ({
        listControl: (skill) => ni(skill, { toggleAvailable: true }, false),
        detailControl: (e) => { const ${availability}, Ln = false, ${switchElement}; return Zn; },
      })`,
    context,
  );
  for (const enabled of [true, false]) {
    const skill = { enabled, source: "custom", skillName: "review", canToggle: false };
    const readOnly = { ...skill, claudexReadOnly: true };
    assert.equal(listControl(readOnly), undefined, `read-only list, enabled=${enabled}`);
    assert.ok(!detailControl(readOnly), `read-only detail, enabled=${enabled}`);
    const granted = { ...readOnly, canToggle: true, canEdit: false, canRemove: false };
    assert.equal(listControl(granted)?.enabled, enabled);
    assert.equal(detailControl(granted)?.checked, enabled);
    assert.equal(detailControl(granted)?.disabled, false);
    for (const canToggle of [undefined, "true"]) {
      const blocked = { ...readOnly, canToggle };
      assert.equal(listControl(blocked), undefined);
      assert.ok(!detailControl(blocked));
    }
    const upstream = { ...skill, canToggle: true };
    assert.equal(listControl(upstream)?.enabled, enabled);
    assert.equal(detailControl(upstream)?.checked, enabled);
  }
});
