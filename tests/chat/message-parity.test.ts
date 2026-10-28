import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { usageHoldMessage, UsageHold } from "../../src/transcript/UsageHold";
import { applyUsageHold } from "../../shared/usage-hold";
import {
  ConversationDisclaimer,
  disclaimerFeedbackAvailable,
} from "../../src/composer/ConversationDisclaimer";
import { failedRuns } from "../../src/transcript/TurnOutcome";
import type { Conversation, Turn } from "../../shared/types";
import { readSource } from "../support/read-source";

const turn = (): Turn => ({
  id: "t",
  prompt: "Hello",
  attachments: [],
  items: [],
  status: "failed",
  createdAt: 1,
});

test("message chrome uses official theme tokens and floating copy controls", () => {
  const css = readSource(
    new URL("../../src/transcript/chat-transcript.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /background: var\(--cds-bg-user-message\)/);
  assert.match(css, /color: var\(--cds-text-primary\)/);
  assert.match(css, /background: var\(--cds-fill-ghost-selected\)/);
  assert.match(css, /border: 0\.5px solid var\(--cds-border\)/);
  assert.match(css, /\.mode-chat \.code-bar \{\s*display: contents/);
  assert.match(css, /@container conversation-composer \(min-width: 38rem\)/);
  assert.match(css, /background: var\(--cds-fill-ghost-hover\)/);
  assert.match(css, /\.mode-chat \.code-actions \{\s*position: absolute/);
  assert.match(
    css,
    /\.mode-chat \.code-bar > span \{\s*display: block;\s*padding: 14px 14px 0/,
  );
});

test("usage stops distinguish held, untimed, lifted and historical replies", () => {
  const reply = turn();
  applyUsageHold(reply, { exceeded: true, reason: "weekly", resetsAt: 2000 });
  assert.equal(reply.stopReason, "usage_limit");
  assert.equal(
    usageHoldMessage(reply, true, true, null),
    "Paused: Your usage limit was reached. Continue once it resets.",
  );
  assert.equal(
    usageHoldMessage(reply, true, false, null),
    "Stopped by a usage limit. You can try again now.",
  );
  reply.items.push({ id: "a", type: "agentMessage", text: "Partial answer" });
  assert.equal(
    usageHoldMessage(reply, true, false, null),
    "Paused when your usage limit was reached. Continue to pick up where Claudex stopped.",
  );
  assert.equal(
    usageHoldMessage(reply, false, false, null),
    "Paused when your usage limit was reached.",
  );
  const now = new Date(2026, 9, 16, 12).getTime();
  assert.match(
    usageHoldMessage(reply, true, true, now + 3600000, now),
    /^Paused: Your usage limit resets at .+\. Continue then\.$/,
  );
  assert.match(
    usageHoldMessage(reply, true, true, now + 86400000, now),
    /Oct 17/,
  );
  assert.equal(failedRuns([reply, { ...reply, id: "other" }]).size, 0);
});

test("billing and authentication refusals are not resumable usage holds", () => {
  for (const reason of ["balance", "subscription", undefined]) {
    const reply = turn();
    applyUsageHold(reply, { exceeded: true, reason });
    assert.equal(reply.stopReason, undefined);
  }
});

test("Continue remains visible but held until the service reset", () => {
  const reply = turn();
  applyUsageHold(reply, {
    exceeded: true,
    reason: "session",
    resetsAt: Date.now() + 60000,
  });
  const html = renderToStaticMarkup(
    createElement(UsageHold, {
      turn: reply,
      mode: "chat",
      latest: true,
      busy: false,
      onContinue() {},
      onRetry() {},
    }),
  );
  assert.match(html, /aria-disabled="true"/);
  assert.match(html, />Continue</);
});

test("the inline disclaimer keeps responsive copy and omits it only for incognito", () => {
  const short = renderToStaticMarkup(
    createElement(ConversationDisclaimer, { short: true }),
  );
  const full = renderToStaticMarkup(createElement(ConversationDisclaimer));
  assert.doesNotMatch(short, /double-check/);
  assert.match(full, /Please double-check responses\./);
  assert.match(full, /class="disclaimer-more"/);
  assert.match(
    renderToStaticMarkup(
      createElement(ConversationDisclaimer, {
        second: "Please double-check cited sources.",
      }),
    ),
    /double-check cited sources/,
  );
});

test("the disclaimer feedback link belongs to the feedback-enabled Cowork route", () => {
  const status = {
    feedback: true,
    diagnostics: false,
    consented: true,
    allowConversationExcerpt: false,
  };
  const conversation = { mode: "chat" } as Conversation;
  assert.equal(disclaimerFeedbackAvailable(conversation, status), false);
  conversation.mode = "cowork";
  assert.equal(disclaimerFeedbackAvailable(conversation, status), true);
  assert.equal(
    disclaimerFeedbackAvailable(conversation, { ...status, consented: false }),
    false,
  );
  assert.equal(disclaimerFeedbackAvailable(conversation, null), false);
});
