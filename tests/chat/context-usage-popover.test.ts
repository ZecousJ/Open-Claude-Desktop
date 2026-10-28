import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PlanUsage, PlanUsageWindow } from "../../shared/usage-api";
import {
  planRingLabel,
  planRingName,
  resetIn,
  ringWindow,
  tokenCount,
  usageSeverity,
} from "../../src/composer/usage-meter";
import { contextUsage } from "../../src/composer/context-usage";
import type { Conversation } from "../../shared/types";

const { ContextPopover } = await import("../../src/composer/ContextPopover");

const now = Date.UTC(2026, 9, 12, 8, 0);
const minute = 60_000;

const window = (over: Partial<PlanUsageWindow>): PlanUsageWindow => ({
  id: "rule:1",
  kind: "session",
  label: "Session",
  windowSeconds: 5 * 3600,
  usedUsd: 2.1,
  limitUsd: 5,
  percent: 42,
  resetsAt: now + 25 * minute,
  active: true,
  exceeded: false,
  models: null,
  ...over,
});

const plan = (windows: PlanUsageWindow[]): PlanUsage => ({
  plan: "Max",
  expiresAt: null,
  windows,
  updatedAt: now,
  warnPercent: 80,
  learnMoreUrl: null,
});

const used = { used: 64_600, window: 258_400, fraction: 0.25 };

test("plan meters turn amber from 75% and red from 90%, as the live ones", () => {
  assert.equal(usageSeverity(74), "normal");
  assert.equal(usageSeverity(75), "warning");
  assert.equal(usageSeverity(89.9), "warning");
  assert.equal(usageSeverity(90), "critical");
});

test("reset times read in minutes, hours and minutes, then a day and time", () => {
  assert.equal(resetIn(now + 25 * minute, now), "Resets in 25 min");
  assert.equal(resetIn(now + 185 * minute, now), "Resets in 3 hr 5 min");
  assert.match(
    resetIn(now + 2 * 1440 * minute, now)!,
    /^Resets [A-Z][a-z]{2} /,
  );
  assert.match(resetIn(now + 8 * 1440 * minute, now)!, /^Resets Oct 20/);
  assert.equal(resetIn(null, now), null);
  assert.equal(resetIn(now - minute, now), null);
});

test("token counts are written short, as the live report does", () => {
  assert.equal(tokenCount(950), "950");
  assert.equal(tokenCount(12_000), "12k");
  assert.equal(tokenCount(12_345), "12.3k");
  assert.equal(tokenCount(999_960), "1M");
  assert.equal(tokenCount(1_234_567), "1.2M");
});

test("a composer with no session is a draft; a session carries its totals", () => {
  assert.equal(contextUsage(undefined, null).draft, true);
  const total = {
    totalTokens: 10,
    inputTokens: 8,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
  };
  const conversation = {
    tokenUsage: { total, last: total, modelContextWindow: 100 },
  } as unknown as Conversation;
  const usage = contextUsage(conversation, null);
  assert.equal(usage.draft, false);
  assert.deepEqual(usage.total, total);
});

test("the ring follows the fullest limit over all models", () => {
  const session = window({ percent: 40 });
  const weekly = window({
    id: "subscription:weekly",
    kind: "all_models",
    windowSeconds: 7 * 86_400,
    percent: 61,
  });
  const opus = window({
    id: "rule:2",
    kind: "models",
    percent: 99,
    models: ["opus*"],
  });
  assert.equal(ringWindow([session, weekly, opus]), weekly);
  assert.equal(ringWindow([opus]), undefined);
  assert.equal(planRingLabel(session), "40% of session limit");
  assert.equal(planRingLabel({ ...weekly, label: "Weekly" }), "Weekly: 61%");
  assert.equal(
    planRingName("40% of session limit", "Resets in 25 min"),
    "Usage: 40% of session limit, Resets in 25 min",
  );
});

test("in a session the panel shows the context window, then balance and usage, then the group's limits", () => {
  const html = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: used,
      onCompact: () => {},
      plan: {
        status: "ready",
        usage: { ...plan([window({})]), balanceUsd: 32.28 },
      },
      spend: { status: "ready", todayUsd: 0.44, weekUsd: 23.64 },
      onUsageSettings: () => {},
      onShowUsageReport: () => {},
      now,
    }),
  );
  assert.match(html, /Context window/);
  assert.match(html, /Compact session/);
  assert.doesNotMatch(html, /Hand off/);
  assert.match(html, /Balance and usage/);
  assert.match(html, /aria-label="View usage in Settings"/);
  assert.match(html, /\$32\.28/);
  assert.match(html, /\$0\.44/);
  assert.match(html, /\$23\.64/);
  assert.match(html, /Current session/);
  assert.match(html, /Resets in 25 min/);
  assert.match(html, />42%</);
  assert.match(html, /See detailed breakdown/);
  assert.ok(html.indexOf("Context window") < html.indexOf("Balance and usage"));
  // Before a session: balance and usage only, nothing to break down.
  const draft = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: { used: 0, window: null, fraction: null, draft: true },
      plan: { status: "ready", usage: { ...plan([]), balanceUsd: 5 } },
      spend: { status: "ready", todayUsd: 0, weekUsd: 1 },
      onShowUsageReport: () => {},
      now,
    }),
  );
  assert.doesNotMatch(draft, /Context window/);
  assert.doesNotMatch(draft, /See detailed breakdown/);
  assert.match(draft, /Balance and usage/);
  assert.match(draft, /\$5\.00/);
});

test("balance and usage say when they are loading or could not load", () => {
  const render = (
    state: Parameters<typeof ContextPopover>[0]["plan"],
    spend?: Parameters<typeof ContextPopover>[0]["spend"],
  ) =>
    renderToStaticMarkup(
      createElement(ContextPopover, { usage: used, plan: state, spend, now }),
    );
  assert.match(render({ status: "loading" }), /…/);
  assert.match(render({ status: "error" }), /Couldn’t load usage limits/);
  assert.match(
    render({ status: "ready", usage: null }, { status: "error" }),
    /—/,
  );
  assert.doesNotMatch(render(undefined), /Balance and usage/);
});

test("See detailed breakdown posts the report, with a session only", () => {
  let posted = 0;
  const show = () => posted++;
  const wide = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: used,
      plan: { status: "ready", usage: plan([window({})]) },
      onShowUsageReport: show,
      now,
    }),
  );
  assert.match(wide, /See detailed breakdown/);
  // Without a way to post it (no session), there is no button.
  const none = renderToStaticMarkup(
    createElement(ContextPopover, {
      usage: used,
      plan: { status: "ready", usage: plan([window({})]) },
      now,
    }),
  );
  assert.doesNotMatch(none, /See detailed breakdown/);
  assert.equal(posted, 0);
});
