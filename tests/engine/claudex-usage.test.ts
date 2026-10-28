import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  envelopeData,
  parseUsageStatus,
  type ClaudexUsageStatus,
} from "../../shared/claudex-contract";
import { openPolicy, type ClientPolicy } from "../../shared/client-policy";
import {
  bannerWindow,
  blockedUntil,
  planWindowsFromStatus,
} from "../../shared/plan-usage";
import type { PlanUsage, PlanUsageWindow } from "../../shared/usage-api";
import {
  ClaudexUsageReader,
  fetchUsageStatus,
  planUsageFromStatus,
  usageCacheMs,
} from "../../electron/sub2api/claudex-usage";
import {
  blockedStatus,
  blockFor,
  planWindows,
  weeklyFromUsageStatus,
  type TimedRefusal,
} from "../../electron/sub2api/quota";
import { Sub2ApiError } from "../../electron/sub2api/http";
import { RemoteAccounts } from "../../electron/sub2api/identity";
import { remoteBannerPolicy } from "../../electron/account/remote-mode";
import {
  currentPlanUsage,
  currentWeeklyUsage,
  weeklyUsageTurns,
} from "../../electron/ipc/usage";
import {
  headline,
  pace,
  periodWord,
  resetText,
  rowLabel,
  rowNote,
  rowSeverity,
  spendText,
  updatedText,
} from "../../src/settings/planUsageFormat";
import { MockSub2Api, fakeCipher, ok } from "../support/sub2api-mock";
import type { AppContext } from "../../electron/app/app-context";

type Json = Record<string, any>;
const fixture = (name: string): Json =>
  envelopeData(
    JSON.parse(
      fs.readFileSync(
        fileURLToPath(
          new URL(
            `../../backend/backend/internal/claudex/contract/testdata/${name}.json`,
            import.meta.url,
          ),
        ),
        "utf8",
      ),
    ),
  ) as Json;
const hour = 3_600_000;
const day = 24 * hour;
const week = 604_800;

function limit(
  kind: PlanUsageWindow["kind"],
  percent: number,
  resetsAt: number | null,
  extra: Partial<PlanUsageWindow> = {},
): PlanUsageWindow {
  return {
    id: `${kind}:${percent}`,
    kind,
    label: kind === "models" ? "Opus" : "All models",
    windowSeconds: kind === "session" ? 18_000 : week,
    usedUsd: percent,
    limitUsd: 100,
    percent,
    resetsAt,
    active: resetsAt !== null,
    exceeded: percent >= 100,
    models: kind === "models" ? ["claude-opus-*"] : null,
    ...extra,
  };
}

test("usage-status windows keep the service's order, grouped by kind", () => {
  const status = parseUsageStatus(fixture("usage-status.plan"));
  assert.deepEqual(
    planWindowsFromStatus(status).map((w) => [w.id, w.kind, w.label]),
    [
      ["rule:3", "session", "Current session"],
      ["subscription:weekly", "all_models", "All models"],
      ["rule:5", "models", "Opus"],
      ["subscription:daily", "daily", "Daily"],
      ["key:5h", "key", "This device · 5 hours"],
    ],
  );
  // Out of order on the wire: grouped by kind, same-kind order kept.
  const shuffled = structuredClone(fixture("usage-status.plan"));
  const opus2 = { ...shuffled.windows[2], id: "rule:9", label: "Sonnet" };
  shuffled.windows = [
    shuffled.windows[4],
    shuffled.windows[2],
    shuffled.windows[3],
    opus2,
    shuffled.windows[1],
    shuffled.windows[0],
  ];
  assert.deepEqual(
    planWindowsFromStatus(parseUsageStatus(shuffled)).map((w) => w.id),
    [
      "rule:3",
      "subscription:weekly",
      "rule:5",
      "rule:9",
      "subscription:daily",
      "key:5h",
    ],
  );
  const opus = planWindowsFromStatus(status)[2];
  assert.deepEqual(
    [opus.active, opus.resetsAt, opus.models, opus.windowSeconds],
    [false, null, ["claude-opus-*"], week],
  );
});

