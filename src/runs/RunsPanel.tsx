import { useEffect, useState } from "react";
import {
  Maximize2,
  Minimize2,
  Check,
  ChevronRight,
  Clock,
  X,
} from "../ui/glyphs";
import { Spinner } from "../ui/Spinner";
import type { Conversation } from "../../shared/types";
import {
  repeatLabel,
  repeatOf,
  type RoutineRun,
} from "../../shared/routine-labels";
import { useApp } from "../app/AppContext";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { usePaneExpandToggle } from "../app/pane-expand";
import { RelativeTime } from "../ui/RelativeTime";
import { t } from "../i18n";
import { groupRuns, sessionRuns, type SessionRuns } from "./runs-model";
import "./runs-panel.css";

/** Scheduled-task runs. */
export function RunsPanel({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const app = useApp();
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<{
    id: string;
    data?: SessionRuns;
    loading: boolean;
    error?: string;
  }>({
    id: conversation.id,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  usePaneExpandToggle("runs", () => setExpanded((value) => !value));
  useEffect(() => {
    let alive = true;
    let request = 0;
    setState({ id: conversation.id, loading: true });
    const load = () => {
      const current = ++request;
      void sessionRuns(conversation.id, window.desktop).then(
        (data) => {
          if (alive && request === current)
            setState({ id: conversation.id, data, loading: false });
        },
        (error) => {
          if (alive && request === current)
            setState({
              id: conversation.id,
              loading: false,
              error: String(error),
            });
        },
      );
    };
    load();
    const off = window.desktop.onEvent((event) => {
      if (event.type === "schedules") load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [conversation.id, conversation.turns.at(-1)?.status, tick]);
  const rows = (runs: RoutineRun[]) => (
    <ul>
      {runs.map((run) => {
        const target = app.snapshot.conversations.find(
          (chat) => chat.id === run.conversationId,
        );
        const running = run.status === "running" || run.status === "starting";
        const label = running
          ? "Running"
          : run.status === "failed"
            ? "Failed"
            : run.status === "interrupted"
              ? "Cancelled"
              : "Completed";
        return (
          <li
            key={run.id}
            data-current={run.conversationId === conversation.id || undefined}
          >
            <button
              type="button"
              aria-current={
                run.conversationId === conversation.id ? "page" : undefined
              }
              onClick={() => {
                if (target) {
                  app.openConversation(target);
                  app.setPanel("runs");
                }
              }}
            >
              {running ? (
                <Spinner inheritColor size={12} className="spin" />
              ) : run.status === "completed" ? (
                <Check size={12} />
              ) : (
                <X size={12} />
              )}
              <span>
                <RelativeTime createdAt={run.startedAt} />
                <small>{t(label)}</small>
              </span>
              <ChevronRight size={16} />
            </button>
          </li>
        );
      })}
    </ul>
  );
  const groups = groupRuns(
    (state.data?.runs ?? []).filter((run) =>
      app.snapshot.conversations.some((chat) => chat.id === run.conversationId),
    ),
  );
  return (
    <aside
      className={`work-panel runs-panel${expanded ? " expanded" : ""}`}
      aria-label={t("Runs")}
    >
      <header>
        <strong>{t("Runs")}</strong>
        <div>
          <button
            type="button"
            aria-label={t(expanded ? "Tile" : "Fill")}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          <button type="button" aria-label={t("Close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </header>
      {state.loading || state.id !== conversation.id ? (
        <div className="runs-empty" role="status">
          <Spinner inheritColor size={20} className="spin" />
          <span className="sr-only">{t("Loading")}</span>
        </div>
      ) : state.error ? (
        <div className="runs-empty" role="alert">
          <p>{state.error}</p>
          <button onClick={() => setTick((value) => value + 1)}>
            {t("Try again")}
          </button>
        </div>
      ) : !state.data ? (
        <div className="runs-empty">
          <Clock size={20} />
          <h3>{t("Not a scheduled task run")}</h3>
          <p>
            {t(
              "This session wasn’t started from a scheduled task. Open a session that a scheduled task started to see its run history here.",
            )}
          </p>
        </div>
      ) : (
        <div className="runs-content">
          <div className="runs-summary">
            <div>
              <h2>
                {state.data.routine.name} <small>{t("Local")}</small>
              </h2>
              <p>{repeatLabel(repeatOf(state.data.routine))}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                requestScheduleConfirmation({
                  description: "",
                  routineId: state.data!.routine.id,
                });
                app.setPage("scheduled");
              }}
            >
              {t("Details")}
            </button>
          </div>
          {groups.running.length > 0 && (
            <section>
              <h3>{t("Running")}</h3>
              {rows(groups.running)}
            </section>
          )}
          {groups.completed.length > 0 && (
            <section>
              <h3>{t("Completed")}</h3>
              {rows(groups.completed)}
            </section>
          )}
          {!groups.running.length && !groups.completed.length && (
            <p className="runs-empty-message">{t("No runs yet")}</p>
          )}
        </div>
      )}
    </aside>
  );
}
