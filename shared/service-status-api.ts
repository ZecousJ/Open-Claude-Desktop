/**
 * The Service status page (below API): each provider's channels — the
 * Claudex service's channel monitors — with their uptime and a bar a day,
 * and the incidents the administrator is handling. The service builds it
 * (GET /api/v1/claudex/status); the desktop app asks from the main process
 * with the session's token, the web app from the page, and both read the
 * answer with `serviceStatusFrom`.
 */
import { z } from "zod";
import { bridgeMethods } from "./bridge-methods";

export type StatusLevel = "none" | "operational" | "degraded" | "outage";
export type IncidentStatus =
  "investigating" | "identified" | "monitoring" | "resolved";
export type IncidentImpact = "degraded" | "outage";

export interface StatusDay {
  /** YYYY-MM-DD in the service's time zone. */
  date: string;
  level: StatusLevel;
  /** Percent of checks that passed; null without checks. */
  uptime: number | null;
  checks: number;
  degraded: number;
  failed: number;
  incidents: number[];
}

/** The last hour of the window (the last day for days): what a mark says. */
export interface StatusRecent {
  checks: number;
  failed: number;
  uptime: number | null;
}

export interface StatusComponent {
  monitorId: number;
  /** The model the channel checks. */
  name: string;
  /** The channel's name. */
  channel: string;
  /** The mark: the last hour's checks (`recent`). */
  level: StatusLevel;
  uptime: number | null;
  recent: StatusRecent;
  days: StatusDay[];
}

/** One Sub2API channel (a channel monitor) and the models it checks. */
export interface StatusPlatform {
  /** The channel's key: its name, which incidents name too. */
  platform: string;
  name: string;
  /** The Sub2API platform the channel belongs to (openai, grok, …). */
  provider: string;
  /** The window's checks and how many failed (its uptime). */
  checks: number;
  failed: number;
  /** The mark: the last hour's checks (`recent`) and open incidents. */
  level: StatusLevel;
  uptime: number | null;
  recent: StatusRecent;
  components: StatusComponent[];
  days: StatusDay[];
}

export interface IncidentUpdate {
  status: IncidentStatus;
  message: string;
  at: number;
}

export interface StatusIncident {
  id: number;
  title: string;
  /** The channel's name, or "" for every service. */
  platform: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  startedAt: number;
  resolvedAt: number | null;
  updatedAt: number;
  message: string;
  updates: IncidentUpdate[];
}

/**
 * One IQ check (owner, 2026-10-06): every hour the service asks a model for
 * an HTML page with an SVG animation of a pelican riding a bicycle.
 */
export interface IqCheck {
  id: number;
  model: string;
  status: "ok" | "failed";
  startedAt: number;
  finishedAt: number | null;
  /** The page the model wrote; "" when the check failed. */
  html: string;
}

/**
 * A group the IQ check runs in (owner, 2026-10-14: codex and "Astra 专用");
 * the status page switches between them.
 */
export interface IqGroup {
  key: string;
  name: string;
  /** Its latest checks, newest first. */
  checks: IqCheck[];
}

/** A fixed example above the checks: a normal page and a dumbed-down one. */
export interface IqExample {
  kind: "normal" | "degraded";
  model: string;
  html: string;
}

export interface ServiceStatus {
  timezone: string;
  start: string;
  end: string;
  /** A bar is part of a day ("2026-09-30T14:20"), else a day. */
  hourly: boolean;
  /** A bar's minutes when hourly (10, 60…); 0 for days. */
  stepMinutes: number;
  generatedAt: number;
  level: StatusLevel;
  platforms: StatusPlatform[];
  incidents: StatusIncident[];
  /** The latest IQ checks, newest first. */
  iq: IqCheck[];
  /** The checks per group; empty from a service before groups. */
  iqGroups: IqGroup[];
  iqExamples: IqExample[];
}

const maxStatusHours = 720;
const maxStatusDays = 366;
const statusSteps = [10, 15, 20, 30, 60] as const;
const statusEnd = /^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2})?)?$/;

