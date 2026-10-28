/**
 * The Service status page: synthetic bars (90 days, or `hours` of `step`-minute slots) for the channels codex (two
 * models) and grok. `status=issues` adds two open incidents, `status=none` an account
 * without a service. Nothing is fetched.
 */
import type {
  ServiceStatus,
  StatusDay,
  StatusIncident,
  StatusLevel,
  ServiceStatusQuery,
} from "../../../shared/service-status-api";
import type { FixtureDomain } from "./index";

/** 智商检测: a small drawn pelican for the fixture cards. */
const pelican = "<!doctype html><html><body style=\"margin:0;display:grid;place-items:center;height:100vh;background:#e8f4fb\"><svg viewBox=\"0 0 200 150\" width=\"90%\"><g><animateTransform attributeName=\"transform\" type=\"translate\" values=\"-10 0;10 0;-10 0\" dur=\"2s\" repeatCount=\"indefinite\"/><circle cx=\"60\" cy=\"110\" r=\"22\" fill=\"none\" stroke=\"#333\" stroke-width=\"4\"/><circle cx=\"140\" cy=\"110\" r=\"22\" fill=\"none\" stroke=\"#333\" stroke-width=\"4\"/><path d=\"M60 110 L100 80 L140 110 M100 80 L90 60\" stroke=\"#c56b4e\" stroke-width=\"5\" fill=\"none\"/><ellipse cx=\"95\" cy=\"50\" rx=\"22\" ry=\"14\" fill=\"#fff\" stroke=\"#999\"/><path d=\"M112 44 L150 52 L112 54 Z\" fill=\"#f2b33d\"/></g></svg></body></html>";

const hour = 60 * 60 * 1000;

