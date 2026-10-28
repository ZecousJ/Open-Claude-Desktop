import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  feedbackDialogWanted,
  feedbackOutcomeMessage,
  feedbackSubmittable,
  negativeCategories,
  feedbackCategoriesFor,
  ReplyFeedbackDialog,
} from "../../src/reply-feedback/ReplyFeedbackDialog";
import { feedbackCategories } from "../../electron/support/diagnostics-support";
import type { Conversation } from "../../shared/types";
import { feedbackReportComment } from "../../shared/feedback-report";

test("feedback reasons follow thinking, search, memory and images through the rated turn", () => {
  const conversation = {
    webSearch: true,
    turns: [
      { id: "before", attachments: [{ kind: "image" }], items: [] },
      {
        id: "reply",
        attachments: [],
        items: [{ type: "reasoning" }, { type: "webSearch" }],
      },
      { id: "future", attachments: [], items: [] },
    ],
  } as unknown as Conversation;
  const ids = (turnId: string, memoryAvailable = false) =>
    feedbackCategoriesFor({
      conversation,
      turnId,
      memoryAvailable,
      webSearchAvailable: true,
    }).map((item) => item.id);
  assert.deepEqual(ids("reply", true), [
    "ui_bug",
    "overactive_refusal",
    "file",
    "did_not_follow_instructions",
    "not_factually_correct",
    "incomplete_response",
    "thoughts",
    "web_over",
    "web_sources",
    "web_url",
    "memory",
    "harmful_content",
    "constitution",
    "other",
  ]);
  assert.ok(ids("before").includes("think_under"));
  assert.ok(ids("before").includes("web_under"));
  assert.ok(!ids("before").includes("thoughts"));
  assert.ok(!ids("before").includes("web_url"));
  assert.ok(!ids("before").includes("memory"));
  assert.ok(!ids("missing").includes("file"));
  const laterImage = {
    ...conversation,
    turns: conversation.turns.map((turn, index) => ({
      ...turn,
      attachments:
        index === 2
          ? [
              {
                kind: "image" as const,
                id: "image",
                name: "image.png",
                path: "image.png",
                size: 1,
              },
            ]
          : [],
    })),
  };
  assert.ok(
    !feedbackCategoriesFor({ conversation: laterImage, turnId: "reply" }).some(
      (item) => item.id === "file",
    ),
  );
  const fetchOnly = {
    ...conversation,
    turns: [
      {
        ...conversation.turns[1],
        items: [
          { id: "fetch", type: "webSearch", action: { type: "openPage" } },
        ],
      },
    ],
  };
  assert.ok(
    !feedbackCategoriesFor({ conversation: fetchOnly, turnId: "reply" }).some(
      (item) => item.id === "web_url",
    ),
  );
  assert.deepEqual(
    feedbackCategoriesFor({ turnId: "reply" }).map((item) => item.id),
    [
      ...negativeCategories.slice(0, 5).map((item) => item.id),
      "think_under",
      "harmful_content",
      "constitution",
      "other",
    ],
  );
});

test("URL reports require an HTTP URL and retain it in the administrator's report", () => {
  const report = {
    conversationId: "c1",
    turnId: "t1",
    rating: "down" as const,
    categories: ["web_url"],
    comment: "Unsafe result",
    reportUrl: "https://example.com/page",
  };
  assert.equal(
    feedbackReportComment(report),
    "https://example.com/page\n\nUnsafe result",
  );
  for (const reportUrl of [
    "",
    "not a URL",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:secret@example.com",
  ])
    assert.throws(
      () => feedbackReportComment({ ...report, reportUrl }),
      /Enter a valid URL/,
    );
  assert.equal(
    feedbackReportComment({ ...report, categories: ["web_sources"] }),
    "Unsafe result",
  );
  assert.equal(
    feedbackReportComment({ ...report, comment: "x".repeat(5000) }).length,
    4000,
  );
});

const render = (rating: "up" | "down", allowConversationExcerpt = false) =>
  renderToStaticMarkup(
    createElement(ReplyFeedbackDialog, {
      conversationId: "c1",
      turnId: "t1",
      rating,
      allowConversationExcerpt,
      submit: async () => ({ sent: true }),
      onDone: () => {},
      onClose: () => {},
    }),
  );

test("the dialog opens only when the service collects feedback and the person agreed", () => {
  assert.equal(feedbackDialogWanted(null), false);
  const status = {
    diagnostics: true,
    feedback: true,
    allowConversationExcerpt: false,
    consented: true,
  };
  assert.equal(feedbackDialogWanted(status), true);
  assert.equal(feedbackDialogWanted({ ...status, consented: false }), false);
  assert.equal(feedbackDialogWanted({ ...status, feedback: false }), false);
});

test("positive feedback asks what was satisfying, without issue types", () => {
  const html = render("up");
  assert.match(html, /aria-label="Give positive feedback"/);
  assert.match(html, /What was satisfying about this response\?/);
  assert.doesNotMatch(html, /What type of issue/);
  assert.doesNotMatch(html, /Include this conversation/);
  // Nothing written yet: Submit waits.
  assert.match(
    html,
    /<button type="submit" class="primary" disabled="">Submit/,
  );
});

test("negative feedback lists the issue types; the conversation box shows only when allowed", () => {
  const html = render("down", true);
  assert.match(html, /aria-label="Give negative feedback"/);
  assert.match(html, /What was unsatisfying about this response\?/);
  // The types are one menu-backed field, empty at first, as on claude.ai.
  assert.match(html, /What type of issue do you wish to report\? \(optional\)/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /Select…/);
  assert.equal(negativeCategories.length, 7);
  assert.match(html, /Include this conversation/);
  // Unticked by default.
  assert.doesNotMatch(html, /type="checkbox" checked=""/);
});

test("issue ids are what the service accepts, and Submit needs text or an issue", () => {
  const ids = negativeCategories.map((category) => category.id);
  assert.deepEqual(feedbackCategories(ids), ids);
  assert.equal(feedbackSubmittable("", []), false);
  assert.equal(feedbackSubmittable("   ", []), false);
  assert.equal(feedbackSubmittable("", ["ui_bug"]), true);
  assert.equal(feedbackSubmittable("Too long", []), true);
});

test("the toast says what happened to the feedback", () => {
  assert.equal(
    feedbackOutcomeMessage({ sent: true }),
    "Thanks for your feedback",
  );
  assert.match(
    feedbackOutcomeMessage({ sent: true, excerptDropped: true }),
    /conversation was not included/,
  );
  assert.match(
    feedbackOutcomeMessage({ sent: false, queued: true }),
    /sent when Claudex can reach the service/,
  );
  assert.equal(
    feedbackOutcomeMessage({ sent: false }),
    "Your feedback could not be sent.",
  );
});
