import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  act,
  createElement as h,
  createRef,
  lazy,
  Suspense,
  type ComponentProps,
} from "react";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import { parse as selectors, type Selector } from "css-what";
import type { Settings } from "../../shared/types";
import { useAppearance } from "../../src/settings/useAppearance";
import { routineDom } from "../support/routine-dom";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";
import { webHost } from "../../shared/host";
import type { ComposerField } from "../../src/composer/composer-field";
import {
  createFixtureDesktop,
  fixtureSnapshot,
} from "../../scripts/preview/app-fixture";
import { readSource } from "../support/read-source";

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

const read = (path: string) =>
  readSource(new URL(`../../src/${path}`, import.meta.url), "utf8");
// Production eager sheets, followed by the lazy composer and live slot. These
// are DOM/cascade models; root separately checks actual web/native layout.
const paths = [
  "styles/20-workspace.css",
  "styles/80-dialogs-responsive.css",
  "styles/91-reference-workspace.css",
  "styles/92-reference-pages.css",
  "styles/93-reference-responsive.css",
  "settings/appearance.css",
  "transcript/chat-transcript.css",
  "transcript/code-transcript.css",
  "home/chat-home.css",
  "code-home/code-home.css",
  "composer/code/code-composer-footer.css",
  "artifacts/file-viewer.css",
  "styles/95-web.css",
  "styles/chat-phone-parity.css",
  "composer/composer-core.css",
  "live-web/composer.css",
  "live-web/transcript.css",
  "composer/native-chat-composer.css",
  "sidebar/native-chat-sidebar.css",
];
const sheets = paths.map((path) => postcss.parse(read(path)));
const previous = sheets.map((sheet, index) => {
  const copy = sheet.clone();
  if (paths[index] === "settings/appearance.css")
    copy.walkRules((rule) => {
      if (rule.selector.includes(".app.mode-chat")) rule.remove();
    });
  if (paths[index] === "transcript/chat-transcript.css")
    copy.walkRules(".mode-chat .messages", (rule) => {
      rule.walkDecls("width", (declaration) => {
        declaration.value = "min(794px, 100%)";
      });
    });
  if (paths[index] === "composer/composer-core.css")
    copy.walkDecls("width", (declaration) => {
      if (declaration.value.includes("var(--chat-column-measure, 768px)"))
        declaration.value = "min(768px, calc(100% - 48px))";
    });
  return copy;
});
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
function media(query: string, width: number) {
  return postcss.list.comma(query).some((alternative) => {
    for (const match of alternative.matchAll(
      /\((min|max)-width:\s*([\d.]+)px\)/g,
    ))
      if (
        match[1] === "min" ? width < Number(match[2]) : width > Number(match[2])
      )
        return false;
    if (/pointer:\s*coarse|hover:\s*none/.test(alternative)) return false;
    return true;
  });
}
function value(
  element: Element,
  property: string,
  width: number,
  sources = sheets,
): string | undefined {
  const inline = (element as HTMLElement).style?.getPropertyValue(property);
  if (inline) return inline;
  let winner: { rank: number; value: string } | undefined;
  for (const sheet of sources)
    sheet.walkRules((rule) => {
      const declarations = rule.nodes.filter(
        (node) => node.type === "decl" && node.prop === property,
      ) as postcss.Declaration[];
      if (!declarations.length) return;
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
        if (parent.name === "media" && !media(parent.params, width)) return;
      }
      for (const selector of postcss.list.comma(rule.selector)) {
        if (selector.includes("::")) continue;
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
        for (const declaration of declarations) {
          const priority = specificity + (declaration.important ? 1000000 : 0);
          if (!winner || winner.rank <= priority)
            winner = { rank: priority, value: declaration.value };
        }
      }
    });
  return (
    winner?.value ??
    (property.startsWith("--") && element.parentElement
      ? value(element.parentElement, property, width, sources)
      : undefined)
  );
}
function length(
  expression: string,
  element: Element,
  viewport: number,
  available: number,
  sources = sheets,
): number {
  let expanded = expression;
  for (let step = 0; expanded.includes("var(") && step < 8; step++)
    expanded = expanded.replace(
      /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
      (_match, name: string, fallback: string) =>
        value(element, name, viewport, sources) ?? fallback,
    );
  if (/^(min|max)\(/.test(expanded)) {
    const kind = expanded.startsWith("min") ? Math.min : Math.max;
    return kind(
      ...postcss.list
        .comma(expanded.slice(4, -1))
        .map((part) => length(part, element, viewport, available, sources)),
    );
  }
  expanded = expanded
    .replace(/calc\(/g, "(")
    .replace(/([\d.]+)%/g, (_match, amount) =>
      String((available * Number(amount)) / 100),
    )
    .replace(/px\b/g, "");
  assert.match(
    expanded,
    /^[\d.()+\-*/\s]+$/,
    `unsupported local width expression ${expanded}`,
  );
  return Number(Function(`"use strict"; return (${expanded})`)());
}
function resolvedValue(
  element: Element,
  property: string,
  viewport: number,
  sources = sheets,
) {
  return value(element, property, viewport, sources)?.replace(
    /var\((--[\w-]+)(?:,\s*([^()]+))?\)/g,
    (_match, name: string, fallback: string) =>
      value(element, name, viewport, sources) ?? fallback,
  );
}
function frame({
  width = "s",
  web = false,
  mode = "chat",
  stored = mode,
  sidebar = true,
  panel = false,
  home = false,
}: {
  width?: string;
  web?: boolean;
  mode?: string;
  stored?: string;
  sidebar?: boolean;
  panel?: boolean;
  home?: boolean;
} = {}) {
  const document =
    parseHTML(`<html data-theme="dark" data-transcript-width="${width}" data-surface="${web ? "web" : "desktop"}"><body>
    <div class="app ${web ? "web" : "darwin desktop"} mode-${mode} ${sidebar ? "" : "sidebar-hidden"}" data-execution-mode="${stored}">
      <aside class="sidebar"></aside><div class="workspace"><div class="chat-layout">
        <main class="chat-main ${home ? "empty-chat" : "has-conversation"}">
          ${home ? '<div class="chat-home"></div>' : '<div class="messages-scroll"><div class="messages"><article><div class="markdown">Actual content</div></article></div></div>'}
          <div class="composer-wrap ${mode === "code" ? "code-composer" : "chat-composer"} ${home ? "" : "conversation-composer"}"></div>
        </main>${panel ? '<aside class="artifact-panel"></aside>' : ""}
      </div></div>
    </div></body></html>`).document;
  return {
    document,
    messages: document.querySelector(".messages")!,
    composer: document.querySelector(".composer-wrap")!,
    home: document.querySelector(".chat-home")!,
    sidebar: document.querySelector(".sidebar")!,
  };
}

test("Code's Medium and Wide columns are not cut to 818px and 770px in a window of 1500px or more", () => {
  for (const [width, messages] of [
    ["m", 1008],
    ["l", 1328],
  ] as const) {
    const f = frame({ width, mode: "code" });
    for (const viewport of [1440, 2000]) {
      assert.equal(value(f.messages, "max-width", viewport), "none");
      assert.equal(value(f.composer, "max-width", viewport), "none");
    }
    assert.equal(value(f.messages, "width", 2000), `min(${messages}px, 100%)`);
  }
});

test("shared Chat Source measure removes the old >=1500px caps and keeps the measured full-pane dock widths", () => {
  for (const web of [false, true])
    for (const sidebar of [false, true])
      for (const [width, viewport, main, prose, dock] of [
        ["s", 1440, 1152, 736, 768],
        ["m", 1440, 1152, 928, 960],
        ["l", 1440, 1152, 1072, 1104],
        ["l", 2000, 1712, 1248, 1280],
        ["m", 2000, 1712, 928, 960],
      ] as const) {
        const f = frame({ width, web, sidebar });
        const messageWidth = length(
          value(f.messages, "width", viewport)!,
          f.messages,
          viewport,
          main - (web ? 16 : 22),
        );
        const dockWidth = length(
          value(f.composer, "width", viewport)!,
          f.composer,
          viewport,
          main,
        );
        // Both hosts' unconstrained caps are exact. The constrained Web case
        // needs root's actual scroll-port measurement (8px vs native11px
        // scrollbars); do not substitute the native gutter for that evidence.
        if (!web || width !== "l" || viewport !== 1440)
          assert.equal(
            messageWidth - 58,
            prose,
            `${web}:${sidebar}:${width}:${viewport} Prose`,
          );
        assert.equal(
          dockWidth,
          dock,
          `${web}:${sidebar}:${width}:${viewport} dock`,
        );
        assert.equal(value(f.messages, "max-width", viewport), "none");
        assert.equal(value(f.composer, "max-width", viewport), "none");
        assert.ok(dockWidth <= main - 48);
      }
});

test("stored Cowork projected by unified Chat follows the selected measure, while Code and legacy Cowork keep their own cascade", () => {
  for (const width of ["s", "m", "l"])
    for (const viewport of [390, 900, 1440, 2000]) {
      const unified = frame({ width, mode: "chat", stored: "cowork" });
      assert.equal(
        value(unified.composer, "--chat-column-measure", viewport),
        width === "m" ? "960px" : width === "l" ? "1280px" : undefined,
      );
      for (const mode of ["code", "cowork"]) {
        const f = frame({ width, mode });
        assert.equal(
          value(f.composer, "--chat-column-measure", viewport),
          undefined,
        );
        for (const element of [f.messages, f.composer, f.sidebar])
          for (const property of [
            "width",
            "max-width",
            "padding-left",
            "padding-right",
          ])
            assert.equal(
              resolvedValue(element, property, viewport),
              resolvedValue(element, property, viewport, previous),
              `${mode}:${width}:${viewport}:${property}`,
            );
      }
    }
});

test("phone gutters, side-panel available widths and the official 640px home maximum survive every transcript choice", () => {
  for (const width of ["s", "m", "l"])
    for (const web of [false, true]) {
      const phone = frame({ width, web });
      assert.equal(
        length(value(phone.composer, "width", 390)!, phone.composer, 390, 390),
        length(
          value(phone.composer, "width", 390, previous)!,
          phone.composer,
          390,
          390,
          previous,
        ),
      );
      assert.ok(
        length(
          value(phone.messages, "width", 390)!,
          phone.messages,
          390,
          390,
        ) <= 390,
      );
      for (const viewport of [900, 1440, 2000]) {
        const panel = frame({ width, web, panel: true });
        const available = viewport < 1000 ? 360 : 620;
        assert.ok(
          length(
            value(panel.composer, "width", viewport)!,
            panel.composer,
            viewport,
            available,
          ) <= available,
        );
        assert.ok(
          length(
            value(panel.messages, "width", viewport)!,
            panel.messages,
            viewport,
            available - 22,
          ) <=
            available - 22,
        );
        const f = frame({ width, web, home: true });
        assert.equal(
          value(f.home, "width", viewport),
          value(f.home, "width", viewport, previous),
        );
        if (web)
          assert.equal(
            length(value(f.home, "width", viewport)!, f.home, viewport, 1712),
            640,
          );
      }
    }
});

test("the real appearance hook changes the Chat measure before paint and restores Narrow without remounting the application", async () => {
  const env = await routineDom();
  const saved = Object.getOwnPropertyDescriptor(globalThis, "matchMedia");
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: env.window.matchMedia,
  });
  function Probe({ width }: { width: "s" | "m" | "l" }) {
    useAppearance({ theme: "dark", transcriptWidth: width } as Settings);
    return h(
      "div",
      { className: "app mode-chat" },
      h(
        "main",
        { className: "chat-main has-conversation" },
        h("div", { className: "messages" }),
        h("div", {
          className: "composer-wrap chat-composer conversation-composer",
        }),
      ),
    );
  }
  try {
    await env.render(h(Probe, { width: "s" }));
    const app = env.document.querySelector(".app")!;
    for (const [width, expected] of [
      ["m", "960px"],
      ["l", "1280px"],
      ["s", undefined],
    ] as const) {
      await env.render(h(Probe, { width }));
      assert.equal(env.document.querySelector(".app"), app);
      assert.equal(env.document.documentElement.dataset.transcriptWidth, width);
      assert.equal(
        value(
          env.document.querySelector(".composer-wrap")!,
          "--chat-column-measure",
          2000,
        ),
        expected,
      );
    }
  } finally {
    await env.clean();
    if (saved) Object.defineProperty(globalThis, "matchMedia", saved);
    else Reflect.deleteProperty(globalThis, "matchMedia");
  }
});