test("older services: /subscriptions/progress becomes the same windows", () => {
  const at = Date.parse("2026-09-28T00:00:00Z");
  const windows = planWindows({
    groupId: 4,
    groupName: "Pro",
    expiresAt: null,
    daily: { limitUsd: 2, usedUsd: 0.5, percentage: 25, resetsAt: at },
    weekly: { limitUsd: 10, usedUsd: 10, percentage: 100, resetsAt: at },
    monthly: { limitUsd: 0, usedUsd: 0, percentage: 0, resetsAt: at },
  } as never);
  assert.deepEqual(
    windows.map((w) => [w.id, w.kind, w.label, w.exceeded]),
    [
      ["subscription:weekly", "all_models", "All models", true],
      ["subscription:daily", "daily", "Daily", false],
    ],
  );
});

test("the reader asks the service, caches for 15 s and remembers an older service", async () => {
  let now = 1_000_000;
  let calls = 0;
  const status = parseUsageStatus(fixture("usage-status.plan"));
  let reply: () => Promise<ClaudexUsageStatus> = async () => status;
  const reader = new ClaudexUsageReader(
    () => {
      calls++;
      return reply();
    },
    () => undefined,
    () => now,
  );
  assert.equal(await reader.status(), status);
  assert.equal(await reader.status(), status);
  assert.equal(calls, 1);
  assert.equal(reader.readAt, 1_000_000);
  await reader.status(true);
  assert.equal(calls, 2);
  now += usageCacheMs;
  await reader.status();
  assert.equal(calls, 3);
  reader.invalidate();
  await reader.status();
  assert.equal(calls, 4);
  // Other failures are reported and asked again next time.
  reply = async () => {
    throw new Sub2ApiError(500, "HTTP_500", "boom");
  };
  await assert.rejects(reader.status(true), /boom/);
  // A 404 means no Claudex routes: the caller reads the older routes.
  reply = async () => {
    throw new Sub2ApiError(404, "NOT_FOUND", "no");
  };
  assert.equal(await reader.status(true), undefined);
  assert.equal(reader.supported, false);
  assert.equal(await reader.status(true), undefined);
  assert.equal(calls, 6);

  // The bootstrap's feature flag decides without asking.
  let asked = 0;
  const off = new ClaudexUsageReader(
    async () => {
      asked++;
      return status;
    },
    () => false,
  );
  assert.equal(await off.status(), undefined);
  assert.equal(asked, 0);
});

