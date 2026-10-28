import test from "node:test";
import assert from "node:assert/strict";
import { setLocale } from "../../src/i18n";
import { runTime } from "../../src/collections/routines/routine-list";
import { projectDate } from "../../src/collections/projects/project-list";
import { editedLabel } from "../../src/collections/customize/customize-list";
import { formatPublished } from "../../src/settings/directory/directory-helpers";
import { money, shortDate, dateTime } from "../../src/settings/billing/quote";
import { money as usageMoney } from "../../src/settings/planUsageFormat";
import {
  quietTimeOptions,
  quietWeekdays,
  reminderChoices,
} from "../../src/settings/time-options";

const date = new Date(2026, 8, 30, 14, 30);
const at = date.getTime();

test("dates and money follow the selected interface locale, including repeated changes", async () => {
  try {
    for (const locale of [
      "en-US",
      "zh-CN",
      "de-DE",
      "fr-FR",
      "hi-IN",
      "ja-JP",
      "en-US",
    ]) {
      await setLocale(locale);
      assert.equal(
        // A date from another year keeps its year (the card's relative time).
        projectDate(at, new Date(2027, 0, 15).getTime()),
        date.toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        locale,
      );
      assert.equal(
        runTime(at),
        date.toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
        locale,
      );
      assert.equal(
        editedLabel(at, at),
        date.toLocaleDateString(locale, { month: "short", day: "numeric" }),
        locale,
      );
      assert.equal(
        formatPublished("2026-09-30"),
        new Date("2026-09-30T12:00:00Z").toLocaleDateString(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        locale,
      );
      assert.equal(
        shortDate(at),
        new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(date),
        locale,
      );
      assert.equal(
        dateTime(at),
        new Intl.DateTimeFormat(locale, {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(date),
        locale,
      );
      for (const currency of ["USD", "CNY", "JPY", "EUR"]) {
        assert.equal(
          money(1234.5, currency),
          new Intl.NumberFormat(locale, { style: "currency", currency }).format(
            1234.5,
          ),
          `${locale}/${currency}`,
        );
      }
      assert.equal(
        usageMoney(1234.5),
        new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(1234.5),
      );
      assert.equal(
        money(1234.5, "invalid-code"),
        `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(1234.5)} invalid-code`,
      );
    }
  } finally {
    await setLocale("en-US");
  }
});

test("quiet-time labels localize without changing stored time values or Sunday-based day indexes", () => {
  const expectedValues = quietTimeOptions("en-US").map(
    (option) => option.value,
  );
  for (const locale of ["en-US", "zh-CN", "de-DE", "fr-FR", "ja-JP", "hi-IN"]) {
    const times = quietTimeOptions(locale);
    assert.equal(times.length, 48);
    assert.deepEqual(
      times.map((option) => option.value),
      expectedValues,
    );
    assert.equal(times[0].value, "00:00");
    assert.equal(times[47].value, "23:30");
    const formatter = new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
    assert.equal(
      times[29].label,
      formatter.format(new Date(Date.UTC(2000, 0, 2, 14, 30))),
    );
    const days = quietWeekdays(locale);
    assert.equal(days.length, 7);
    for (let index = 0; index < 7; index++) {
      const day = new Date(Date.UTC(2000, 0, 2 + index));
      assert.equal(
        days[index].short,
        new Intl.DateTimeFormat(locale, {
          weekday: "narrow",
          timeZone: "UTC",
        }).format(day),
      );
      assert.equal(
        days[index].full,
        new Intl.DateTimeFormat(locale, {
          weekday: "long",
          timeZone: "UTC",
        }).format(day),
      );
    }
  }
});

test("reminder choice units and numerals localize while persistence remains numeric", () => {
  for (const locale of ["en-US", "zh-CN", "de-DE", "hi-IN"]) {
    for (const unit of ["hour", "minute"] as const) {
      const choices = reminderChoices(locale, unit, [0, 1, 15]);
      assert.deepEqual(
        choices.map((option) => option.value),
        ["", "0", "1", "15"],
      );
      assert.equal(choices[0].label, "–");
      assert.equal(
        choices[3].label,
        new Intl.NumberFormat(locale, {
          style: "unit",
          unit,
          unitDisplay: "short",
        }).format(15),
      );
    }
  }
});

test("usage units, decimals and USD formatting follow the app locale", async () => {
  const { compact, cost, duration } =
    await import("../../src/settings/usage-activity/format");
  try {
    for (const locale of ["en-US", "zh-CN", "de-DE", "fr-FR", "ja-JP"]) {
      await setLocale(locale);
      assert.equal(
        compact(12345),
        new Intl.NumberFormat(locale, {
          notation: "compact",
          maximumSignificantDigits: 3,
        }).format(12345),
      );
      assert.equal(
        cost(0.0421),
        new Intl.NumberFormat(locale, {
          style: "currency",
          currency: "USD",
          // "$", not "US$".
          currencyDisplay: "narrowSymbol",
          minimumFractionDigits: 4,
          maximumFractionDigits: 4,
        }).format(0.0421),
      );
      assert.equal(
        duration(1240),
        new Intl.NumberFormat(locale, {
          style: "unit",
          unit: "second",
          unitDisplay: "short",
          maximumFractionDigits: 2,
        }).format(1.24),
      );
    }
  } finally {
    await setLocale("en-US");
  }
});

test("localized plan summaries keep fresh-week semantics and opaque model names", async () => {
  const { headline, rowLabel, rowNote, updatedText } =
    await import("../../src/settings/planUsageFormat");
  const { formatText } = await import("../../src/i18n");
  const now = Date.UTC(2026, 8, 30, 12);
  const window = {
    id: "weekly",
    kind: "all_models" as const,
    label: "Settings",
    active: true,
    models: [],
    windowSeconds: 604800,
    usedUsd: 1,
    limitUsd: 10,
    percent: 8,
    exceeded: false,
    resetsAt: null,
  };
  try {
    for (const locale of ["zh-CN", "de-DE", "ja-JP", "en-US"]) {
      await setLocale(locale);
      assert.equal(
        headline([window], now),
        formatText("Fresh week. {percent}% of your weekly limit used.", {
          percent: "8",
        }),
      );
      assert.ok(rowLabel({ ...window, kind: "models" }).includes("Settings"));
      assert.ok(
        rowNote({ ...window, kind: "models" }, now).includes("Settings"),
      );
      assert.equal(
        updatedText(now - 2 * 60_000, now),
        formatText("Last updated: {minutes} minutes ago", { minutes: "2" }),
      );
      if (locale !== "en-US")
        assert.ok(!headline([window], now)?.includes("Fresh week"));
    }
  } finally {
    await setLocale("en-US");
  }
});
