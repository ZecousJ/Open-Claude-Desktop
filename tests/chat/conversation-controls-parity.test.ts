import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Provider } from "../../shared/types";
import type {
  ModelCatalog,
  ModelCatalogItem,
} from "../../shared/model-catalog-api";
import { webHost, desktopHost } from "../../shared/host";
import { HostContext } from "../../src/host/HostContext";
import { OpenLink } from "../../src/ui/ExternalLinks";
import { ConversationDisclaimer } from "../../src/composer/ConversationDisclaimer";
import { ModelMenu } from "../../src/composer/model/ModelMenu";
import { HelpPage } from "../../src/help/HelpPage";
import { parseWebRoute } from "../../src/web/routes";
import {
  ActivityPanel,
  hasSessionActivity,
} from "../../src/cowork/ActivityPanel";
import { ConversationPanelButtons } from "../../src/conversation/ConversationPanelButtons";
import { ActivityIllustration } from "../../src/cowork/ActivityIllustration";
import { ToolSidePanel } from "../../src/conversation/ToolSidePanel";
import { ConversationLayout } from "../../src/app/ConversationLayout";
import type { AgentTranscript, Conversation, Item } from "../../shared/types";

const noop = () => {};
function conversation(items: Item[] = []): Conversation {
  return {
    id: "controls",
    title: "Controls",
    mode: "cowork",
    providerId: "first",
    model: "claude-opus-5-5",
    createdAt: 1,
    updatedAt: 1,
    pinned: false,
    archived: false,
    cwd: "/workspace",
    turns: [
      {
        id: "turn",
        prompt: "Hello",
        createdAt: 1,
        status: "completed",
        attachments: [],
        items,
      },
    ],
  };
}
const localLocation = {
  origin: "http://127.0.0.1:5174",
  protocol: "http:",
  pathname: "/help/support",
  search: "",
};

function disclaimer(
  props: Parameters<typeof ConversationDisclaimer>[0] = {},
  web = true,
) {
  return parseHTML(
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: web ? webHost : desktopHost },
        createElement(ConversationDisclaimer, props),
      ),
    ),
  ).document;
}

test("ordinary web disclaimer is one sentence with a real local public help destination", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: localLocation,
  });
  try {
    const document = disclaimer();
    const link = document.querySelector(".conversation-disclaimer > a")!;
    assert.equal(link.textContent, "Claudex is AI and can make mistakes.");
    assert.equal(
      link.getAttribute("href"),
      "http://127.0.0.1:5174/help/support",
    );
    assert.equal(link.getAttribute("target"), "_blank");
    assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    assert.deepEqual(parseWebRoute("/help/support"), {
      kind: "help",
      slug: "support",
    });
    const help = renderToStaticMarkup(createElement(HelpPage));
    assert.match(help, /Contact Claudex support/);
    assert.match(help, /service administrator/);
    assert.doesNotMatch(document.toString(), /Please double-check responses/);
  } finally {
    if (saved) Object.defineProperty(globalThis, "location", saved);
    else Reflect.deleteProperty(globalThis, "location");
  }
});

test("help overrides stay valid and desktop/research/short disclaimer variants retain their copy", () => {
  assert.equal(
    disclaimer({ help: "https://operator.example/help" })
      .querySelector("a")
      ?.getAttribute("href"),
    "https://operator.example/help",
  );
  for (const help of [
    "javascript:alert(1)",
    "file:///private/data",
    "not-a-url",
  ])
    assert.match(
      disclaimer({ help }).querySelector("a")!.getAttribute("href")!,
      /^(https?:.*)?\/help\/support$/,
    );
  assert.match(
    disclaimer({}, false).textContent ?? disclaimer({}, false).toString(),
    /Please double-check responses/,
  );
  assert.match(
    disclaimer({ second: "Please double-check cited sources." }).toString(),
    /Please double-check cited sources/,
  );
  assert.doesNotMatch(
    disclaimer({ short: true }, false).toString(),
    /Please double-check/,
  );
});

