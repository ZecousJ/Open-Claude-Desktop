import test from "node:test";
import assert from "node:assert/strict";
import { browserTitle } from "../../src/code-tools/browser-tools";
import { sourceLocale } from "../../shared/locales";
import { setLocale } from "../../src/i18n";

test("browser tool rows follow the interface language, holes filled with what the call names", async () => {
  await setLocale("zh-CN");
  try {
    assert.equal(browserTitle("click", {}, "running"), "正在点击");
    assert.equal(
      browserTitle(
        "click",
        {},
        "done",
        "Clicked ref_3 at (10, 20) on http://localhost:5173/.",
      ),
      "已点击（localhost:5173）",
    );
    assert.equal(browserTitle("click", {}, "failed"), "无法点击");
    assert.equal(
      browserTitle("navigate", { url: "http://localhost:5173/" }, "running"),
      "正在打开 localhost:5173",
    );
    assert.equal(
      browserTitle("type", { text: "hello" }, "done"),
      "已输入 5 个字符",
    );
    assert.equal(
      browserTitle("scroll", { direction: "up" }, "done"),
      "已向上滚动",
    );
    assert.equal(
      browserTitle("console", {}, "done", "[error] a\n[error] b"),
      "已读取控制台（2 个错误）",
    );
    assert.equal(browserTitle("preview_list", {}, "running"), "正在列出预览");
  } finally {
    await setLocale(sourceLocale);
  }
  assert.equal(browserTitle("click", {}, "running"), "Clicking");
  assert.equal(
    browserTitle("console", {}, "done", "[error] a\n[error] b"),
    "Read the console (2 errors)",
  );
});
