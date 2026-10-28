import test from "node:test";
import assert from "node:assert/strict";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Conversation, Turn } from "../../shared/types";
import type { PlanUsageWindow } from "../../shared/usage-api";
import {
  sessionUsageFrom,
  usageStatsMethods,
  usageStatsPaths,
  validSessionQuery,
  type SessionUsage,
} from "../../shared/usage-stats-api";
import { createUsageStatsMethods } from "../../src-web/bridge/usage-stats";
import {
  activeMs,
  copyReportText,
  modelFamily,
  reportSession,
  sessionThreadIds,
  shortDuration,
  statCells,
} from "../../src/usage-report/report-model";
import {
  clearUsageReports,
  postUsageReport,
  reportsAfter,
  usageReports,
} from "../../src/usage-report/usage-report-store";
import { sessionHeader } from "../../electron/engine/gateway";

const { UsageReportCard } =
  await import("../../src/usage-report/UsageReportCard");
const { UsageReportsHere } =
  await import("../../src/usage-report/UsageReportsHere");

const now = Date.UTC(2026, 9, 12, 8, 0);

const service: SessionUsage = {
  models: [
    {
      model: "gpt-5.5-mini",
      requests: 2,
      inputTokens: 500,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.1,
      durationMs: 4_000,
    },
    {
      model: "claude-opus-5",
      requests: 3,
      inputTokens: 12_000,
      outputTokens: 3_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 8_000,
      cost: 0.3,
      durationMs: 61_000,
    },
  ],
};

const label = (model: string) =>
  ({ "claude-opus-5": "Opus 5", "gpt-5.5-mini": "GPT-5.5 mini" })[model] ??
  model;

const turn = (over: Partial<Turn>): Turn => ({
  id: "t1",
  prompt: "hi",
  attachments: [],
  items: [],
  status: "completed",
  createdAt: now,
  ...over,
});

test("the service's answer is read, and the query checked, before it is asked", () => {
  assert.ok(usageStatsMethods.includes("sessionUsage"));
  assert.deepEqual(
    sessionUsageFrom({
      models: [
        {
          model: "gpt-5.5",
          requests: 3,
          input_tokens: 1200,
          output_tokens: 300,
          cache_read_tokens: 9000,
          cache_creation_tokens: 10,
          actual_cost: 0.42,
          duration_ms: 61000,
        },
        { model: "", requests: 1 },
        "nonsense",
      ],
    }),
    {
      models: [
        {
          model: "gpt-5.5",
          requests: 3,
          inputTokens: 1200,
          outputTokens: 300,
          cacheReadTokens: 9000,
          cacheWriteTokens: 10,
          cost: 0.42,
          durationMs: 61000,
        },
      ],
    },
  );
  assert.deepEqual(sessionUsageFrom(null), { models: [] });
  assert.equal(
    usageStatsPaths.session({ sessionIds: ["a", "b"], since: now }),
    "/claudex/session-usage?session_id=a&session_id=b&since=2026-10-12T07%3A59%3A00.000Z",
  );
  assert.deepEqual(
    validSessionQuery({ sessionIds: [" a ", "a", "", "b"], since: now }),
    { sessionIds: ["a", "b"], since: now },
  );
  assert.throws(() => validSessionQuery({ sessionIds: [], since: now }));
  assert.throws(() => validSessionQuery({ sessionIds: ["a"], since: NaN }));
});

test("the web asks the service's session route with the session", async () => {
  const seen: string[] = [];
  const methods = createUsageStatsMethods({
    json: async (path: string) => {
      seen.push(path);
      return { code: 0, data: { models: [] } };
    },
  } as never);
  assert.deepEqual(
    await methods.sessionUsage!({ sessionIds: ["thread-1"], since: now }),
    { models: [] },
  );
  assert.match(
    seen[0]!,
    /^\/api\/v1\/claudex\/session-usage\?session_id=thread-1&since=/,
  );
});

test("the gateway names the request's thread as the service's session", () => {
  assert.deepEqual(sessionHeader("019a-thread_1"), {
    session_id: "019a-thread_1",
  });
  assert.deepEqual(sessionHeader(undefined), {});
  assert.deepEqual(sessionHeader("bad id\r\n"), {});
});

test("a session's threads are its own, the rewound one and its saved versions", () => {
  assert.deepEqual(
    sessionThreadIds({
      threadId: "t-1",
      rewind: {
        variant: "pending",
        index: 1,
        threadId: "t-0",
        turns: [],
        at: 0,
      },
      savedBranches: [
        {
          id: "b",
          threadId: "t-1",
          turns: [],
          providerId: "p",
          model: "m",
          visited: 0,
        },
        {
          id: "c",
          threadId: "t-2",
          turns: [],
          providerId: "p",
          model: "m",
          visited: 0,
        },
      ],
    }),
    ["t-1", "t-0", "t-2"],
  );
  assert.deepEqual(sessionThreadIds({}), []);
});

