import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { act, createElement } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import postcss from "postcss";
import { parse as parseSelector, type Selector } from "css-what";
import { HostContext } from "../../src/host/HostContext";
import { webHost, desktopHost } from "../../shared/host";
import { CoworkVoiceControls } from "../../src/composer/voice/CoworkVoiceControls";
// Vite supplies ?url imports as URLs. No audio worklet is executed here.
registerHooks({
  load(url, context, next) {
    if (url.includes("?url"))
      return {
        format: "module",
        source: `export default ${JSON.stringify(url)};`,
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const { VoiceModeButton } = await import("../../src/composer/VoiceModeButton");

const noop = () => {};
function render(web: boolean, props: Parameters<typeof VoiceModeButton>[0]) {
  return parseHTML(
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: web ? webHost : desktopHost },
        createElement(VoiceModeButton, props),
      ),
    ),
  ).document;
}
test("web reply voice group names its real waveform/caret and uses 16px/12px glyphs", () => {
  const document = render(true, { variant: "reply" });
  const group = document.querySelector(
    '.voice-mode-button.reply-voice-mode[role="group"]',
  )!;
  assert.equal(group.getAttribute("aria-label"), "Use voice mode");
  assert.deepEqual(
    [...group.querySelectorAll("button")].map((button) =>
      button.getAttribute("aria-label"),
    ),
    ["Use voice mode", "Microphone"],
  );
  assert.deepEqual(
    [...group.children]
      .filter((child) => child.matches("button,.reply-voice-divider"))
      .map((child) => child.className.split(" ")[0]),
    ["voice-mode-main", "reply-voice-divider", "voice-mode-chevron"],
    "the transparent 1px seam follows the waveform, before the microphone caret",
  );
  assert.equal(
    group.querySelector(".reply-voice-divider")?.getAttribute("aria-hidden"),
    "true",
  );
  assert.equal(
    group.querySelector(".voice-mode-main > svg")?.getAttribute("width"),
    "16",
  );
  assert.equal(
    group
      .querySelector('.voice-mode-chevron [data-icon="CaretDown"]')
      ?.getAttribute("width"),
    "12",
  );
});

const css = (path: string) =>
  readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const voiceCSS = css("composer/voice/voice-mode.css");
const otherCSS = [
  css("composer/voice/cowork-voice.css"),
  css("composer/voice/dictation.css"),
  css("home/chat-home.css"),
  css("live-web/composer.css"),
  css("styles/95-web.css"),
];
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
function expand(property: string, value: string, target: string) {
  if (property === target) return value;
  const side = /^(margin|padding)-(top|right|bottom|left)$/.exec(target);
  if (side && property === side[1]) {
    const pieces = value.trim().split(/\s+/);
    const expanded = [
      pieces[0],
      pieces[1] ?? pieces[0],
      pieces[2] ?? pieces[0],
      pieces[3] ?? pieces[1] ?? pieces[0],
    ];
    return expanded[["top", "right", "bottom", "left"].indexOf(side[2])];
  }
}
const parsedCSS = new Map<string, postcss.Root>();
function declaration(
  element: Element,
  sources: string[],
  property: string,
  width: number,
) {
  let winner: { rank: number; value: string } | undefined;
  for (const source of sources) {
    const root = parsedCSS.get(source) ?? postcss.parse(source);
    parsedCSS.set(source, root);
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
        if (parent.name === "media") {
          const min = parent.params.match(/min-width:\s*([\d.]+)px/),
            max = parent.params.match(/max-width:\s*([\d.]+)px/);
          if (
            (min && width < +min[1]) ||
            (max && width > +max[1]) ||
            /hover:\s*none|pointer:\s*coarse/.test(parent.params)
          )
            return;
        }
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        const resting = selector.replace(
          /:(hover|focus-visible|focus-within|focus|active)(?![\w-])/g,
          (_, state: string) => `[data-css-${state}]`,
        );
        let matches = false;
        try {
          matches = !selector.includes("::") && element.matches(resting);
        } catch {}
        if (!matches) continue;
        const rank = Math.max(...parseSelector(selector).map(specificity));
        rule.walkDecls((decl) => {
          const value = expand(decl.prop, decl.value, property);
          if (value === undefined) return;
          const priority = rank + (decl.important ? 1000000 : 0);
          if (!winner || winner.rank <= priority)
            winner = { rank: priority, value };
        });
      }
    });
  }
  return winner?.value;
}
function fixture(group: string, classes = "app web") {
  return parseHTML(
    `<html data-surface="web"><body><div class="${classes}"><div class="composer-wrap conversation-composer"><div class="composer-chin"><div class="composer-chin-voice"><div class="cowork-voice-controls chin-voice-controls"><button class="dictation-button">Dictate</button></div>${group}</div></div></div></div></body></html>`,
  ).document;
}
function geometry(document: Document, sources: string[], width: number) {
  const group = document.querySelector(".voice-mode-button")!;
  const value = (selector: string, property: string) =>
    declaration(
      selector === ":self" ? group : document.querySelector(selector)!,
      sources,
      property,
      width,
    );
  return {
    groupWidth: value(":self", "width"),
    groupHeight: value(":self", "height"),
    mainWidth: value(".voice-mode-main", "width"),
    mainHeight: value(".voice-mode-main", "height"),
    dividerWidth: value(".reply-voice-divider", "width"),
    dividerAlign: value(".reply-voice-divider", "align-self"),
    caretWidth: value(".voice-mode-chevron", "width"),
    caretHeight: value(".voice-mode-chevron", "height"),
    caretLeft: value(".voice-mode-chevron", "margin-left"),
    caretPadding: value(".voice-mode-chevron", "padding"),
    gap: value(".composer-chin-voice", "gap"),
  };
}
const replyMarkup = () =>
  render(true, { variant: "reply" }).querySelector(".voice-mode-button")!
    .outerHTML;
