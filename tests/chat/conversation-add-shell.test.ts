import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import { ComposerAddMenu } from "../../src/composer/ComposerAddMenu";
import { readSource } from "../support/read-source";

const read = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const addCSS = read("composer/composer-add-menu.css"),
  webCSS = read("styles/95-web.css");
const noop = () => {};
function fixture(
  presentation: ComponentProps<
    typeof ComposerAddMenu
  >["presentation"] = "web-chat",
  platform: NodeJS.Platform = "darwin",
  classes = "app web",
  light = false,
) {
  const props: ComponentProps<typeof ComposerAddMenu> = {
    presentation,
    platform,
    projects: [],
    webSearch: false,
    webSearchAvailable: true,
    researchAvailable: true,
    onResearch: noop,
    onWebSearch: noop,
    onClose: noop,
    onFiles: noop,
    onFolder: noop,
    onProject: noop,
    onCreateProject: noop,
    onSettings: noop,
    onUnavailable: noop,
  };
  return parseHTML(
    `<html data-surface="web"${light ? ' data-theme="light"' : ""}><body><div class="${classes}">${renderToStaticMarkup(createElement(ComposerAddMenu, props))}</div></body></html>`,
  ).document;
}
function rank(tokens: Selector[]): number {
  return tokens.reduce((total, token) => {
    if (token.type === "attribute")
      return total + (token.name === "id" ? 10000 : 100);
    if (token.type === "tag" || token.type === "pseudo-element")
      return total + 1;
    if (token.type !== "pseudo" || token.name === "where") return total;
    if (["is", "not", "has"].includes(token.name) && Array.isArray(token.data))
      return total + Math.max(0, ...token.data.map(rank));
    return total + 100;
  }, 0);
}
function value(property: string, text: string, target: string) {
  if (property === target) return text;
  const side = /^(padding|margin)-(top|right|bottom|left)$/.exec(target);
  if (side && property === side[1]) {
    const pieces = text.split(/\s+/),
      values = [
        pieces[0],
        pieces[1] ?? pieces[0],
        pieces[2] ?? pieces[0],
        pieces[3] ?? pieces[1] ?? pieces[0],
      ];
    return values[["top", "right", "bottom", "left"].indexOf(side[2])];
  }
  if (
    target === "border-bottom-width" &&
    ["border", "border-bottom"].includes(property)
  )
    return text.split(/\s+/)[0];
}
const parsed = new Map<string, postcss.Root>();
function style(
  element: Element,
  sources: string[],
  target: string,
  coarse = false,
) {
  let winner: { rank: number; value: string } | undefined;
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
        if (parent.name !== "media") continue;
        if (/max-width/.test(parent.params)) return; // 1440px desktop contract
        if (/pointer:\s*coarse|hover:\s*none/.test(parent.params) && !coarse)
          return;
        if (/pointer:\s*fine|hover:\s*hover/.test(parent.params) && coarse)
          return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        let matches = false;
        try {
          matches =
            !selector.includes("::") &&
            element.matches(
              selector.replace(
                /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g,
                ":not(*)",
              ),
            );
        } catch {}
        if (!matches) continue;
        const priority = Math.max(...selectors(selector).map(rank));
        rule.walkDecls((decl) => {
          const expanded = value(decl.prop, decl.value, target);
          if (expanded === undefined) return;
          const next = priority + (decl.important ? 1000000 : 0);
          if (!winner || winner.rank <= next)
            winner = { rank: next, value: expanded };
        });
      }
    });
  }
  return winner?.value;
}
const rootRows = (document: Document) => [
  ...document.querySelectorAll(
    ".composer-add-menu > button, .composer-add-menu > .composer-add-branch > button",
  ),
];
function shellContract(sources: string[]) {
  const document = fixture(),
    root = document.querySelector(".composer-add-menu")!;
  const css = (target: string) => style(root, sources, target);
  assert.equal(css("width"), "226.375px");
  assert.equal(css("padding"), "4px");
  assert.equal(css("border"), "0");
  assert.equal(css("border-bottom-width"), "1px");
  assert.equal(css("border-radius"), "12px");
  assert.equal(css("background"), "#20201f");
  assert.equal(
    css("height"),
    undefined,
    "eligibility and translated content can change the row set",
  );
  const contentWidth =
    Number.parseFloat(css("width")!) - 2 * Number.parseFloat(css("padding")!);
  assert.equal(contentWidth, 218.375);
  for (const row of rootRows(document)) {
    assert.equal(style(row, sources, "width"), "100%");
    assert.equal(style(row, sources, "height"), "32px");
    assert.equal(style(row, sources, "padding"), "6px 10px");
    assert.equal(style(row, sources, "border-radius"), "8px");
  }
  const separators = root.querySelectorAll(":scope > [role=separator]").length;
  assert.equal(separators, 2);
  assert.equal(
    4 + rootRows(document).length * 32 + separators * 9 + 4 + 1,
    219,
    "six real local rows naturally total 219px; no fake Devices action fills the missing capability",
  );
  assert.equal(
    4 + (rootRows(document).length + 1) * 32 + separators * 9 + 4 + 1,
    251,
    "a seventh eligible row can grow to the observed official height without a fixed shell height",
  );
}
test("actual web Add root matches the captured shell/rows in either CSS arrival order", () => {
  shellContract([addCSS, webCSS]);
  shellContract([webCSS, addCSS]);
});

