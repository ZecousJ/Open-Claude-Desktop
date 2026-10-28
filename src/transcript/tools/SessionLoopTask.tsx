import { useEffect, useRef, useState } from "react";
import type { SessionLoop } from "../../../shared/session-loops";
import {
  loopNextRun,
  sessionLoopLifetime,
} from "../../../shared/session-loops";
import { api } from "../../desktop-api";
import { currentLocale, formatText, t } from "../../i18n";
import { BackgroundGlyph } from "../../conversation/background-glyphs";
import { showToast } from "../../ui/toast-store";
import { ShimmerText } from "../../ui/ShimmerText";

export function useSessionLoops(
  conversationId: string | undefined,
  onError: (error: unknown) => void,
) {
  const [loops, setLoops] = useState<SessionLoop[]>([]);
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const callbacks = useRef({ onError });
  callbacks.current = { onError };
  useEffect(() => {
    setLoops([]);
    setStopping(new Set());
    if (!conversationId) return;
    let live = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const listed = await api.listSessionLoops(conversationId);
        if (live) setLoops(listed);
      } catch (error) {
        if (live) callbacks.current.onError(error);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [conversationId]);
  const stop = async (loop: SessionLoop) => {
    if (stopping.has(loop.id)) return;
    setStopping((current) => new Set(current).add(loop.id));
    try {
      if (await api.stopSessionLoop(loop.conversationId, loop.id)) {
        setLoops((current) => current.filter((value) => value.id !== loop.id));
        showToast(
          t(loop.recurring ? "Loop stopped" : "Scheduled prompt stopped"),
        );
      }
    } catch (error) {
      callbacks.current.onError(error);
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(loop.id);
        return next;
      });
    }
  };
  return { loops, stopping, stop };
}

export function loopCountdown(milliseconds: number) {
  if (milliseconds <= 0) return t("now");
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const units: [number, "second" | "minute" | "hour" | "day"][] =
    seconds < 60
      ? [[seconds, "second"]]
      : minutes < 60
        ? [
            [minutes, "minute"],
            ...(minutes < 5 && seconds % 60
              ? [[seconds % 60, "second"] as [number, "second"]]
              : []),
          ]
        : hours < 24
          ? [
              [hours, "hour"],
              ...(minutes % 60
                ? [[minutes % 60, "minute"] as [number, "minute"]]
                : []),
            ]
          : [
              [days, "day"],
              ...(hours % 24 ? [[hours % 24, "hour"] as [number, "hour"]] : []),
            ];
  return units
    .map(([value, unit], index) =>
      new Intl.NumberFormat(currentLocale(), {
        style: "unit",
        unit,
        unitDisplay: "narrow",
        minimumIntegerDigits: index ? 2 : 1,
      }).format(value),
    )
    .join(" ");
}

// Loop cards.
function LoopValue({
  template,
  values,
}: {
  template: string;
  values: Record<string, string | number>;
}) {
  const [before, value, after] = formatText(t(template), values).split(
    /<v>|<\/v>/,
  );
  return (
    <>
      {before}
      <span className="session-loop-value">{value}</span>
      {after}
    </>
  );
}

export function SessionLoopTask({
  loop,
  now,
  stopping,
  onStop,
}: {
  loop: SessionLoop;
  now: number;
  stopping: boolean;
  onStop: (loop: SessionLoop) => void;
}) {
  const title =
    loop.prompt || t(loop.recurring ? "Recurring loop" : "Scheduled prompt");
  const row = useRef<HTMLDivElement>(null);
  const nextRunAt = loopNextRun(loop, now);
  const stopLabel = stopping
    ? t("Stop requested. Claudex will cancel it.")
    : t(loop.recurring ? "Stop this loop" : "Stop this scheduled prompt");
  return (
    <div
      className="session-loop-task"
      ref={row}
      tabIndex={-1}
      aria-label={formatText(
        t(loop.recurring ? "Loop: {description}" : "Once: {description}"),
        { description: title },
      )}
    >
      <div className="session-loop-title">
        <ShimmerText>{title}</ShimmerText>
        <button
          aria-label={stopLabel}
          title={stopLabel}
          aria-busy={stopping || undefined}
          disabled={stopping}
          onClick={() => {
            row.current?.focus({ preventScroll: true });
            onStop(loop);
          }}
        >
          <BackgroundGlyph name="Stop" />
        </button>
      </div>
      <div className="session-loop-meta">
        <span className="session-loop-details">
          <span className="session-loop-kind">
            {t(loop.recurring ? "Loop" : "Once")}
          </span>
          {stopping && <span role="status">{t("Stop requested…")}</span>}
          <span dir="ltr">{loop.cron}</span>
        </span>
        <span className="session-loop-details">
          {nextRunAt !== undefined && (
            <span className="session-loop-next">
              <LoopValue
                template="Next <v>{countdown}</v>"
                values={{ countdown: loopCountdown(nextRunAt - now) }}
              />
            </span>
          )}
          {(loop.recurring ||
            loop.nextRunAt > loop.createdAt + sessionLoopLifetime) && (
            <span>
              <LoopValue
                template="Ends <v>{days}d</v>"
                values={{
                  days: Math.max(
                    1,
                    Math.round(
                      (loop.createdAt + sessionLoopLifetime - now) / 86400000,
                    ),
                  ),
                }}
              />
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
