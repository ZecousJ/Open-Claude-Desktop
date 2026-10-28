import { useEffect, useRef, useState } from "react";
import type {
  RoutineSchedulePreview as Preview,
  Routine,
} from "../../../shared/routines";
import { currentLocale, formatText, t } from "../../i18n";
import "./routine-schedule-preview.css";

function validPreview(value: unknown): value is Preview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Partial<Preview>;
  if (
    preview.nextRunAt !== null &&
    (!Number.isFinite(preview.nextRunAt) ||
      Number.isNaN(new Date(preview.nextRunAt!).getTime()))
  )
    return false;
  if (preview.timeZone !== undefined) {
    if (typeof preview.timeZone !== "string" || !preview.timeZone) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: preview.timeZone }).format();
    } catch {
      return false;
    }
  }
  return true;
}

/** A remote schedule is previewed by its runner, never by this browser's clock. */
export function RoutineSchedulePreview({
  expression,
  executionLocation,
  disabled,
}: {
  expression: string;
  executionLocation?: Routine["executionLocation"];
  disabled: boolean;
}) {
  const [value, setValue] = useState<Preview>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requestKey = JSON.stringify([expression, executionLocation]);
  const renderedFor = useRef(requestKey);
  const preview = renderedFor.current === requestKey ? value : undefined;
  const visibleError = renderedFor.current === requestKey ? error : "";
  useEffect(() => {
    let current = true;
    renderedFor.current = requestKey;
    setValue(undefined);
    setError("");
    void Promise.resolve()
      .then(() => {
        if (!current) return;
        if (typeof window.desktop.routineSchedulePreview !== "function")
          throw new Error(
            t("Schedule preview isn’t available on this service."),
          );
        return window.desktop.routineSchedulePreview(
          { kind: "cron", expression: expression.trim() },
          executionLocation,
        );
      })
      .then((next: unknown) => {
        if (!current) return;
        if (!validPreview(next))
          throw new Error(t("Couldn’t load the schedule preview. Try again."));
        setValue(next);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      current = false;
    };
  }, [expression, executionLocation, attempt]);
  if (visibleError)
    return (
      <span className="routine-schedule-preview" role="alert">
        <span>{visibleError}</span>{" "}
        <button
          type="button"
          className="secondary"
          disabled={disabled}
          onClick={() => setAttempt((value) => value + 1)}
        >
          {t("Retry")}
        </button>
      </span>
    );
  return (
    <span className="routine-schedule-preview" role="status">
      {!preview ? (
        t("Loading schedule preview…")
      ) : (
        <>
          <span>
            {preview.nextRunAt === null
              ? t("No upcoming run for this schedule.")
              : formatText("Next run: {date}", {
                  date: preview.timeZone
                    ? new Date(preview.nextRunAt).toLocaleString(
                        currentLocale(),
                        {
                          timeZone: preview.timeZone,
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        },
                      )
                    : new Date(preview.nextRunAt).toISOString(),
                })}
          </span>
          <span>
            {preview.timeZone
              ? formatText("Time zone: {zone}", { zone: preview.timeZone })
              : t("Time zone unavailable.")}
          </span>
        </>
      )}
    </span>
  );
}
