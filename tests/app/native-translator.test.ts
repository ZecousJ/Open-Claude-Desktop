import test from "node:test";
import assert from "node:assert/strict";
import { catalogTranslator } from "../../electron/app/native-i18n";
import { quitBusyChoice, quitBusyDialog } from "../../electron/app/quit-dialog";
import zh from "../../shared/i18n/catalogs/zh-CN";

test("native texts with {holes} are translated, the holes carried over", () => {
  const translate = catalogTranslator({
    "Quit anyway": "仍然退出",
    "Failed to check for updates: {error}": "检查更新失败：{error}",
    "Claudex {version} couldn’t be installed": "无法安装 Claudex {version}",
    "Claudex {version} couldn’t be installed: {reason}":
      "无法安装 Claudex {version}：{reason}",
  });
  assert.equal(translate("Quit anyway"), "仍然退出");
  assert.equal(
    translate("Failed to check for updates: network is down"),
    "检查更新失败：network is down",
  );
  assert.equal(
    translate("Claudex 0.0.33 couldn’t be installed"),
    "无法安装 Claudex 0.0.33",
  );
  // The template with more fixed text is the one that fits.
  assert.equal(
    translate("Claudex 0.0.33 couldn’t be installed: disk full"),
    "无法安装 Claudex 0.0.33：disk full",
  );
  assert.equal(translate("Not in the catalog"), "Not in the catalog");
  assert.equal(translate("a.b {x}"), "a.b {x}");
});

test("the quit question reads in the app's language, with the number of sessions", () => {
  const translate = catalogTranslator(zh);
  const one = quitBusyDialog(translate, 1);
  assert.equal(one.message, "Claudex 仍在工作");
  assert.deepEqual(one.buttons.slice(0, 2), ["仍然退出", "等待 Claudex"]);
  assert.match(one.detail, /1/);
  assert.ok(!/\{count\}/.test(quitBusyDialog(translate, 3).detail));
  assert.match(quitBusyDialog(translate, 3).detail, /3/);
  const english = quitBusyDialog((text) => text, 2);
  assert.equal(english.message, "Claudex is still working");
  assert.equal(
    english.detail,
    "Claudex is working in 2 sessions. Quitting now will interrupt that work.",
  );
  assert.deepEqual(english.buttons, [
    "Quit anyway",
    "Wait for Claudex",
    "Cancel",
  ]);
  assert.deepEqual([0, 1, 2].map(quitBusyChoice), ["quit", "wait", "cancel"]);
});
