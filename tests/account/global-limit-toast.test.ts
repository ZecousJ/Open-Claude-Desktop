import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WeeklyUsageStatus } from "../../shared/usage-api";
import { openPolicy } from "../../shared/client-policy";
import {
  scheduleResetReminder,
  withGlobalLimit,
  withResetNotification,
} from "../../electron/ipc/usage";
import { GlobalLimitView } from "../../src/policy/GlobalLimitToast";
import { NoticeView } from "../../src/policy/NoticeView";
import {
  formatResetClock,
  globalLimitKey,
  globalLimitText,
  usageNotice,
} from "../../src/policy/notice-content";

const resetsAt = new Date(2026, 8, 26, 9, 30).getTime();

const exceeded: WeeklyUsageStatus = {
  used: 5,
  limit: 5,
  percent: 100,
  warnPercent: 80,
  resetsAt,
  moreUsageUrl: "https://usage.example.com/claudex",
  state: "exceeded",
  dismissed: false,
  unit: "usd",
  reason: "session",
};

test("the corner notice says which limit and when it resets (R-0314 wording)", () => {
  assert.equal(formatResetClock(resetsAt), "9:30\u00a0AM");
  assert.equal(
    globalLimitText({ kind: "session", resetsAt }),
    "You’ve hit your limit for Claudex messages. Limits will reset at 9:30\u00a0AM.",
  );
  assert.equal(
    globalLimitText({ kind: "session", resetsAt: null }),
    "You’ve hit your limit for Claudex messages.",
  );
  assert.equal(
    globalLimitText({ kind: "rate-limit", resetsAt }),
    "Too many requests right now. Try again at 9:30\u00a0AM.",
  );
  assert.notEqual(
    globalLimitKey({ kind: "session", resetsAt }),
    globalLimitKey({ kind: "session", resetsAt: resetsAt + 1 }),
  );
});

test("the corner notice links to the usage details only when it can open them", () => {
  const withLink = renderToStaticMarkup(
    createElement(GlobalLimitView, {
      notice: { kind: "session", resetsAt },
      onViewUsage: () => {},
      onDismiss: () => {},
    }),
  );
  assert.match(withLink, /class="global-limit-toast"/);
  assert.match(withLink, /role="alert"/);
  assert.match(withLink, /View your usage details<\/button>\./);
  assert.match(withLink, /aria-label="Dismiss"/);
  const without = renderToStaticMarkup(
    createElement(GlobalLimitView, {
      notice: { kind: "rate-limit", resetsAt: null },
      onDismiss: () => {},
    }),
  );
  assert.doesNotMatch(without, /View your usage details/);
  assert.match(without, /data-limit="rate-limit"/);
});

test("the status carries the notice; without a banner a quiet status carries it alone", () => {
  const notice = { kind: "rate-limit" as const, resetsAt: null };
  assert.equal(withGlobalLimit(exceeded, undefined, openPolicy), exceeded);
  assert.deepEqual(withGlobalLimit(exceeded, notice, openPolicy), {
    ...exceeded,
    globalLimit: notice,
  });
  const alone = withGlobalLimit(null, notice, openPolicy, 1_000)!;
  assert.equal(alone.state, "ok");
  assert.equal(alone.globalLimit, notice);
  assert.equal(alone.resetsAt, 61_000);
  // The quiet status shows no banner.
  assert.equal(usageNotice(alone, "usage", "chat"), null);
  assert.equal(usageNotice(alone, "service", "chat"), null);
});

test("Get notified is offered only when this computer can notify, and only once", () => {
  const now = resetsAt - 60 * 60 * 1000;
  assert.equal(
    withResetNotification(exceeded, "acct", now, false),
    exceeded,
    "no system notifications: no button",
  );
  const offered = withResetNotification(exceeded, "acct", now, true)!;
  assert.equal(offered.resetNotification, "available");
  const banner = usageNotice(offered, "usage", "chat")!;
  assert.deepEqual(banner.secondary, { kind: "notify", label: "Get notified" });
  const html = renderToStaticMarkup(
    createElement(NoticeView, {
      content: banner,
      surface: "chat",
      variant: "home",
      onAction: () => {},
      onSecondary: () => {},
      onDismiss: () => {},
    }),
  );
  assert.ok(
    html.indexOf("Get notified") < html.indexOf("Get more usage"),
    "Get notified comes before Get more usage",
  );
  // A warning, a passed reset or one too far away offers nothing.
  assert.equal(
    withResetNotification({ ...exceeded, state: "warning" }, "acct", now, true)!
      .resetNotification,
    undefined,
  );
  assert.equal(
    withResetNotification(exceeded, "acct", resetsAt + 1, true)!
      .resetNotification,
    undefined,
  );
  // Without a handler the button is not drawn (no dead control).
  assert.doesNotMatch(
    renderToStaticMarkup(
      createElement(NoticeView, {
        content: banner,
        surface: "chat",
        variant: "home",
        onDismiss: () => {},
      }),
    ),
    /Get notified/,
  );
});

test("the reset reminder fires once for the account that asked", async () => {
  const shown: string[] = [];
  const ctx = { activeAccount: { id: "acct-r" } } as never;
  const soon = Date.now() + 30;
  assert.equal(
    scheduleResetReminder(ctx, "acct-r", soon, Date.now(), (_title, body) =>
      shown.push(body),
    ),
    true,
  );
  // Asking again for the same reset changes nothing.
  assert.equal(scheduleResetReminder(ctx, "acct-r", soon), true);
  assert.equal(
    withResetNotification(
      { ...exceeded, resetsAt: soon },
      "acct-r",
      Date.now(),
      true,
    )!.resetNotification,
    "scheduled",
  );
  // Another account signed in by then hears nothing.
  const other = { activeAccount: { id: "someone-else" } } as never;
  scheduleResetReminder(other, "acct-gone", Date.now() + 30, Date.now(), () =>
    shown.push("wrong account"),
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(shown, [
    "Your usage limit has reset. You can send messages again.",
  ]);
  // A reset in the past or months away is refused.
  assert.equal(scheduleResetReminder(ctx, "acct-r", Date.now() - 1), false);
  assert.equal(
    scheduleResetReminder(ctx, "acct-r", Date.now() + 40 * 86_400_000),
    false,
  );
});
