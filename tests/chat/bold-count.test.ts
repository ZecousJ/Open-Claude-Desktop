import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BoldCount } from "../../src/transcript/agents/BoldCount";
import { currentLocale, setLocale } from "../../src/i18n";

const render = (template: string, count: number | string) =>
  renderToStaticMarkup(createElement(BoldCount, { template, count }));

test("a count with its noun keeps the number bold in the order of the language", async () => {
  const previous = currentLocale();
  try {
    await setLocale("en-US");
    assert.equal(render("{count} agents", 3), "<b>3</b> agents");
    assert.equal(render("{count} tool use", 1), "<b>1</b> tool use");
    assert.equal(render("{count} tokens", "12.3k"), "<b>12.3k</b> tokens");
    await setLocale("zh-CN");
    assert.equal(render("{count} agents", 3), "<b>3</b> 个智能体");
    assert.equal(render("{count} tool uses", 3), "<b>3</b> 次工具调用");
    await setLocale("ko-KR");
    assert.equal(render("{count} agents", 3), "에이전트 <b>3</b>개");
  } finally {
    await setLocale(previous);
  }
});
