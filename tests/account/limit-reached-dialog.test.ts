import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WeeklyUsageStatus } from "../../shared/usage-api";
import { limitDialogKey } from "../../src/policy/limit-reached";
import {
  LimitReachedBody,
  limitDialogText,
} from "../../src/policy/LimitReachedDialog";
import { currentLocale, setLocale } from "../../src/i18n";

const future = Date.now() + 3 * 24 * 3600_000;
const weekly: WeeklyUsageStatus = {
  used: 100,
  limit: 100,
  percent: 100,
  warnPercent: 80,
  resetsAt: future,
  moreUsageUrl: "https://usage.example.com",
  state: "exceeded",
  dismissed: false,
  unit: "usd",
  reason: "weekly",
};

test("the limit dialog shows once per window, only with a way to keep working", () => {
  assert.equal(limitDialogKey(weekly, false), `weekly:${future}`);
  assert.equal(limitDialogKey({ ...weekly, state: "warning" }, false), null);
  assert.equal(limitDialogKey(null, true), null);
  // Nothing to offer: the usage notice says it.
  assert.equal(limitDialogKey({ ...weekly, moreUsageUrl: null }, true), null);
  const balance = { ...weekly, reason: "balance" as const, moreUsageUrl: null };
  assert.equal(limitDialogKey(balance, false), null);
  assert.equal(limitDialogKey(balance, true), `balance:${future}`);
});

test("the limit dialog's words follow the window", () => {
  const week = limitDialogText(weekly, "en-US");
  assert.equal(week.title, "Weekly limit reached");
  assert.match(
    week.body,
    /^You’ve reached your weekly limit\. It resets at .+ on .+\. To keep working before then:$/,
  );
  assert.match(
    week.wait,
    /^Wait until (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day$/,
  );
  const session = limitDialogText({ ...weekly, reason: "session" }, "en-US");
  assert.equal(session.title, "Session limit reached");
  assert.match(session.body, /your plan’s limit/);
  assert.match(session.wait, /^Wait until \d{1,2}:\d{2}/);
  const balance = limitDialogText({ ...weekly, reason: "balance" }, "en-US");
  assert.equal(balance.title, "Usage limit reached");
  assert.equal(balance.body, "You’re out of usage credits. To keep working:");
  assert.equal(balance.wait, "No, thanks");
  const past = limitDialogText(
    { ...weekly, reason: "monthly", resetsAt: 0 },
    "en-US",
  );
  assert.equal(
    past.body,
    "You’ve reached your plan’s limit. To keep working before it resets:",
  );
});

test("the limit dialog offers Add funds with its benefits, else Get more usage", () => {
  const html = (addFunds: boolean) =>
    renderToStaticMarkup(
      createElement(LimitReachedBody, {
        status: weekly,
        addFunds,
        onAction() {},
        onClose() {},
      }),
    );
  const funds = html(true);
  assert.match(funds, /Add funds/);
  assert.match(funds, /Pay only for what you use/);
  const more = html(false);
  assert.match(more, /Get more usage/);
  assert.match(more, /Wait until/);
  assert.doesNotMatch(more, /Pay only for what you use/);
});

test("without a locale the dialog's times follow the interface language", async () => {
  const locale = currentLocale();
  try {
    await setLocale("zh-CN");
    const week = limitDialogText(weekly);
    assert.match(week.wait, /星期[一二三四五六日天]/, week.wait);
    assert.ok(!/(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/.test(week.wait));
    const session = limitDialogText({ ...weekly, reason: "session" });
    assert.match(session.wait, /\d{1,2}:\d{2}/);
  } finally {
    await setLocale(locale);
  }
});