function geometryContract(sources: string[], width: number) {
  const document = fixture(replyMarkup());
  const measured = geometry(document, sources, width);
  assert.deepEqual(measured, {
    groupWidth: "41px",
    groupHeight: "24px",
    mainWidth: "24px",
    mainHeight: "24px",
    dividerWidth: "1px",
    dividerAlign: "stretch",
    caretWidth: "20px",
    caretHeight: "24px",
    caretLeft: "-4px",
    caretPadding: "0 4px",
    gap: "4px",
  });
  assert.equal(24 + 1 + 20 - 4, Number.parseFloat(measured.groupWidth!));
  assert.equal(
    24 +
      Number.parseFloat(measured.gap!) +
      Number.parseFloat(measured.groupWidth!),
    69,
  );
  return document;
}
test("reply split geometry wins the shipped CSS in either lazy-sheet order at 1440 and 390", () => {
  for (const width of [1440, 390])
    for (const sources of [
      [voiceCSS, ...otherCSS],
      [...otherCSS, voiceCSS],
    ])
      geometryContract(sources, width);
});
test("removing the reply overrides exposes the old 14px caret and rejects the geometry contract", () => {
  const old = postcss.parse(voiceCSS);
  old.walkRules((rule) => {
    if (rule.selector.includes("reply-voice-mode")) rule.remove();
  });
  const sources = [...otherCSS, old.toString()];
  assert.equal(
    declaration(
      fixture(replyMarkup()).querySelector(".voice-mode-chevron")!,
      sources,
      "width",
      390,
    ),
    "14px",
  );
  assert.throws(() => geometryContract(sources, 390));
});
test("reply ring is transparent at rest and only takes the border when hovered, pressed or menu-open", () => {
  const sources = [...otherCSS, voiceCSS];
  const document = geometryContract(sources, 1440);
  const group = document.querySelector(".voice-mode-button")!;
  const value = (property: string) =>
    declaration(group, sources, property, 1440);
  assert.equal(
    value("box-shadow"),
    "inset 0 0 0 1px var(--cds-split-ring, transparent)",
  );
  assert.equal(value("--cds-split-ring"), undefined);
  for (const state of ["hover", "pressed", "open"]) {
    if (state === "hover") group.setAttribute("data-css-hover", "");
    else if (state === "pressed")
      group
        .querySelector(".voice-mode-main")!
        .setAttribute("aria-pressed", "true");
    else group.querySelector(".voice-mode-chevron")!.classList.add("open");
    assert.equal(
      value("--cds-split-ring"),
      "var(--cds-border, var(--border))",
      state,
    );
    group.removeAttribute("data-css-hover");
    group.querySelector(".voice-mode-main")!.removeAttribute("aria-pressed");
    group.querySelector(".voice-mode-chevron")!.classList.remove("open");
  }
});
test("reply private CSS leaves actual native wrapper and legacy/home groups unchanged", () => {
  const old = postcss.parse(voiceCSS);
  old.walkRules((rule) => {
    if (rule.selector.includes("reply-voice-mode")) rule.remove();
  });
  for (const classes of ["app web mobile-conversation", "app"]) {
    const document = fixture(replyMarkup(), classes);
    for (const selector of [
      ".composer-chin-voice",
      ".voice-mode-button",
      ".voice-mode-main",
      ".voice-mode-chevron",
    ])
      for (const property of [
        "width",
        "height",
        "margin-left",
        "padding",
        "gap",
        "box-shadow",
      ])
        assert.equal(
          declaration(
            document.querySelector(selector)!,
            [...otherCSS, voiceCSS],
            property,
            390,
          ),
          declaration(
            document.querySelector(selector)!,
            [...otherCSS, old.toString()],
            property,
            390,
          ),
          `${classes} ${selector} ${property}`,
        );
  }
  const legacy = render(true, {
    microphoneOptions: false,
    iconSize: 20,
  }).querySelector(".voice-mode-button")!.outerHTML;
  const document = fixture(legacy);
  for (const selector of [
    ".composer-chin-voice",
    ".voice-mode-button",
    ".voice-mode-main",
  ])
    for (const property of [
      "width",
      "height",
      "margin-left",
      "padding",
      "gap",
      "box-shadow",
    ])
      assert.equal(
        declaration(
          document.querySelector(selector)!,
          [...otherCSS, voiceCSS],
          property,
          1440,
        ),
        declaration(
          document.querySelector(selector)!,
          [...otherCSS, old.toString()],
          property,
          1440,
        ),
        `legacy ${selector} ${property}`,
      );
});
test("the real preferred input retains its caret while the voice action is cold, then resolves without starting audio", async () => {
  const { routineDom } = await import("../support/routine-dom");
  const { PreferredVoiceInput } =
    await import("../../src/composer/PreferredVoiceInput");
  const { AppContext } = await import("../../src/app/AppContext");
  const env = await routineDom({}, { jsdom: true });
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "SpeechSynthesisUtterance",
  );
  Object.defineProperty(globalThis, "SpeechSynthesisUtterance", {
    configurable: true,
    value: class {},
  });
  Object.defineProperty(env.window, "speechSynthesis", {
    configurable: true,
    value: {},
  });
  const app = {
    accountId: "voice-group-cold",
    controllerScope: {},
    page: "home",
  } as unknown as import("../../src/app/AppContext").AppController;
  let resolve!: (value: { default: typeof VoiceModeButton }) => void;
  const pending = new Promise<{ default: typeof VoiceModeButton }>(
    (done) => (resolve = done),
  );
  const Cold = React.lazy(() => pending);
  env.window.localStorage.setItem(
    "claudex.voice.pinned-input-action.voice-group-cold",
    "voice",
  );
  const child = createElement(
    HostContext.Provider,
    { value: webHost },
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(PreferredVoiceInput, {
        dictation: createElement("button", { "aria-label": "Dictate" }),
        voice: createElement(Cold, {
          waveform: true,
          microphoneOptions: false,
          iconSize: 16,
        }),
      }),
    ),
  );
  try {
    env.document.body.className = "app web composer-wrap";
    env.document.querySelector("main")!.className = "composer-chin";
    await env.render(child);
    const group = env.document.querySelector(".preferred-voice-input")!;
    const slot = () =>
      [390, 1440].map((width) => [
        declaration(
          group.querySelector(".voice-mode-button.standalone")!,
          [voiceCSS, ...otherCSS],
          "width",
          width,
        ),
        declaration(
          group.querySelector(
            ".voice-mode-button.standalone > .voice-mode-main",
          )!,
          [voiceCSS, ...otherCSS],
          "height",
          width,
        ),
      ]);
    const coldSize = slot();
    assert.deepEqual(coldSize, [
      ["24px", "24px"],
      ["24px", "24px"],
    ]);
    assert.ok(
      group.querySelector('.voice-mode-button.standalone[aria-hidden="true"]'),
    );
    const caret = group.querySelector('[aria-label="Voice input"]');
    assert.ok(caret);
    assert.equal(group.querySelector(".reply-voice-divider"), null);
    assert.equal(group.querySelector('[aria-label="Dictate"]'), null);
    await act(async () => resolve({ default: VoiceModeButton }));
    assert.equal(
      group.querySelector('[aria-hidden="true"].voice-mode-button'),
      null,
    );
    assert.ok(group.querySelector('button[aria-label="Use voice mode"]'));
    assert.ok(group.querySelector('[aria-label="Voice input"]') === caret);
    assert.deepEqual(slot(), coldSize);
    group.classList.remove("preferred-voice-input");
    assert.notDeepEqual(
      slot(),
      coldSize,
      "removing the source-backed single-slot scope is a negative control",
    );
    assert.equal(group.querySelector('[aria-pressed="true"]'), null);
  } finally {
    await env.clean();
    if (descriptor)
      Object.defineProperty(globalThis, "SpeechSynthesisUtterance", descriptor);
    else Reflect.deleteProperty(globalThis, "SpeechSynthesisUtterance");
  }
});
test("native and web home callers keep their original split/standalone presentation", () => {
  for (const web of [false, true]) {
    const document = render(
      web,
      web
        ? { waveform: true, microphoneOptions: false, iconSize: 20 }
        : { variant: "reply" },
    );
    assert.equal(Boolean(document.querySelector(".reply-voice-mode")), false);
    assert.equal(
      document.querySelector(".voice-mode-button")?.getAttribute("role"),
      null,
    );
    assert.equal(
      document.querySelector(".voice-mode-main > svg")?.getAttribute("width"),
      "20",
    );
    assert.equal(Boolean(document.querySelector(".voice-mode-chevron")), !web);
  }
});

