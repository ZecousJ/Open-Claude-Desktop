import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";

const read = (name: string) =>
  readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const before = [
  "styles/00-foundation.css",
  "styles/20-workspace.css",
  "styles/91-reference-workspace.css",
  "home/chat-home.css",
  "composer/composer-core.css",
  "transcript/transcript-text-size.css",
  "styles/95-web.css",
  "sidebar/native-chat-sidebar.css",
  "composer/native-chat-composer.css",
].map(read);
const mirror = read("composer/skill-token-mirror.css");
const after = ["live-web/composer.css", "light-main/light-main.css"].map(read);
function rank(tokens: Selector[]): number {
  return tokens.reduce((sum, token) => {
    if (token.type === "attribute")
      return sum + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element") return sum + 1;
    if (token.type !== "pseudo" || token.name === "where") return sum;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return sum + Math.max(0, ...token.data.map(rank));
    return sum + 100;
  }, 0);
}
const parsed = new Map<string, postcss.Root>();
function value(element: Element, property: string, sheets: string[]) {
  let winner: { priority: number; value: string } | undefined;
  for (const sheet of sheets) {
    const root = parsed.get(sheet) ?? postcss.parse(sheet);
    parsed.set(sheet, root);
    root.walkRules((rule) => {
      for (
        let parent:
          | postcss.AtRule
          | postcss.Rule
          | postcss.Root
          | postcss.Document
          | undefined = rule.parent;
        parent;
        parent = parent.parent
      ) {
        if (parent.type !== "atrule") continue;
        if (parent.name === "container" || /keyframes/.test(parent.name))
          return;
        if (
          parent.name === "media" &&
          /max-width:\s*(?:639\.98|640|767|768)px|pointer:\s*coarse/.test(
            parent.params,
          )
        )
          return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        if (/::/.test(selector)) continue;
        let matches = false;
        try {
          matches = element.matches(
            selector.replace(
              /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g,
              ":not(*)",
            ),
          );
        } catch {}
        if (!matches) continue;
        const specificity = Math.max(...selectors(selector).map(rank));
        rule.walkDecls(property, (declaration) => {
          const priority = specificity + (declaration.important ? 1000000 : 0);
          if (!winner || winner.priority <= priority)
            winner = { priority, value: declaration.value };
        });
      }
    });
  }
  return winner?.value;
}
function resolved(
  element: Element,
  property: string,
  sheets: string[],
): string | undefined {
  const own = value(element, property, sheets);
  if (!own && property.startsWith("--") && element.parentElement)
    return resolved(element.parentElement, property, sheets);
  return own?.replace(
    /var\((--[\w-]+)\)/g,
    (_match, variable) => resolved(element, variable, sheets) ?? _match,
  );
}
function field({
  web = false,
  light = false,
  reply = false,
  tokens = true,
  code = false,
} = {}) {
  const document =
    parseHTML(`<html data-theme="${light ? "light" : "dark"}"><body><div class="app ${web ? "web" : "darwin desktop"} mode-${code ? "code" : "chat"}">
    <main class="chat-main ${reply ? "has-conversation" : "empty-chat"}"><div class="${reply ? "conversation" : "chat-home"}">
      <div class="composer-wrap ${code ? "code-composer" : "chat-composer"} ${reply ? "conversation-composer" : ""}"><div class="composer"><div class="composer-input-row">
        <div class="composer-mention-field composer-skill-field">${tokens ? '<div class="composer-skill-mirror"><mark class="composer-skill-reference"><span class="composer-skill-raw">$review</span><button class="composer-skill-reference-trigger">/review</button></mark></div>' : ""}<textarea>$review</textarea></div>
      </div></div></div></div></main></div></body></html>`).document;
  return {
    area: document.querySelector("textarea")!,
    reference: document.querySelector(".composer-skill-reference"),
  };
}

test("actual native and web composer sheets cannot repaint the raw dollar glyph over the visible slash reference", () => {
  for (const web of [false, true])
    for (const light of [false, true])
      for (const reply of [false, true])
        for (const sheets of [
          [...before, mirror, ...after],
          [...before, ...after, mirror],
        ]) {
          const { area, reference } = field({ web, light, reply });
          assert.equal(
            value(area, "color", sheets),
            "transparent",
            `${web}:${light}:${reply}`,
          );
          assert.equal(
            value(area, "-webkit-text-fill-color", sheets),
            "transparent",
          );
          assert.notEqual(resolved(area, "caret-color", sheets), "transparent");
          assert.ok(resolved(area, "caret-color", sheets));
          assert.equal(
            value(reference!, "color", sheets),
            light ? "var(--focus-accent)" : "#6da7ec",
          );
        }
});

test("the original lower-specificity masking rule actually reproduces the observed white glyph regression", () => {
  const old =
    ".composer-skill-field:has(> .composer-skill-mirror) > textarea { color: transparent; caret-color: var(--text); }";
  for (const web of [false, true]) {
    const { area } = field({ web });
    assert.equal(value(area, "color", [...before, old, ...after]), "#f0efec");
  }
});

test("without a reference mirror, and in Code, the actual textarea ink remains visible", () => {
  const sheets = [...before, mirror, ...after];
  for (const web of [false, true])
    for (const light of [false, true]) {
      const plain = field({ web, light, tokens: false }).area;
      assert.notEqual(resolved(plain, "color", sheets), "transparent");
      assert.equal(value(plain, "-webkit-text-fill-color", sheets), undefined);
      const code = field({ web, light, code: true }).area;
      assert.notEqual(resolved(code, "color", sheets), "transparent");
      assert.equal(value(code, "-webkit-text-fill-color", sheets), undefined);
    }
});

test("raw fallback keeps honest visible normal text in both themes rather than retaining reference accent paint", () => {
  const sheets = [...before, mirror, ...after];
  for (const web of [false, true])
    for (const light of [false, true]) {
      const { reference } = field({ web, light });
      reference!.setAttribute("data-reference-mode", "raw");
      const raw = reference!.querySelector(".composer-skill-raw")!;
      assert.equal(value(raw, "visibility", sheets), "visible");
      assert.equal(value(reference!, "color", sheets), "var(--text)");
    }
});
