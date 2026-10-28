import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Turn } from "../../shared/types";
import type { SharedChatContent } from "../../shared/sharing-api";
import {
  dismissNextStep,
  emptyPacing,
  emptyTipPacing,
  nextStepInput,
  nextStepOffers,
  nextStepSuppressed,
  suggestionItem,
  tipAllowed,
} from "../../shared/chat-suggestions";
import { chatSuggestionsExtension } from "../../electron/engine/chat-suggestions";
import type {
  DynamicToolCall,
  EngineTurnContext,
} from "../../electron/engine/engine-extensions";
import { AppContext, type AppController } from "../../src/app/AppContext";
import ChatSuggestions from "../../src/chat-suggestions/ChatSuggestions";
import { nextStepCopy } from "../../src/chat-suggestions/next-step-copy";
import { chatSegments } from "../../src/transcript/ChatActivityGroup";
import ArtifactEditAccess, {
  editAccessMessages,
} from "../../src/collections/shared/ArtifactEditAccess";

const turn = (extra: Partial<Turn> = {}): Turn => ({
  id: "turn",
  prompt: "Explain this",
  attachments: [],
  status: "completed",
  createdAt: 0,
  items: [
    { id: "answer", type: "agentMessage", text: "A complete answer." },
    {
      id: "offer",
      type: "dynamicToolCall",
      tool: "offer_next_step_v0",
      status: "completed",
      arguments: { offer: "build_doc", scenario: "answer_to_work" },
      success: true,
    },
  ],
  ...extra,
});
const conversation = (value: Turn): Conversation =>
  ({ id: "chat", mode: "chat", turns: [value] }) as Conversation;
const app = { accountId: "local", text: "" } as AppController;
test("edit access offers the original request action, keeps pending focusable and hides it from editors", () => {
  const render = (canEdit: boolean, editRequestPending = false) =>
    renderToStaticMarkup(
      createElement(ArtifactEditAccess, {
        token: "share",
        chat: { canEdit, editRequestPending } as SharedChatContent,
        onChanged: () => {},
        onError: () => {},
      }),
    );
  assert.match(render(false), /data-edit-request="offered"/);
  assert.match(render(false), /Ask to edit/);
  const pending = render(false, true);
  assert.match(pending, /data-edit-request="pending"/);
  assert.match(pending, /aria-disabled="true"/);
  assert.match(pending, /Request sent/);
  assert.doesNotMatch(pending, / disabled=""/);
  assert.doesNotMatch(render(true), /data-edit-request/);
});
function markup(value: Turn, kind: "next-step" | "tip" = "next-step") {
  return renderToStaticMarkup(
    createElement(
      AppContext.Provider,
      { value: app },
      createElement(ChatSuggestions, {
        conversation: conversation(value),
        turn: value,
        kind,
      }),
    ),
  );
}

test("next step accepts only the official six offers and two scenarios, not inherited properties", () => {
  for (const offer of nextStepOffers)
    for (const scenario of ["answer_to_work", "next_after_completion"]) {
      assert.deepEqual(nextStepInput({ offer, scenario }), { offer, scenario });
    }
  for (const value of [
    null,
    [],
    "build_doc",
    {},
    { offer: "other", scenario: "answer_to_work" },
    { offer: "build_doc", scenario: "other" },
    Object.create({ offer: "build_doc", scenario: "answer_to_work" }),
  ]) {
    assert.equal(nextStepInput(value), undefined);
  }
});

test("pacing preserves a shown call, waits three ignored turns, and backs off an unanswered offer", () => {
  const state = {
    ...emptyPacing(),
    shownFor: "turn",
    shownToolUseId: "first",
    open: { build_doc: "first" },
  };
  assert.equal(nextStepSuppressed(state, "first", "build_doc", 0), false);
  assert.equal(nextStepSuppressed(state, "second", "build_doc", 20), true);
  assert.equal(nextStepSuppressed(state, "second", "write_brief", 3), true);
  assert.equal(nextStepSuppressed(state, "second", "write_brief", 4), false);
  assert.equal(
    nextStepSuppressed(
      { ...state, outcome: "clicked" },
      "second",
      "write_brief",
      1,
    ),
    false,
  );
  assert.equal(
    nextStepSuppressed({ ...state, closed: true }, "second", "write_brief", 20),
    true,
  );
});

test("three dismissals in a rolling week pause suggestions for seven days", () => {
  const day = 86400000;
  assert.deepEqual(
    dismissNextStep({ closes: [day, 2 * day], pausedUntil: 0 }, 3 * day),
    { closes: [], pausedUntil: 10 * day },
  );
  assert.deepEqual(
    dismissNextStep({ closes: [day, 20 * day], pausedUntil: 0 }, 9 * day),
    { closes: [9 * day], pausedUntil: 0 },
  );
});

test("tips have their own three-conversation cooldown, three-show cap and per-feature dismissal", () => {
  const state = {
    ...emptyTipPacing(),
    lastShownConversation: "one",
    sessionsSinceLastShow: 2,
    ledger: { artifacts: { count: 3, lastSessionId: "one" } },
  };
  assert.equal(tipAllowed(state, "artifacts", "one"), true);
  assert.equal(tipAllowed(state, "document_creation", "two"), false);
  assert.equal(
    tipAllowed(
      { ...state, sessionsSinceLastShow: 3 },
      "document_creation",
      "two",
    ),
    true,
  );
  assert.equal(
    tipAllowed({ ...state, sessionsSinceLastShow: 3 }, "artifacts", "two"),
    false,
  );
  assert.equal(
    tipAllowed({ ...state, dismissed: ["artifacts"] }, "artifacts", "one"),
    false,
  );
});