test("native Add keeps the measured shell and reserves a 20px folder font glyph in either CSS order", () => {
  const nativeCSS = read("composer/native-chat-composer.css");
  const document = fixture(
    "native-chat",
    "darwin",
    "app host-desktop mode-chat",
  );
  const root = document.querySelector(".composer-add-native-chat")!;
  const icon = root.querySelector('[data-icon="FolderPlus"]')!;
  assert.ok(icon);
  for (const sources of [
    [addCSS, nativeCSS],
    [nativeCSS, addCSS],
  ]) {
    assert.equal(style(root, sources, "width"), "226.375px");
    assert.equal(style(root, sources, "padding"), "4px");
    assert.equal(style(root, sources, "border-radius"), "12px");
    assert.equal(style(icon, sources, "flex"), "0 0 20px");
    assert.equal(style(icon, sources, "width"), "20px");
    assert.equal(style(icon, sources, "height"), "20px");
    for (const row of rootRows(document)) {
      assert.equal(style(row, sources, "gap"), "4px");
      assert.equal(style(row, sources, "height"), "32px");
    }
  }
});
test("removing the current root rules restores the old 228/r11 shell and is rejected", () => {
  const old = postcss.parse(addCSS);
  old.walkRules((rule) => {
    if (rule.selector.includes("composer-add-web-chat")) rule.remove();
  });
  const document = fixture(),
    root = document.querySelector(".composer-add-menu")!;
  assert.equal(style(root, [old.toString(), webCSS], "width"), "228px");
  assert.equal(style(root, [old.toString(), webCSS], "border-radius"), "11px");
  assert.throws(() => shellContract([old.toString(), webCSS]));
});
test("only the observed web Add action restores its real platform shortcut over the global hide rule", () => {
  for (const sources of [
    [addCSS, webCSS],
    [webCSS, addCSS],
  ]) {
    const document = fixture(),
      shortcut = document.querySelector(".composer-add-shortcut")!;
    assert.deepEqual(
      [...shortcut.querySelectorAll("kbd")].map((key) => key.textContent),
      ["⌘", "U"],
    );
    assert.equal(shortcut.getAttribute("aria-hidden"), "true");
    assert.equal(style(shortcut, sources, "display"), "inline-flex");
    assert.equal(style(shortcut, sources, "font-size"), "13px");
    assert.equal(style(shortcut, sources, "line-height"), "17px");
    assert.equal(style(shortcut, sources, "gap"), "0.15em");
    for (const key of shortcut.querySelectorAll("kbd")) {
      assert.equal(style(key, sources, "display"), "block");
      assert.equal(style(key, sources, "font"), "inherit");
      assert.equal(
        style(key, [webCSS], "display"),
        "none",
        "negative control: the old global important hide wins without the local opt-in",
      );
    }
    assert.equal(
      style(shortcut, sources, "display", true),
      "none",
      "coarse pointer follows the captured pointer-coarse:hidden contract",
    );
  }
  assert.deepEqual(
    [
      ...fixture("web-chat", "win32").querySelectorAll(
        ".composer-add-shortcut > kbd",
      ),
    ].map((key) => key.textContent),
    ["Ctrl+U"],
  );
});
test("the displayed upload chord runs the production Composer handler and keeps its real safety guards", () => {
  const composer = readSource("src/composer/Composer.tsx");
  const section = composer.slice(
    composer.indexOf("const currentDraft = useRef"),
  );
  const signature = "const listener = (event: KeyboardEvent) => {";
  const start = section.indexOf(signature);
  assert.ok(start >= 0);
  const body = section.slice(
    start + signature.length,
    section.indexOf("\n    };", start),
  );
  const chooseFiles = composer.match(
    /const chooseFiles = \(\) => \{([\s\S]*?)\n  \};/,
  )?.[1];
  assert.ok(chooseFiles);
  type Chord = {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
    repeat: boolean;
    preventDefault(): void;
  };
  const make = new Function(
    "document",
    "platform",
    "attachmentsAllowed",
    "voicePhase",
    "bash",
    "pickFiles",
    "notify",
    "report",
    "t",
    "bashRefusal",
    "setModelMenu",
    "setAddMenu",
    `const chooseFiles=()=>{${chooseFiles}};return event=>{${body}};`,
  ) as (...values: unknown[]) => (event: Chord) => void;
  for (const platform of ["darwin", "win32"] as const) {
    let picked = 0;
    const close: boolean[] = [];
    const handler = (
      options: {
        blocked?: boolean;
        dialog?: boolean;
        voice?: string;
        bash?: boolean;
      } = {},
    ) =>
      make(
        { querySelector: () => (options.dialog ? {} : null) },
        platform,
        !options.blocked,
        options.voice ?? "off",
        options.bash ?? false,
        async () => {
          picked++;
        },
        noop,
        noop,
        (text: string) => text,
        "Bash does not take files",
        noop,
        (open: boolean) => close.push(open),
      );
    const event = (patch: Partial<Chord> = {}): Chord => ({
      key: "u",
      metaKey: platform === "darwin",
      ctrlKey: platform !== "darwin",
      shiftKey: false,
      altKey: false,
      defaultPrevented: false,
      repeat: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      ...patch,
    });
    const valid = event();
    handler()(valid);
    assert.equal(picked, 1, `${platform} reaches the existing real picker`);
    assert.deepEqual(close, [false], "the menu closes before opening a picker");
    assert.equal(valid.defaultPrevented, true);
    for (const patch of [
      { shiftKey: true },
      { altKey: true },
      { defaultPrevented: true },
      { repeat: true },
    ])
      handler()(event(patch));
    for (const options of [
      { blocked: true },
      { dialog: true },
      { voice: "listening" },
      { bash: true },
    ])
      handler(options)(event());
    assert.equal(
      picked,
      1,
      "repeat, unrelated chords, policy, dialogs, voice and Bash retain their actual guards",
    );
  }
});
test("native/legacy roots, submenu geometry, and existing light fill retain their previous rules", () => {
  const old = postcss.parse(addCSS);
  old.walkRules((rule) => {
    if (rule.selector.includes("composer-add-web-chat")) rule.remove();
  });
  const before = [webCSS, old.toString()],
    after = [webCSS, addCSS];
  for (const [presentation, classes] of [
    ["legacy", "app"],
    ["legacy", "app web"],
    ["web-chat", "app web mobile-conversation"],
  ] as const) {
    const document = fixture(presentation, "darwin", classes),
      root = document.querySelector(".composer-add-menu")!;
    for (const property of [
      "width",
      "height",
      "padding",
      "border",
      "border-radius",
      "background",
    ])
      assert.equal(
        style(root, after, property),
        style(root, before, property),
        `${presentation}/${classes}/${property}`,
      );
  }
  const document = fixture(),
    branch = document.querySelector(".composer-add-branch")!;
  const submenu = document.createElement("div");
  submenu.className = "composer-add-submenu";
  const row = document.createElement("button");
  submenu.append(row);
  branch.append(submenu);
  for (const element of [submenu, row])
    for (const property of [
      "width",
      "height",
      "padding",
      "border",
      "border-radius",
      "background",
    ])
      assert.equal(
        style(element, after, property),
        style(element, before, property),
        `submenu/${element.tagName}/${property}`,
      );
  const light = fixture("web-chat", "darwin", "app web", true).querySelector(
    ".composer-add-menu",
  )!;
  assert.equal(
    style(light, after, "background"),
    style(light, before, "background"),
  );
});
