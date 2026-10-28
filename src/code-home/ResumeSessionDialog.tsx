import { useEffect, useRef, useState } from "react";
import { GitBranch, Search } from "../ui/glyphs";
import type { Conversation, Turn } from "../../shared/types";
import {
  filterResumeSessions,
  resumeFolder,
  type ResumableSession,
  type ResumeScope,
} from "../../shared/resume-sessions";
import { currentLocale, t, useT } from "../i18n";
import { Modal } from "../ui/Controls";
import { SegmentedControl } from "../ui/SegmentedControl";
import "./resume-session.css";
import { useWorkspaceGit } from "./useWorkspaceGit";

/** Native session picker and transcript preview. */
export function ResumeSessionDialog({
  initialQuery,
  cwd,
  branch,
  onClose,
  onResume,
}: {
  initialQuery: string;
  cwd?: string;
  branch?: string;
  onClose(): void;
  onResume(conversation: Conversation): void;
}) {
  useT();
  const git = useWorkspaceGit(cwd);
  const currentBranch = branch ?? git.branch ?? undefined;
  const [query, setQuery] = useState(initialQuery);
  const [scope, setScope] = useState<ResumeScope>("all");
  const [sessions, setSessions] = useState<ResumableSession[]>();
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<Turn[] | null>();
  const input = useRef<HTMLInputElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setError(undefined);
    void window.desktop
      .listResumableSessions()
      .then((rows) => {
        if (current) setSessions(rows);
      })
      .catch(() => {
        if (current) setError("Couldn’t load your Claudex Code sessions.");
      });
    return () => {
      current = false;
    };
  }, [attempt]);
  const rows = filterResumeSessions(
    sessions ?? [],
    query,
    scope,
    cwd,
    currentBranch,
    /Mac|Win/.test(globalThis.navigator?.platform ?? ""),
  );
  const index = Math.max(
    0,
    rows.findIndex((row) => row.handle === selected),
  );
  const chosen = rows[index];
  useEffect(() => {
    let current = true;
    setPreview(undefined);
    if (!chosen) return;
    const timer = setTimeout(() => {
      void window.desktop
        .previewResumeSession(chosen.handle)
        .then((turns) => {
          if (current) setPreview(turns);
        })
        .catch(() => {
          if (current) setPreview(null);
        });
    }, 150);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [chosen?.handle]);
  useEffect(() => {
    document
      .getElementById(`resume-option-${index}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);
  async function resume(row: ResumableSession) {
    if (busy) return;
    setBusy(row.handle);
    setError(undefined);
    try {
      const conversation = await window.desktop.resumeSession(row.handle);
      if (live.current) {
        onResume(conversation);
        onClose();
      }
    } catch (failure) {
      if (live.current)
        setError(
          failure instanceof Error
            ? failure.message
            : "Couldn’t resume that session.",
        );
    } finally {
      if (live.current) setBusy(undefined);
    }
  }
  return (
    <Modal
      title={t("Resume a session")}
      onClose={onClose}
      className="resume-session-dialog"
    >
      <div
        className="resume-session-body"
        onKeyDown={(event) => {
          if (
            busy ||
            event.nativeEvent.isComposing ||
            (event.target instanceof HTMLElement &&
              event.target.closest("[data-resume-preview], [role=radio]"))
          )
            return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setSelected(
              rows[
                Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                )
              ]?.handle,
            );
          } else if (event.key === "Enter" && chosen && !event.repeat) {
            event.preventDefault();
            void resume(chosen);
          }
        }}
      >
        <div className="resume-session-list">
          <label className="resume-session-search">
            <Search size={16} />
            <input
              ref={input}
              autoFocus
              value={query}
              readOnly={!!busy}
              role="combobox"
              aria-expanded="true"
              aria-controls="resume-sessions"
              aria-activedescendant={
                chosen ? `resume-option-${index}` : undefined
              }
              placeholder={t("Search by title, folder, or branch")}
              aria-label={t("Search by title, folder, or branch")}
              onChange={(event) => {
                setQuery(event.target.value);
                setSelected(undefined);
              }}
            />
          </label>
          <SegmentedControl
            label={t("Which sessions to show")}
            value={scope}
            disabled={!!busy}
            segments={[
              { value: "all", label: t("All folders") },
              {
                value: "folder",
                label: t("This folder"),
                disabled: !cwd,
                disabledReason: t("Pick a folder in the composer first"),
              },
              {
                value: "branch",
                label: t("This branch"),
                disabled: !currentBranch,
                disabledReason: t("The composer isn’t on a Git branch"),
              },
            ]}
            onChange={(value) => {
              setScope(value);
              setSelected(undefined);
            }}
          />
          {error && (
            <div role="alert" className="resume-session-empty">
              {t(error)}
              {!sessions && (
                <button
                  type="button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  {t("Retry")}
                </button>
              )}
            </div>
          )}
          <ul
            id="resume-sessions"
            role="listbox"
            aria-label={t("Resume a session")}
            aria-busy={!!busy}
            onMouseDown={(event) => {
              event.preventDefault();
              input.current?.focus();
            }}
          >
            {!sessions && !error ? (
              <li role="presentation" className="resume-session-empty">
                {t("Loading sessions…")}
              </li>
            ) : !rows.length && sessions ? (
              <li role="presentation" className="resume-session-empty">
                {t(
                  query.trim() || scope !== "all"
                    ? "No sessions match your search."
                    : "No Claudex Code sessions found on this computer.",
                )}
              </li>
            ) : (
              rows.map((row, rowIndex) => (
                <li
                  key={row.handle}
                  id={`resume-option-${rowIndex}`}
                  role="option"
                  aria-selected={rowIndex === index}
                  onClick={() => {
                    if (!busy) setSelected(row.handle);
                  }}
                  onDoubleClick={() => void resume(row)}
                >
                  {(row.folderMissing || row.liveness === "unknown") && (
                    <span
                      className="resume-status-dot"
                      data-missing={row.folderMissing}
                      title={t(
                        row.folderMissing
                          ? "Folder not found"
                          : "Can’t confirm it’s closed",
                      )}
                    />
                  )}
                  <span className="resume-session-title">
                    {row.title || t("Untitled session")}
                  </span>
                  {row.gitBranch && (
                    <span
                      className="resume-session-branch"
                      title={row.gitBranch}
                    >
                      <GitBranch size={12} />
                      {row.gitBranch.split("/").at(-1)}
                    </span>
                  )}
                  {scope === "all" && (
                    <span className="resume-session-folder" title={row.cwd}>
                      {resumeFolder(row.cwd)}
                    </span>
                  )}
                  <time dateTime={new Date(row.lastActivityAt).toISOString()}>
                    {busy === row.handle
                      ? t("Resuming…")
                      : new Date(row.lastActivityAt).toLocaleDateString(
                          currentLocale(),
                          { month: "short", day: "numeric" },
                        )}
                  </time>
                </li>
              ))
            )}
          </ul>
        </div>
        <aside className="resume-session-preview">
          {chosen ? (
            <>
              <strong>{chosen.title || t("Untitled session")}</strong>
              <span className="resume-session-path">{chosen.cwd}</span>
              {chosen.gitBranch && <span>{chosen.gitBranch}</span>}
              <span>
                {t("Last active")}:{" "}
                {new Date(chosen.lastActivityAt).toLocaleString(
                  currentLocale(),
                )}
              </span>
              <span>{t("Where you left off")}</span>
              <div
                data-resume-preview
                role="region"
                tabIndex={0}
                aria-label={t("Where you left off")}
              >
                {preview === undefined
                  ? t("Loading preview…")
                  : preview === null
                    ? t("Couldn’t load the preview.")
                    : !preview.length
                      ? t("No messages yet.")
                      : preview.map((turn) => (
                          <div key={turn.id} className="resume-preview-turn">
                            {turn.prompt && (
                              <p className="resume-preview-user">
                                {turn.prompt}
                              </p>
                            )}
                            {turn.items
                              .filter((item) => item.type === "agentMessage")
                              .map((item) => (
                                <p key={item.id}>{item.text}</p>
                              ))}
                          </div>
                        ))}
              </div>
            </>
          ) : (
            <span>{t("Nothing to preview.")}</span>
          )}
        </aside>
      </div>
      <footer className="resume-session-keys">
        <span>↑ ↓ {t("navigate")}</span>
        <span>esc {t("close")}</span>
        <span>↵ {t("resume")}</span>
      </footer>
    </Modal>
  );
}
