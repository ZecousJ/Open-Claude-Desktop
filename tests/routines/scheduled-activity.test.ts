import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import postcss from "postcss";
import type { Conversation } from "../../shared/types";
import { desktopHost, webHost, type HostInfo } from "../../shared/host";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { ConversationPanelButtons } from "../../src/conversation/ConversationPanelButtons";
import {
  ToolSidePanel,
  type SidePanel,
} from "../../src/conversation/ToolSidePanel";
import { ActivityPanel } from "../../src/cowork/ActivityPanel";
import { HostContext } from "../../src/host/HostContext";
import { atomicChatDom } from "../support/atomic-chat-dom";

const noop = () => {};
const snapshot = fixtureSnapshot({ states: true });
function ordinary(id = "scheduled-activity"): Conversation {
  return {
    ...structuredClone(snapshot.conversations[0]),
    id,
    mode: "chat",
    cwd: "/workspace",
    turns: [
      {
        id: `${id}-turn`,
        prompt: "A neutral activity reference",
        createdAt: 1,
        status: "completed",
        attachments: [],
        items: [{ id: `${id}-reply`, type: "agentMessage", text: "Hello." }],
      },
    ],
  };
}

const toolProps = {
  accountId: "scheduled-b19",
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

async function mount(
  host: HostInfo = webHost,
  initial: SidePanel | null = null,
) {
  const env = await atomicChatDom({
    mcpServers: async () => ({ servers: [] }),
    linearStatus: async () => ({ connected: false }),
  } as never);
  let setPanel: (panel: SidePanel | null) => void = noop;
  let setConversation: (conversation: Conversation) => void = noop;
  const conversation = ordinary();
  const original = structuredClone(conversation);
  function Route() {
    const [panel, updatePanel] = useState(initial);
    const [active, updateConversation] = useState(conversation);
    setPanel = updatePanel;
    setConversation = updateConversation;
    const mode = active.mode === "code" ? "code" : "chat";
    return createElement(
      HostContext.Provider,
      { value: host },
      createElement(
        "div",
        {
          className: `app ${host.kind === "web" ? "web" : "host-desktop"} mode-${mode}`,
        },
        createElement(
          "div",
          { className: "workspace" },
          createElement(
            "header",
            { className: "chat-header header-actions" },
            createElement(ConversationPanelButtons, {
              conversation: active,
              mode,
              panel,
              onTogglePanel: (next) =>
                updatePanel((current) => (current === next ? null : next)),
            }),
          ),
          createElement(
            "div",
            { className: "chat-layout" },
            createElement(
              "main",
              { className: "chat-main" },
              createElement("button", { id: "composer-target" }, "Composer"),
            ),
            panel === "progress" &&
              createElement(ToolSidePanel, {
                ...toolProps,
                panel,
                conversation: active,
                onArtifact: noop,
                onClose: () => updatePanel(null),
              }),
            panel === "artifact" &&
              createElement(
                "aside",
                { className: "artifact-panel" },
                createElement("button", { id: "viewer-target" }, "Close file"),
              ),
          ),
        ),
      ),
    );
  }
  await env.render(createElement(Route));
  const query = <T extends Element = HTMLElement>(selector: string) => {
    const node = env.document.querySelector<T>(selector);
    assert.ok(node, selector);
    return node;
  };
  const click = async (selector: string) =>
    act(async () => {
      query(selector).dispatchEvent(
        new env.window.MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  const waitPanel = async () => {
    for (
      let attempt = 0;
      attempt < 30 && !env.document.querySelector(".session-activity-panel");
      attempt++
    )
      await env.settle();
    return query(".session-activity-panel");
  };
  return {
    ...env,
    query,
    click,
    waitPanel,
    conversation,
    original,
    toggle: () => query<HTMLButtonElement>('[aria-label="Activity panel"]'),
    status: () => query('[role="status"][aria-live="polite"]').textContent,
    setPanel: (next: SidePanel | null) => act(async () => setPanel(next)),
    setConversation: (next: Conversation) =>
      act(async () => setConversation(next)),
  };
}

test("Scheduled40: real web/native lazy Activity toggles announce committed state and retain pressed/expanded parity", async () => {
  for (const host of [webHost, desktopHost]) {
    const env = await mount(host);
    try {
      assert.equal(env.status(), "", "do not announce initial closed state");
      assert.equal(env.toggle().getAttribute("aria-pressed"), "false");
      assert.equal(env.toggle().getAttribute("aria-expanded"), "false");
      await env.click('[aria-label="Activity panel"]');
      await env.waitPanel();
      assert.equal(env.status(), "Activity panel shown");
      assert.equal(env.toggle().getAttribute("aria-pressed"), "true");
      assert.equal(env.toggle().getAttribute("aria-expanded"), "true");
      await env.click('[aria-label="Close activity panel"]');
      assert.equal(env.status(), "Activity panel hidden");
      assert.equal(env.toggle().getAttribute("aria-expanded"), "false");
      assert.equal(env.document.querySelector(".session-activity-panel"), null);
      assert.deepEqual(env.conversation, env.original);
    } finally {
      await env.clean();
    }
  }
});

test("Scheduled40: closing a focused card returns its lost focus to the same session toggle", async () => {
  const env = await mount();
  try {
    await env.click('[aria-label="Activity panel"]');
    await env.waitPanel();
    env
      .query(".session-activity-panel")
      .setAttribute("aria-label", "会话活动面板");
    const close = env.query<HTMLButtonElement>(
      '[aria-label="Close activity panel"]',
    );
    await act(async () => close.focus());
    assert.equal(env.document.activeElement, close);
    await env.click('[aria-label="Close activity panel"]');
    assert.equal(env.document.activeElement, env.toggle());
  } finally {
    await env.clean();
  }
});

test("Scheduled40: initial open and cross-session navigation are quiet, and another focused control is not stolen", async () => {
  const env = await mount(webHost, "progress");
  try {
    await env.waitPanel();
    assert.equal(env.status(), "");
    await act(async () =>
      env
        .query<HTMLButtonElement>('[aria-label="Close activity panel"]')
        .focus(),
    );
    await env.setConversation(ordinary("other-session"));
    await env.setPanel(null);
    // Closing B is a real B transition; A's panel does not reclaim focus.
    assert.equal(env.document.activeElement, env.document.body);
    await env.setPanel("progress");
    await env.waitPanel();
    const outside = env.query<HTMLButtonElement>("#composer-target");
    await act(async () => outside.focus());
    await env.setPanel(null);
    assert.equal(env.document.activeElement, outside);
  } finally {
    await env.clean();
  }
});

test("Scheduled40: replacing Activity with a viewer does not focus the Activity toggle or announce navigation as opening", async () => {
  const env = await mount(webHost, "progress");
  try {
    await env.waitPanel();
    await act(async () =>
      env
        .query<HTMLButtonElement>('[aria-label="Close activity panel"]')
        .focus(),
    );
    await env.setPanel("artifact");
    assert.equal(env.status(), "Activity panel hidden");
    assert.notEqual(env.document.activeElement, env.toggle());
    await act(async () =>
      env.query<HTMLButtonElement>("#viewer-target").focus(),
    );
    await env.setConversation(ordinary("another-session"));
    assert.equal(
      env.status(),
      "",
      "new session never replays another session's announcement",
    );
    assert.equal(env.document.activeElement, env.query("#viewer-target"));
  } finally {
    await env.clean();
  }
});

test("Scheduled54: existing empty composition is honest for Chat/stored Cowork and keeps real rich Progress/Code branches", () => {
  for (const host of [webHost, desktopHost]) {
    for (const mode of ["chat", "cowork"] as const) {
      const value = { ...ordinary(), mode };
      const document = parseHTML(
        renderToStaticMarkup(
          createElement(
            HostContext.Provider,
            { value: host },
            createElement(ActivityPanel, {
              conversation: value,
              onClose: noop,
              onArtifact: noop,
            }),
          ),
        ),
      ).document;
      const panel = document.querySelector(
        'aside[aria-label="Session activity panel"]',
      )!;
      assert.equal(panel.querySelector("h3")?.textContent, "Nothing here yet");
      assert.equal(
        panel.querySelector("p")?.textContent,
        "Files Claudex makes and tools it uses will show up here.",
      );
      assert.equal(panel.querySelector(".progress-section"), null);
      assert.equal(panel.querySelector(".cowork-computer-state"), null);
      assert.ok(panel.querySelector(".session-activity-illustration"));
      assert.equal(
        value.mode,
        mode,
        "presentation does not change stored execution kind",
      );
    }
  }
  const rich = snapshot.conversations.find(
    (value) => value.id === "c-activity",
  )!;
  assert.ok(rich);
  const richHtml = renderToStaticMarkup(
    createElement(ActivityPanel, {
      conversation: rich,
      onClose: noop,
      onArtifact: noop,
    }),
  );
  assert.match(richHtml, /work-panel progress-panel/);
  assert.match(richHtml, /Progress/);
  assert.doesNotMatch(richHtml, /session-activity-empty/);
  const code = renderToStaticMarkup(
    createElement(ConversationPanelButtons, {
      conversation: { ...ordinary(), mode: "code" },
      mode: "code",
      panel: null,
      onTogglePanel: noop,
    }),
  );
  assert.doesNotMatch(code, /Activity panel|aria-live/);
});

test("Scheduled55: actual empty DOM matches the 320px/y44 shell and scoped light tokens, not legacy Progress rules", () => {
  const empty = renderToStaticMarkup(
    createElement(ActivityPanel, {
      conversation: ordinary(),
      onClose: noop,
      onArtifact: noop,
    }),
  );
  const document = parseHTML(`<html data-theme="dark"><body>
    <div class="app web"><div class="workspace"><header class="chat-header"></header><div class="chat-layout"><main class="chat-main"></main>${empty}</div></div></div>
    <div class="app web mobile-conversation"><div class="workspace"><div class="chat-layout">${empty}</div></div></div>
  </body></html>`).document;
  const panel = document.querySelector(
    ".app.web:not(.mobile-conversation) .session-activity-panel",
  )!;
  const styles = [
    "src/styles/40-panels.css",
    "src/styles/92-reference-panels.css",
    "src/cowork/progress-panel.css",
    "src/cowork/activity-panel.css",
  ].map((file) =>
    postcss.parse(
      readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"),
    ),
  );
  const declarations = (
    element: Element,
    property: string,
    viewport = 1440,
  ) => {
    const values: string[] = [];
    for (const style of styles)
      style.walkRules((rule) => {
        if (
          !rule.nodes.some(
            (node) => node.type === "decl" && node.prop === property,
          )
        )
          return;
        let parent: postcss.AnyNode | undefined = rule.parent;
        while (parent) {
          if (parent.type === "atrule" && parent.name === "media") {
            const min = parent.params.match(/min-width:\s*(\d+)px/);
            if (min && viewport < Number(min[1])) return;
          }
          parent = parent.parent;
        }
        if (
          !rule.selectors.some(
            (selector) =>
              !selector.includes("::") &&
              !selector.includes(":focus-within") &&
              element.matches(selector),
          )
        )
          return;
        rule.walkDecls(property, (declaration) => {
          values.push(declaration.value);
        });
      });
    return values;
  };
  assert.equal(
    declarations(panel.closest(".workspace")!, "--tool-panel-width").at(-1),
    "min(320px, calc(100% - 16px))",
  );
  assert.equal(declarations(panel, "top").at(-1), "44px");
  assert.equal(declarations(panel, "right").at(-1), "8px");
  assert.equal(declarations(panel, "background").at(-1), "#1a1a19");
  assert.equal(declarations(panel, "border-radius").at(-1), "12px");
  assert.equal(declarations(panel, "background").includes("#262626"), false);
  document.documentElement.dataset.theme = "light";
  assert.equal(declarations(panel, "background").at(-1), "var(--surface)");
  assert.equal(declarations(panel, "border-color").at(-1), "var(--border)");
  assert.equal(declarations(panel, "color").at(-1), "var(--text-secondary)");
  // No claim about an uncaptured light opened card's literal computed fill.
  const embedded = document.querySelector(
    ".mobile-conversation .session-activity-panel",
  )!;
  assert.notEqual(declarations(embedded, "top").at(-1), "44px");
});
