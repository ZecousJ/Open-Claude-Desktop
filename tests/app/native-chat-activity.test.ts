import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import ts from "typescript";
import type { Conversation } from "../../shared/types";
import { desktopHost, webHost } from "../../shared/host";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { ConversationPanelButtons } from "../../src/conversation/ConversationPanelButtons";
import {
  ToolSidePanel,
  type SidePanel,
} from "../../src/conversation/ToolSidePanel";
import { ActivityPanel } from "../../src/cowork/ActivityPanel";
import { HostContext } from "../../src/host/HostContext";
import type { Artifact } from "../../src/ui/ArtifactTypes";

const noop = () => {};
const fixtures = fixtureSnapshot({ states: true });
function fixture(id: string) {
  const conversation = fixtures.conversations.find((value) => value.id === id);
  assert.ok(conversation);
  return structuredClone(conversation);
}
function ordinaryChat() {
  const value = fixture("c-run-cowork");
  value.mode = "chat";
  value.turns[0].items = value.turns[0].items.filter(
    (item) => item.type === "agentMessage",
  );
  return value;
}
const panelProps = {
  accountId: "fixture",
  onStopAgent: async () => {},
  onRefreshWorkflow: async () => {},
  onStopTerminal: async () => true,
  onStopCommand: async () => {},
  onClearFinished: async () => {},
  onReadAgent: async () => ({
    model: "m",
    context: "",
    status: "completed" as const,
    items: [],
    toolUses: 0,
  }),
  onShowBackground: noop,
  dismissedFinished: [],
  engineReady: true,
  onError(error: unknown) {
    throw error;
  },
};

function NativePanelRoute({
  conversation,
  initialPanel = null,
  onArtifact,
}: {
  conversation: Conversation;
  initialPanel?: SidePanel | null;
  onArtifact: (artifact: Artifact) => void;
}) {
  const [panel, setPanel] = useState<SidePanel | null>(initialPanel);
  const mode = conversation.mode === "code" ? "code" : "chat";
  return createElement(
    HostContext.Provider,
    { value: desktopHost },
    createElement(
      "div",
      { className: `app host-desktop mode-${mode}` },
      createElement(
        "div",
        { className: "workspace" },
        createElement(
          "header",
          { className: "chat-header header-actions" },
          createElement(ConversationPanelButtons, {
            conversation,
            mode,
            panel,
            onTogglePanel: (next) =>
              setPanel((current) => (current === next ? null : next)),
          }),
        ),
        createElement(
          "div",
          { className: "chat-layout" },
          createElement("main", { className: "chat-main" }),
          panel &&
            createElement(ToolSidePanel, {
              ...panelProps,
              panel,
              conversation,
              onClose: () => setPanel(null),
              onArtifact,
            }),
        ),
      ),
    ),
  );
}