test("every offer renders the official caption and chip; interrupted, failed and non-final replies never offer", () => {
  for (const offer of nextStepOffers) {
    const value = turn();
    value.items[1].arguments.offer = offer;
    const html = markup(value);
    assert.match(html, /data-testid="offer-next-step"/);
    assert.ok(html.includes(nextStepCopy[offer].chip));
    assert.ok(html.includes(nextStepCopy[offer].caption));
    assert.match(html, /Dismiss suggestion/);
    assert.ok(!html.includes(nextStepCopy[offer].prompts.answer_to_work));
  }
  for (const status of ["inProgress", "failed", "interrupted"] as const)
    assert.equal(markup(turn({ status })), "");
  const following = turn();
  following.items.push({
    id: "after",
    type: "agentMessage",
    text: "More text",
  });
  assert.equal(markup(following), "");
  const failed = turn();
  failed.items[1].success = false;
  assert.equal(markup(failed), "");
});

test("artifact tips render a reply banner with Add to message, not an extra transcript tool card", () => {
  const value = turn();
  value.items[1] = {
    id: "tip",
    type: "dynamicToolCall",
    tool: "suggest_capability",
    arguments: { feature: "artifacts" },
    status: "completed",
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: '{"suggest":true,"feature":"artifacts","tier":2}',
      },
    ],
  };
  const html = markup(value, "tip");
  assert.match(html, /data-cds="Banner"/);
  assert.match(html, /Generate code, documents, and designs/);
  assert.match(html, /Add to message/);
  assert.equal(markup(value), "");
  assert.equal(suggestionItem(value.items[1]), true);
  assert.deepEqual(
    chatSegments(value.items)
      .flatMap((segment) => segment.items)
      .map((item) => item.id),
    ["answer"],
  );
});

test("judged scheduled-task tips render under completed replies and yield to next-step offers", () => {
  const value = turn({
    capabilityTip: { feature: "scheduled_tasks", tier: 2 },
  });
  assert.equal(markup(value, "tip"), "");
  value.items = [value.items[0]];
  const html = markup(value, "tip");
  assert.match(
    html,
    /Doing this every week\? Set it up as a scheduled task in Cowork\./,
  );
  assert.match(html, /Open scheduled tasks/);
  for (const status of ["inProgress", "failed", "interrupted"] as const)
    assert.equal(markup({ ...value, status }, "tip"), "");
  assert.equal(
    markup(
      {
        ...value,
        capabilityTip: { feature: "__proto__", tier: 2 },
      } as unknown as Turn,
      "tip",
    ),
    "",
  );
});

test("desktop and runner's shared engine exposes working suggestion tools only for chat", async () => {
  const extension = chatSuggestionsExtension();
  const tools = extension.dynamicTools!({ mode: "chat" } as EngineTurnContext)!;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["offer_next_step_v0", "suggest_capability"],
  );
  assert.deepEqual(
    extension.dynamicTools!({ mode: "code" } as EngineTurnContext),
    [],
  );
  const call = {
    conversation: conversation(turn()),
    namespace: null,
    tool: "offer_next_step_v0",
    arguments: { offer: "build_doc", scenario: "answer_to_work" },
  } as DynamicToolCall;
  assert.equal((await extension.handleDynamicTool!(call))?.success, true);
  assert.equal(
    (await extension.handleDynamicTool!({ ...call, arguments: {} }))?.success,
    false,
  );
  assert.equal(
    await extension.handleDynamicTool!({ ...call, namespace: "untrusted" }),
    undefined,
  );
  const tip = await extension.handleDynamicTool!({
    ...call,
    tool: "suggest_capability",
    arguments: { feature: "artifacts" },
  });
  assert.deepEqual(tip, {
    success: true,
    contentItems: [
      {
        type: "inputText",
        text: '{"suggest":true,"feature":"artifacts","tier":2}',
      },
    ],
  });
});

test("all user-facing suggestion and access strings have translations in every locale", async () => {
  const strings = [
    ...Object.values(nextStepCopy).flatMap((copy) => [
      copy.caption,
      copy.chip,
      ...Object.values(copy.prompts),
    ]),
    ...Object.values(editAccessMessages),
    "Ask to edit",
    "Sending…",
    "Request sent",
    "You’ll be able to edit if an owner approves.",
    "Make this an artifact I can keep editing and share.",
    "Turn this into a file I can download and send as is.",
    "Generate code, documents, and designs in a dedicated window alongside your conversation.",
    "Ask Claudex to make this a Word, Excel, PowerPoint or PDF file you can download without copying and pasting.",
    "Add to message",
    "Dismiss suggestion",
    "Suggested next step: {caption}",
    "Dismiss",
    "Download as PDF",
    "Couldn’t download this artifact. Try again.",
  ];
  for (const locale of [
    "zh-CN",
    "ja-JP",
    "ko-KR",
    "de-DE",
    "fr-FR",
    "es-ES",
    "es-419",
    "it-IT",
    "pt-BR",
    "id-ID",
    "hi-IN",
  ]) {
    const catalog = (await import(`../../shared/i18n/catalogs/${locale}.ts`))
      .default;
    for (const text of strings) assert.ok(catalog[text], `${locale}: ${text}`);
  }
});
import { before as beforeChatSteps } from "node:test";
import { preloadChatSteps } from "../../src/transcript/ChatTurnContent";
beforeChatSteps(() => preloadChatSteps());