function days(end: string, count: number, seed: number, step = 60): StatusDay[] {
  const [date, time] = end.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  const hourly = time !== undefined;
  const hour = hourly ? Number(time.slice(0, 2)) : 0;
  const minute = hourly ? Number(time.slice(3, 5)) || 0 : 0;
  return Array.from({ length: count }, (_, i) => {
    const at = hourly
      ? new Date(y!, m! - 1, d!, hour, minute - (count - 1 - i) * step)
      : new Date(y!, m! - 1, d! - (count - 1 - i));
    const p = (n: number) => String(n).padStart(2, "0");
    const wave = Math.abs(Math.sin(i * 1.3 + seed));
    const level: StatusLevel =
      !hourly && i < 6 ? "none" : wave > 0.97 ? "outage" : wave > 0.85 ? "degraded" : "operational";
    const checks = level === "none" ? 0 : hourly ? Math.max(2, step / 5) : 288;
    const failed =
      level === "outage" ? (hourly ? checks / 2 : 40) : level === "degraded" ? (hourly ? Math.max(1, checks / 6) : 30) : 0;
    return {
      date:
        `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
        (hourly ? `T${p(at.getHours())}:${p(at.getMinutes())}` : ""),
      level,
      uptime: checks ? ((checks - failed) / checks) * 100 : null,
      checks,
      degraded: level === "degraded" ? 30 : 4,
      failed,
      incidents: [],
    };
  });
}

/** The last hour of a row (the last day for days), as the service sums it. */
function recentOf(row: StatusDay[], step: number) {
  const last = row.slice(-(step > 0 && step < 60 ? 60 / step : 1));
  const checks = last.reduce((n, d) => n + d.checks, 0);
  const failed = last.reduce((n, d) => n + d.failed, 0);
  return { checks, failed, uptime: checks ? ((checks - failed) / checks) * 100 : null };
}

function build(mode: string, query: ServiceStatusQuery = {}): ServiceStatus {
  const now = Date.now();
  const today = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const hourly = query.hours !== undefined;
  const step = hourly ? (query.step ?? 60) : 0;
  const end =
    (query.end && (hourly && query.end.length === 13 ? `${query.end}:00` : query.end)) ??
    `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}` +
      (hourly
        ? `T${p(today.getHours())}:${p(Math.floor(today.getMinutes() / step) * step)}`
        : "");
  const count = hourly ? (query.hours! * 60) / step : (query.days ?? 90);
  const openai = [days(end, count, 1, step), days(end, count, 2, step)];
  const xai = days(end, count, 3, step);
  const incidents: StatusIncident[] =
    mode === "issues"
      ? [
          {
            id: 2,
            title: "Elevated errors on codex",
            platform: "codex",
            impact: "degraded",
            status: "monitoring",
            startedAt: now - 6 * hour,
            resolvedAt: null,
            updatedAt: now - hour,
            message: "We have applied the mitigation and are monitoring the recovery.",
            updates: [],
          },
          {
            id: 3,
            title: "Slow replies on grok",
            platform: "grok",
            impact: "outage",
            status: "identified",
            startedAt: now - 2 * hour,
            resolvedAt: null,
            updatedAt: now - hour,
            message: "We found the cause and are working on a fix.",
            updates: [],
          },
        ]
      : [];
  incidents.push({
    id: 1,
    title: "Codex requests failing",
    platform: "codex",
    impact: "outage",
    status: "resolved",
    startedAt: now - 50 * hour,
    resolvedAt: now - 47 * hour,
    updatedAt: now - 47 * hour,
    message: "The channels are working normally again.",
    updates: [],
  });
  const merge = (rows: StatusDay[][]) =>
    rows[0]!.map((day, i) => {
      const all = rows.map((r) => r[i]!);
      const rank = ["none", "operational", "degraded", "outage"];
      return {
        ...day,
        level: all.reduce(
          (worst, d) => (rank.indexOf(d.level) > rank.indexOf(worst) ? d.level : worst),
          "none" as StatusLevel,
        ),
      };
    });
  return {
    timezone: "Asia/Shanghai",
    start: openai[0]![0]!.date,
    end,
    hourly,
    stepMinutes: step,
    generatedAt: now,
    level: mode === "issues" ? "outage" : "operational",
    platforms: [
      {
        platform: "codex",
        name: "codex",
        provider: "openai",
        checks: 576,
        failed: 12,
        level: mode === "issues" ? "degraded" : "operational",
        uptime: 99.95,
        recent: recentOf(merge(openai), step),
        components: [
          { monitorId: 1, name: "gpt-6-sol", channel: "codex", level: "operational", uptime: 99.97, recent: recentOf(openai[0]!, step), days: openai[0]! },
          { monitorId: 3, name: "gpt-6-astra", channel: "codex-2", level: mode === "issues" ? "degraded" : "operational", uptime: 99.91, recent: recentOf(openai[1]!, step), days: openai[1]! },
        ],
        days: merge(openai),
      },
      {
        platform: "grok",
        name: "grok",
        provider: "grok",
        checks: 288,
        failed: 40,
        level: mode === "issues" ? "outage" : "operational",
        uptime: 99.65,
        recent: recentOf(xai, step),
        components: [
          { monitorId: 2, name: "grok-4.6", channel: "grok", level: mode === "issues" ? "outage" : "operational", uptime: 99.65, recent: recentOf(xai, step), days: xai },
        ],
        days: xai,
      },
    ],
    incidents,
    // 智商检测: a drawn pelican, and one check that wrote no page.
    iqExamples: [
      { kind: "normal", model: "gpt-6-astra", html: pelican },
      { kind: "degraded", model: "gpt-6.1-sol", html: pelican.replace("#e8f4fb", "#f4e8e8") },
    ],
    iq: [
      { id: 2, model: "gpt-6-astra", status: "ok", startedAt: Date.now() - 20 * 60_000, finishedAt: Date.now() - 18 * 60_000, html: pelican },
      { id: 1, model: "gpt-6-astra", status: "failed", startedAt: Date.now() - 80 * 60_000, finishedAt: Date.now() - 79 * 60_000, html: "" },
    ],
    // The groups the check runs in; the head switches between them.
    iqGroups: [
      { key: "codex", name: "codex", checks: [
        { id: 2, model: "gpt-6-astra", status: "ok", startedAt: Date.now() - 20 * 60_000, finishedAt: Date.now() - 18 * 60_000, html: pelican },
        { id: 1, model: "gpt-6-astra", status: "failed", startedAt: Date.now() - 80 * 60_000, finishedAt: Date.now() - 79 * 60_000, html: "" },
      ] },
      { key: "astra", name: "Astra 专用", checks: [
        { id: 3, model: "gpt-6-astra", status: "ok", startedAt: Date.now() - 19 * 60_000, finishedAt: Date.now() - 17 * 60_000, html: pelican.replace("#e8f4fb", "#eef7e8") },
      ] },
    ],
  };
}

export const serviceStatusFixture: FixtureDomain = {
  params: {
    status: "issues | none: open incidents, or an account without a service (default: all working)",
  },
  bridge: ({ params }) => {
    const mode = params.get("status") ?? "ok";
    return {
      serviceStatus: async (query?: ServiceStatusQuery) =>
        mode === "none" ? null : build(mode, query),
    };
  },
};