export interface ServiceStatusQuery {
  /** Bars of `step` minutes for this many hours (up to 720)… */
  hours?: number;
  /** A bar's minutes with `hours`: 10, 15, 20, 30 or 60 (default). */
  step?: number;
  /** …or a day a bar for this many days. */
  days?: number;
  /** The last slot shown: YYYY-MM-DDTHH:MM for hours, YYYY-MM-DD for days; now when left out. */
  end?: string;
}

export const serviceStatusQuery = z.strictObject({
  end: z.string().regex(statusEnd).optional(),
  days: z.number().int().min(1).max(maxStatusDays).optional(),
  hours: z.number().int().min(1).max(maxStatusHours).optional(),
  step: z.literal(statusSteps).optional(),
});

export const officialServiceStatusPath = "/api/claudex/service-status";

export function parseOfficialServiceStatusQuery(
  params: URLSearchParams,
): ServiceStatusQuery | undefined {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(fields, key) || value !== value.trim()) return undefined;
    switch (key) {
      case "end":
        fields.end = value;
        break;
      case "hours":
      case "days":
      case "step":
        if (!/^[1-9]\d{0,2}$/.test(value)) return undefined;
        fields[key] = Number(value);
        break;
      default:
        return undefined;
    }
  }
  const checked = serviceStatusQuery.safeParse(fields);
  if (!checked.success) return undefined;
  const { hours, days, step, end } = checked.data;
  const hourly = hours !== undefined;
  if (hourly ? days !== undefined : step !== undefined) return undefined;
  if (end !== undefined) {
    const date = end.slice(0, 10);
    const stamp = new Date(date);
    if (
      !Number.isFinite(stamp.valueOf()) ||
      stamp.toISOString().slice(0, 10) !== date
    )
      return undefined;
    if (hourly ? !/T(?:[01]\d|2[0-3])(?::[0-5]\d)?$/.test(end) : end !== date)
      return undefined;
  }
  return checked.data;
}

export interface ServiceStatusAPI {
  /** Null when the account has no Claudex service. */
  serviceStatus(query?: ServiceStatusQuery): Promise<ServiceStatus | null>;
}

export const serviceStatusMethods = bridgeMethods<ServiceStatusAPI>({
  serviceStatus: true,
});

/** The address under /api/v1, the query checked. */
export function serviceStatusPath(query: ServiceStatusQuery = {}): string {
  const params = new URLSearchParams();
  if (query.hours !== undefined)
    params.set(
      "hours",
      String(
        Math.min(maxStatusHours, Math.max(1, Math.trunc(query.hours) || 24)),
      ),
    );
  if (query.hours !== undefined && query.step !== undefined)
    params.set("step", String(Math.trunc(query.step) || 60));
  if (query.end && statusEnd.test(query.end)) params.set("end", query.end);
  if (query.days !== undefined)
    params.set(
      "days",
      String(
        Math.min(maxStatusDays, Math.max(1, Math.trunc(query.days) || 90)),
      ),
    );
  const text = params.toString();
  return `/claudex/status${text ? `?${text}` : ""}`;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, limit = 200) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const channelName = (value: unknown) =>
  typeof value === "string" ? value : "";
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const optional = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const time = (value: unknown) => {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : null;
};
// The service sends the last 24 runs of a group (status/iq.go iqShown).
const iqChecks = (value: unknown): IqCheck[] =>
  list(value)
    .slice(0, 24)
    .map((raw) => {
      const r = record(raw);
      const ok = r.status === "ok";
      return {
        id: number(r.id),
        model: text(r.model, 100),
        status: ok ? ("ok" as const) : ("failed" as const),
        startedAt: time(r.started_at) ?? 0,
        finishedAt: time(r.finished_at),
        html: ok ? text(r.html, 512 * 1024) : "",
      };
    })
    .filter((check) => check.id > 0 && check.startedAt > 0);
const levels: StatusLevel[] = ["none", "operational", "degraded", "outage"];
const level = (value: unknown): StatusLevel =>
  levels.includes(value as StatusLevel) ? (value as StatusLevel) : "none";
