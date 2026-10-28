import test from "node:test";
import assert from "node:assert/strict";
import {
  bannerText,
  bannerVisible,
  formatReset,
} from "../../src/composer/usageBanner";
import type { WeeklyUsageStatus } from "../../shared/types";
import { currentLocale, setLocale } from "../../src/i18n";

const status: WeeklyUsageStatus = {
  used: 850,
  limit: 1000,
  percent: 85,
  warnPercent: 80,
  resetsAt: Date.UTC(2026, 8, 29, 0), // Mon 28 Sep 17:00 in Los Angeles
  moreUsageUrl: null,
  state: "warning",
  dismissed: false,
};

test("usage banner wording follows the captures and names the exceeded state", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    // Intl may separate the time and PM with a narrow no-break space.
    const reset = formatReset(status.resetsAt).replace(/\s/g, " ");
    assert.equal(reset, "Mon, Sep 28, 5:00 PM");
    assert.equal(
      bannerText(status, "code").title,
      "Approaching weekly usage limit",
    );
    assert.match(
      bannerText(status, "code").detail!,
      /^Resets Mon, Sep 28, 5:00/,
    );
    assert.deepEqual(bannerText(status, "chat"), {
      title: "You’ve used 85% of your weekly limit",
    });
    const exceeded = { ...status, state: "exceeded" as const, percent: 100 };
    assert.equal(
      bannerText(exceeded, "code").title,
      "Weekly usage limit reached",
    );
    assert.equal(
      bannerText(exceeded, "chat").title,
      "You’ve reached your weekly limit",
    );
    assert.match(bannerText(exceeded, "chat").detail!, /^Resets /);
    process.env.TZ = "Asia/Shanghai";
    assert.match(formatReset(status.resetsAt), /^Tue, Sep 29, 8:00/);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
  assert.equal(bannerVisible(status), true);
  assert.equal(bannerVisible({ ...status, state: "ok" }), false);
  assert.equal(bannerVisible({ ...status, dismissed: true }), false);
  assert.equal(bannerVisible(null), false);
});

test("the reset time follows the interface language, not en-US", async () => {
  const previous = process.env.TZ;
  const locale = currentLocale();
  process.env.TZ = "Asia/Shanghai";
  try {
    await setLocale("zh-CN");
    const text = bannerText(status, "code").detail!;
    assert.ok(!/Mon|Tue|Sep/.test(text), text);
    assert.match(text, /^重置.*(周二|星期二)/, text);
    assert.ok(text.includes("29"), text);
  } finally {
    await setLocale(locale);
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
