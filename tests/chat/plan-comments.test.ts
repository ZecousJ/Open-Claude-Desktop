import test, { before } from "node:test";
import { preloadMarkdownRenderer } from "../../src/ui/MarkdownRenderer";

before(() => preloadMarkdownRenderer());
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation } from "../../shared/types";
import type { PlanComment } from "../../shared/plan-comments";
import {
  overlapsPlanComment,
  planRevisionText,
} from "../../shared/plan-comments";
import {
  planAnnotationPlugin,
  selectedPlanText,
} from "../../src/plan/plan-comment-annotations";
import {
  planCommentKey,
  planComments,
} from "../../src/plan/plan-comments-store";
import { Markdown } from "../../src/ui/Markdown";

const entry = (patch: Partial<PlanComment> = {}): PlanComment => ({
  id: "comment",
  selectedText: "first\nsecond",
  startOffset: 0,
  endOffset: 12,
  comment: "Use a queue.",
  ...patch,
});

test("revision feedback uses the live bundle's sorted quotes, blank lines and optional trailing feedback", () => {
  const early = entry();
  const late = entry({
    id: "late",
    selectedText: "last",
    startOffset: 20,
    endOffset: 24,
    comment: "Keep this.",
  });
  const expected =
    "On selected text:\n> first\n> second\nUse a queue.\n\nOn selected text:\n> last\nKeep this.";
  assert.equal(planRevisionText([late, early], "  "), expected);
  assert.equal(
    planRevisionText([late, early], "  Also add tests. \n"),
    `${expected}\n\n\nAlso add tests.`,
  );
  assert.equal(planRevisionText([], "  Keep planning.  "), "Keep planning.");
  assert.equal(planRevisionText([], " \n "), "");
  assert.deepEqual(
    [late, early].map((comment) => comment.id),
    ["late", "comment"],
  );
});

test("annotations exclude overlapping selections but permit adjacent comments", () => {
  const comments = [entry()];
  assert.equal(overlapsPlanComment(comments, 1, 4), true);
  assert.equal(overlapsPlanComment(comments, 10, 15), true);
  assert.equal(overlapsPlanComment(comments, 12, 15), false);
});

test("comments survive edits, are scoped to the conversation and plan, and can be removed", () => {
  const first = planCommentKey("one", "plan");
  const second = planCommentKey("two", "plan");
  planComments.add(first, entry());
  const saved = planComments.get(first)[0];
  assert.notEqual(saved.id, "comment");
  planComments.update(first, saved.id, "Updated");
  assert.equal(planComments.get(first)[0].comment, "Updated");
  assert.deepEqual(planComments.get(second), []);
  assert.deepEqual(planComments.get(planCommentKey("one", "next")), []);
  planComments.remove(first, saved.id);
  assert.deepEqual(planComments.get(first), []);
  planComments.clear(first);
});

test("Markdown comments span formatting, skip fenced code and relocate to the nearest matching quote", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      text: "Hello **world**!\n\n```text\nHello world!\n```\n\nAgain Hello world!",
      extraRehypePlugins: [
        planAnnotationPlugin([
          entry({ selectedText: "Hello world!", endOffset: 12 }),
        ]),
      ],
    }),
  );
  assert.match(
    html,
    /<mark data-plan-comment-id="comment">Hello <\/mark><strong><mark data-plan-comment-id="comment">world<\/mark><\/strong><mark data-plan-comment-id="comment">!<\/mark>/,
  );
  assert.doesNotMatch(html, /<code[^>]*>[^<]*<mark/);
  const relocated = renderToStaticMarkup(
    createElement(Markdown, {
      text: "prefix target middle target",
      extraRehypePlugins: [
        planAnnotationPlugin([
          entry({ selectedText: "target", startOffset: 22, endOffset: 28 }),
        ]),
      ],
    }),
  );
  assert.match(
    relocated,
    /prefix target middle <mark data-plan-comment-id="comment">target<\/mark>/,
  );
});

test("selection offsets and text follow rendered text across inline formatting", () => {
  const { document } = parseHTML(
    "<html><body><div id='plan'><p>Hello <strong>world</strong>!</p></div></body></html>",
  );
  const root = document.getElementById("plan")!;
  const range = {
    startContainer: root.querySelector("p")!.firstChild!,
    startOffset: 3,
    endContainer: root.querySelector("strong")!.firstChild!,
    endOffset: 4,
  } as unknown as Range;
  assert.deepEqual(selectedPlanText(root, range), {
    startOffset: 3,
    endOffset: 10,
    selectedText: "lo worl",
  });
});

{
  const { window, document } = parseHTML("<html><body></body></html>");
  (document as unknown as { oninput: null }).oninput = null;
  Object.assign(globalThis, { window, document });
}
const { createRoot } = await import("react-dom/client");
const { PlanApprovalCard } = await import("../../src/plan/PlanApprovalCard");
const { PlanCommentList, PlanCommentText } =
  await import("../../src/plan/PlanComments");
const { ConversationServicesContext, desktopConversationServices } =
  await import("../../src/conversation/ConversationServices");