test("usage-status goes to the service with the device id and the plan group", async () => {
  const mock = new MockSub2Api({
    users: [{ id: 3, email: "bob@example.test", password: "bob-password" }],
  });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-usage-"));
  try {
    let query = "";
    mock.route("GET", "/api/v1/claudex/usage-status", (request) => {
      query = request.url.search;
      return ok(fixture("usage-status.plan"));
    });
    const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
    const login = await accounts.login("bob@example.test", "bob-password");
    assert.equal(login.kind, "signedIn");
    const session = (login as { session: any }).session;
    const device = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const status = await session.authorized((token: string) =>
      fetchUsageStatus(mock.url, token, { deviceId: device, groupId: 4 }),
    );
    assert.equal(status.windows.length, 5);
    assert.equal(query, "?group_id=4");
    const sent = mock.requests.filter((r) =>
      r.path.endsWith("/usage-status"),
    )[0];
    assert.equal(sent.headers["x-claudex-device-id"], device);
    assert.match(String(sent.headers.authorization), /^Bearer /);
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const banner = { warnPercent: 60, moreUsageUrl: "https://example.com/more" };

test("the banner follows the all-models window, with the policy's threshold", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const status = parseUsageStatus(fixture("usage-status.plan"));
  const windows = planWindowsFromStatus(status);
  const weekly = weeklyFromUsageStatus(status, windows, banner, now)!;
  assert.deepEqual(
    [weekly.state, weekly.percent, weekly.used, weekly.limit, weekly.resetsAt],
    ["ok", 30, 30, 100, Date.parse("2026-09-29T00:00:00Z")],
  );
  assert.equal(weekly.warnPercent, 60);
  assert.equal(weekly.moreUsageUrl, "https://example.com/more");
  // The threshold is the policy's, not limits.json's 80.
  const near = [limit("all_models", 65, now + day)];
  assert.equal(
    weeklyFromUsageStatus(status, near, banner, now)!.state,
    "warning",
  );
  // Several all-models windows: the one closest to its limit.
  assert.equal(
    bannerWindow([
      limit("all_models", 20, now + day),
      limit("all_models", 70, now + day, { id: "rule:7" }),
    ])!.id,
    "rule:7",
  );
  // A window that has not started resets a full window from now.
  const idle = [limit("all_models", 0, null)];
  assert.equal(
    weeklyFromUsageStatus(status, idle, banner, now)!.resetsAt,
    now + week * 1000,
  );
  assert.equal(weeklyFromUsageStatus(status, [], banner, now), null);
});

test("a blocking window keeps the banner exceeded until its reset", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const raw = structuredClone(fixture("usage-status.plan"));
  raw.windows[0].exceeded = true;
  raw.windows[0].percent = 100;
  raw.blocked = {
    blocked: true,
    window_id: "rule:3",
    reason: "RULE_LIMIT",
    resets_at: "2026-09-26T14:00:00Z",
  };
  const status = parseUsageStatus(raw);
  assert.equal(blockedUntil(status, now), Date.parse("2026-09-26T14:00:00Z"));
  const weekly = weeklyFromUsageStatus(
    status,
    planWindowsFromStatus(status),
    banner,
    now,
  )!;
  assert.deepEqual(
    [weekly.state, weekly.percent, weekly.resetsAt],
    ["exceeded", 30, Date.parse("2026-09-26T14:00:00Z")],
  );
  // The dismissal of an exceeded banner lasts until that reset.
  assert.equal(
    weeklyFromUsageStatus(status, planWindowsFromStatus(status), banner, now, {
      resetsAt: Date.parse("2026-09-26T14:00:00Z"),
      exceeded: true,
    })!.dismissed,
    true,
  );
  // Without `blocked`, the latest reset among exceeded windows.
  raw.blocked = null;
  const early = Date.parse("2026-09-26T02:00:00Z");
  assert.equal(
    blockedUntil(parseUsageStatus(raw), early),
    Date.parse("2026-09-26T06:00:00Z"),
  );
  // Past resets block nothing.
  assert.equal(blockedUntil(parseUsageStatus(raw), now), null);
});

test("a refusal holds the banner until the reset the service named", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const refusal: TimedRefusal = {
    status: 429,
    code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
    reason: "weekly",
    exceeded: true,
    invalidKey: false,
    message: "You've reached the Opus limit.",
    resetsAt: Date.parse("2026-10-02T08:00:00Z"),
  };
  const progress = {
    groupId: 4,
    groupName: "Pro",
    expiresAt: null,
    weekly: {
      limitUsd: 10,
      usedUsd: 3,
      percentage: 30,
      resetsAt: now + day,
    },
  } as never;
  const block = blockFor(refusal, progress, now);
  assert.equal(block.until, Date.parse("2026-10-02T08:00:00Z"));
  const base = {
    used: 3,
    limit: 10,
    percent: 30,
    warnPercent: 80,
    resetsAt: now + day,
    moreUsageUrl: null,
    state: "ok" as const,
    dismissed: false,
    unit: "usd" as const,
  };
  assert.equal(
    blockedStatus(base, block, banner, undefined).resetsAt,
    Date.parse("2026-10-02T08:00:00Z"),
  );
  // Older services name no reset: the refused plan window's, as before.
  const legacy = blockFor({ ...refusal, resetsAt: undefined }, progress, now);
  assert.equal(legacy.until, now + day);
  assert.equal(
    blockedStatus(base, legacy, banner, undefined).resetsAt,
    now + day,
  );
  // A reset in the past is ignored.
  assert.equal(
    blockFor({ ...refusal, resetsAt: now - 1 }, undefined, now).until,
    now + week * 1000,
  );
});

