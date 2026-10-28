import assert from "node:assert/strict";
import test, { before } from "node:test";
import { act, createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import type { Conversation, Turn } from "../../shared/types";
import { fixtureSnapshot } from "../../scripts/preview/app-fixture";
import { AppContext, type AppController } from "../../src/app/AppContext";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
import { preloadArtifactCard } from "../../src/artifacts/LazyArtifactCard";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";
import { coworkEditNote } from "../../src/transcript/cowork-prompt-actions";
import { editLastMessageEvent } from "../../src/composer/double-escape";

before(async () => {
  await Promise.all([
    preloadChatSteps(),
    preloadArtifactCard(),
    preloadMarkdownRenderer(),
    preloadCodeTurnError(),
  ]);
});

const fixtures = fixtureSnapshot({ states: true });
const fixture = (id: string) => {
  const found = fixtures.conversations.find(
    (conversation) => conversation.id === id,
  );
  assert.ok(found, `actual existing fixture ${id}`);
  return structuredClone(found);
};
const noop = () => {};
function props(conversation: Conversation, extra = {}) {
  return {
    conversation,
    mode: conversation.mode,
    sending: false,
    running: false,
    approvals: [],
    replyFeedback: {},
    onReplyFeedback: async () => {},
    onArtifact: noop,
    onOpenWorkflow: noop,
    onEditPrompt: async () => true,
    onRetryResponse: noop,
    onContinue: noop,
    onSelectVersion: noop,
    onError: noop,
    scrollRef: createRef<HTMLDivElement>(),
    onScroll: noop,
    onWheel: noop,
    away: false,
    onJumpToLatest: noop,
    ...extra,
  };
}
function render(conversation: Conversation, extra = {}) {
  return parseHTML(
    `<html><body>${renderToStaticMarkup(createElement(ConversationTranscript, props(conversation, extra)))}</body></html>`,
  ).document;
}
const userActions = (document: Document, index = 0) => {
  const row = document.querySelectorAll(".user-message-article")[index];
  assert.ok(row, `prompt article ${index}`);
  return [...row.querySelectorAll("button")].map(
    (button) => button.getAttribute("aria-label") ?? button.textContent,
  );
};

test("unified Chat presents the existing Cowork fixture as a parsed bubble and Chat steps, without rewriting its execution record", () => {
  const conversation = fixture("c-run-cowork");
  const original = structuredClone(conversation);
  const document = render(conversation, { presentation: "chat" });
  assert.ok(document.querySelector(".user-message-text .prompt-paragraph"));
  assert.equal(
    document.querySelector(".user-message-text")?.textContent,
    conversation.turns[0].prompt,
  );
  assert.equal(document.querySelectorAll(".chat-steps").length, 1);
  assert.equal(document.querySelectorAll(".agent-activity-group").length, 0);
  assert.equal(document.querySelector(".response-end-mark"), null);
  assert.match(
    document.querySelector(".chat-steps-head")?.textContent ?? "",
    /Ran a command/,
  );
  assert.match(
    document.querySelector(".assistant-message")?.textContent ?? "",
    /twelve lines/,
  );
  assert.deepEqual(conversation, original);
  assert.equal(conversation.mode, "cowork");
  assert.equal(conversation.turns[0].items[0].command, "wc -l notes.txt");
});

test("the optional presentation preserves the independent legacy Cowork view and the normal Chat/Code views", () => {
  const cowork = render(fixture("c-run-cowork"));
  assert.equal(cowork.querySelectorAll(".chat-steps").length, 0);
  assert.equal(cowork.querySelectorAll(".agent-activity-group").length, 1);
  assert.equal(
    cowork.querySelectorAll(".user-message-text .prompt-paragraph").length,
    0,
  );
  const chat = render(fixture("c-run-chat"));
  assert.ok(chat.querySelector(".user-message-text .prompt-paragraph"));
  const code = render(fixture("c-run-code"), { presentation: "chat" });
  assert.equal(
    code.querySelectorAll(".user-message-text .prompt-paragraph").length,
    0,
  );
  assert.equal(code.querySelectorAll(".chat-steps").length, 0);
  assert.equal(code.querySelectorAll('[role="feed"]').length, 0);
  assert.ok(code.querySelector('[role="region"][aria-label="Chat messages"]'));
});

test("current unified Chat has no reply mark, streaming or done, while the standalone legacy interface keeps its end mark", () => {
  const conversation = fixture("c-run-cowork");
  conversation.mode = "chat";
  assert.ok(render(conversation).querySelector(".response-end-mark"));
  assert.equal(
    render(conversation, { presentation: "chat" }).querySelector(
      ".response-end-mark",
    ),
    null,
  );
  conversation.turns[0].status = "inProgress";
  conversation.turns[0].items.push({
    id: "streaming-reply",
    type: "agentMessage",
    text: "Continuing",
    lifecycleStatus: "inProgress",
  });
  // No mark while it streams either.
  assert.equal(
    render(conversation, { presentation: "chat" }).querySelector(
      ".response-stream-mark",
    ),
    null,
  );
});

test("Cowork presentation retains file activities and generated artifact cards", async () => {
  const conversation = fixture("c-activity");
  const original = structuredClone(conversation);
  let document = render(conversation, { presentation: "chat" });
  for (
    let i = 0;
    i < 40 && !document.querySelector(".file-document-card");
    i++
  ) {
    await new Promise((resolve) => setImmediate(resolve));
    document = render(conversation, { presentation: "chat" });
  }
  assert.ok(document.querySelector(".chat-steps"));
  assert.ok(
    document.querySelector(
      'button[aria-label="View R-0928-synthetic-output.txt"]',
    ),
  );
  assert.ok(document.querySelector(".file-document-card"));
  assert.deepEqual(conversation, original);
});

test("unified Cowork keeps latest-only Edit/Restart policy, while normal Chat retains Retry", () => {
  const conversation = fixture("c-run-cowork");
  const turn = conversation.turns[0];
  conversation.turns = [{ ...structuredClone(turn), id: "older" }, turn];
  const document = render(conversation, { presentation: "chat" });
  const older = userActions(document, 0);
  assert.ok(!older.includes("Edit"));
  assert.ok(!older.includes("Retry"));
  assert.ok(!older.includes("Restart session from here"));
  assert.ok(older.includes("Copy"));
  assert.ok(userActions(document, 1).includes("Restart session from here"));
  const chat = render({ ...conversation, mode: "chat" });
  assert.ok(userActions(chat, 0).includes("Retry"));
});

test("busy, compact, shell and review Cowork turns gain no edit/retry action from Chat presentation", () => {
  const base = fixture("c-run-cowork");
  for (const [name, patch, extra] of [
    ["busy", {}, { running: true }],
    ["sending", {}, { sending: true }],
    ["inProgress", { status: "inProgress" }, {}],
    ["compact", { compaction: "manual" }, {}],
    ["shell", { shell: true }, {}],
    ["review", { review: { type: "uncommittedChanges" } }, {}],
  ] as const) {
    const conversation = structuredClone(base);
    Object.assign(conversation.turns[0], patch);
    const document = render(conversation, { presentation: "chat", ...extra });
    const actions = name === "compact" ? [] : userActions(document);
    assert.ok(!actions.includes("Edit"), name);
    assert.ok(!actions.includes("Retry"), name);
    assert.ok(!actions.includes("Restart session from here"), name);
    if (name === "shell")
      assert.match(
        document.querySelector(".user-message-text")?.textContent ?? "",
        /^! /,
      );
  }
});

async function mountHost(conversation: Conversation) {
  const { window, document } = parseHTML(
    "<html><body><main></main></body></html>",
  );
  (document as unknown as { oninput: null }).oninput = null;
  Object.getPrototypeOf(document.createElement("textarea")).setSelectionRange =
    noop;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 100,
    y: 100,
    top: 100,
    left: 100,
    right: 124,
    bottom: 124,
    width: 24,
    height: 24,
    toJSON: () => ({}),
  });
  const calls: { action: string; id: string; mode: string; text?: string }[] =
    [];
  window.desktop = {
    modelCatalog: async () => undefined,
    voiceAvailability: async () => ({
      transcription: false,
      maxTranscriptionBytes: null,
      maxSeconds: null,
    }),
    onEvent: () => noop,
    memoryStatus: async () => undefined,
    editPrompt: async (id: string, _turnId: string, text: string) => {
      calls.push({ action: "edit", id, mode: conversation.mode, text });
      return structuredClone(conversation);
    },
    retryResponse: async (id: string) => {
      calls.push({ action: "retry", id, mode: conversation.mode });
      return structuredClone(conversation);
    },
  } as never;
  const globals = {
    window,
    document,
    innerWidth: 1280,
    innerHeight: 720,
    navigator: { userAgent: "node-test", language: "en-US" },
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    getComputedStyle: () => ({ getPropertyValue: () => "0" }),
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: noop,
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
  const { TranscriptHost } = await import("../../src/app/TranscriptHost");
  const root = createRoot(document.querySelector("main")!);
  const app = {
    mode: conversation.mode === "code" ? "code" : "chat",
    active: conversation,
    activeId: conversation.id,
    snapshot: { ...structuredClone(fixtures), conversations: [conversation] },
    scroll: createRef<HTMLDivElement>(),
    composer: createRef<HTMLTextAreaElement>(),
    activeTerminals: [],
    sending: false,
    running: false,
    providerId: conversation.providerId,
    model: conversation.model,
    policy: { webSearch: false, memory: { enabled: false } },
    transcriptScroll: {
      onScroll: noop,
      onWheel: noop,
      away: false,
      jumpToLatest: noop,
    },
    toolPanels: { isOpen: () => false },
    setPanel: noop,
    setArtifact: noop,
    setSending: noop,
    setError: noop,
    upsert: noop,
    follow: { current: false },
    report(error: unknown) {
      throw error;
    },
  } as unknown as AppController;
  const tree = () =>
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(TranscriptHost, { active: conversation }),
    );
  const click = async (selector: string) => {
    const control = document.querySelector(selector);
    assert.ok(control, selector);
    await act(async () => {
      control.dispatchEvent(
        new window.Event("click", { bubbles: true, cancelable: true }),
      );
    });
  };
  await act(async () => {
    root.render(tree());
  });
  for (
    let i = 0;
    i < 40 && !document.querySelector(".user-message-text");
    i++
  ) {
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  }
  assert.ok(
    document.querySelector(".user-message-text"),
    "real lazy TranscriptHost loaded",
  );
  return {
    document,
    window,
    app,
    calls,
    click,
    async refresh() {
      await act(async () => {
        root.render(tree());
      });
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

test("real TranscriptHost keeps Cowork execution callbacks and edit note while presenting Chat steps", async () => {
  const conversation = fixture("c-run-cowork");
  const mounted = await mountHost(conversation);
  try {
    assert.ok(mounted.document.querySelector(".chat-steps"));
    assert.ok(
      mounted.document.querySelector(".user-message-text .prompt-paragraph"),
    );
    assert.equal(mounted.app.active?.mode, "cowork");
    await mounted.click(
      '.user-message-actions button[aria-label="Restart session from here"]',
    );
    assert.deepEqual(mounted.calls, [
      { action: "retry", id: conversation.id, mode: "cowork" },
    ]);
    await mounted.click(
      '.user-message-actions button[aria-label="More options"]',
    );
    await mounted.click('[role="menuitem"]');
    assert.ok(
      mounted.document.querySelector('textarea[aria-label="Edit message"]'),
    );
    await act(async () => {
      mounted.document
        .querySelector('[aria-label="About saving"]')!
        .dispatchEvent(
          new mounted.window.Event("pointerover", { bubbles: true }),
        );
      await new Promise((resolve) => setTimeout(resolve, 320));
    });
    assert.ok(mounted.document.body.textContent.includes(coworkEditNote));
    const field = mounted.document.querySelector(
      'textarea[aria-label="Edit message"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(field),
        "value",
      )!.set!.call(field, "Updated synthetic notes request");
      field.dispatchEvent(new mounted.window.Event("input", { bubbles: true }));
    });
    await mounted.click(".save-message");
    assert.deepEqual(mounted.calls.at(-1), {
      action: "edit",
      id: conversation.id,
      mode: "cowork",
      text: "Updated synthetic notes request",
    });
    assert.equal(conversation.mode, "cowork");
  } finally {
    await mounted.dispose();
  }
});

test("unified Cowork double-Escape editing respects execution-kind exclusions and busy state", async () => {
  for (const patch of [
    { shell: true },
    { review: { type: "uncommittedChanges" } },
    {},
  ] as Partial<Turn>[]) {
    const conversation = fixture("c-run-cowork");
    Object.assign(conversation.turns[0], patch);
    const mounted = await mountHost(conversation);
    try {
      if (!patch.shell && !patch.review) mounted.app.running = true;
      await mounted.refresh();
      await act(async () => {
        mounted.window.dispatchEvent(
          new mounted.window.CustomEvent(editLastMessageEvent, {
            detail: conversation.id,
          }),
        );
      });
      assert.equal(
        mounted.document.querySelector('textarea[aria-label="Edit message"]'),
        null,
      );
      assert.equal(mounted.calls.length, 0);
    } finally {
      await mounted.dispose();
    }
  }
});
