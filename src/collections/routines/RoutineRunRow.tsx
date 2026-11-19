import { t } from "../../i18n";
import { RelativeTime } from "../../ui/RelativeTime";
import { Spinner } from "../../ui/Spinner";
import { CircleX, CircleHelp, Laptop } from "../../ui/glyphs";
import { type RoutineRunPage } from "../../../shared/routines";
import { type RoutineRun } from "../../../shared/routine-labels";
import { useHost } from "../../host/HostContext";
import "./routine-history.css";
import { skippedRunReason, HistoryTime } from "./RoutineHistory";

/** Inline history (live claude.ai bundle, 2026-10-14, ccd3f68fe-Ch8U0gGS.js:4001). */
export function RoutineRunRow({
  run,
  local,
  onOpen,
  href,
}: {
  run: RoutineRun;
  local: boolean;
  onOpen: (run: RoutineRun) => void;
  href?: string;
}) {
  const web = useHost().kind === "web";
  const running = run.status === "starting" || run.status === "running";
  const failed = run.status === "failed" || run.status === "interrupted";
  const skipped = run.status === "skipped";
  const content = (
    <>
      {web ? (
        <span className="routine-history-time">
          <HistoryTime startedAt={run.startedAt} />
          {run.trigger === "manual" && (
            <span className="routine-history-provenance"> · {t("Manual")}</span>
          )}
        </span>
      ) : (
        <RelativeTime
          createdAt={run.startedAt}
          className="routine-history-time"
        />
      )}
      <span className="routine-history-state">
        {local && (
          <span className="routine-history-host">
            <Laptop size={12} />
            Only this computer
          </span>
        )}
        {running ? (
          <span className="routine-history-state">
            <Spinner size={16} />
            Running
          </span>
        ) : failed ? (
          <span className="routine-history-state" title={run.error}>
            <CircleX size={16} />
            Failed
          </span>
        ) : skipped ? (
          <span className="routine-history-state">
            <svg
              width={16}
              height={16}
              viewBox="0 0 256 256"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M53.92,34.62A8,8,0,0,0,48,32,16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a8,8,0,0,0,5.92-13.38ZM73.55,80H48V51.88ZM48,208V96H88.1L189.92,208ZM224,48V177.23a8,8,0,1,1-16,0V96H134.88a8,8,0,0,1,0-16H208V48H184v8a8,8,0,0,1-16,0V48H91.25a8,8,0,0,1,0-16H168V24a8,8,0,0,1,16,0v8h24A16,16,0,0,1,224,48Z" />
            </svg>
            Skipped
            <span title={t(skippedRunReason(run))}>
              <CircleHelp size={12} />
            </span>
          </span>
        ) : (
          !run.readAt && (
            <span
              className="routine-run-unread"
              role="img"
              aria-label="Unread completed run"
            />
          )
        )}
      </span>
    </>
  );
  return (
    <li>
      {run.conversationId && web && href ? (
        <a
          className="routine-history-row"
          href={href}
          onClick={(event) => {
            if (
              event.button ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onOpen(run);
          }}
        >
          {content}
        </a>
      ) : run.conversationId ? (
        <button
          type="button"
          className="routine-history-row"
          onClick={() => onOpen(run)}
        >
          {content}
        </button>
      ) : (
        <div className="routine-history-row">{content}</div>
      )}
    </li>
  );
}

export function validRoutineRunPage(value: unknown): value is RoutineRunPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<RoutineRunPage>;
  if (
    !Array.isArray(page.runs) ||
    page.runs.length > 100 ||
    (page.nextCursor !== undefined && page.runs.length === 0) ||
    (page.nextCursor !== undefined &&
      (typeof page.nextCursor !== "string" ||
        !page.nextCursor ||
        page.nextCursor.length > 8192))
  )
    return false;
  const ids = new Set<string>();
  return page.runs.every((run) => {
    if (
      !run ||
      typeof run.id !== "string" ||
      !run.id ||
      ids.has(run.id) ||
      !Number.isFinite(run.startedAt) ||
      Number.isNaN(new Date(run.startedAt).getTime()) ||
      ![
        "starting",
        "running",
        "completed",
        "failed",
        "interrupted",
        "skipped",
      ].includes(run.status) ||
      !["manual", "schedule"].includes(run.trigger) ||
      (run.conversationId !== undefined &&
        typeof run.conversationId !== "string") ||
      (run.readAt !== undefined && !Number.isFinite(run.readAt)) ||
      (run.finishedAt !== undefined &&
        (!Number.isFinite(run.finishedAt) ||
          Number.isNaN(new Date(run.finishedAt).getTime()))) ||
      (run.error !== undefined && typeof run.error !== "string") ||
      (run.skipReason !== undefined &&
        !["missed", "in_progress", "busy", "sign_in"].includes(run.skipReason))
    )
      return false;
    ids.add(run.id);
    return true;
  });
}
