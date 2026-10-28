import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { parseHTML } from "linkedom";

const source = (path: string) => readFileSync(path, "utf8");
test("reply atoms retain the source wrapper's centered 32px control without changing the home or Code", () => {
  const css = postcss.parse(source("src/composer/atomic-chat-input.css"));
  const rule = css.nodes.find(
    (node) =>
      node.type === "rule" &&
      node.selector.includes(".composer-atomic-field") &&
      node.selector.includes(".conversation-composer"),
  ) as postcss.Rule;
  assert.ok(rule);
  assert.match(rule.selector, /:not\(\.code-composer\)/);
  const values = Object.fromEntries(
    rule.nodes
      .filter((node) => node.type === "decl")
      .map((node) => [
        (node as postcss.Declaration).prop,
        (node as postcss.Declaration).value,
      ]),
  );
  assert.equal(values["min-height"], "32px");
  assert.equal(
    values["padding-block"],
    "max(0px, calc((32px - var(--composer-line, 21px)) / 2))",
  );
  assert.equal(values["box-sizing"], "border-box");
});
function winningParagraphLine(sheets: string[]) {
  const { document } = parseHTML(
    '<div class="composer-atomic-input"><p>First</p><p><br></p><p>Third</p></div>',
  );
  return [...document.querySelectorAll("p")].map((paragraph) => {
    let winner: { rank: number; value: string } | undefined;
    for (const css of sheets)
      postcss.parse(css).walkRules((rule) => {
        if (
          !["p", ".composer-atomic-input > p"].includes(rule.selector) ||
          !paragraph.matches(rule.selector)
        )
          return;
        const rank = rule.selector === "p" ? 1 : 101;
        rule.walkDecls("line-height", (declaration) => {
          if (!winner || rank >= winner.rank)
            winner = { rank, value: declaration.value };
        });
      });
    return winner?.value;
  });
}
test("the real global p=1.7 rule cannot change empty or multiple editor paragraphs away from the source input line", () => {
  const foundation = source("src/styles/00-foundation.css"),
    editor = source("src/composer/atomic-chat-input.css");
  assert.deepEqual(
    winningParagraphLine([foundation]),
    ["1.7", "1.7", "1.7"],
    "the original actual stylesheet reproduces root's 25.5px regression",
  );
  for (const sheets of [
    [foundation, editor],
    [editor, foundation],
  ])
    assert.deepEqual(winningParagraphLine(sheets), [
      "inherit",
      "inherit",
      "inherit",
    ]);
  const rules = postcss.parse(editor);
  const paragraph = rules.nodes.find(
    (node) =>
      node.type === "rule" && node.selector === ".composer-atomic-input > p",
  ) as postcss.Rule;
  const values = Object.fromEntries(
    paragraph.nodes
      .filter((node) => node.type === "decl")
      .map((node) => [
        (node as postcss.Declaration).prop,
        (node as postcss.Declaration).value,
      ]),
  );
  assert.equal(values.font, "inherit");
  assert.equal(values["min-height"], "1lh");
  assert.equal(values.margin, "0");
  assert.equal(values.padding, "0");
});
