import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLocale } from "../../src/i18n";
import type { FindBarBridge } from "../../shared/find-in-page";

Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mac" },
  configurable: true,
});
Object.defineProperty(globalThis, "window", {
  value: {},
  configurable: true,
});
const { FindBar } = await import("../../src/find-bar/FindBar");

const bridge: FindBarBridge = {
  find: async () => ({ index: 0, total: 0 }),
  stop: async () => {},
  close: async () => {},
  onFocus: () => () => {},
  onStep: () => () => {},
  onClear: () => () => {},
} as unknown as FindBarBridge;

test("the find bar's labels, placeholder and tooltips follow the language", async () => {
  try {
    await setLocale("zh-CN");
    const html = renderToStaticMarkup(createElement(FindBar, { bridge }));
    assert.match(html, /aria-label="在页面中查找"/);
    assert.match(html, /placeholder="在页面中查找"/);
    assert.match(html, /aria-label="上一个匹配项"/);
    assert.match(html, /title="上一个匹配项 \(⇧⌘G\)"/);
    assert.match(html, /title="下一个匹配项 \(⌘G\)"/);
    assert.match(html, /title="关闭查找栏 \(Esc\)"/);
  } finally {
    await setLocale("en-US");
  }
  const html = renderToStaticMarkup(createElement(FindBar, { bridge }));
  assert.match(html, /placeholder="Find in page"/);
  assert.match(html, /title="Close find bar \(Esc\)"/);
});

test("the compact bar keeps the 8px inside and 24px buttons around 16px glyphs", () => {
  const css = readFileSync("src/find-bar/find-bar.css", "utf8");
  const compact = css.match(/@media \(max-height: 75px\) \{([\s\S]*?)\n\}/)![1];
  assert.doesNotMatch(compact, /\.find-bar \{/);
  assert.match(compact, /\.find-count \{\s*font-size: 12px;/);
  assert.match(compact, /\.find-field \{\s*gap: 6px;/);
  assert.match(compact, /width: 24px;\s*height: 24px;/);
});