test("the banner's threshold and page come from the policy, not limits.json", async () => {
  const accounts = {
    publicSettings: async () => ({ purchaseUrl: "https://shop.example.com" }),
  } as unknown as RemoteAccounts;
  const policy = (links: ClientPolicy["links"], warnPercent = 70) => ({
    usageBanner: { warnPercent },
    links,
  });
  assert.deepEqual(
    await remoteBannerPolicy(
      policy({ learnMore: [], getMoreUsage: "https://more.example.com" }),
      accounts,
    ),
    { warnPercent: 70, moreUsageUrl: "https://more.example.com" },
  );
  // No page in the policy: the service's purchase page.
  assert.deepEqual(
    await remoteBannerPolicy(policy({ learnMore: [] }, 85), accounts),
    { warnPercent: 85, moreUsageUrl: "https://shop.example.com" },
  );
  const noShop = {
    publicSettings: async () => ({ purchaseUrl: "http://plain.example.com" }),
  } as unknown as RemoteAccounts;
  assert.equal(
    (await remoteBannerPolicy(policy({ learnMore: [] }), noShop)).moreUsageUrl,
    null,
  );
});

/** Settings → Usage and the banner through the IPC functions, against the mock service. */
async function remoteContext(options: {
  claudex?: boolean;
  policy?: ClientPolicy;
}) {
  const mock = new MockSub2Api({
    users: [{ id: 3, email: "bob@example.test", password: "bob-password" }],
    claudex: options.claudex,
    usageStatus: fixture("usage-status.plan"),
  });
  await mock.start();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claudex-usage-ipc-"));
  const accounts = new RemoteAccounts(root, mock.url, fakeCipher);
  const login = await accounts.login("bob@example.test", "bob-password");
  const session = (login as { session: any }).session;
  const legacyPlan: PlanUsage = {
    plan: "claudex-pro",
    expiresAt: null,
    windows: [limit("all_models", 40, Date.now() + day)],
    updatedAt: 1,
    warnPercent: 80,
    learnMoreUrl: "https://docs.example.com/usage",
  };
  const legacyCalls: string[] = [];
  const backend = {
    plan: { groupId: 4, expiresAt: Date.parse("2026-10-25T00:00:00Z") },
    planName: "claudex-pro",
    refusal: undefined as TimedRefusal | undefined,
    planUsage: async (warn: number) => {
      legacyCalls.push(`planUsage ${warn}`);
      return legacyPlan;
    },
    weeklyStatus: async () => {
      legacyCalls.push("weeklyStatus");
      return null;
    },
  };
  const remote = {
    session,
    accounts,
    backend,
    clearRefusal() {},
  };
  const ctx = {
    dataRoot: root,
    store: { root },
    activeAccount: { id: "remote-3" },
    credentials: {},
    remote,
    policy: () => options.policy ?? openPolicy,
    push() {},
  };
  return {
    ctx: ctx as never,
    mock,
    backend,
    legacyCalls,
    async done() {
      await mock.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test(
  "Settings → Usage reads usage-status from the Claudex service",
  { timeout: 15_000 },
  async () => {
    const policy: ClientPolicy = {
      ...openPolicy,
      planLabel: "Pro (5x)",
      usageBanner: { warnPercent: 75 },
      links: {
        learnMore: [],
        usageLearnMore: "https://help.example.com/usage",
      },
    };
    const env = await remoteContext({ policy });
    try {
      const usage = (await currentPlanUsage(env.ctx, false))!;
      assert.deepEqual(
        usage.windows.map((w) => w.kind),
        ["session", "all_models", "models", "daily", "key"],
      );
      assert.deepEqual(
        [usage.plan, usage.warnPercent, usage.learnMoreUrl, usage.balanceUsd],
        ["Pro (5x)", 75, "https://help.example.com/usage", null],
      );
      assert.equal(usage.expiresAt, Date.parse("2026-10-25T00:00:00Z"));
      assert.deepEqual(env.legacyCalls, []);
      // Cached: the banner does not ask again within 15 s.
      const reads = () =>
        env.mock.calls.filter((c) => c.endsWith("/usage-status")).length;
      const weekly = (await currentWeeklyUsage(env.ctx))!;
      assert.deepEqual([weekly.percent, weekly.warnPercent], [30, 75]);
      assert.equal(reads(), 1);
      // A finished turn reads the windows again.
      const refreshed = new Promise<void>((resolve) => {
        (env.ctx as AppContext).push = (event) => {
          if (event.type === "weekly-usage") resolve();
        };
      });
      const turns = weeklyUsageTurns(env.ctx);
      turns.observe({ id: "c", turns: [{ status: "inProgress" }] } as never);
      turns.observe({ id: "c", turns: [{ status: "completed" }] } as never);
      // Observe the real post-fetch IPC event, independent of host load.
      await refreshed;
      assert.equal(reads(), 2);
      // A held refusal turns the banner exceeded until its reset.
      env.backend.refusal = {
        status: 429,
        code: "CLAUDEX_USAGE_LIMIT_EXCEEDED",
        exceeded: true,
        invalidKey: false,
        message: "",
        resetsAt: Date.now() + 2 * hour,
      };
      const held = (await currentWeeklyUsage(env.ctx))!;
      assert.equal(held.state, "exceeded");
      assert.equal(held.resetsAt, env.backend.refusal.resetsAt);
      // Without resets_at (before C3), the end is fixed when first seen.
      env.backend.refusal = { ...env.backend.refusal, resetsAt: undefined };
      const first = (await currentWeeklyUsage(env.ctx))!.resetsAt;
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await currentWeeklyUsage(env.ctx))!.resetsAt, first);
    } finally {
      await env.done();
    }
  },
);

test("a service without usage-status keeps the plan windows and its docs page", async () => {
  const env = await remoteContext({ claudex: false });
  try {
    const usage = (await currentPlanUsage(env.ctx, true))!;
    assert.equal(usage.learnMoreUrl, "https://docs.example.com/usage");
    assert.deepEqual(env.legacyCalls, ["planUsage 80"]);
    await currentWeeklyUsage(env.ctx);
    assert.deepEqual(env.legacyCalls, ["planUsage 80", "weeklyStatus"]);
    // The 404 is remembered: no second try.
    await currentPlanUsage(env.ctx, true);
    assert.equal(
      env.mock.calls.filter((c) => c.endsWith("/usage-status")).length,
      1,
    );
  } finally {
    await env.done();
  }
});

test("a balance plan shows its balance", () => {
  const raw = structuredClone(fixture("usage-status.plan"));
  raw.plan.billing_mode = "balance";
  raw.windows = [];
  const usage = planUsageFromStatus(parseUsageStatus(raw), {
    plan: undefined,
    expiresAt: null,
    warnPercent: 80,
    learnMoreUrl: null,
    readAt: 5,
  });
  assert.deepEqual(
    [usage.plan, usage.balanceUsd, usage.windows, usage.updatedAt],
    ["claudex-pro", 12.34, [], 5],
  );
});

test("usage rows read like the original page", () => {
  const now = new Date(2026, 8, 26, 23, 0).getTime(); // Saturday 11 PM
  assert.equal(
    resetText(new Date(2026, 8, 26, 23, 30).getTime(), now),
    "Resets at 11:30 PM",
  );
  assert.equal(
    resetText(new Date(2026, 8, 27, 4, 30).getTime(), now, "short"),
    "Resets Sun 4:30 AM",
  );
  assert.equal(
    resetText(new Date(2026, 8, 28, 17, 0).getTime(), now),
    "Resets Monday 5:00 PM",
  );
  assert.equal(
    resetText(new Date(2026, 9, 12, 9, 0).getTime(), now),
    "Resets Oct 12, 9:00 AM",
  );
  const session = limit("session", 30, now + 5 * hour);
  const weekly = limit("all_models", 8, now + 2 * day);
  const opus = limit("models", 0, null);
  assert.deepEqual(
    [rowLabel(session), rowLabel(weekly), rowLabel(opus)],
    ["Current session", "This week", "Opus this week"],
  );
  assert.equal(rowNote(session, now), "Resets Sun 4:00 AM");
  assert.equal(rowNote(opus, now), "Separate weekly limit for Opus");
  assert.equal(
    rowNote(limit("session", 0, null), now),
    "Starts with your first message",
  );
  assert.equal(
    rowNote({ ...opus, resetsAt: now + 2 * day, active: true }, now),
    `Separate weekly limit for Opus · Resets Monday 11:00 PM`,
  );
  assert.equal(
    rowNote({ ...opus, windowSeconds: 86_400 }, now),
    "You haven’t used Opus yet",
  );
  // Other windows keep the service's label.
  assert.equal(
    rowLabel(limit("key", 5, now, { label: "This device · 5 hours" })),
    "This device · 5 hours",
  );
  assert.equal(
    rowLabel(limit("all_models", 5, now, { windowSeconds: 86_400 })),
    "All models",
  );
  assert.deepEqual(
    [periodWord(18_000), periodWord(86_400), periodWord(2_592_000)],
    ["5-hour", "daily", "30-day"],
  );
  assert.equal(spendText({ usedUsd: 1.2, limitUsd: 5 }), "$1.20 of $5.00");
  assert.deepEqual(
    [74, 75, 89, 90].map((percent) =>
      rowSeverity(limit("all_models", percent, now)),
    ),
    ["normal", "warning", "warning", "critical"],
  );
  assert.equal(updatedText(now, now), "Last updated: just now");
  assert.equal(
    updatedText(now - 10_000, now),
    "Last updated: less than a minute ago",
  );
  assert.equal(updatedText(now - 60_000, now), "Last updated: 1 minute ago");
  assert.equal(
    updatedText(now - 5 * 60_000, now),
    "Last updated: 5 minutes ago",
  );
  assert.equal(updatedText(now - 3 * hour, now), "Last updated: 8:00 PM");
});

test("the headline follows the original's pace states", () => {
  const monday = new Date(2026, 8, 28, 17, 0).getTime();
  const start = monday - week * 1000;
  const at = (
    percent: number,
    when: number,
    resetsAt: number | null = monday,
  ) => pace([limit("all_models", percent, resetsAt)], when);
  assert.deepEqual(at(0, start + day), {
    state: "zero",
    text: "No usage yet. 100% of your weekly limit is available.",
  });
  assert.equal(
    at(8, start + 12 * hour)?.text,
    "Fresh week. 8% of your weekly limit used.",
  );
  // Under half a day in.
  assert.equal(
    at(30, start + 6 * hour)?.text,
    "30% of your weekly limit used.",
  );
  // Five days in at 49%: the same pace stays under the limit.
  assert.equal(
    at(49, start + 5 * day)?.text,
    "On track. You should reach Monday’s reset with room to spare.",
  );
  // Three days in at 90%: out by Thursday afternoon.
  const thursday = start + 3 * day;
  assert.deepEqual(at(90, thursday), {
    state: "heads_up",
    text: "Heads up. At this pace you’ll run out tonight, before Monday’s reset.",
  });
  assert.match(
    at(100, thursday)!.text,
    /^Limit hit\. You can send new messages when your week resets Monday, 5:00 PM \S+\.$/,
  );
  assert.equal(
    at(100, thursday, null)?.text,
    "Limit hit. You can send new messages when your week resets.",
  );
  // Without a weekly window: a refused window first.
  assert.equal(
    headline(
      [limit("session", 100, new Date(2026, 8, 26, 9, 30).getTime())],
      new Date(2026, 8, 26, 6, 0).getTime(),
    ),
    "You’ve hit your session limit. It resets at 9:30 AM.",
  );
  assert.equal(headline([limit("session", 10, monday)], start), null);
});

test("a week's per-model limits fold under This week", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { LimitRowsForTests } = await import("../../src/settings/tabs/Usage");
  const now = Date.UTC(2026, 9, 1);
  const html = renderToStaticMarkup(
    createElement(LimitRowsForTests, {
      windows: [
        limit("session", 10, now + hour),
        limit("all_models", 40, now + 2 * day),
        limit("models", 20, now + 2 * day),
      ],
      now,
    }),
  );
  assert.match(html, /data-testid="pace-week" data-state="closed"/);
  assert.match(
    html,
    /data-testid="pace-week-toggle" aria-expanded="false">This week/,
  );
  assert.doesNotMatch(html, /pace-week-scoped/);
  assert.match(html, /Current session/);
  const flat = renderToStaticMarkup(
    createElement(LimitRowsForTests, {
      windows: [limit("all_models", 40, now + 2 * day)],
      now,
    }),
  );
  assert.doesNotMatch(flat, /pace-week/);
});