test("the conversation model line box changes only in the ordinary web wrapper", () => {
  const css = readFileSync(
    new URL("../../src/live-web/composer.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selector, body]) =>
      selector.includes(".app.web:not(.mobile-conversation)") &&
      selector.includes(".model-button") &&
      /line-height:\s*19px/.test(body),
  );
  assert.ok(rule);
  const document = parseHTML(
    '<html><body><div class="app web"><div class="conversation-composer composer-wrap"><div class="composer-chin"><button id="web" class="model-button"></button></div></div></div><div class="app web mobile-conversation"><div class="conversation-composer composer-wrap"><div class="composer-chin"><button id="native" class="model-button"></button></div></div></div><div class="app"><div class="conversation-composer composer-wrap"><div class="composer-chin"><button id="desktop" class="model-button"></button></div></div></div><div class="app web"><div class="conversation-composer composer-wrap code-composer"><div class="composer-chin"><button id="code" class="model-button"></button></div></div></div></body></html>',
  ).document;
  assert.deepEqual(
    [...document.querySelectorAll(rule[1].trim())].map((element) => element.id),
    ["web"],
  );
  assert.match(
    css,
    /\.composer-wrap:not\(\.code-composer\) \.composer-chin \.model-button\s*\{[^}]*line-height:\s*17px;/,
  );
});

const providers: Provider[] = [
  {
    id: "first",
    name: "Service one",
    baseUrl: "https://one.invalid",
    protocol: "openai-responses" as Provider["protocol"],
    model: "claude-opus-5-5",
    models: ["claude-sonnet-5-5", "gpt-provider", "claude-haiku-5-5"],
  },
  {
    id: "second",
    name: "Service two",
    baseUrl: "https://two.invalid",
    protocol: "openai-responses" as Provider["protocol"],
    model: "claude-opus-5-5",
    models: ["gemini-provider"],
  },
];
const entry = (id: string, sort: number, hidden = false): ModelCatalogItem => ({
  id,
  displayName: `${id} label`,
  description: `${id} description`,
  badges: [],
  sort,
  hidden,
  isDefault: false,
  usageHint: "",
  efforts: ["low", "high"],
  defaultEffort: "high",
});
const catalog: ModelCatalog = {
  defaultModel: "claude-opus-5-5",
  items: [
    entry("claude-opus-5-5", 0),
    entry("claude-sonnet-5-5", 1),
    entry("gpt-provider", 2),
    entry("claude-haiku-5-5", 3, true),
    entry("gemini-provider", 4),
  ],
};

function environment(value: ModelCatalog | null = catalog) {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  Object.assign(window, {
    innerWidth: 1440,
    innerHeight: 900,
    desktop: {
      modelCatalog: async () => value,
      onEvent: () => noop,
      mcpServers: async () => ({ servers: [] }),
      linearStatus: async () => ({ connected: false }),
    },
  });
  const globals = {
    window,
    document,
    location: localLocation,
    getComputedStyle: () => ({ overflow: "visible", overflowX: "visible" }),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) =>
      clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(
    Object.keys(globals).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  for (const [key, next] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: next,
    });
  const root = createRoot(document.querySelector("main")!);
  let focused: HTMLElement | undefined;
  const previousFocus = window.HTMLElement.prototype.focus;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused?.isConnected ? focused : document.body),
  });
  window.HTMLElement.prototype.focus = function () {
    focused = this;
  };
  return {
    window,
    document,
    root,
    click: (element: HTMLElement) =>
      act(async () => {
        element.dispatchEvent(
          new window.Event("click", { bubbles: true, cancelable: true }),
        );
      }),
    key: (element: HTMLElement, key: string) =>
      act(async () => {
        const event = new window.Event("keydown", {
          bubbles: true,
          cancelable: true,
        });
        Object.assign(event, { key });
        element.dispatchEvent(event);
      }),
    async restore() {
      await act(async () => root.unmount());
      window.HTMLElement.prototype.focus = previousFocus;
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function menuProps(extra: Partial<Parameters<typeof ModelMenu>[0]> = {}) {
  return {
    providers,
    providerId: "first",
    model: "claude-opus-5-5",
    effort: "high" as const,
    onSelect: noop,
    onEffort: noop,
    onManage: noop,
    onClose: noop,
    onThinking: noop,
    ...extra,
  };
}

test("the Activity illustration uses the exact captured HandShapes flipbook, not a replacement icon", () => {
  const raw = readFileSync(
    new URL("../../src/cowork/activity-hand-shapes.json", import.meta.url),
    "utf8",
  );
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    "0f62dab2b622da9d31f6739ff65c94e0ad14ba64d1e1dc748a846d731e8cb2a3",
  );
  const data = JSON.parse(raw) as {
    width: number;
    height: number;
    frameRate: number;
    frames: { highlight: string[]; line: string[] }[];
  };
  assert.deepEqual(
    [data.width, data.height, data.frameRate, data.frames.length],
    [1200, 1200, 12, 60],
  );
  const document = parseHTML(
    renderToStaticMarkup(createElement(ActivityIllustration)),
  ).document;
  const svg = document.querySelector("svg")!;
  assert.equal(svg.getAttribute("viewBox"), "0 0 1200 1200");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  assert.equal(svg.getAttribute("width"), "96");
  const strip = svg.querySelector(".session-activity-flipbook")!;
  assert.equal(strip.children.length, 60);
  assert.match(strip.getAttribute("style")!, /--session-activity-steps:60/);
  assert.match(strip.getAttribute("style")!, /--session-activity-span:-11800%/);
  assert.match(strip.getAttribute("style")!, /animation-duration:5s/);
  assert.match(strip.getAttribute("style")!, /animation-iteration-count:1/);
  assert.match(strip.getAttribute("style")!, /animation-fill-mode:forwards/);
  for (const index of [0, 1, 59]) {
    const frame = data.frames[index];
    const offset = index * 2 * data.width;
    const shifted = (path: string) =>
      path.replace(/M(-?\d+)/g, (_, x: string) => `M${Number(x) + offset}`);
    assert.deepEqual(
      [...strip.children[index].querySelectorAll("path")].map((path) =>
        path.getAttribute("d"),
      ),
      [...frame.highlight, ...frame.line].map(shifted),
    );
  }
  const css = readFileSync(
    new URL("../../src/cowork/activity-panel.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /scale:\s*1\.2/);
  assert.match(css, /transform-box:\s*view-box/);
  assert.match(css, /steps\(var\(--session-activity-steps\), jump-none\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(
    css,
    /:root\[data-motion="reduced"\] \.session-activity-flipbook\s*\{\s*animation:\s*none/,
  );
});

test("the empty web card's desktop geometry excludes the actual native wrapper", () => {
  const css = readFileSync(
    new URL("../../src/cowork/activity-panel.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const geometry = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selector, body]) =>
      selector.includes(".session-activity-panel") && /top:\s*44px/.test(body),
  );
  assert.ok(geometry);
  const document = parseHTML(
    '<html><body><div class="app web"><div class="workspace"><div class="chat-layout"><aside id="web" class="session-activity-panel"></aside></div></div></div><div class="app web mobile-conversation"><div class="workspace"><div class="chat-layout"><aside id="native" class="session-activity-panel"></aside></div></div></div><div class="app"><div class="workspace"><div class="chat-layout"><aside id="desktop" class="session-activity-panel"></aside></div></div></div></body></html>',
  ).document;
  assert.deepEqual(
    [...document.querySelectorAll(geometry[1].trim())].map(
      (element) => element.id,
    ),
    ["web"],
  );
  assert.match(css, /@media \(min-width:\s*640px\)/);
  assert.match(css, /--tool-panel-width:\s*min\(320px, calc\(100% - 16px\)\)/);
  assert.match(css, /bottom:\s*auto/);
  assert.match(css, /padding:\s*48px 12px/);
});

test("Activity reserves the measured body inset while its header stays still; old zero-body and 12px-header rules fail", () => {
  const css = readFileSync(
    new URL("../../src/cowork/activity-panel.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  type Rule = { selector: string; body: string; media: string[] };
  function rules(source: string, media: string[] = []): Rule[] {
    const result: Rule[] = [];
    let cursor = 0;
    while (cursor < source.length) {
      const opening = source.indexOf("{", cursor);
      if (opening < 0) break;
      const selector = source.slice(cursor, opening).trim();
      let end = opening + 1,
        depth = 1;
      for (; end < source.length && depth; end++) {
        if (source[end] === "{") depth++;
        if (source[end] === "}") depth--;
      }
      const body = source.slice(opening + 1, end - 1);
      if (selector.startsWith("@media"))
        result.push(...rules(body, [...media, selector]));
      else if (!selector.startsWith("@"))
        result.push({ selector, body, media });
      cursor = end;
    }
    return result;
  }
  const cases = [
    { id: "web", web: true, classes: "app web", kind: "empty" },
    { id: "closed", web: true, classes: "app web", kind: "closed" },
    { id: "progress", web: true, classes: "app web", kind: "progress" },
    // The real native conversation wrapper carries both app and web.
    {
      id: "native",
      web: true,
      classes: "app web mobile-conversation",
      kind: "empty",
    },
    { id: "desktop", web: false, classes: "app", kind: "empty" },
  ];
  const document = parseHTML(
    `<html><body>${cases
      .map(({ id, web, classes, kind }) =>
        renderToStaticMarkup(
          createElement(
            HostContext.Provider,
            { value: web ? webHost : desktopHost },
            createElement(
              "div",
              { className: classes },
              createElement(
                "div",
                { className: "workspace" },
                createElement(ConversationLayout, {
                  header: createElement("header", {
                    className: "chat-header",
                    id: `${id}-header`,
                  }),
                  main: createElement("main", {
                    className: "chat-main",
                    id: `${id}-body`,
                  }),
                  panels:
                    kind === "closed"
                      ? null
                      : createElement(ActivityPanel, {
                          conversation: conversation(
                            kind === "progress"
                              ? [
                                  {
                                    id: "tool",
                                    type: "commandExecution",
                                    command: "ls",
                                    status: "completed",
                                  },
                                ]
                              : [],
                          ),
                          onArtifact: noop,
                          onClose: noop,
                        }),
                }),
              ),
            ),
          ),
        ),
      )
      .join("")}</body></html>`,
  ).document;
  function contract(source: string) {
    const parsed = rules(source).filter((rule) =>
      rule.selector.includes(".session-activity-panel"),
    );
    const declarations = (id: string, property: string, viewport = 1440) =>
      parsed
        .filter(
          (rule) =>
            rule.media.every((media) => {
              const min = media.match(/min-width:\s*([\d.]+)px/);
              return !min || viewport >= Number(min[1]);
            }) &&
            [...document.querySelectorAll(rule.selector)].some(
              (node) => node.id === id,
            ),
        )
        .flatMap((rule) =>
          [
            ...rule.body.matchAll(
              new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+)`, "g"),
            ),
          ].map((match) => match[1].trim()),
        );
    const body = declarations("web-body", "margin-right");
    assert.deepEqual(
      body,
      ["calc(var(--tool-panel-width) + 16px)"],
      "open Activity body needs the measured 320+16 inset",
    );
    assert.deepEqual(
      declarations("web-header", "margin-right"),
      ["0"],
      "header must not follow the body inset",
    );
    assert.deepEqual(
      declarations("web-header", "padding-right"),
      ["17px"],
      "header keeps its settled closed baseline instead of legacy open 12px",
    );
    const extra = Number(body[0].match(/\+\s*(\d+)px/)![1]);
    assert.equal(
      (320 + extra) / 2,
      168,
      "the fixed-width centered feed shifts 168px at the captured viewport",
    );
    for (const id of ["closed", "progress", "native", "desktop"])
      for (const part of ["body", "header"])
        assert.deepEqual(
          declarations(`${id}-${part}`, "margin-right"),
          [],
          `${id} keeps its existing layout`,
        );
    for (const part of ["body", "header"])
      for (const property of ["margin-right", "padding-right"])
        assert.deepEqual(
          declarations(`web-${part}`, property, 390),
          [],
          "phone keeps the existing sheet rules",
        );
  }
  contract(css);
  assert.throws(
    () =>
      contract(
        css.replace(
          "margin-right: calc(var(--tool-panel-width) + 16px)",
          "margin-right: 0",
        ),
      ),
    /body needs/,
  );
  assert.throws(
    () => contract(css.replace("padding-right: 17px", "padding-right: 12px")),
    /header keeps/,
  );
});

test("the real side-panel route renders empty Chat and Cowork activity on both hosts while preserving Code", async () => {
  const env = environment();
  try {
    for (const web of [true, false]) {
      for (const mode of ["chat", "cowork", "code"] as const) {
        await act(async () => {
          env.root.render(
            createElement(
              HostContext.Provider,
              { value: web ? webHost : desktopHost },
              createElement(ToolSidePanel, {
                panel: "progress",
                conversation: { ...conversation(), mode },
                accountId: "fixture",
                onClose: noop,
                onArtifact: noop,
                onStopAgent: async () => {},
                onRefreshWorkflow: async () => {},
                onStopTerminal: async () => true,
                onStopCommand: async () => {},
                onClearFinished: async () => {},
                onReadAgent: async (): Promise<AgentTranscript> => ({
                  model: "",
                  context: "",
                  status: "completed",
                  items: [],
                  toolUses: 0,
                }),
                onShowBackground: noop,
                dismissedFinished: [],
                engineReady: true,
                onError: noop,
              }),
            ),
          );
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.equal(
          Boolean(env.document.querySelector(".session-activity-panel")),
          mode !== "code",
          `${web ? "web" : "native"}/${mode}`,
        );
        assert.equal(
          Boolean(env.document.querySelector(".progress-panel")),
          false,
          `${web ? "web" : "native"}/${mode}`,
        );
      }
    }
  } finally {
    await env.restore();
  }
});

test("new drafts retain quick choices and maker switching instead of applying the existing-session projection", async () => {
  const env = environment();
  try {
    await act(async () =>
      env.root.render(createElement(ModelMenu, menuProps())),
    );
    assert.ok(env.document.querySelector(".model-vendor-switch"));
    assert.ok(
      env.document.querySelectorAll(
        '.model-menu > button[role="menuitemradio"]',
      ).length > 1,
    );
    assert.match(env.document.body.textContent!, /Extended thinking/);
  } finally {
    await env.restore();
  }
});

test("web local-help clicks stay native and valid configured help retains the existing opening callback", async () => {
  const env = environment();
  const opened: string[] = [];
  try {
    const render = (help?: string, web = true) =>
      act(async () =>
        env.root.render(
          createElement(
            OpenLink.Provider,
            {
              value: (url) => {
                opened.push(url);
              },
            },
            createElement(
              HostContext.Provider,
              { value: web ? webHost : desktopHost },
              createElement(ConversationDisclaimer, { help }),
            ),
          ),
        ),
      );
    await render();
    await env.click(env.document.querySelector<HTMLElement>("a")!);
    assert.equal(opened.length, 0);
    await render("https://operator.example/help");
    await env.click(env.document.querySelector<HTMLElement>("a")!);
    assert.deepEqual(opened, ["https://operator.example/help"]);
    await render(undefined, false);
    await env.click(env.document.querySelector<HTMLElement>("a")!);
    assert.ok(opened.at(-1)?.endsWith("/help/support"));
  } finally {
    await env.restore();
  }
});

test("a genuinely empty session on either host replaces the legacy Progress card", () => {
  const value = conversation([
    { id: "thinking", type: "reasoning", text: "Thinking" },
    { id: "reply", type: "agentMessage", text: "Hello." },
  ]);
  assert.equal(
    hasSessionActivity(value),
    false,
    "runner cwd is not itself tool activity",
  );
  const render = (web: boolean) =>
    parseHTML(
      renderToStaticMarkup(
        createElement(
          HostContext.Provider,
          { value: web ? webHost : desktopHost },
          createElement(ActivityPanel, {
            conversation: value,
            onArtifact: noop,
            onClose: noop,
          }),
        ),
      ),
    ).document;
  const empty = render(true);
  assert.ok(
    empty.querySelector(
      'aside[aria-label="Session activity panel"].session-activity-panel',
    ),
  );
  assert.equal(empty.querySelector("h3")?.textContent, "Nothing here yet");
  assert.equal(
    empty.querySelector("p")?.textContent,
    "Files Claudex makes and tools it uses will show up here.",
  );
  assert.ok(empty.querySelector('button[aria-label="Close activity panel"]'));
  assert.doesNotMatch(
    empty.toString(),
    /Requires your computer|Computer access is off|progress-section/,
  );
  assert.ok(render(false).querySelector(".session-activity-panel"));
  assert.equal(render(false).querySelector(".progress-panel"), null);
});

test("unified Chat on both hosts adds Activity while Code keeps its existing header controls", () => {
  for (const web of [true, false]) {
    for (const mode of ["chat", "cowork", "code"] as const) {
      const document = parseHTML(
        renderToStaticMarkup(
          createElement(
            HostContext.Provider,
            { value: web ? webHost : desktopHost },
            createElement(ConversationPanelButtons, {
              conversation: { ...conversation(), mode },
              mode,
              panel: null,
              onTogglePanel: noop,
            }),
          ),
        ),
      ).document;
      const activity = document.querySelector('[aria-label="Activity panel"]');
      assert.equal(Boolean(activity), mode !== "code");
      if (activity) {
        assert.ok(activity.classList.contains("session-activity-toggle"));
        assert.equal(
          Boolean(activity.querySelector('[data-icon="File"]')),
          web || mode === "chat",
        );
      }
      if (mode === "code") {
        // The web's cloud sessions have no terminal.
        assert.equal(
          Boolean(document.querySelector('[aria-label="Terminal"]')),
          !web,
        );
        assert.ok(document.querySelector('[aria-label="Changes"]'));
      }
    }
  }
  const css = readFileSync(
    new URL("../../src/conversation/conversation-header.css", import.meta.url),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const geometry = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selector]) => selector.includes(".session-activity-toggle"),
  );
  assert.ok(geometry);
  assert.ok(geometry[1].includes(".app.web:not(.mobile-conversation)"));
  assert.match(geometry[2], /width:\s*28px/);
  assert.match(geometry[2], /height:\s*28px/);
  assert.match(geometry[2], /border-radius:\s*7px/);
});

test("real tools, attachments, files and fenced artifacts keep their existing activity functionality", () => {
  const file = {
    id: "f",
    name: "Result",
    path: "/workspace/result.txt",
    language: "text",
    operation: "create" as const,
    state: "ready" as const,
    content: "Done",
  };
  for (const item of [
    {
      id: "command",
      type: "commandExecution",
      command: "ls",
      status: "completed",
    },
    { id: "file", type: "agentMessage", generatedFiles: [file] },
    {
      id: "artifact",
      type: "agentMessage",
      text: "```html\n<p>Generated</p>\n```",
    },
  ] satisfies Item[])
    assert.equal(hasSessionActivity(conversation([item])), true, item.id);
  const attachment = conversation();
  attachment.turns[0].attachments = [
    { id: "a", name: "Input", path: "/input.txt", kind: "text", size: 4 },
  ];
  assert.equal(hasSessionActivity(attachment), true);
  const html = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(ActivityPanel, {
        conversation: conversation([
          {
            id: "command",
            type: "commandExecution",
            command: "ls",
            status: "completed",
          },
        ]),
        onArtifact: noop,
        onClose: noop,
      }),
    ),
  );
  assert.match(html, /progress-panel/);
  assert.doesNotMatch(html, /session-activity-empty/);
});

test("empty panel Close and the ordinary Chat Activity toggle call their real handlers", async () => {
  const env = environment();
  let closed = 0;
  const panels: string[] = [];
  try {
    await act(async () =>
      env.root.render(
        createElement(
          HostContext.Provider,
          { value: webHost },
          createElement(
            "div",
            null,
            createElement(ConversationPanelButtons, {
              conversation: { ...conversation(), mode: "chat" },
              mode: "chat",
              panel: null,
              onTogglePanel: (panel) => {
                panels.push(panel);
              },
            }),
            createElement(ActivityPanel, {
              conversation: conversation(),
              onArtifact: noop,
              onClose: () => {
                closed++;
              },
            }),
          ),
        ),
      ),
    );
    const toggle = env.document.querySelector<HTMLElement>(
      'button[aria-label="Activity panel"]',
    )!;
    assert.ok(toggle.querySelector('[data-icon="File"]'));
    await env.click(toggle);
    await env.click(
      env.document.querySelector<HTMLElement>(
        'button[aria-label="Close activity panel"]',
      )!,
    );
    assert.deepEqual(panels, ["progress"]);
    assert.equal(closed, 1);
  } finally {
    await env.restore();
  }
});
