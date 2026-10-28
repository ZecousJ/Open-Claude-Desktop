import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";

const html = (s: string) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: [remarkGfm, remarkCjkFriendly] },
      s,
    ),
  );

test("bold closes after full-width punctuation", () => {
  assert.match(
    html("**这已经不是龙井奶茶，是龙井参加的饮料群聊了。**😂"),
    /<strong>这已经不是龙井奶茶，是龙井参加的饮料群聊了。<\/strong>😂/,
  );
  assert.match(html("**好。**后文"), /<strong>好。<\/strong>后文/);
});

test("Latin emphasis keeps CommonMark rules", () => {
  assert.equal(html("a **b** c"), "<p>a <strong>b</strong> c</p>");
  assert.equal(html("2*3*4"), "<p>2<em>3</em>4</p>");
  assert.equal(html("snake_case_name"), "<p>snake_case_name</p>");
});