test("the genuinely delayed real Composer attaches its dock before paint, tracks resize and releases scope without a new container", async () => {
  const env = await routineDom(
    createFixtureDesktop(
      { history: "empty" },
      new URLSearchParams("fonts=system"),
    ),
    { jsdom: true },
  );
  env.window.innerWidth = 1440;
  const watches: { node?: Element; update(): void; stopped: boolean }[] = [];
  let dockWidth = 1104;
  const bounds = Object.getOwnPropertyDescriptor(
    env.window.HTMLElement.prototype,
    "getBoundingClientRect",
  );
  env.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = this.classList.contains("conversation-composer")
      ? dockWidth
      : 600;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 48,
      width,
      height: 48,
      toJSON() {},
    };
  };
  const computed = () =>
    Object.assign(env.document.createElement("div").style, {
      paddingLeft: "0px",
      paddingRight: "0px",
      lineHeight: "21px",
      letterSpacing: "0px",
      font: "15px sans-serif",
    });
  const globals = {
    navigator: { language: "en-US", userAgent: "width-test" },
    HTMLElement: env.window.HTMLElement,
    Element: env.window.Element,
    Node: env.window.Node,
    HTMLInputElement: env.window.HTMLInputElement,
    HTMLTextAreaElement: env.window.HTMLTextAreaElement,
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: computed,
    addEventListener: env.window.addEventListener.bind(env.window),
    removeEventListener: env.window.removeEventListener.bind(env.window),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    ResizeObserver: class {
      entry: (typeof watches)[number];
      constructor(update: () => void) {
        this.entry = { update, stopped: false };
        watches.push(this.entry);
      }
      observe(node: Element) {
        this.entry.node = node;
      }
      unobserve() {}
      disconnect() {
        this.entry.stopped = true;
      }
    },
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
  Object.assign(env.window, { getComputedStyle: computed });
  const state = fixtureSnapshot({ history: "empty" });
  const active: NonNullable<AppController["active"]> = {
    id: "width-session",
    title: "Width",
    mode: "chat",
    providerId: state.settings.activeProviderId,
    model: state.settings.providers[0].model,
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [],
  };
  const field = createRef<ComposerField>();
  const noop = () => {};
  const props: ComponentProps<
    typeof import("../../src/composer/Composer").Composer
  > = {
    settings: state.settings,
    platform: "darwin",
    active,
    activeId: active!.id,
    projects: [],
    mode: "chat",
    draftIdentity: "width",
    providerId: state.settings.activeProviderId,
    model: state.settings.providers[0].model,
    text: "",
    attachments: [],
    recentFolders: [],
    running: false,
    sending: false,
    composer: field,
    onProject: noop,
    onCreateProject: noop,
    openSettingsTab: noop,
    onOpenUsage: noop,
    onCompact: noop,
    onNavigate: noop,
    setMode: noop,
    setProviderId: noop,
    setModel: noop,
    setText: noop,
    setAttachments: noop,
    setCwd: noop,
    webSearch: false,
    webSearchAvailable: false,
    onWebSearch: noop,
    pickFiles: async () => {},
    pickFolder: async () => {},
    updatePreference: async () => {},
    send: async () => {},
    interrupt: async () => {},
    report(error: unknown) {
      throw error;
    },
    notify: noop,
    setSettingsOpen: noop,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const DelayedComposer = lazy(async () => {
    await gate;
    return { default: (await import("../../src/composer/Composer")).Composer };
  });
  const draw = (
    scope: object,
    panel: AppController["panel"] = null,
    mode = "chat",
  ) =>
    env.render(
      h(
        HostContext.Provider,
        { value: webHost },
        h(
          AppContext.Provider,
          {
            value: {
              accountId: "width-account",
              controllerScope: scope,
              snapshot: state,
              panel,
              composer: field,
            } as AppController,
          },
          h(
            "div",
            { className: `app web mode-${mode}` },
            h(
              "div",
              { className: "chat-layout" },
              h(
                "main",
                { className: "chat-main has-conversation" },
                h("div", { className: "messages" }),
                h(
                  Suspense,
                  {
                    fallback: h(
                      "span",
                      { "data-lazy": true },
                      "Pending actual Composer",
                    ),
                  },
                  h(DelayedComposer, {
                    ...props,
                    mode: mode as "chat" | "code",
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  try {
    env.document.documentElement.dataset.transcriptWidth = "l";
    const first = {};
    await draw(first);
    const main = env.document.querySelector<HTMLElement>(".chat-main")!;
    assert.ok(env.document.querySelector("[data-lazy]"));
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "",
    );
    // Let genuinely cold dynamic-import I/O advance on Node's real
    // scheduler; React 19 act can otherwise spin its Suspense retry lanes.
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
    release();
    for (
      let attempt = 0;
      !field.current?.classList.contains("composer-atomic-input") &&
      attempt < 200;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    await act(async () => {});
    assert.ok(field.current);
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "1104px",
      "the real committed dock attaches in layout, not a Host's earlier empty-ref pass",
    );
    const feed = env.document.querySelector(".messages")!;
    for (const scrollPort of [1136, 1130])
      assert.equal(
        length(value(feed, "width", 1440)!, feed, 1440, scrollPort) - 58,
        1072,
      );
    const old = watches.find((entry) =>
      entry.node?.classList.contains("conversation-composer"),
    )!;
    assert.ok(old);
    dockWidth = 1280;
    await act(async () => old.update());
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "1280px",
    );
    await draw({});
    assert.equal(old.stopped, true);
    dockWidth = 999;
    await act(async () => old.update());
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "1280px",
      "an old owner callback cannot mutate the successor's measure",
    );
    await draw({}, "files");
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "",
      "a side panel restores the independent pane cascade",
    );
    await draw({});
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "999px",
    );
    env.window.innerWidth = 390;
    await env.event(env.window as unknown as Document, "resize");
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "",
    );
    env.window.innerWidth = 1440;
    await env.event(env.window as unknown as Document, "resize");
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "999px",
    );
    await draw({}, null, "code");
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "",
    );
    assert.equal(main.style.getPropertyValue("container-type") ?? "", "");
    await env.render(h("p", null, "unmounted"));
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure") ?? "",
      "",
    );
    assert.ok(
      watches
        .filter((entry) =>
          entry.node?.classList.contains("conversation-composer"),
        )
        .every((entry) => entry.stopped),
    );
  } finally {
    await env.clean();
    if (bounds)
      Object.defineProperty(
        env.window.HTMLElement.prototype,
        "getBoundingClientRect",
        bounds,
      );
    else
      Reflect.deleteProperty(
        env.window.HTMLElement.prototype,
        "getBoundingClientRect",
      );
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("an older dock cleanup cannot delete a newer owner on the same pane, and final cleanup restores the original variable", async () => {
  const { useChatTranscriptColumn } =
    await import("../../src/composer/useChatTranscriptColumn");
  const env = await routineDom();
  env.window.innerWidth = 1440;
  const bounds = Object.getOwnPropertyDescriptor(
    env.window.HTMLElement.prototype,
    "getBoundingClientRect",
  );
  env.window.HTMLElement.prototype.getBoundingClientRect = function () {
    const width = Number(this.getAttribute("data-width"));
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: 48,
      width,
      height: 48,
      toJSON() {},
    };
  };
  const owners = { a: {}, b: {} };
  function Dock({ owner }: { owner: "a" | "b" }) {
    const ref = useChatTranscriptColumn(true, owners[owner]);
    return h("div", {
      ref,
      className: "composer-wrap conversation-composer",
      "data-width": owner === "a" ? 101 : 202,
    });
  }
  const draw = (showA: boolean, showB: boolean) =>
    env.render(
      h(
        "div",
        { className: "app mode-chat" },
        h(
          "main",
          {
            className: "chat-main has-conversation",
            style: {
              "--chat-composer-measure": "777px",
            } as import("react").CSSProperties,
          },
          showA && h(Dock, { key: "a", owner: "a" }),
          showB && h(Dock, { key: "b", owner: "b" }),
        ),
      ),
    );
  try {
    await draw(true, true);
    const main = env.document.querySelector<HTMLElement>("main main")!;
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure"),
      "202px",
    );
    await draw(false, true);
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure"),
      "202px",
    );
    await draw(false, false);
    assert.equal(
      main.style.getPropertyValue("--chat-composer-measure"),
      "777px",
    );
  } finally {
    await env.clean();
    if (bounds)
      Object.defineProperty(
        env.window.HTMLElement.prototype,
        "getBoundingClientRect",
        bounds,
      );
    else
      Reflect.deleteProperty(
        env.window.HTMLElement.prototype,
        "getBoundingClientRect",
      );
  }
});