test("active time runs from each finished prompt to its last activity", () => {
  assert.equal(
    activeMs([
      turn({
        items: [
          {
            id: "a",
            type: "agentMessage",
            startedAt: now + 1_000,
            completedAt: now + 30_000,
          },
          { id: "b", type: "commandExecution", startedAt: now + 40_000 },
        ],
      }),
      // Still running: not counted yet.
      turn({
        id: "t2",
        status: "inProgress",
        items: [{ id: "c", type: "x", completedAt: now + 99_000 }],
      }),
    ]),
    40_000,
  );
  assert.equal(activeMs([turn({})]), null);
});

test("the service's record gives one column per model, a Total and the cost cells", () => {
  const session = reportSession({
    service,
    codexTotal: undefined,
    label,
    wallMs: 125_000,
    lines: { added: 12, removed: 3 },
  })!;
  assert.deepEqual(
    session.columns.map((c) => c.label),
    ["Opus 5", "GPT-5.5 mini"],
  );
  assert.equal(session.showTotal, true);
  assert.deepEqual(session.totals, {
    input: 12_500,
    output: 3_100,
    cacheRead: 90_000,
    cacheWrite: 8_000,
  });
  assert.equal(session.result?.apiMs, 65_000);
  const rows = statCells(session, "Cache hit");
  assert.deepEqual(
    rows.map((row) => row.map((cell) => cell.key)),
    [
      ["cost", "api", "active"],
      ["lines", "family-Opus", "family-GPT-5.5 mini"],
      ["cache-hit"],
    ],
  );
  const flat = rows.flat();
  assert.deepEqual(
    flat.find((cell) => cell.key === "family-Opus"),
    { key: "family-Opus", label: "Opus", pct: 75 },
  );
  assert.deepEqual(flat.at(-1), {
    key: "cache-hit",
    label: "Cache hit",
    pct: Math.round((90_000 / (12_500 + 90_000 + 8_000)) * 100),
  });
  assert.equal(modelFamily("claude-sonnet-5", "Sonnet 5"), "Sonnet");
  assert.equal(modelFamily("gpt-5.5", "GPT-5.5"), "GPT-5.5");
});

test("without the service's record Codex's totals stand alone, with no cache writes", () => {
  const session = reportSession({
    service: { models: [] },
    codexTotal: {
      totalTokens: 13_800,
      inputTokens: 13_000,
      cachedInputTokens: 9_000,
      outputTokens: 800,
      reasoningOutputTokens: 0,
    },
    label,
  })!;
  assert.equal(session.result, null);
  assert.deepEqual(session.columns, [
    {
      model: "",
      label: "Total",
      cost: null,
      input: 4_000,
      output: 800,
      cacheRead: 9_000,
      cacheWrite: null,
    },
  ]);
  // Only the cache hit: cost, times and lines need the service's record.
  assert.deepEqual(
    statCells(session, "Cache hit")
      .flat()
      .map((cell) => cell.key),
    ["cache-hit"],
  );
  assert.equal(
    reportSession({ service: null, codexTotal: undefined, label }),
    null,
  );
});

test("durations read short, as the live cells", () => {
  assert.equal(shortDuration(400, "en-US"), "1s");
  assert.equal(shortDuration(42_000, "en-US"), "42s");
  assert.equal(shortDuration(185_000, "en-US"), "3m 5s");
  assert.equal(shortDuration(180_000, "en-US"), "3m");
  assert.equal(shortDuration(4_320_000, "en-US"), "1h 12m");
});

const window = (over: Partial<PlanUsageWindow> = {}): PlanUsageWindow => ({
  id: "rule:1",
  kind: "session",
  label: "Current session",
  windowSeconds: 5 * 3600,
  usedUsd: 2.1,
  limitUsd: 5,
  percent: 42.4,
  resetsAt: Date.UTC(2026, 9, 12, 10, 0),
  active: true,
  exceeded: false,
  models: null,
  ...over,
});

test("Copy report writes the live report's text with what Claudex has", () => {
  const session = reportSession({
    service,
    codexTotal: undefined,
    label,
    wallMs: 125_000,
  });
  assert.equal(
    copyReportText({
      generatedAt: new Date(now),
      userAgent: "Claudex/1.0",
      windows: [
        window(),
        window({ id: "w", label: "Weekly", exceeded: true, resetsAt: null }),
      ],
      planError: false,
      session,
    }),
    [
      "Claudex usage report (2026-10-12T08:00:00.000Z)",
      "Client: Claudex/1.0",
      "",
      "Plan limits:",
      "- Current session: 42% (resets 2026-10-12T10:00:00.000Z)",
      "- Weekly: 100%",
      "",
      "Session:",
      "- Opus 5: 12k in / 3k out / 90k cache read / 8k cache write",
      "- GPT-5.5 mini: 500 in / 100 out / 0 cache read / 0 cache write",
      "- Cost: $0.40 | API 1m | Wall 2m",
    ].join("\n"),
  );
  const codexOnly = reportSession({
    service: null,
    codexTotal: {
      totalTokens: 1_200,
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 200,
      reasoningOutputTokens: 0,
    },
    label,
  });
  assert.equal(
    copyReportText({
      generatedAt: new Date(now),
      userAgent: "UA",
      windows: [],
      planError: true,
      session: codexOnly,
    }),
    [
      "Claudex usage report (2026-10-12T08:00:00.000Z)",
      "Client: UA",
      "",
      "Plan limits:",
      "- unavailable (limits fetch failed)",
      "",
      "Session:",
      "- Total: 600 in / 200 out / 400 cache read",
    ].join("\n"),
  );
  assert.match(
    copyReportText({
      generatedAt: new Date(now),
      userAgent: "UA",
      windows: [],
      planError: false,
      session: null,
    }),
    /Plan limits:\n- none reported$/,
  );
});

