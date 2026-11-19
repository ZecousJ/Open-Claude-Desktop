import test, { before } from "node:test";
import assert from "node:assert/strict";
import { createElement as h, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { referenceFonts } from "../../electron/app/reference-fonts";
import { loadReferenceFonts } from "../../src/boot/reference-fonts";
import { ConversationTranscript } from "../../src/transcript/ConversationTranscript";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";
import { preloadCodeTurnError } from "../../src/transcript/TurnOutcome";
import { fixtureSnapshot } from "../../scripts/fidelity/app-fixture";
import type { Conversation } from "../../shared/types";

const normalFonts = ["Sans", "Serif"].map((family) => ({
  family: `Claudex Reference ${family}`,
  style: "normal" as const,
  data: new Uint8Array([0, 1, 0, 0]),
}));

function fontEnvironment(failItalic = false) {
  const { document } = parseHTML("<html><body></body></html>");
  const added: MockFace[] = [];
  const pending: MockFace[] = [];
  class MockFace {
    constructor(
      readonly family: string,
      readonly source: ArrayBuffer,
      readonly descriptors: FontFaceDescriptors,
    ) {
      pending.push(this);
    }
    async load() {
      if (failItalic && this.descriptors.style === "italic")
        throw new Error("Unreadable italic font");
      return this;
    }
  }
  Object.defineProperty(document, "fonts", {
    value: { add: (face: MockFace) => added.push(face) },
  });
  return {
    document,
    added,
    pending,
    Face: MockFace as unknown as typeof FontFace,
  };
}

test("font startup consumes real local font bytes and registers both normal display families", async (context) => {
  const fonts = referenceFonts();
  if (!fonts.length) return context.skip("No local Claude font installation");
  const env = fontEnvironment();
  await loadReferenceFonts(async () => fonts, env.document, env.Face);
  assert.equal(env.document.documentElement.dataset.referenceFonts, "true");
  assert.equal(env.added.length, fonts.length);
  for (const [index, face] of env.added.entries()) {
    assert.equal(face.family, fonts[index].family);
    assert.equal(face.descriptors.style, fonts[index].style);
    assert.equal(face.descriptors.weight, "300 800");
    assert.deepEqual(new Uint8Array(face.source), fonts[index].data);
    assert.ok(
      face.source.byteLength > 10_000,
      "Actual font, not a path or family label",
    );
    assert.deepEqual(
      [...new Uint8Array(face.source).slice(0, 4)],
      [0, 1, 0, 0],
    );
  }
});

test("normal body fonts become available after loading even if an italic fails", async () => {
  const env = fontEnvironment(true);
  env.document.documentElement.dataset.chatFont = "system";
  let resolve!: (fonts: Awaited<ReturnType<typeof referenceFonts>>) => void;
  const loading = loadReferenceFonts(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    env.document,
    env.Face,
  );
  assert.equal(env.document.documentElement.dataset.referenceFonts, undefined);
  assert.equal(env.added.length, 0);
  resolve([...normalFonts, { ...normalFonts[1], style: "italic" }]);
  await loading;
  assert.deepEqual(
    env.added.map((font) => font.family),
    normalFonts.map((font) => font.family),
  );
  assert.equal(env.document.documentElement.dataset.referenceFonts, "true");
  assert.equal(env.document.documentElement.dataset.chatFont, "system");
});

test("empty browser delivery, missing normal families and failed reads never advertise loaded display fonts", async () => {
  const env = fontEnvironment();
  for (const fonts of [
    [],
    [normalFonts[0]],
    normalFonts.map((font) => ({ ...font, style: "italic" as const })),
  ]) {
    env.document.documentElement.dataset.referenceFonts = "true";
    await loadReferenceFonts(async () => fonts, env.document, env.Face);
    assert.equal(
      env.document.documentElement.dataset.referenceFonts,
      undefined,
    );
  }
  await loadReferenceFonts(
    async () => {
      throw new Error("Installation unavailable");
    },
    env.document,
    env.Face,
  );
  assert.equal(env.document.documentElement.dataset.referenceFonts, undefined);
  await loadReferenceFonts(undefined, env.document, env.Face);
  assert.equal(env.document.documentElement.dataset.referenceFonts, undefined);
});

before(async () => {
  await Promise.all([
    preloadChatSteps(),
    preloadMarkdownRenderer(),
    preloadCodeTurnError(),
  ]);
});

function transcript(conversation: Conversation, presentation?: "chat") {
  const noop = () => {};
  return parseHTML(
    `<html><body>${renderToStaticMarkup(
      h(ConversationTranscript, {
        conversation,
        mode: conversation.mode,
        presentation,
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
      }),
    )}</body></html>`,
  ).document;
}

test("a stored Cowork execution uses current Chat message presentation while retaining its independent task capabilities", () => {
  const fixture = fixtureSnapshot({ states: true });
  const value = structuredClone(
    fixture.conversations.find((item) => item.id === "c-run-cowork")!,
  );
  value.turns[0].status = "completed";
  const original = structuredClone(value);
  const current = transcript(value, "chat");
  assert.ok(current.querySelector(".chat-steps"));
  assert.equal(current.querySelector(".agent-activity-group"), null);
  assert.equal(
    current.querySelectorAll('[role="feed"] [role="article"]').length,
    2,
  );
  assert.deepEqual(
    [...current.querySelectorAll('[role="article"]')].map((message) =>
      message.getAttribute("aria-label"),
    ),
    ["Message 1 of 2", "Message 2 of 2"],
  );
  assert.ok(
    current
      .querySelector(".assistant-message .message-summary")
      ?.textContent?.startsWith("Claudex responded:"),
  );
  // Merged into Chat, its reply has Chat's actions (live claude.ai,
  // 2026-10-20: Copy, Read aloud, the two ratings, Retry).
  assert.equal(
    current.querySelector('.message-actions button[aria-label="More options"]'),
    null,
  );
  assert.ok(
    current.querySelector('.message-actions button[aria-label="Retry"]'),
  );
  const legacy = transcript(value);
  assert.ok(legacy.querySelector(".agent-activity-group"));
  assert.equal(legacy.querySelector(".chat-steps"), null);
  assert.deepEqual(value, original);
});