test("reply Microphone opens the real idle device menu and Escape returns to its trigger without recording", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  let focused: HTMLElement | undefined;
  const oldFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  let enumerated = 0,
    recorded = 0;
  const preferences = new Map<string, string>();
  const globals = {
    window,
    document,
    innerWidth: 390,
    innerHeight: 844,
    navigator: {
      userAgent: "Linkedom",
      mediaDevices: {
        enumerateDevices: async () => {
          enumerated++;
          return [];
        },
        addEventListener: noop,
        removeEventListener: noop,
        getUserMedia: async () => {
          recorded++;
          throw new Error("No recording requested by this test");
        },
      },
    },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    localStorage: {
      getItem: (key: string) => preferences.get(key) ?? null,
      setItem: (key: string, value: string) => preferences.set(key, value),
    },
    dispatchEvent: window.dispatchEvent.bind(window),
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.querySelector("main")!);
  const phases: string[] = [];
  try {
    await act(async () =>
      root.render(
        createElement(
          HostContext.Provider,
          { value: webHost },
          createElement(VoiceModeButton, {
            variant: "reply",
            onPhase: (phase) => phases.push(phase),
          }),
        ),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Microphone"]',
    )!;
    trigger.focus();
    await act(async () =>
      trigger.dispatchEvent(new window.Event("click", { bubbles: true })),
    );
    for (
      let attempt = 0;
      attempt < 50 && !document.querySelector(".microphone-menu-idle");
      attempt++
    )
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2));
      });
    assert.ok(document.querySelector(".microphone-menu-idle"));
    assert.ok(enumerated > 0);
    assert.match(
      document.querySelector(".microphone-menu")!.textContent!,
      /No devices found/,
    );
    assert.doesNotMatch(
      document.querySelector(".microphone-menu")!.textContent!,
      /Hold to record/,
    );
    assert.equal(recorded, 0);
    assert.deepEqual(phases, ["off"]);
    const language = document.querySelector<HTMLButtonElement>(
      ".microphone-language-status",
    )!;
    assert.equal(language.disabled, false);
    await act(async () => language.click());
    assert.ok(
      document.querySelector(
        '.dictation-language-menu input[aria-label="Search languages"]',
      ),
    );
    const back = new window.Event("keydown", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(back, { key: "Escape" });
    await act(async () =>
      document.querySelector(".dictation-language-menu")!.dispatchEvent(back),
    );
    assert.ok(
      document.querySelector(".microphone-menu"),
      "Escape closes only the language submenu",
    );
    assert.equal(document.querySelector(".dictation-language-menu"), null);
    assert.equal(document.activeElement, language);
    await act(async () => language.click());
    const english = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".dictation-language-menu button",
      ),
    ].find((button) => button.textContent === "English")!;
    await act(async () => english.click());
    assert.equal(preferences.get("claudex.dictation.language"), "en");
    assert.equal(document.querySelector(".microphone-menu"), null);
    assert.equal(document.activeElement, trigger);
    await act(async () => trigger.click());
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>(".microphone-language-status")!
        .click(),
    );
    assert.equal(
      [
        ...document.querySelectorAll(
          '.dictation-language-menu [aria-checked="true"]',
        ),
      ][0]?.textContent,
      "English",
    );
    const auto = [
      ...document.querySelectorAll<HTMLButtonElement>(
        ".dictation-language-menu button",
      ),
    ].find((button) => button.textContent === "Auto")!;
    await act(async () => auto.click());
    assert.equal(preferences.get("claudex.dictation.language"), "");
    assert.equal(recorded, 0);
    await act(async () => trigger.click());
    const escape = new window.Event("keydown", { bubbles: true });
    Object.assign(escape, { key: "Escape" });
    await act(async () =>
      document.querySelector(".microphone-menu")!.dispatchEvent(escape),
    );
    assert.equal(Boolean(document.querySelector(".microphone-menu")), false);
    assert.equal(document.activeElement === trigger, true);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
  } finally {
    await act(async () => root.unmount());
    window.HTMLElement.prototype.focus = oldFocus;
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("voice mode lit state is text-accent over bg-accent in both themes", () => {
  assert.match(
    voiceCSS,
    /\.voice-mode-main\.active:not\(:disabled\)\s*\{[^}]*background:\s*#257de01f;[^}]*color:\s*#6aabf1;/,
  );
  assert.match(
    voiceCSS,
    /\[data-theme="light"\][^{]*\.voice-mode-main\.active:not\(:disabled\)\s*\{[^}]*color:\s*#1757ac;/,
  );
  assert.doesNotMatch(voiceCSS, /#da6b61/);
});