test("selecting plan text opens a comment editor; saved marks reopen for editing and deletion", async () => {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  Object.getPrototypeOf(document.createElement("textarea")).setSelectionRange =
    () => {};
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  Object.assign(window, { innerWidth: 1024, innerHeight: 768 });
  const range = {
    startContainer: document.body as Node,
    endContainer: document.body as Node,
    startOffset: 0,
    endOffset: 0,
    cloneRange() {
      return { ...this };
    },
    selectNodeContents(element: HTMLElement) {
      this.startContainer = element.firstChild!;
      this.endContainer = element.lastChild!;
      this.startOffset = 0;
      this.endOffset = element.lastChild!.textContent!.length;
    },
    getBoundingClientRect() {
      return { left: 40, top: 20, bottom: 40 };
    },
  };
  const selection = {
    anchorNode: document.body as Node,
    isCollapsed: true,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {
      this.isCollapsed = true;
    },
  };
  Object.assign(document, {
    getSelection: () => selection,
    createRange: () => ({ ...range }),
  });
  const key = planCommentKey("selection", "plan");
  const root = createRoot(document.getElementById("root")!);
  const input = async (value: string) =>
    act(async () => {
      const field = document.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(field),
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  const click = async (selector: string) =>
    act(async () => {
      (document.querySelector(selector)! as HTMLElement).click();
    });
  try {
    planComments.enable(key, true);
    await act(async () =>
      root.render(
        createElement(
          ConversationServicesContext.Provider,
          {
            value: {
              ...desktopConversationServices,
              conversationId: "selection",
            },
          },
          createElement(PlanCommentText, {
            planId: "plan",
            text: "Hello **world**!",
          }),
        ),
      ),
    );
    assert.match(
      document.body.textContent!,
      /Select any text to leave a comment for Claudex/,
    );
    const paragraph = document.querySelector("p")!;
    range.startContainer = paragraph.firstChild!;
    range.endContainer = paragraph.querySelector("strong")!.firstChild!;
    range.endOffset = 2;
    selection.anchorNode = range.startContainer;
    selection.isCollapsed = false;
    await act(async () => {
      document.dispatchEvent(new window.Event("mouseup", { bubbles: true }));
    });
    assert.equal(
      document.querySelector('[role="dialog"]')?.getAttribute("aria-label"),
      "Comment on selection",
    );
    assert.equal(
      document.querySelector("textarea")?.getAttribute("aria-label"),
      "Plan comment",
    );
    assert.equal(
      document.querySelector<HTMLButtonElement>('[aria-label="Save comment"]')!
        .disabled,
      true,
    );
    await input("  Rewrite this.  ");
    await click('[aria-label="Save comment"]');
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(planComments.get(key)[0].selectedText, "Hello wo");
    assert.equal(planComments.get(key)[0].comment, "Rewrite this.");
    assert.equal(document.querySelectorAll("mark").length, 2);
    await click('mark span[role="button"]');
    assert.equal(
      document.querySelector<HTMLTextAreaElement>("textarea")?.value,
      "Rewrite this.",
    );
    await input("Use a queue instead.");
    await click('[aria-label="Save comment"]');
    assert.equal(planComments.get(key)[0].comment, "Use a queue instead.");
    await click('mark span[role="button"]');
    await click('[aria-label="Delete comment"]');
    assert.deepEqual(planComments.get(key), []);
    assert.equal(document.querySelector("mark"), null);
  } finally {
    await act(async () => root.unmount());
    planComments.enable(key, false);
    planComments.clear(key);
  }
});

test("the card automatically revises with comments, changes its placeholder and sends quotes to the engine; failures retain the draft", async () => {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const sent: { text: string; conversationId: string }[] = [];
  const errors: unknown[] = [];
  const received: Conversation[] = [];
  let fail = true;
  const conversation = {
    id: "revision",
    mode: "code",
    cwd: "/project",
    turns: [
      {
        id: "turn",
        status: "completed",
        items: [{ id: "plan", type: "plan", text: "first\nsecond" }],
      },
    ],
  } as Conversation;
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.assign(window, {
    desktop: {
      async send(input: (typeof sent)[number]) {
        sent.push(input);
        if (fail) throw new Error("Retry the send");
        return conversation;
      },
    },
  });
  const root = createRoot(document.getElementById("root")!);
  const key = planCommentKey(conversation.id, "plan");
  const button = (label: string) =>
    Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === label,
    )!;
  try {
    await act(async () =>
      root.render(
        createElement(PlanApprovalCard, {
          conversation,
          mac: true,
          autoAcceptAvailable: true,
          updatePreference: async () => {
            throw new Error("Revision must keep plan mode");
          },
          onSent: (value) => received.push(value),
          onKeepPlanning: () => {
            throw new Error("Comments must be sent");
          },
          onError: (error) => errors.push(error),
        }),
      ),
    );
    assert.equal(document.querySelector("textarea"), null);
    await act(async () => planComments.add(key, entry()));
    assert.equal(
      document.querySelector("textarea")?.getAttribute("placeholder"),
      "Anything else to add?",
    );
    assert.equal(button("Back"), undefined);
    const list = renderToStaticMarkup(
      createElement(PlanCommentList, { planId: key, disabled: false }),
    );
    assert.match(list, /1 inline comment will be sent/);
    assert.match(list, /Delete comment/);
    await act(async () => button("Revise").click());
    assert.equal(errors.length, 1);
    assert.equal(planComments.get(key).length, 1);
    assert.equal(
      document.querySelector("textarea")?.getAttribute("placeholder"),
      "Anything else to add?",
    );
    fail = false;
    await act(async () => button("Revise").click());
    const expected = "On selected text:\n> first\n> second\nUse a queue.";
    assert.equal(sent[0].text, expected);
    assert.equal(sent[1].text, expected);
    assert.equal(sent[1].conversationId, conversation.id);
    assert.deepEqual(received, [conversation]);
    assert.deepEqual(planComments.get(key), []);
    const { turnInput } = await import("../../electron/engine/engine-support");
    assert.deepEqual(await turnInput(sent[1].text, []), [
      { type: "text", text: expected, text_elements: [] },
    ]);
  } finally {
    await act(async () => root.unmount());
    planComments.clear(key);
  }
});
