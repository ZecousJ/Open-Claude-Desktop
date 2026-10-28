import test from "node:test";
import assert from "node:assert/strict";
import {
  serviceStatusFrom,
  serviceStatusPath,
} from "../../shared/service-status-api";
import { createServiceStatusMethods } from "../../src-web/bridge/service-status";
import { sidebarNav } from "../../src/sidebar/navItems";
import { parseWebRoute } from "../../src/web/routes";

const raw = {
  timezone: "Asia/Shanghai",
  start: "2026-07-03",
  end: "2026-09-30",
  generated_at: "2026-09-30T08:00:00Z",
  level: "degraded",
  platforms: [
    {
      platform: "codex",
      name: "codex",
      provider: "openai",
      level: "degraded",
      uptime: 99.95,
      recent: { checks: 12, failed: 0, uptime: 100 },
      days: [
        {
          date: "2026-09-30",
          level: "outage",
          uptime: 80,
          checks: 100,
          degraded: 3,
          failed: 20,
          incidents: [4],
        },
        { date: "2026-09-29", level: "weird", uptime: null },
      ],
      components: [
        {
          monitor_id: 1,
          name: "gpt-6-sol",
          channel: "codex",
          level: "operational",
          uptime: 100,
          days: [],
        },
      ],
    },
  ],
  incidents: [
    {
      id: 4,
      title: "Elevated errors on OpenAI",
      platform: "openai",
      impact: "outage",
      status: "monitoring",
      started_at: "2026-09-30T02:00:00Z",
      resolved_at: null,
      updated_at: "2026-09-30T04:00:00Z",
      message: "Watching it.",
      updates: [
        {
          status: "monitoring",
          message: "Watching it.",
          created_at: "2026-09-30T04:00:00Z",
        },
      ],
    },
  ],
};

test("the service's status is read field by field", () => {
  const s = serviceStatusFrom(raw);
  assert.equal(s.level, "degraded");
  const p = s.platforms[0]!;
  assert.equal(p.provider, "openai");
  assert.equal(p.checks, 0, "missing counts read as none");
  assert.deepEqual(p.recent, { checks: 12, failed: 0, uptime: 100 });
  assert.deepEqual(
    p.components[0]!.recent,
    { checks: 0, failed: 0, uptime: null },
    "an older service: no last hour",
  );
  assert.equal(p.days[0]!.level, "outage");
  assert.deepEqual(p.days[0]!.incidents, [4]);
  assert.equal(p.days[1]!.level, "none", "an unknown level reads as no data");
  assert.equal(p.days[1]!.uptime, null);
  assert.equal(p.components[0]!.monitorId, 1);
  const i = s.incidents[0]!;
  assert.equal(i.impact, "outage");
  assert.equal(i.resolvedAt, null);
  assert.equal(i.startedAt, Date.parse("2026-09-30T02:00:00Z"));
  assert.equal(i.updates[0]!.status, "monitoring");
  assert.deepEqual(serviceStatusFrom(undefined).platforms, []);
  assert.deepEqual(serviceStatusFrom(undefined).iq, []);
});

test("IQ checks: a failed one carries no page, a malformed one is dropped", () => {
  const s = serviceStatusFrom({
    ...raw,
    iq: [
      {
        id: 3,
        model: "gpt-6.1-sol",
        status: "ok",
        started_at: "2026-10-06T05:00:05Z",
        finished_at: "2026-10-06T05:02:00Z",
        html: "<html></html>",
      },
      {
        id: 2,
        model: "gpt-6.1-sol",
        status: "failed",
        started_at: "2026-10-06T04:00:05Z",
        finished_at: null,
        html: "<html>left over</html>",
      },
      { id: 0, status: "ok" },
    ],
  });
  assert.equal(s.iq.length, 2);
  assert.equal(s.iq[0]!.html, "<html></html>");
  assert.equal(s.iq[0]!.startedAt, Date.parse("2026-10-06T05:00:05Z"));
  assert.equal(s.iq[1]!.status, "failed");
  assert.equal(s.iq[1]!.html, "");
  assert.equal(s.iq[1]!.finishedAt, null);
});

test("IQ groups: each group carries its own checks; a nameless one is dropped", () => {
  const s = serviceStatusFrom({
    ...raw,
    iq_groups: [
      {
        key: "codex",
        name: "codex",
        runs: [
          {
            id: 3,
            model: "gpt-6-astra",
            status: "ok",
            started_at: "2026-10-14T05:00:05Z",
            finished_at: "2026-10-14T05:02:00Z",
            html: "<html></html>",
          },
        ],
      },
      { key: "astra", name: "Astra 专用", runs: [] },
      { key: "", name: "x", runs: [] },
    ],
  });
  assert.deepEqual(
    s.iqGroups.map((g) => g.name),
    ["codex", "Astra 专用"],
  );
  assert.equal(s.iqGroups[0]!.checks[0]!.html, "<html></html>");
  assert.deepEqual(s.iqGroups[1]!.checks, []);
  assert.deepEqual(serviceStatusFrom(undefined).iqGroups, []);
});

test("the address carries a checked window", () => {
  assert.equal(serviceStatusPath(), "/claudex/status");
  assert.equal(
    serviceStatusPath({ end: "2026-06-30", days: 90 }),
    "/claudex/status?end=2026-06-30&days=90",
  );
  assert.equal(
    serviceStatusPath({ hours: 24, end: "2026-09-30T14" }),
    "/claudex/status?hours=24&end=2026-09-30T14",
  );
  assert.equal(
    serviceStatusPath({ hours: 24, step: 10, end: "2026-09-30T14:20" }),
    "/claudex/status?hours=24&step=10&end=2026-09-30T14%3A20",
  );
  assert.equal(
    serviceStatusPath({ end: "nope", days: 9999 }),
    "/claudex/status?days=366",
  );
});

test("ten-minute bars: the step comes with the answer", () => {
  const s = serviceStatusFrom({ ...raw, hourly: true, step_minutes: 10 });
  assert.equal(s.stepMinutes, 10);
  assert.equal(
    serviceStatusFrom({ ...raw, hourly: true }).stepMinutes,
    60,
    "an older service: an hour a bar",
  );
  assert.equal(serviceStatusFrom(raw).stepMinutes, 0, "days");
});

test("the web asks the service and reads its answer", async () => {
  const seen: string[] = [];
  const methods = createServiceStatusMethods({
    json: async (path: string) => {
      seen.push(path);
      return { code: 0, data: raw };
    },
  } as never);
  const s = (await methods.serviceStatus!({ days: 90 })) as ReturnType<
    typeof serviceStatusFrom
  >;
  assert.equal(s.platforms[0]!.name, "codex");
  assert.deepEqual(seen, ["/api/v1/claudex/status?days=90"]);
});

test("Service status sits below API in the sidebar and has its own address", () => {
  // On the sidebar itself in every mode.
  const ids = sidebarNav("chat").shown.map((item) => item.id);
  assert.equal(ids.indexOf("status"), ids.indexOf("api") + 1);
  assert.ok(sidebarNav("code").shown.some((item) => item.id === "status"));
  assert.deepEqual(parseWebRoute("/status", ""), {
    kind: "page",
    page: "status",
  });
});
