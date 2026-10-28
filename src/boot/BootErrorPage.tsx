import { useEffect, useState } from "react";
import { formatText, useT } from "../i18n";
import { Star } from "../ui/Star";
import { productName } from "../web/document-title";
import { browserOnline, bootFailureKind } from "../app/load-failure";
import { surface } from "../../shared/host";
import { WindowControls } from "../app/WindowControls";

/**
 * The window's caption buttons on a page shown without the app's title bar
 * (Windows and Linux desktop: the window has no frame of its own).
 */
export function FramelessControls() {
  const frameless =
    surface !== "web" &&
    !/Mac/i.test(navigator.platform || navigator.userAgent);
  return frameless ? <WindowControls /> : null;
}

/** The wait before Try again while the service is down (live: 10 s). */
const UNAVAILABLE_WAIT_S = 10;

/**
 * The page in place of the app when it could not start: the account or the
 * workspace did not load. The product's mark over a serif
 * headline and a secondary line, centred, and below them:
 * - service down (a 5xx, or the service's own refusal): "Claudex is
 *   temporarily unavailable", "We’re working on it — try again in a
 *   moment.", Try again held for 10 seconds with a countdown, and Log out;
 * - the browser offline: "You’re offline", "Check your connection.";
 * - anything else: "Can’t reach Claudex", "Check your connection.".
 * Try again reloads the page, as the original's does. Its "working on it"
 * links the public status page; Claudex's status page needs the app that
 * just failed to load, so the line is plain text here.
 *
 * In the first-load bundle: it has to show when nothing more can be fetched.
 */
export function BootErrorPage({
  error,
  answered,
  onLogOut,
}: {
  error: unknown;
  /** The failure came from the service (or the desktop's main process). */
  answered?: boolean;
  /** Signs this browser out; offered while the service is down. */
  onLogOut?: () => void;
}) {
  useT();
  const [online, setOnline] = useState(browserOnline);
  useEffect(() => {
    const update = () => setOnline(browserOnline());
    addEventListener("online", update);
    addEventListener("offline", update);
    return () => {
      removeEventListener("online", update);
      removeEventListener("offline", update);
    };
  }, []);
  const kind = bootFailureKind(error, { online, answered });
  const unavailable = kind === "unavailable";
  const [wait, setWait] = useState(unavailable ? UNAVAILABLE_WAIT_S : 0);
  const waiting = unavailable && wait > 0;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setWait((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  useEffect(() => {
    console.error("Claudex failed to start:", error);
  }, [error]);
  return (
    <div className="boot-error" data-testid="bootstrap-connection-error">
      <FramelessControls />
      <div className="boot-error-logo">
        <Star size={24} />
        <span>{productName}</span>
      </div>
      <h2>
        {unavailable
          ? "Claudex is temporarily unavailable"
          : kind === "offline"
            ? "You’re offline"
            : "Can’t reach Claudex"}
      </h2>
      <h3>
        {unavailable
          ? "We’re working on it — try again in a moment."
          : "Check your connection."}
      </h3>
      <div className="boot-error-actions">
        <button
          type="button"
          className="primary"
          disabled={waiting}
          onClick={() => location.reload()}
        >
          {waiting
            ? formatText("Try again in {seconds}s", { seconds: wait })
            : "Try again"}
        </button>
        {unavailable && onLogOut && (
          <button type="button" className="secondary" onClick={onLogOut}>
            Log out
          </button>
        )}
      </div>
    </div>
  );
}