const statuses: IncidentStatus[] = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
];
const status = (value: unknown): IncidentStatus =>
  statuses.includes(value as IncidentStatus)
    ? (value as IncidentStatus)
    : "investigating";

function day(raw: unknown): StatusDay {
  const d = record(raw);
  return {
    date: text(d.date, 16),
    level: level(d.level),
    uptime: optional(d.uptime),
    checks: number(d.checks),
    degraded: number(d.degraded),
    failed: number(d.failed),
    incidents: list(d.incidents).filter(
      (id): id is number => typeof id === "number",
    ),
  };
}

function incident(raw: unknown): StatusIncident {
  const i = record(raw);
  return {
    id: number(i.id),
    title: text(i.title),
    platform: channelName(i.platform),
    impact: i.impact === "outage" ? "outage" : "degraded",
    status: status(i.status),
    startedAt: time(i.started_at) ?? 0,
    resolvedAt: time(i.resolved_at),
    updatedAt: time(i.updated_at) ?? 0,
    message: text(i.message, 5000),
    updates: list(i.updates)
      .slice(0, 50)
      .map((u) => {
        const r = record(u);
        return {
          status: status(r.status),
          message: text(r.message, 5000),
          at: time(r.created_at) ?? 0,
        };
      }),
  };
}

const recentFrom = (raw: unknown): StatusRecent => {
  const r = record(raw);
  return {
    checks: number(r.checks),
    failed: number(r.failed),
    uptime: optional(r.uptime),
  };
};

/** The service's answer, field by field; anything missing reads as empty. */
export function serviceStatusFrom(raw: unknown): ServiceStatus {
  const s = record(raw);
  return {
    timezone: text(s.timezone, 60),
    start: text(s.start, 16),
    end: text(s.end, 16),
    hourly: s.hourly === true,
    stepMinutes:
      s.hourly === true
        ? Math.min(60, Math.max(1, number(s.step_minutes) || 60))
        : 0,
    generatedAt: time(s.generated_at) ?? 0,
    level: level(s.level),
    platforms: list(s.platforms).map((raw) => {
      const p = record(raw);
      return {
        platform: channelName(p.platform),
        name: channelName(p.name),
        provider: text(p.provider, 40),
        checks: number(p.checks),
        failed: number(p.failed),
        level: level(p.level),
        uptime: optional(p.uptime),
        recent: recentFrom(p.recent),
        days: list(p.days).map(day),
        components: list(p.components).map((raw) => {
          const c = record(raw);
          return {
            monitorId: number(c.monitor_id),
            name: text(c.name),
            channel: channelName(c.channel),
            level: level(c.level),
            uptime: optional(c.uptime),
            recent: recentFrom(c.recent),
            days: list(c.days).map(day),
          };
        }),
      };
    }),
    incidents: list(s.incidents).slice(0, 200).map(incident),
    iq: iqChecks(s.iq),
    iqGroups: list(s.iq_groups)
      .slice(0, 8)
      .map((raw) => {
        const g = record(raw);
        return {
          key: text(g.key, 32),
          name: text(g.name, 100),
          checks: iqChecks(g.runs),
        };
      })
      .filter((group) => group.key && group.name),
    iqExamples: list(s.iq_examples)
      .slice(0, 4)
      .map((raw) => {
        const r = record(raw);
        return {
          kind:
            r.kind === "degraded" ? ("degraded" as const) : ("normal" as const),
          model: text(r.model, 100),
          html: text(r.html, 512 * 1024),
        };
      })
      .filter((example) => example.html !== ""),
  };
}

export function serviceStatusResponseFrom(body: unknown): ServiceStatus {
  const data = record(body);
  const raw = record("data" in data ? data.data : body);
  if (
    ("code" in data && data.code !== 0) ||
    !Array.isArray(raw.platforms) ||
    !Array.isArray(raw.incidents) ||
    !time(raw.generated_at)
  )
    throw Error("The service status couldn't be read.");
  return serviceStatusFrom(raw);
}