test("a posted report sits under the latest turn, and moves to the end if that turn goes", () => {
  clearUsageReports();
  const conversation = { id: "c1", turns: [turn({ id: "t1" })] };
  const report = postUsageReport(conversation, now);
  assert.equal(report.afterTurnId, "t1");
  const empty = postUsageReport({ id: "c1", turns: [] }, now);
  assert.equal(empty.afterTurnId, null);
  const all = usageReports("c1");
  assert.equal(all.length, 2);
  assert.deepEqual(reportsAfter(all, "t1", conversation.turns), [report]);
  assert.deepEqual(reportsAfter(all, null, conversation.turns), [empty]);
  // t1 was rewound away: its report follows the last turn left.
  const after = [{ id: "t9" }];
  assert.deepEqual(reportsAfter(all, "t9", after), [report]);
  assert.deepEqual(usageReports("other"), []);
  clearUsageReports();
  assert.deepEqual(usageReports("c1"), []);
});

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: "c1",
  title: "Session",
  mode: "code",
  providerId: "p",
  model: "gpt-5.5",
  pinned: false,
  archived: false,
  createdAt: now,
  updatedAt: now,
  turns: [turn({})],
  ...over,
});

test("the card shows Codex's totals by kind, or says there is nothing yet", () => {
  const empty = renderToStaticMarkup(
    createElement(UsageReportCard, { conversation: conversation(), posted: 0 }),
  );
  assert.match(empty, /class="usage-card"/);
  assert.match(empty, /No usage data yet/);
  const total = {
    totalTokens: 13_800,
    inputTokens: 13_000,
    cachedInputTokens: 9_000,
    outputTokens: 800,
    reasoningOutputTokens: 0,
  };
  const html = renderToStaticMarkup(
    createElement(UsageReportCard, {
      conversation: conversation({
        tokenUsage: { total, last: total, modelContextWindow: 100_000 },
      }),
      posted: 0,
    }),
  );
  assert.match(html, /This session/);
  assert.match(html, /Breakdown/);
  assert.match(html, />Input<\/span><span class="usage-card-cell">4k</);
  assert.match(html, />Cache read<\/span><span class="usage-card-cell">9k</);
  assert.match(html, /Cache hit/);
  // Codex reports no cache writes; the row is left out rather than zero.
  assert.doesNotMatch(html, /Cache write/);
  // No plan section without the service: no Copy report either.
  assert.doesNotMatch(html, /Copy report/);
});

test("a Code transcript shows a posted report after its turn; Chat never does", async () => {
  const { ConversationTranscript } =
    await import("../../src/transcript/ConversationTranscript");
  clearUsageReports();
  const render = (mode: "code" | "chat") =>
    renderToStaticMarkup(
      createElement(ConversationTranscript, {
        conversation: conversation({
          mode,
          turns: [
            turn({ id: "t1", prompt: "First" }),
            turn({ id: "t2", prompt: "Second" }),
          ],
        }),
        mode,
        sending: false,
        running: false,
        approvals: [],
        replyFeedback: {},
        onReplyFeedback: async () => {},
        onArtifact() {},
        onOpenWorkflow() {},
        onEditPrompt: async () => true,
        onRetryResponse() {},
        onContinue() {},
        onSelectVersion() {},
        onError() {},
        scrollRef: createRef<HTMLDivElement>(),
        onScroll() {},
        onWheel() {},
        away: false,
        onJumpToLatest() {},
      }),
    );
  postUsageReport({ id: "c1", turns: [turn({ id: "t1" })] }, now);
  const code = render("code");
  const first = code.indexOf("First");
  const report = code.indexOf("usage-report-turn");
  const second = code.indexOf("Second");
  assert.ok(first >= 0 && first < report && report < second);
  assert.doesNotMatch(render("chat"), /usage-report-turn/);
  clearUsageReports();
});

test("a posted report reads as the /usage prompt and the card under it", () => {
  const html = renderToStaticMarkup(
    createElement(UsageReportsHere, {
      conversation: conversation(),
      reports: [{ id: "usage-report-1", afterTurnId: "t1", at: now }],
    }),
  );
  assert.match(html, /class="usage-report-turn"/);
  assert.match(html, /\/usage/);
  assert.equal(
    renderToStaticMarkup(
      createElement(UsageReportsHere, {
        conversation: conversation(),
        reports: [],
      }),
    ),
    "",
  );
});
