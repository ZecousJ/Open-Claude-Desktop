import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";

const read = (name: string) =>
  readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");
const phone = read("styles/chat-phone-parity.css");
test("phone corrections are wired after the production web rules", () => {
  const entry = read("main.tsx");
  const web = entry.indexOf('import "./styles/95-web.css"');
  const patch = entry.indexOf('import "./styles/chat-phone-parity.css"');
  assert.ok(web >= 0 && patch > web);
});
// Match the eager ordering, then test the lazy composer's higher-specificity
// rules after it as well. These are DOM/cascade assertions, not a claim of
// visual, browser media-emulation or physical touch-device acceptance.
const sheets = [
  "styles/91-reference-workspace.css",
  "styles/93-reference-responsive.css",
  "home/chat-home.css",
  "transcript/transcript-text-size.css",
  "composer/cowork-options.css",
  "styles/95-web.css",
].map(read);
sheets.push(phone, read("live-web/composer.css"));

type Media = {
  width: number;
  coarse: boolean;
  hover: boolean;
};
const fine: Media = { width: 390, coarse: false, hover: true };
const touch: Media = { width: 390, coarse: true, hover: false };
function mediaMatches(query: string, media: Media) {
  return postcss.list.comma(query).some((alternative) => {
    for (const match of alternative.matchAll(
      /\((min|max)-width:\s*([\d.]+)px\)/g,
    ))
      if (
        match[1] === "min"
          ? media.width < Number(match[2])
          : media.width > Number(match[2])
      )
        return false;
    if (/\(pointer:\s*coarse\)/.test(alternative) && !media.coarse)
      return false;
    if (/\(pointer:\s*fine\)/.test(alternative) && media.coarse) return false;
    if (/\(hover:\s*none\)/.test(alternative) && media.hover) return false;
    if (/\(hover:\s*hover\)/.test(alternative) && !media.hover) return false;
    // Height-dependent headroom rules do not affect the assertions below;
    // use the recorded 844px viewport for those rules that do participate.
    for (const match of alternative.matchAll(
      /\((min|max)-height:\s*([\d.]+)px\)/g,
    ))
      if (match[1] === "min" ? 844 < Number(match[2]) : 844 > Number(match[2]))
        return false;
    return true;
  });
}
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
function value(
  element: Element,
  property: string,
  media = fine,
  sources = sheets,
) {
  let winner: { priority: number; value: string } | undefined;
  for (const source of sources) {
    const root = parsed.get(source) ?? postcss.parse(source);
    parsed.set(source, root);
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
        if (parent.name === "media" && !mediaMatches(parent.params, media))
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
function fixture({
  web = true,
  code = false,
  reply = false,
  greeting = "Evening thoughts",
  project = "Project",
}: {
  web?: boolean;
  code?: boolean;
  reply?: boolean;
  greeting?: string;
  project?: string;
} = {}) {
  // Preserve the actual component class/slot relationships, including the
  // shared Send/Voice slot. No application preferences or backend are changed.
  return parseHTML(`<html><body><div class="app ${web ? "web" : "desktop"} mode-${code ? "code" : "chat"}">
    <main class="chat-main ${reply ? "has-conversation" : "empty-chat"}">
      <div class="${reply ? "conversation" : "chat-home"}">
        <h1><svg class="star star"></svg>${greeting}</h1>
        <div class="composer-wrap ${reply ? "conversation-composer" : ""} ${code ? "code-composer" : ""}">
          <div class="composer"><div class="composer-input-row"><textarea></textarea></div>
            <div class="composer-toolbar"><div class="composer-action-slot"><button class="voice-mode-main">Voice</button><button class="send-button">Send</button></div></div>
          </div>
          <div class="composer-chin"${reply ? "" : ' data-place="home"'}>
            <div class="composer-chin-leading"><div class="cowork-options"><button><span>${project}</span><i></i></button></div></div>
            <div class="composer-chin-trailing"><div class="model-effort-anchor"><button class="model-effort-pill model-button"><span>Opus 5.5</span><span>High</span></button></div>
              <button class="task-permission-trigger"><span class="task-permission-label">Auto</span><i class="task-permission-mobile-icon"></i></button>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div></body></html>`).document;
}

test("phone greeting balances and wraps without changing its measured 24px seat", () => {
  for (const greeting of [
    "Evening thoughts",
    "Good evening, Alexandra Maria von Example",
    "晚间思绪，今天我们一起完成一件重要的事情",
    "こんばんは、今日は何をしましょうか",
  ]) {
    const document = fixture({ greeting });
    const heading = document.querySelector("h1")!;
    assert.equal(heading.textContent, greeting);
    assert.equal(value(heading, "font-size"), "24px");
    assert.equal(value(heading, "white-space"), "normal");
    assert.equal(value(heading, "text-wrap"), "balance");
    assert.equal(value(heading, "box-sizing"), "border-box");
    assert.equal(value(heading, "padding-inline"), "0.96em");
    assert.notEqual(value(heading, "position"), "absolute");
    assert.equal(
      value(heading.querySelector("svg")!, "margin-inline-start"),
      "-0.84em",
    );
  }
});

test("coarse phone input floor covers both home and replies after the lazy CSS loads", () => {
  for (const reply of [false, true]) {
    const editor = fixture({ reply }).querySelector("textarea")!;
    assert.equal(
      value(editor, "font-size", touch),
      "max(16px, var(--composer-text, 15px))",
    );
    assert.equal(
      value(editor, "line-height", touch),
      "max(22px, var(--composer-line, 21px))",
    );
    assert.equal(
      value(editor, "min-height", touch),
      "max(22px, var(--composer-line, 21px))",
    );
    assert.equal(value(editor, "font-size", fine, [phone]), undefined);
    assert.equal(
      value(editor, "font-size", { ...touch, width: 640 }, [phone]),
      undefined,
    );
  }
});

test("narrow no-hover fine pointers keep the source's coarse-only font distinction", () => {
  const editor = fixture().querySelector("textarea")!;
  assert.equal(
    value(editor, "font-size", { ...fine, hover: false }, [phone]),
    undefined,
  );
  assert.equal(value(editor, "font-size", fine), "15px");
  assert.equal(value(editor, "line-height", fine), "21px");
});

test("existing home touch chin stays 32px while fine-pointer buttons stay 24px", () => {
  const document = fixture();
  for (const selector of [
    ".cowork-options > button",
    ".model-effort-pill",
    ".task-permission-trigger",
  ]) {
    const button = document.querySelector(selector)!;
    assert.equal(value(button, "height", fine), "24px", selector);
    assert.equal(value(button, "height", touch), "32px", selector);
    assert.equal(value(button, "margin-block", touch), "-4px", selector);
  }
  const permission = document.querySelector(".task-permission-trigger")!;
  assert.equal(value(permission, "width", fine), "24px");
  assert.equal(value(permission, "width", touch), "32px");
  assert.equal(
    value(document.querySelector(".task-permission-label")!, "display", touch),
    "none",
  );
  assert.equal(
    value(
      document.querySelector(".task-permission-mobile-icon")!,
      "display",
      touch,
    ),
    "inline-block",
  );
});

test("parity CSS leaves desktop, Code, wide windows and shared action visibility alone", () => {
  for (const options of [{ web: false }, { code: true }]) {
    const document = fixture(options);
    const editor = document.querySelector("textarea")!;
    assert.equal(value(editor, "font-size", touch, [phone]), undefined);
    assert.equal(
      value(document.querySelector("h1")!, "white-space", touch, [phone]),
      undefined,
    );
  }
  const document = fixture({ project: "项目 · リサーチ · Long project name" });
  for (const selector of [
    ".cowork-options > button",
    ".send-button",
    ".voice-mode-main",
    ".composer-action-slot",
  ])
    for (const property of [
      "display",
      "visibility",
      "width",
      "position",
      "bottom",
    ])
      assert.equal(
        value(document.querySelector(selector)!, property, touch, [phone]),
        undefined,
      );
  const heading = document.querySelector("h1")!;
  assert.equal(
    value(heading, "white-space", { ...fine, width: 640 }, [phone]),
    undefined,
  );
  assert.ok(
    gzipSync(phone).length < 1200,
    "small scoped supplement; bundle-wide 100k CSS gate stays unchanged",
  );
});
