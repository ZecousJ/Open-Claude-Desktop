import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseHTML } from "linkedom";
import { parse as selectors, stringify, type Selector } from "css-what";

type Rule = {
  selectorText?: string;
  style?: {
    length: number;
    [index: number]: string;
    getPropertyValue(name: string): string;
    getPropertyPriority(name: string): string;
  };
};
const { parse: css } = createRequire(import.meta.url)("cssom") as {
  parse(text: string): { cssRules: Rule[] };
};
const read = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const base = [read("ui/menu.css"), read("live-web/pages.css")];
const permission = read("composer/permission-mode-menu.css");
const environment = read("composer/web-code-environment-menu.css");
const codeList = read("sidebar/code-list.css");

// Resolve only the declarations under test, from actual shipped CSS. This
// catches specificity/order bugs that ReactDOM tests without CSS cannot see.
// These cases exercise the 1440px fine-pointer surface: media rules do not apply.
function specificity(tokens: Selector[]): number {
  return tokens.reduce((score, token) => {
    if (token.type === "attribute") return score + 100;
    if (token.type === "tag" || token.type === "pseudo-element")
      return score + 1;
    if (token.type !== "pseudo" || token.name === "where") return score;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return score + Math.max(0, ...token.data.map(specificity));
    return score + 100;
  }, 0);
}
function declaration(property: string, value: string, target: string) {
  if (property === target) return value;
  const side = /^(padding)-(top|right|bottom|left)$/.exec(target);
  if (side && property === "padding") {
    const p = value.trim().split(/\s+/);
    const expanded = [p[0], p[1] ?? p[0], p[2] ?? p[0], p[3] ?? p[1] ?? p[0]];
    return expanded[["top", "right", "bottom", "left"].indexOf(side[2])];
  }
  if (
    side &&
    property === "padding-block" &&
    ["top", "bottom"].includes(side[2])
  ) {
    const p = value.trim().split(/\s+/);
    return side[2] === "top" ? p[0] : (p[1] ?? p[0]);
  }
  if (
    target === "border-bottom-width" &&
    ["border", "border-bottom"].includes(property)
  )
    return value.trim().split(/\s+/)[0];
}
function cascade(sheets: string[], element: Element, target: string) {
  let winner: { rank: number; order: number; value: string } | undefined;
  let order = 0;
  for (const source of sheets)
    for (const rule of css(source).cssRules) {
      if (!rule.selectorText || !rule.style) continue;
      const relevant = Array.from(
        { length: rule.style.length },
        (_, index) => rule.style![index],
      ).some(
        (property) =>
          declaration(
            property,
            rule.style!.getPropertyValue(property),
            target,
          ) !== undefined,
      );
      if (!relevant) continue;
      const ranks = selectors(rule.selectorText)
        // linkedom has no input state; this contract checks the resting
        // menu. Keep the original specificity while making state pseudos false.
        .filter((group) =>
          element.matches(
            stringify([group]).replace(
              /:(?:focus-visible|focus-within|focus|hover|active)(?![\w-])/g,
              ":not(*)",
            ),
          ),
        )
        .map(specificity);
      if (!ranks.length) continue;
      for (let index = 0; index < rule.style.length; index++) {
        const property = rule.style[index];
        const value = declaration(
          property,
          rule.style.getPropertyValue(property),
          target,
        );
        if (value === undefined) continue;
        const rank =
          Math.max(...ranks) +
          (rule.style.getPropertyPriority(property) ? 1_000_000 : 0);
        const next = { rank, order: order++, value };
        if (
          !winner ||
          next.rank > winner.rank ||
          (next.rank === winner.rank && next.order > winner.order)
        )
          winner = next;
      }
    }
  return winner?.value;
}
const px = (value: string | undefined) => {
  assert.ok(value !== undefined);
  return Number.parseFloat(value);
};