async function mountRoute(
  conversation: Conversation,
  initialPanel?: SidePanel,
) {
  const { window, document } = parseHTML(
    '<html data-motion="reduced"><body><main></main></body></html>',
  );
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100,
    y: 100,
    top: 100,
    left: 100,
    right: 128,
    bottom: 128,
    width: 28,
    height: 28,
    toJSON: () => ({}),
  });
  window.desktop = {
    onEvent: () => noop,
    mcpServers: async () => ({ servers: [] }),
    linearStatus: async () => ({ connected: false }),
  } as never;
  const globals = {
    window,
    document,
    innerWidth: 1280,
    innerHeight: 720,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
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
  const opened: Artifact[] = [];
  await act(async () => {
    root.render(
      createElement(NativePanelRoute, {
        conversation,
        initialPanel,
        onArtifact: (artifact) => opened.push(artifact),
      }),
    );
  });
  return {
    document,
    opened,
    async click(selector: string) {
      const node = document.querySelector(selector);
      assert.ok(node, selector);
      await act(async () => {
        node.dispatchEvent(
          new window.Event("click", { bubbles: true, cancelable: true }),
        );
      });
    },
    async waitFor(selector: string) {
      for (
        let index = 0;
        index < 40 && !document.querySelector(selector);
        index++
      )
        await act(async () => {
          await new Promise((resolve) => setImmediate(resolve));
        });
      assert.ok(document.querySelector(selector), selector);
    },
    async dispose() {
      await act(async () => {
        root.unmount();
      });
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("native ordinary Chat toggles the real lazy activity route, reports pressed state, and closes from the card", async () => {
  const conversation = ordinaryChat();
  const original = structuredClone(conversation);
  const env = await mountRoute(conversation);
  try {
    const button = () =>
      env.document.querySelector('button[aria-label="Activity panel"]')!;
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.ok(button().querySelector('[data-icon="File"]'));
    assert.match(
      button().querySelector('[data-icon="File"]')!.getAttribute("width") ?? "",
      /^18$/,
    );
    assert.equal(env.document.querySelector(".session-activity-panel"), null);
    await env.click('button[aria-label="Activity panel"]');
    await env.waitFor(".session-activity-panel");
    assert.equal(button().getAttribute("aria-pressed"), "true");
    assert.equal(
      env.document.querySelector(".session-activity-panel h3")?.textContent,
      "Nothing here yet",
    );
    assert.equal(
      env.document.querySelector(".session-activity-panel p")?.textContent,
      "Files Claudex makes and tools it uses will show up here.",
    );
    assert.equal(env.document.querySelector(".progress-panel"), null);
    assert.ok(
      env.document.querySelector(".session-activity-illustration"),
      "retain the official 96px illustration seat",
    );
    await env.click('button[aria-label="Close activity panel"]');
    assert.equal(button().getAttribute("aria-pressed"), "false");
    assert.equal(env.document.querySelector(".session-activity-panel"), null);
    await env.click('button[aria-label="Activity panel"]');
    await env.waitFor(".session-activity-panel");
    await env.click('button[aria-label="Activity panel"]');
    assert.equal(env.document.querySelector(".session-activity-panel"), null);
    assert.deepEqual(conversation, original);
  } finally {
    await env.dispose();
  }
});

test("native empty stored Cowork uses the unified honest empty card without changing its execution kind", async () => {
  const conversation = ordinaryChat();
  conversation.mode = "cowork";
  const env = await mountRoute(conversation);
  try {
    await env.click('button[aria-label="Activity panel"]');
    await env.waitFor(".session-activity-panel");
    assert.equal(conversation.mode, "cowork");
    assert.equal(env.document.querySelector(".progress-panel"), null);
    assert.doesNotMatch(
      env.document.querySelector(".session-activity-panel")!.textContent ?? "",
      /Requires your computer|Computer access is off/,
    );
  } finally {
    await env.dispose();
  }
});

test("rich Cowork retains real Progress steps, generated outputs, and the artifact callback", async () => {
  const conversation = fixture("c-activity");
  const original = structuredClone(conversation);
  const env = await mountRoute(conversation);
  try {
    await env.click('button[aria-label="Activity panel"]');
    await env.waitFor(".progress-panel");
    assert.equal(env.document.querySelector(".session-activity-empty"), null);
    await env.click(".progress-section-heading");
    assert.equal(
      env.document.querySelectorAll('[aria-label="Task steps"] > li').length,
      4,
    );
    const heading = [
      ...env.document.querySelectorAll<HTMLButtonElement>(
        ".progress-section-heading",
      ),
    ].find((node) =>
      node.textContent?.includes(conversation.cwd!.split("/").at(-1)!),
    );
    assert.ok(heading);
    heading.id = "native-activity-output-heading";
    await env.click("#native-activity-output-heading");
    assert.match(
      env.document.querySelector(".progress-list")?.textContent ?? "",
      /R 0928 synthetic output/,
    );
    await env.click(".progress-resource-row > button");
    assert.equal(env.opened.length, 1);
    assert.equal(env.opened[0].conversationId, conversation.id);
    assert.equal(env.opened[0].filename, "R-0928-synthetic-output.txt");
    assert.deepEqual(conversation, original);
  } finally {
    await env.dispose();
  }
});

test("Code does not acquire an Activity button or a progress route", async () => {
  const env = await mountRoute(fixture("c-run-code"), "progress");
  try {
    assert.equal(
      env.document.querySelector('button[aria-label="Activity panel"]'),
      null,
    );
    assert.ok(env.document.querySelector('button[aria-label="Terminal"]'));
    assert.ok(env.document.querySelector('button[aria-label="Changes"]'));
    assert.equal(
      env.document.querySelector('[aria-label="Session activity panel"]'),
      null,
    );
  } finally {
    await env.dispose();
  }
});

test("web retains the verified illustration and independent legacy Cowork retains its glyph", () => {
  const html = renderToStaticMarkup(
    createElement(
      HostContext.Provider,
      { value: webHost },
      createElement(ActivityPanel, {
        conversation: ordinaryChat(),
        onClose: noop,
        onArtifact: noop,
      }),
    ),
  );
  assert.match(html, /session-activity-pictogram/);
  assert.match(html, /session-activity-flipbook/);
  const legacy = parseHTML(
    renderToStaticMarkup(
      createElement(
        HostContext.Provider,
        { value: desktopHost },
        createElement(ConversationPanelButtons, {
          conversation: fixture("c-run-cowork"),
          mode: "cowork",
          panel: null,
          onTogglePanel: noop,
        }),
      ),
    ),
  ).document;
  assert.ok(legacy.querySelector('[aria-label="Activity panel"]'));
  assert.equal(legacy.querySelector('[data-icon="File"]'), null);
});

test("native geometry and startup import match the main desktop wrapper without affecting web, Code or embedded views", () => {
  const css = postcss.parse(
    readFileSync(
      new URL("../../src/cowork/native-chat-activity.css", import.meta.url),
      "utf8",
    ),
  );
  const document = parseHTML(
    "<html><body>" +
      [
        ["native", "app host-desktop mode-chat"],
        ["web", "app web mode-chat"],
        ["code", "app host-desktop mode-code"],
        ["embedded", "app web mobile-conversation mode-chat"],
        ["mini", "mini-session mode-cowork"],
      ]
        .map(
          ([id, classes]) =>
            `<div class="${classes}"><div class="workspace"><header class="chat-header header-actions"><button class="icon-button session-activity-toggle"></button></header><div class="chat-layout"><main class="chat-main"></main><aside id="${id}" class="work-panel session-activity-panel"></aside></div></div></div>`,
        )
        .join("") +
      "</body></html>",
  ).document;
  let position = false;
  css.walkRules((rule) => {
    if (rule.selector.includes(":root")) return;
    const declarations = new Map<string, string>();
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
    if (declarations.get("top") === "44px") {
      position = true;
      assert.deepEqual(
        [...document.querySelectorAll(rule.selector)].map((node) => node.id),
        ["native"],
      );
      assert.equal(declarations.get("bottom"), "auto");
    }
    for (const node of document.querySelectorAll(rule.selector))
      assert.equal(
        node.closest(".app")?.classList.contains("host-desktop"),
        true,
      );
  });
  assert.ok(position);
  const main = readFileSync(
    new URL("../../src/main.tsx", import.meta.url),
    "utf8",
  );
  const ast = ts.createSourceFile(
    "main.tsx",
    main,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  let desktopImport = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isIfStatement(node) &&
      node.expression.getText(ast) === 'surface !== "web"'
    ) {
      const imports: string[] = [];
      const collect = (child: ts.Node) => {
        if (
          ts.isCallExpression(child) &&
          child.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteral(child.arguments[0])
        )
          imports.push(child.arguments[0].text);
        ts.forEachChild(child, collect);
      };
      collect(node.thenStatement);
      desktopImport ||= imports.includes("./cowork/native-chat-activity.css");
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(desktopImport, true);
});
