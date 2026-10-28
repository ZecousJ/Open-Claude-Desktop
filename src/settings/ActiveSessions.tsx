import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreVertical, ChevronLeft, ChevronRight } from "../ui/glyphs";
import {
  sessionDeviceLabel,
  sessionLocation,
} from "../../shared/active-sessions";
import type { ActiveSession } from "../../shared/settings-api";
import { ConfirmationDialog } from "../dialogs/ConfirmationDialog";
import { currentLocale, formatText, useT } from "../i18n";
import { Menu, type MenuPosition } from "../ui/Menu";
import { Skeleton } from "../ui/Skeleton";
import { showToast } from "../ui/toast-store";
import { WithTooltip } from "../ui/Tooltip";
import { Section } from "./controls";
import { notAvailable } from "./unavailable";
import "./active-sessions.css";

/**
 * * every signed-in session of the account with its device, location, when it
 *   was created and last updated, and a ⋮ menu that logs this session out or
 *   terminates another one after a confirmation. While it loads the table shows
 *   three placeholder rows; when it cannot load, one muted line replaces it;
 *   ten rows a page.
 *
 * Claudex's sessions are the desktop app on each computer, the web app in each
 * browser and the phone apps. The service may supply location metadata; without
 * it the original falls back to "Unknown".
 */

/** Rows a page (the original's 10). */
export const sessionsPerPage = 10;

/** The original's date in the table and the row's label: "Oct 12, 2026, 9:30 AM". */
export function sessionDate(at: number | null): string {
  if (at === null) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

type Loaded =
  | { state: "loading" }
  | { state: "failed" }
  /** An account on this computer only: there is no service to ask. */
  | { state: "local" }
  | { state: "ready"; sessions: ActiveSession[] };

export function ActiveSessionsSection({
  onSignOut,
  onError = () => {},
}: {
  /** Logs this window's session out (the current row's Log out). */
  onSignOut?: () => Promise<void>;
  /** A failed sign-out of this session. */
  onError?: (error: unknown) => void;
}) {
  return (
    <Section title="Active sessions">
      <ActiveSessionsTable onSignOut={onSignOut} onError={onError} />
    </Section>
  );
}

export function ActiveSessionsTable({
  onSignOut,
  onError,
  initial = { state: "loading" },
}: {
  onSignOut?: () => Promise<void>;
  /** A failed sign-out of this session. */
  onError: (error: unknown) => void;
  /** What to show before the first answer (tests render a state directly). */
  initial?: Loaded;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<Loaded>(initial);
  const [page, setPage] = useState(1);
  const [ending, setEnding] = useState<string>();
  const request = useRef(0);
  const load = () => {
    const id = ++request.current;
    void window.desktop
      .activeSessions()
      .then((sessions) => {
        if (id !== request.current) return;
        // Anything but a list (an older runner, a missing method) reads as
        // a failed load rather than breaking the window.
        setLoaded(
          sessions === null
            ? { state: "local" }
            : Array.isArray(sessions)
              ? { state: "ready", sessions }
              : { state: "failed" },
        );
      })
      .catch(() => {
        if (id === request.current) setLoaded({ state: "failed" });
      });
  };
  useEffect(() => {
    if (initial.state === "loading") load();
  }, []);

  // The original's toasts after a terminate: done, already gone (the list
  // is read again), or failed (the row can be tried again).
  const end = (session: ActiveSession) => {
    setEnding(session.id);
    void window.desktop
      .endActiveSession(session.id)
      .then(({ ended }) => {
        showToast(
          t(
            ended
              ? "Session terminated."
              : "This session has already ended or changed.",
          ),
        );
        load();
      })
      .catch(() =>
        showToast(t("Failed to terminate session. You can try again.")),
      )
      .finally(() => setEnding(undefined));
  };

  if (loaded.state === "failed")
    return (
      <p className="active-sessions-error">
        Unable to load active sessions. Try again later.
      </p>
    );
  const sessions = loaded.state === "ready" ? loaded.sessions : [];
  const pages = Math.max(1, Math.ceil(sessions.length / sessionsPerPage));
  const current = Math.min(page, pages);
  const shown = sessions.slice(
    (current - 1) * sessionsPerPage,
    current * sessionsPerPage,
  );
  return (
    <div className="active-sessions">
      <table className="cowork-devices">
        <colgroup>
          <col className="col-device" />
          <col className="col-location" />
          <col className="col-date" />
          <col className="col-date" />
          <col className="col-actions" />
        </colgroup>
        <thead>
          <tr>
            <th>Device</th>
            <th>Location</th>
            <th>Created</th>
            <th>
              <WithTooltip
                label="When this session was last used or had its expiration time updated."
                size="wrap"
              >
                {(props) => (
                  <span
                    className="session-updated-head"
                    tabIndex={0}
                    {...props}
                  >
                    Updated
                  </span>
                )}
              </WithTooltip>
            </th>
            <th aria-hidden="true" />
          </tr>
        </thead>
        <tbody aria-busy={loaded.state === "loading" || undefined}>
          {loaded.state === "loading" ? (
            [0, 1, 2].map((row) => (
              <tr key={row} aria-hidden="true">
                <td>
                  <Skeleton width="60%" height={14} />
                </td>
                <td>
                  <Skeleton width="50%" height={14} />
                </td>
                <td>
                  <Skeleton width={120} height={14} />
                </td>
                <td>
                  <Skeleton width={120} height={14} />
                </td>
                <td />
              </tr>
            ))
          ) : loaded.state === "local" ? (
            <tr>
              <td colSpan={5} className="session-empty">
                {notAvailable}
              </td>
            </tr>
          ) : !shown.length ? (
            <tr>
              <td colSpan={5} className="session-empty">
                No active sessions found.
              </td>
            </tr>
          ) : (
            shown.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                ending={ending === session.id}
                onEnd={() => end(session)}
                onSignOut={onSignOut}
                onError={onError}
              />
            ))
          )}
        </tbody>
      </table>
      {sessions.length > sessionsPerPage && (
        <Pager
          page={current}
          pages={pages}
          total={sessions.length}
          onPage={setPage}
        />
      )}
    </div>
  );
}

