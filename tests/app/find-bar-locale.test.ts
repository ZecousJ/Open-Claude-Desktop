import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerHooks } from "node:module";
import { currentLocale, setLocale, t } from "../../src/i18n";
import type { FindBarBridge } from "../../shared/find-in-page";

registerHooks({
  load: (url, context, next) =>
    url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context),
});
const { FindBar } = await import("../../src/find-bar/FindBar");

const bridge: FindBarBridge = {
  find: async () => ({ total: 0, active: 0 }),
  stop: async () => {},
  close: async () => {},
  onFocus: () => () => {},
  onStep: () => () => {},
  onClear: () => () => {},
};

test("the find bar's button titles carry their shortcut in the interface language", async () => {
  const previous = currentLocale();
  try {
    await setLocale("zh-CN");
    const html = renderToStaticMarkup(createElement(FindBar, { bridge }));
    assert.match(html, /title="上一个匹配项 \(/);
    assert.match(html, /title="下一个匹配项 \(/);
    assert.equal(t("Find in page"), "在页面中查找");
    assert.equal(t("Close find bar (Esc)"), "关闭查找栏 (Esc)");
  } finally {
    await setLocale(previous);
  }
});