test("Current Code list menu keeps 219px root and 81px Show child across generic stylesheet order", () => {
  const { document } = parseHTML(
    '<html data-surface="web"><body><div class="menu code-list-menu regular"><button></button><hr></div><div class="menu code-list-menu regular" data-submenu><button></button><hr></div></body></html>',
  );
  const root = document.querySelector(".code-list-menu")!,
    child = document.querySelector("[data-submenu]")!;
  for (const sheets of [
    [...base, codeList],
    [codeList, ...base],
  ]) {
    const value = (element: Element, property: string) =>
      cascade(sheets, element, property);
    assert.equal(value(root, "padding-top"), "4px");
    assert.equal(value(root, "padding-bottom"), "5px");
    assert.equal(value(child, "padding-top"), "4px");
    assert.equal(value(child, "padding-bottom"), "4px");
    assert.equal(
      6 * px(value(root.querySelector("button")!, "height")) +
        2 * 9 +
        px(value(root, "padding-top")) +
        px(value(root, "padding-bottom")),
      219,
    );
    assert.equal(
      2 * px(value(child.querySelector("button")!, "height")) +
        9 +
        px(value(child, "padding-top")) +
        px(value(child, "padding-bottom")),
      81,
    );
  }
});

test("Code permission body naturally totals 153.5px and resists the later generic web CSS", () => {
  const { document } = parseHTML(
    '<html data-surface="web"><body><div class="menu web-code-permission-menu"><div class="web-code-permission-body"><div class="menu-heading"></div><button class="has-description"><span class="menu-item-text"><span></span><small class="menu-description"></small></span></button></div></div><div class="menu other-menu"><button class="has-description"></button></div></body></html>',
  );
  const root = document.querySelector(".web-code-permission-menu")!;
  const body = root.firstElementChild!;
  const row = body.querySelector("button")!;
  const title = row.querySelector(".menu-item-text > span")!;
  const note = row.querySelector("small")!;
  const caption = body.querySelector(".menu-heading")!;
  for (const sheets of [
    [...base, permission],
    [permission, ...base],
  ]) {
    const value = (element: Element, property: string) =>
      cascade(sheets, element, property);
    assert.equal(value(root, "padding-top"), "0");
    assert.equal(
      value(root, "height"),
      undefined,
      "popup is not clipped to a fixed total height",
    );
    assert.equal(value(row, "height"), "auto");
    assert.equal(value(row, "min-height"), "0");
    assert.equal(value(title, "font-size"), "13px");
    assert.equal(value(note, "font-size"), "12px");
    const rowHeight =
      px(value(title, "line-height")) +
      px(value(note, "line-height")) +
      px(value(row, "padding-top")) +
      px(value(row, "padding-bottom"));
    const captionHeight =
      px(value(caption, "line-height")) +
      px(value(caption, "padding-top")) +
      px(value(caption, "padding-bottom"));
    assert.equal(rowHeight, 40.5);
    assert.equal(captionHeight, 23);
    assert.equal(
      captionHeight +
        3 * rowHeight +
        px(value(body, "padding-top")) +
        px(value(body, "padding-bottom")) +
        px(value(body, "border-bottom-width")),
      153.5,
    );
    assert.equal(
      value(document.querySelector(".other-menu button")!, "padding-top"),
      "6px",
      "other menus keep their generic web rules",
    );
  }
});

test("Code environment root p0 wins regardless of stylesheet order; removing its scope reproduces p4", () => {
  const { document } = parseHTML(
    '<html data-surface="web"><body><div class="menu web-code-environment-menu"></div><div class="menu other-menu"></div></body></html>',
  );
  const root = document.querySelector(".web-code-environment-menu")!;
  for (const sheets of [
    [...base, environment],
    [environment, ...base],
  ]) {
    assert.equal(cascade(sheets, root, "padding-top"), "0");
    assert.equal(cascade(sheets, root, "padding-bottom"), "0");
    assert.equal(
      cascade(sheets, document.querySelector(".other-menu")!, "padding-top"),
      "4px",
    );
  }
  const oldSpecificity = environment.replace(
    ':root[data-surface="web"] .menu.web-code-environment-menu',
    ".menu.web-code-environment-menu",
  );
  assert.equal(cascade([...base, oldSpecificity], root, "padding-top"), "4px");
});
