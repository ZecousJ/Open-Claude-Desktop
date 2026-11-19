import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import {
  deriveOfficialUiHostExtensionPreviewModule,
  hostExtensionPreviewFiles,
} from "../scripts/official-ui-host-extension-preview.mjs";

const root = path.resolve(process.env.CLAUDEX_OFFICIAL_EXTRACTED ?? ".restore/archive-extracted", "claude-frontend-4.4212.0/src/cloud/assets/v1");

test("a local preview retains the original install control without enabling the directory", () => {
  const file = hostExtensionPreviewFiles[0];
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const derived = deriveOfficialUiHostExtensionPreviewModule(file, source);
  const section = derived.slice(derived.indexOf("function ne(e) {"), derived.indexOf("function P(e) {"));
  assert.ok(section.startsWith("function ne(e) {"));
  const realm = vm.createContext({
    J9: () => [], J1: () => true, K1: (_cache, _index, _key, value) => value,
    d: () => true, m: {}, T: () => ({ isDirectoryEnabled: false }),
    o: (_component, props) => props, j: () => {},
  });
  const render = vm.runInContext(`(${section.trim()})`, realm);
  assert.equal(render({ directoryServer: { manifest: {}, onDiskPath: "/selected.mcpb" } }).directoryServer.onDiskPath, "/selected.mcpb");
  assert.equal(render({ directoryServer: { manifest: {} } }), null);
});

test("preview derivation is pinned to the recovered official source", () => {
  for (const file of hostExtensionPreviewFiles) {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    assert.notEqual(deriveOfficialUiHostExtensionPreviewModule(file, source), source);
    assert.throws(() => deriveOfficialUiHostExtensionPreviewModule(file, "changed source"), /anchor mismatch/);
  }
  assert.equal(deriveOfficialUiHostExtensionPreviewModule("unrelated.js", "unchanged"), "unchanged");
});

test("the original required-field check distinguishes a saved secret from a missing value", () => {
  const file = "c8e3f1bbb-DO7N27k5.js";
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const derived = deriveOfficialUiHostExtensionPreviewModule(file, source);
  const section = derived.slice(derived.indexOf("function q(e)"), derived.indexOf("var J ="));
  const missing = vm.runInNewContext(section + "\nve");
  const manifest = { user_config: { key: { required: true, sensitive: true } } };
  assert.equal(missing({ manifest, userConfig: {} }), true);
  assert.equal(missing({ manifest, userConfig: {}, savedSecrets: ["key"] }), false);
  assert.equal(missing({ manifest, userConfig: { key: "" }, savedSecrets: ["key"] }), true);
  manifest.user_config.key.sensitive = false;
  assert.equal(missing({ manifest, userConfig: {}, savedSecrets: ["key"] }), true);
});

test("the original configuration form renders saved presence without supplying a secret value", () => {
  const file = "cff43335f-4rcG9JEO.js";
  const derived = deriveOfficialUiHostExtensionPreviewModule(file, fs.readFileSync(path.join(root, file), "utf8"));
  const form = derived.slice(derived.indexOf("var x = (a) =>"), derived.indexOf("export {"));
  const field = derived.slice(derived.indexOf("function b(e)"), derived.indexOf("var x = (a) =>"));
  const runtime = {
    e: (value) => [typeof value === "function" ? value() : value, () => {}],
    r: () => "fixture",
    m: () => ({ formatMessage: ({ defaultMessage }) => defaultMessage }),
    f: () => ({ addError() {} }),
    v: (_manifest, settings) => settings.userConfig,
    b: "field", o: "input", s: "button", p: "message",
    t: (...values) => values.filter(Boolean).join(" "),
    i: (component, props) => ({ component, props }),
    n: (component, props) => ({ component, props }),
    J9: () => [],
  };
  for (let count = 0; count <= 6; count++) {
    runtime[`J${count}`] = () => true;
    runtime[`K${count}`] = (...args) => args.at(-1);
    runtime[`I${count}`] = (_cache, _index, value) => value;
  }
  const realm = vm.createContext(runtime);
  const render = vm.runInContext(form + "\nx", realm);
  const tree = render({
    manifest: { user_config: { token: { type: "string", title: "Token", sensitive: true, required: true } } },
    settings: { userConfig: {}, savedSecrets: ["token"] },
    onSave() {},
  });
  const nodes = [];
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (value.component) nodes.push(value);
    for (const child of Object.values(value)) visit(child);
  }
  visit(tree);
  const inputProps = nodes.find(node => node.component === "field").props;
  assert.equal(inputProps.savedSecret, true);
  assert.equal(inputProps.value, undefined);
  const renderField = vm.runInContext(field + "\nb", realm);
  const input = renderField(inputProps);
  assert.equal(input.props.type, "password");
  assert.equal(input.props.value, "");
  assert.equal(input.props.placeholder, "••••••••");
});