function SessionRow({
  session,
  ending,
  onEnd,
  onSignOut,
  onError,
}: {
  session: ActiveSession;
  ending: boolean;
  onEnd: () => void;
  onSignOut?: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const label = sessionDeviceLabel(session);
  return (
    <tr>
      <td>
        <span className="session-device">
          {label ? (
            <span data-no-translate title={label}>
              {label}
            </span>
          ) : (
            <span>Unknown device</span>
          )}
          {session.current && <span className="session-current">Current</span>}
        </span>
      </td>
      <td>{sessionLocation(session) ?? "Unknown"}</td>
      <td>{sessionDate(session.createdAt)}</td>
      <td>{sessionDate(session.updatedAt)}</td>
      <td>
        <SessionActions
          session={session}
          deviceLabel={label}
          ending={ending}
          onEnd={onEnd}
          onSignOut={onSignOut}
          onError={onError}
        />
      </td>
    </tr>
  );
}

/**
 * The row's ⋮ and its confirmation (the original's: one red item, "Log
 * out" on the current session, "Terminate" on the others).
 */
function SessionActions({
  session,
  deviceLabel,
  ending,
  onEnd,
  onSignOut,
  onError,
}: {
  session: ActiveSession;
  deviceLabel: string | null;
  ending: boolean;
  onEnd: () => void;
  onSignOut?: () => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const t = useT();
  const more = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuPosition>();
  const [confirming, setConfirming] = useState(false);
  const device = deviceLabel ?? t("Unknown device");
  // This window's session logs out as the account menu does; without a way
  // to (never for a signed-in window) the row offers nothing.
  if (session.current && !onSignOut) return null;
  const action = session.current ? "Log out" : "Terminate";
  return (
    <>
      <button
        ref={more}
        type="button"
        className="session-more"
        aria-label={
          session.current
            ? formatText("Session actions for {device} (current session)", {
                device,
              })
            : formatText("Session actions for {device} created {date}", {
                device,
                date: sessionDate(session.createdAt),
              })
        }
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={ending}
        onClick={() => {
          const rect = more.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: innerWidth - rect.right, top: rect.bottom + 4 },
          );
        }}
      >
        <MoreVertical size={16} />
      </button>
      {menu && (
        <Menu
          label={t(action)}
          size="regular"
          width={200}
          position={menu}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
          entries={[
            {
              label: action,
              danger: true,
              onSelect: () => setConfirming(true),
            },
          ]}
        />
      )}
      {confirming &&
        createPortal(
          <ConfirmationDialog
            confirmation={{
              title: session.current
                ? "Log out of current session"
                : "Terminate session",
              body: session.current
                ? "This is your current session. Logging out will end your session and you will need to sign in again."
                : "Are you sure you want to terminate this session? The device will lose access to your account.",
              confirm: action,
              danger: true,
              // The original closes the dialog at once; the row's ⋮ waits
              // while the session ends, and a toast says how it went.
              action: async () => {
                if (session.current) void onSignOut?.().catch(onError);
                else onEnd();
              },
            }}
            onClose={() => setConfirming(false)}
            onError={() => {}}
          />,
          document.body,
        )}
    </>
  );
}

/** The original's page footer: the range on the left, ‹ Page n of m › on the right. */
function Pager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const t = useT();
  const locale = currentLocale();
  const start = (page - 1) * sessionsPerPage + 1;
  const end = Math.min(page * sessionsPerPage, total);
  return (
    <div className="active-sessions-pager">
      <div role="status" aria-live="polite">
        {formatText("Showing {start}–{end} of {total}", {
          start: start.toLocaleString(locale),
          end: end.toLocaleString(locale),
          total: total.toLocaleString(locale),
        })}
      </div>
      <nav aria-label={t("Table pagination")}>
        <button
          type="button"
          aria-label={t("Previous page")}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeft size={16} strokeWidth={1.75} />
        </button>
        <span>
          {formatText("Page {page} of {total}", {
            page: page.toLocaleString(locale),
            total: pages.toLocaleString(locale),
          })}
        </span>
        <button
          type="button"
          aria-label={t("Next page")}
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={16} strokeWidth={1.75} />
        </button>
      </nav>
    </div>
  );
}
