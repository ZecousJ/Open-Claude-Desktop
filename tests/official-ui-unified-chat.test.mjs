import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import test from "node:test";
import ts from "typescript";
import { retiredChatPages, unifiedChatFiles } from "../scripts/official-ui-unified-chat.mjs";

const directory = "build/official-ui/ui/assets/v1";
const source = file => fs.readFileSync(path.join(directory, file), "utf8");
const parse = file => ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
function declaration(file, name) {
  return parse(file).statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
}
function callable(file, name, globals) {
  const node = declaration(file, name);
  assert.ok(node, name);
  return vm.runInNewContext("(" + node.getText() + ")", globals);
}

test("the shipped interface contains no standalone Cowork creation page or mode picker", () => {
  assert.equal(JSON.parse(fs.readFileSync("build/official-ui/manifest.json", "utf8")).unifiedChat, true);
  for (const [file, names] of [
    ["shared-5-DQLFfFYX.js", ["KB"]],
    ["shared-20-C2JgSgMH.js", ["pZ", "gw"]],
    ["shared-23-xVessQLu.js", ["$V"]],
    ["shared-46-BL5bnnMV.js", ["C8"]],
  ]) for (const name of names) assert.equal(declaration(file, name), undefined);
  for (const name of retiredChatPages) assert.equal(fs.existsSync(path.join(directory, name)), false);
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith(".js")) continue;
    const text = source(file);
    for (const name of retiredChatPages) assert.ok(!text.includes(name), `${file} still loads ${name}`);
    assert.ok(!text.includes("new_task_nav"), `${file} still registers a separate task command`);
  }
});

test("all reported combinations of legacy areas have one Chat home and at most Code", () => {
  const file = "shared-20-C2JgSgMH.js";
  for (const reported of [[], ["chat"], ["cowork"], ["code"], ["chat", "cowork"], ["cowork", "code"], ["chat", "cowork", "code"]]) {
    for (const home of ["chat", "cowork"]) {
      const modes = callable(file, "claudexNavigationModes", { rT: () => reported, ZE: () => home })();
      assert.ok(modes.length <= 2);
      assert.ok(modes.filter(mode => mode !== "code").length <= 1);
      const labels = callable(file, "e4", { ZE: () => home, rJ: { code: { mode: "code", label: "Code" } } })();
      assert.deepEqual(Array.from(modes, mode => labels[mode].label), reported.some(mode => mode !== "code")
        ? ["Claudex", ...(reported.includes("code") ? ["Code"] : [])]
        : reported.includes("code") ? ["Code"] : []);
    }
  }
});

test("old task links resolve to Chat before any stored layout or feature selection", () => {
  const route = callable("shared-46-BL5bnnMV.js", "Ak", {
    URLSearchParams,
    Fy: value => value,
    QO: () => { throw Error("Old feature selection must not handle retired routes"); },
  });
  for (const pathname of ["/task", "/task/new", "/task/examples", "/cowork", "/cowork/new", "/new"]) {
    assert.throws(() => route({ location: { pathname, searchStr: "?mode=cowork&surface=cowork&prompt=keep" } }),
      result => result.href === "/new?prompt=keep" && result.replace === true);
  }
  assert.throws(() => route({ location: { pathname: "/settings/cowork", searchStr: "" } }),
    result => result.href === "/settings/general");
});

test("the shared modules expose only declared exports", () => {
  for (const file of unifiedChatFiles)
    execFileSync(process.execPath, ["--check", path.join(directory, file)], { stdio: "pipe" });
});

test("navigation uses the compact switcher without a labelled layout alternative", () => {
  const file = "shared-20-C2JgSgMH.js", text = source(file);
  assert.equal(declaration(file, "YHt"), undefined);
  assert.ok(!/\bOx\b/.test(text));
  assert.ok(!/\bOx\b/.test(source("shared-22-Ciy9U3_0.js")));
  assert.ok(text.includes('"data-compact-mode-switcher": !0'));
  for (const peek of [false, true]) {
    const environment = { gW: () => ["chat", "code"], mH: () => peek };
    assert.equal(callable(file, "ksn", environment)(), !peek);
    assert.equal(callable(file, "oIz", environment)(), peek);
  }
});
