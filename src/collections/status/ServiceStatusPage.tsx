import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "../../ui/glyphs";
import type {
  ServiceStatus,
  StatusDay,
  StatusIncident,
  StatusLevel,
  StatusPlatform,
} from "../../../shared/service-status-api";
import { currentLocale, t, tf, useT } from "../../i18n";
import { Skeleton } from "../../ui/Skeleton";
import { useTooltip } from "../../ui/Tooltip";
import "./status.css";
import { IqChecks } from "./IqChecks";
import "../routines/scheduled.css";

/** Hours a page of bars covers, `stepMinutes` a bar. */
const windowHours = 24;
const stepMinutes = 10;
const refreshEvery = 60_000;

const statusLabels = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
} as const;

const levelLabels: Record<StatusLevel, string> = {
  none: "No data",
  operational: "No issues",
  degraded: "Degraded performance",
  outage: "Outage",
};

/** The reference's filled marks: a check in a circle, a warning triangle, a cross. */
function LevelMark({ level }: { level: StatusLevel }) {
  if (level === "degraded")
    return (
      <svg className="st-mark degraded" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 1.5c.5 0 .95.27 1.2.7l5.9 10.3c.5.9-.14 2-1.2 2H2.1c-1.06 0-1.7-1.1-1.2-2L6.8 2.2c.25-.43.7-.7 1.2-.7Z" />
        <path className="st-mark-cut" d="M8 5.5v3.8M8 11.4v.1" />
      </svg>
    );
  if (level === "outage")
    return (
      <svg className="st-mark outage" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="7" />
        <path className="st-mark-cut" d="m5.6 5.6 4.8 4.8M10.4 5.6l-4.8 4.8" />
      </svg>
    );
  return (
    <svg
      className={`st-mark ${level === "none" ? "none" : "operational"}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="7" />
      <path className="st-mark-cut" d="m5 8.2 2 2 4-4.2" />
    </svg>
  );
}

function InfoMark() {
  return (
    <svg className="st-info" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.2v4M8 5v.1" />
    </svg>
  );
}

const percent = (value: number | null) =>
  value === null
    ? null
    : `${(Math.floor(value * 100) / 100).toLocaleString(currentLocale(), {
        maximumFractionDigits: 2,
      })}%`;

/** "6 hours", "2 days": how long an incident has been going. */
function span(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60)
    return tf(minutes === 1 ? "{n} minute" : "{n} minutes", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48)
    return tf(hours === 1 ? "{n} hour" : "{n} hours", { n: hours });
  return tf("{n} days", { n: Math.round(hours / 24) });
}

/** A slot's label as a local date. */
const slotOf = (label: string) => {
  const [date, time] = label.split("T");
  const [y, m, d] = date!.split("-").map(Number);
  return new Date(
    y!,
    m! - 1,
    d!,
    time ? Number(time.slice(0, 2)) : 0,
    time ? Number(time.slice(3, 5)) || 0 : 0,
  );
};

const pad = (n: number) => String(n).padStart(2, "0");
/** The slot as the service reads ?end= ("2026-09-30T14:20"). */
const slotKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const addMinutes = (d: Date, minutes: number) =>
  new Date(d.getTime() + minutes * 60_000);

/** "Sep 29, 15:00 - Sep 30, 15:00": the time a page covers. */
function slotRange(start: string, end: string, step: number) {
  const format = new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${format.format(slotOf(start))} - ${format.format(addMinutes(slotOf(end), step))}`;
}

/** A bar's time: "Sep 30, 14:20 - 14:30" for part of a day (step minutes), the date for a day. */
function slotText(label: string, step: number) {
  const at = slotOf(label);
  if (!step)
    return new Intl.DateTimeFormat(currentLocale(), {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(at);
  const time = new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
  });
  return `${day.format(at)} ${time.format(at)} - ${time.format(addMinutes(at, step))}`;
}

function platformName(status: ServiceStatus, platform: string) {
  if (!platform) return t("All services");
  return (
    status.platforms.find((p) => p.platform === platform)?.name ?? platform
  );
}

/** A row of bars, a slot each, with the slot's figures on hover. */
function Bars({
  days,
  incidents,
  step,
}: {
  days: StatusDay[];
  incidents: StatusIncident[];
  /** A bar's minutes; 0 for a day. */
  step: number;
}) {
  const [hover, setHover] = useState<number>();
  const shown = hover === undefined ? undefined : days[hover];
  return (
    <div className="st-bars-wrap" onMouseLeave={() => setHover(undefined)}>
      <div
        className={`st-bars${days.length > 100 ? " dense" : ""}`}
        role="img"
        aria-label={t("Daily status")}
      >
        {days.map((day, index) => (
          <span
            key={day.date}
            className={`st-bar ${day.level}${hover === index ? " hover" : ""}`}
            // A slot without data is drawn green but has no figures to show: no
            // tip.
            onMouseEnter={() =>
              setHover(day.level === "none" ? undefined : index)
            }
          />
        ))}
      </div>
      {shown && (
        <div
          className="st-tip"
          role="status"
          style={{
            // At the hovered bar's centre, opening rightwards over the first
            // bar and leftwards over the last, so it never leaves the page.
            left: `${((hover! + 0.5) / days.length) * 100}%`,
            transform: `translateX(-${(hover! / Math.max(1, days.length - 1)) * 100}%)`,
          }}
        >
          <b>{slotText(shown.date, step)}</b>
          <span className={`st-tip-level ${shown.level}`}>
            {t(levelLabels[shown.level])}
          </span>
          {shown.uptime !== null && (
            <span>
              {tf("{x} uptime", { x: percent(shown.uptime)! })} ·{" "}
              {tf("{n} checks", { n: shown.checks.toLocaleString() })}
            </span>
          )}
          {shown.incidents.map((id) => {
            const incident = incidents.find((i) => i.id === id);
            return incident ? (
              <span key={id} className="st-tip-incident">
                {incident.title}
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

function PlatformRow({
  platform,
  incidents,
  step,
}: {
  platform: StatusPlatform;
  incidents: StatusIncident[];
  step: number;
}) {
  const [open, setOpen] = useState(false);
  const count = platform.components.length;
  // The models the channel checks.
  const models = [...new Set(platform.components.map((c) => c.name))];
  const uptime = percent(platform.uptime);
  // What the mark means: the state, from the last hour's checks (the uptime
  // beside the name and the bars are the window's).
  const recentUptime = percent(platform.recent.uptime);
  const info = useTooltip(
    [
      t(levelLabels[platform.level]),
      recentUptime ? tf("Last hour: {x} uptime", { x: recentUptime }) : "",
      platform.recent.checks
        ? tf("{n} checks, {m} failed", {
            n: platform.recent.checks.toLocaleString(),
            m: platform.recent.failed.toLocaleString(),
          })
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
    { size: "wrap", placement: "below" },
  );
  return (
    <div className="st-row">
      <div className="st-row-head">
        <LevelMark level={platform.level} />
        <span className="st-row-name">{platform.name}</span>
        <span className="st-row-info" tabIndex={0} {...info.props}>
          <InfoMark />
        </span>
        {info.tooltip}
        {count > 0 && (
          <button
            type="button"
            className="st-row-components"
            aria-expanded={open}
            title={models.join(", ")}
            onClick={() => setOpen((value) => !value)}
          >
            <span className="st-row-models" data-no-translate>
              {models.join(" · ")}
            </span>
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              className={open ? "open" : ""}
            />
          </button>
        )}
        {uptime && (
          <span className="st-row-uptime">
            {tf("{x} uptime", { x: uptime })}
          </span>
        )}
      </div>
      <Bars days={platform.days} incidents={incidents} step={step} />
      {open && (
        <div className="st-components">
          {platform.components.map((component) => (
            <div
              className="st-component"
              key={`${component.monitorId}:${component.name}`}
            >
              <div className="st-row-head">
                <LevelMark level={component.level} />
                <span className="st-component-name">{component.name}</span>
                <span className="st-component-channel">
                  {component.channel}
                </span>
                {percent(component.uptime) && (
                  <span className="st-row-uptime">
                    {tf("{x} uptime", { x: percent(component.uptime)! })}
                  </span>
                )}
              </div>
              <Bars days={component.days} incidents={incidents} step={step} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function IncidentRow({
  incident,
  status,
  now,
}: {
  incident: StatusIncident;
  status: ServiceStatus;
  now: number;
}) {
  const resolved = incident.resolvedAt !== null;
  return (
    <div className="st-incident">
      <LevelMark
        level={
          resolved
            ? "operational"
            : incident.impact === "outage"
              ? "outage"
              : "degraded"
        }
      />
      <div>
        <h3>{incident.title}</h3>
        {incident.message && <p>{incident.message}</p>}
        <div className="st-incident-meta">
          <span>{t(statusLabels[incident.status])}</span>
          <span>
            {resolved
              ? tf("Lasted {x}", {
                  x: span(incident.resolvedAt! - incident.startedAt),
                })
              : tf("Ongoing for {x}", { x: span(now - incident.startedAt) })}
          </span>
          <span>
            {tf("Affects {x}", {
              x: platformName(status, incident.platform),
            })}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The page while it loads, in the loaded page's own boxes: the status
 * banner, then the System status card with a row a channel (mark, name,
 * components and uptime on a 22px line, the bars 12px under it).
 */
function StatusSkeleton() {
  return (
    <div className="st-sk" aria-busy="true" aria-label={t("Loading")}>
      <div className="st-banner st-sk-banner">
        <div className="st-banner-head">
          <Skeleton width={16} height={16} round />
          <Skeleton width={200} height={16} />
        </div>
      </div>
      <div className="st-card">
        <div className="st-card-head">
          <Skeleton width={110} height={16} />
          <Skeleton width={170} height={14} />
        </div>
        {[0, 1].map((i) => (
          <div className="st-row" key={i}>
            <div className="st-row-head">
              <Skeleton width={16} height={16} round />
              <Skeleton width={70} height={14} />
              <Skeleton width={90} height={14} />
              <Skeleton width={110} height={14} className="st-sk-uptime" />
            </div>
            <div className="st-bars-wrap">
              <Skeleton height={15} className="st-sk-bars" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Service status (below API; not in claude.ai): whether the service's
 * providers are working, laid out like the status pages people know — the
 * incidents being handled on top, then each provider with its uptime and a
 * bar a day, which opens to its channels. The administrator updates the
 * incidents in the console; the bars come from the service's channel checks.
 */
export function ServiceStatusPage() {
  useT();
  const [status, setStatus] = useState<ServiceStatus | null>();
  const [end, setEnd] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    return Promise.resolve()
      .then(() =>
        window.desktop.serviceStatus({
          hours: windowHours,
          step: stepMinutes,
          ...(end ? { end } : {}),
        }),
      )
      .then(
        (value) => {
          setStatus(value);
          setFailure(undefined);
          setNow(Date.now());
        },
        (error: unknown) => {
          setFailure(
            error instanceof Error
              ? error.message
              : t("The service status couldn’t be read."),
          );
          setStatus((value) => value ?? null);
        },
      );
  }, [end]);

  useEffect(() => {
    void load();
    if (end) return;
    const timer = setInterval(() => void load(), refreshEvery);
    return () => clearInterval(timer);
  }, [load, end]);

  const open = useMemo(
    () => (status?.incidents ?? []).filter((i) => i.resolvedAt === null),
    [status],
  );
  const past = useMemo(
    () => (status?.incidents ?? []).filter((i) => i.resolvedAt !== null),
    [status],
  );
  const affected = [...new Set(open.map((i) => i.platform))];

  return (
    <div className="routines-view status-view">
      <div className="routines-inner">
        <div className="routines-head">
          <div>
            <h1 className="routines-title">{t("Service status")}</h1>
            <p className="routines-subtitle">
              {t(
                "Whether each channel is working, and what we’re doing about any problem.",
              )}
            </p>
          </div>
        </div>
        {failure && status && (
          <p className="routines-notice failed" role="alert">
            {failure}
          </p>
        )}
        {status === undefined ? (
          <StatusSkeleton />
        ) : status === null ? (
          <p className="routines-none">
            {failure ??
              t(
                "Service status belongs to a Claudex account. Sign in to see it.",
              )}
          </p>
        ) : (
          <>
            {open.length > 0 ? (
              <section className="st-banner" aria-labelledby="st-issues">
                <div className="st-banner-head">
                  <LevelMark level="degraded" />
                  <h2 id="st-issues">
                    {t("We’re currently experiencing issues")}
                  </h2>
                </div>
                <div className="st-chips">
                  {affected.map((platform) => (
                    <span className="st-chip" key={platform || "all"}>
                      {platformName(status, platform)}
                    </span>
                  ))}
                </div>
                {open.map((incident) => (
                  <IncidentRow
                    key={incident.id}
                    incident={incident}
                    status={status}
                    now={now}
                  />
                ))}
              </section>
            ) : (
              <section className="st-banner ok">
                <div className="st-banner-head">
                  <LevelMark level="operational" />
                  <h2>{t("All systems operational")}</h2>
                </div>
              </section>
            )}

            <section className="st-card" aria-labelledby="st-system">
              <div className="st-card-head">
                <h2 id="st-system">{t("System status")}</h2>
                {status.start && status.end && (
                  <div className="st-range">
                    <button
                      type="button"
                      aria-label={t("Earlier")}
                      onClick={() =>
                        setEnd(
                          slotKey(
                            addMinutes(
                              slotOf(status.start),
                              -(status.stepMinutes || 60),
                            ),
                          ),
                        )
                      }
                    >
                      <ChevronLeft size={16} strokeWidth={1.75} />
                    </button>
                    <span>
                      {slotRange(
                        status.start,
                        status.end,
                        status.stepMinutes || 60,
                      )}
                    </span>
                    <button
                      type="button"
                      aria-label={t("Later")}
                      disabled={!end}
                      onClick={() => {
                        const next = addMinutes(
                          slotOf(status.end),
                          windowHours * 60,
                        );
                        setEnd(next >= new Date() ? undefined : slotKey(next));
                      }}
                    >
                      <ChevronRight size={16} strokeWidth={1.75} />
                    </button>
                  </div>
                )}
              </div>
              {status.platforms.length ? (
                status.platforms.map((platform) => (
                  <PlatformRow
                    key={platform.platform}
                    platform={platform}
                    incidents={status.incidents}
                    step={status.hourly ? status.stepMinutes || 60 : 0}
                  />
                ))
              ) : (
                <p className="st-empty">
                  {t("The service isn’t checking any channels yet.")}
                </p>
              )}
            </section>

            <IqChecks
              checks={status.iq}
              groups={status.iqGroups}
              examples={status.iqExamples}
            />

            {past.length > 0 && (
              <section className="st-card" aria-labelledby="st-past">
                <div className="st-card-head">
                  <h2 id="st-past">{t("Past incidents")}</h2>
                </div>
                {past.map((incident) => (
                  <IncidentRow
                    key={incident.id}
                    incident={incident}
                    status={status}
                    now={now}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
