import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { act, createElement, createRef, type ComponentType } from "react";
import { parseHTML } from "linkedom";
import { defaultSettings } from "../../electron/store/store";
import type { Conversation } from "../../shared/types";
import { webHost } from "../../shared/host";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { HostContext } from "../../src/host/HostContext";

const sourceUrl = new URL("../../src/app/TranscriptHost.tsx", import.meta.url);
const read = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

async function deferredTranscriptHost(removePlaceholder: boolean) {
  const key = `__claudexReplyStartup${removePlaceholder ? "Negative" : "Actual"}`;
  let release!: () => void, loaded!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: { wait, loaded },
  });
  const actual = new URL(
    "../../src/transcript/ConversationTranscript.tsx",
    import.meta.url,
  ).href;
  const delayed =
    "data:text/javascript," +
    encodeURIComponent(
      [
        `import { ConversationTranscript } from ${JSON.stringify(actual)};`,
        `await globalThis[${JSON.stringify(key)}].wait;`,
        `globalThis[${JSON.stringify(key)}].loaded();`,
        "export { ConversationTranscript };",
      ].join("\n"),
    );
  let code = readFileSync(sourceUrl, "utf8");
  const placeholder =
    /fallback=\{\s*<div\s+className="messages-scroll"\s+aria-hidden="true"\s*\/?>\s*\}/g;
  assert.equal(
    [...code.matchAll(placeholder)].length,
    1,
    "locate the actual transcript fallback",
  );
  if (removePlaceholder) code = code.replace(placeholder, "fallback={null}");
  assert.ok(code.includes('import("../transcript/ConversationTranscript")'));
  code = code.replace(
    'import("../transcript/ConversationTranscript")',
    `import(${JSON.stringify(delayed)})`,
  );
  // Transpile this actual source in memory. Only its lazy import is held
  // back; the negative control additionally removes precisely the new slot.
  // There is no bundle, file output, probe transcript, or replacement host.
  const output = ts
    .transpileModule(code, {
      fileName: "TranscriptHost.tsx",
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    })
    .outputText.replace(
      /((?:from\s*|import\s*\(\s*|import\s*)["'])([^"']+)(["'])/g,
      (_, start: string, specifier: string, end: string) => {
        const resolved = specifier.startsWith(".")
          ? new URL(specifier, sourceUrl).href
          : /^[a-z]+:/i.test(specifier)
            ? specifier
            : import.meta.resolve(specifier);
        return start + resolved + end;
      },
    );
  const module = (await import(
    "data:text/javascript," + encodeURIComponent(output)
  )) as {
    TranscriptHost: ComponentType<{ active: Conversation }>;
  };
  return {
    Host: module.TranscriptHost,
    async finish() {
      release();
      await ready;
      await new Promise((resolve) => setImmediate(resolve));
    },
    cleanup() {
      release();
      Reflect.deleteProperty(globalThis, key);
    },
  };
}

test("reply startup: the transcript's flex slot is eager and uses the existing loaded layout contract", () => {
  assert.match(read("src/main.tsx"), /import "\.\/styles\.css"/);
  assert.match(
    read("src/styles.css"),
    /@import "\.\/styles\/20-workspace\.css"/,
  );
  const css = read("src/styles/20-workspace.css");
  assert.match(
    css,
    /\.chat-main\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/,
  );
  assert.match(
    css,
    /\.messages-scroll\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*1;/,
  );
});

test("reply startup: a first delayed real transcript keeps the composer after a flex slot; removing only that slot reproduces the missing constraint", async () => {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  window.desktop = {
    modelCatalog: async () => undefined,
    voiceAvailability: async () => ({
      transcription: false,
      maxTranscriptionBytes: null,
      maxSeconds: null,
    }),
    onEvent: () => () => {},
    memoryStatus: async () => undefined,
  } as never;
  const globals = {
    window,
    document,
    navigator: { userAgent: "node-test", language: "en-US" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
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
  const active: Conversation = {
    id: "reply-startup",
    title: "Reply startup",
    mode: "chat",
    providerId: "actual-provider",
    model: "actual-model",
    pinned: false,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    turns: [
      {
        id: "opening-turn",
        prompt: "Startup prompt",
        status: "completed",
        createdAt: 1,
        attachments: [],
        items: [
          {
            id: "opening-reply",
            type: "agentMessage",
            text: "Loaded response",
          },
        ],
      },
    ],
  };
  const app = {
    mode: "chat",
    active,
    activeId: active.id,
    snapshot: {
      settings: defaultSettings,
      platform: "darwin",
      conversations: [active],
      projects: [],
      approvals: [],
      replyFeedback: {},
    },
    scroll: createRef<HTMLDivElement>(),
    composer: createRef<HTMLTextAreaElement>(),
    activeTerminals: [],
    sending: false,
    running: false,
    transcriptScroll: {
      onScroll() {},
      onWheel() {},
      away: false,
      jumpToLatest() {},
    },
    toolPanels: { isOpen: () => false },
    setPanel() {},
    setArtifact() {},
    report(error: unknown) {
      throw error;
    },
  } as unknown as AppController;
  const assertFlexSlot = () => {
    const column = document.querySelector(".chat-main")!;
    const slot = column.querySelector(":scope > .messages-scroll");
    const composer = column.querySelector(":scope > .conversation-composer");
    assert.ok(
      slot,
      "the transcript contributes its eager flex:1 item before the composer",
    );
    assert.ok(composer);
    assert.ok(
      [...column.children].indexOf(slot) <
        [...column.children].indexOf(composer),
    );
    return slot;
  };
  const currentScroller = () => app.scroll.current;
  try {
    for (const negative of [false, true]) {
      const lazy = await deferredTranscriptHost(negative);
      try {
        await act(async () =>
          root.render(
            createElement(
              AppContext.Provider,
              { value: app },
              createElement(
                HostContext.Provider,
                { value: webHost },
                createElement(
                  "div",
                  { className: "chat-main has-conversation chat-main" },
                  createElement(lazy.Host, { active }),
                  createElement(
                    "div",
                    { className: "conversation-composer" },
                    createElement("textarea", {
                      "aria-label": "Startup composer",
                    }),
                  ),
                ),
              ),
            ),
          ),
        );
        const composer = document.querySelector(".conversation-composer")!;
        assert.equal(
          currentScroller(),
          null,
          "pending content never receives the real scroller ref",
        );
        if (negative) {
          assert.throws(assertFlexSlot, /eager flex:1 item/);
        } else {
          const pending = assertFlexSlot();
          assert.equal(pending.getAttribute("aria-hidden"), "true");
          assert.equal(pending.textContent, "");
          assert.equal(pending.getAttribute("tabindex"), null);
          assert.equal(
            pending.querySelector('[role="feed"],button,textarea,input'),
            null,
          );
        }
        await act(async () => lazy.finish());
        const resolved = assertFlexSlot();
        assert.equal(resolved.getAttribute("aria-hidden"), null);
        assert.equal(
          resolved,
          currentScroller(),
          "the real loaded transcript owns its scroller ref",
        );
        assert.ok(
          resolved.querySelector('[role="feed"]'),
          "the actual transcript, not a test probe, resolved",
        );
        assert.match(resolved.textContent!, /Startup prompt/);
        assert.match(resolved.textContent!, /Loaded response/);
        assert.equal(
          document.querySelector(".conversation-composer"),
          composer,
          "the sibling composer never remounts",
        );
      } finally {
        await act(() => root.render(null));
        lazy.cleanup();
      }
    }
  } finally {
    await act(() => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
