import { useState } from "react";
import { AppIcon } from "../ui/app-icon";
import type { BrowserTabState } from "../../shared/browser";
import { describeLoadError } from "../../shared/browser";
import { t } from "../i18n";
import { PreviewGlyph } from "./preview-glyphs";

/**
 * A page that could not be shown: the reason in words ("localhost refused to
 * connect."), Try again, and Open in the system browser (What's new: say
 * clearly why and offer the system browser). A crashed page offers Reload.
 */
export function BrowserErrorState({
  tab,
  browserName,
  onRetry,
  onOpenElsewhere,
}: {
  tab: BrowserTabState;
  browserName: string | null;
  onRetry: () => void;
  /** Absent when the address can't open elsewhere. */
  onOpenElsewhere?: () => void;
}) {
  if (tab.crashed && !tab.error)
    return (
      <div className="browser-error" role="alert">
        <AppIcon
          name="Warning"
          size={20}
          strokeWidth={1.5}
          aria-hidden="true"
        />
        <h3>This page crashed</h3>
        <p>Reload it to try again.</p>
        <div className="browser-error-actions">
          <button onClick={onRetry}>Reload</button>
        </div>
      </div>
    );
  if (!tab.error) return null;
  const { title, detail } = describeLoadError(tab.error);
  const blocked = tab.error.description === "BLOCKED_BY_ADMINISTRATOR";
  // A blocked site is the strip above the page (BlockedSiteStrip) instead.
  if (blocked) return null;
  return (
    <div className="browser-error" role="alert">
      <AppIcon name="Warning" size={20} strokeWidth={1.5} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{detail}</p>
      {!blocked && (
        <div className="browser-error-actions">
          <button onClick={onRetry}>Try again</button>
          {onOpenElsewhere && (
            <button onClick={onOpenElsewhere}>
              {browserName ? `Open in ${browserName}` : "Open in browser"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A site the administrator blocks: a strip over the page, role status, the sm
 * Warning glyph and the line in body text-warning on bg-warning, px-md py-sm,
 * 5px apart.
 */
export function BlockedSiteStrip() {
  return (
    <div className="browser-blocked" role="status">
      <PreviewGlyph name="Warning" />
      <span>{t("This site is blocked by your organization’s policy.")}</span>
    </div>
  );
}

/**
 * Bars between the address row and the page (visual-provisional): Select
 * element instructions, a page still loading after 20 seconds, the page's
 * confirm/prompt/leave question, a download the browser refused.
 */
export function BrowserNotices({
  tab,
  picking,
  onCancelPick,
  onStop,
  onAnswer,
}: {
  tab?: BrowserTabState;
  picking: boolean;
  onCancelPick: () => void;
  onStop: () => void;
  onAnswer: (accept: boolean, text?: string) => void;
}) {
  return (
    <>
      {picking && (
        <div className="browser-notice" role="status">
          <span>Click an element on the page to add it to your message.</span>
          <button onClick={onCancelPick}>Cancel</button>
        </div>
      )}
      {tab?.stalled && tab.loading && (
        <div className="browser-notice" role="status">
          <span>This page is taking a long time to finish loading.</span>
          <button onClick={onStop}>Stop</button>
        </div>
      )}
      {tab?.dialog && (
        <PageDialog
          key={`${tab.id}:${tab.dialog.message}`}
          dialog={tab.dialog}
          onAnswer={onAnswer}
        />
      )}
      {tab?.notice?.kind === "download-blocked" && (
        <div className="browser-notice" role="status">
          <span>
            Downloads aren't supported in the built-in browser
            {tab.notice.filename ? ` (${tab.notice.filename})` : ""}.
          </span>
        </div>
      )}
    </>
  );
}

function PageDialog({
  dialog,
  onAnswer,
}: {
  dialog: NonNullable<BrowserTabState["dialog"]>;
  onAnswer: (accept: boolean, text?: string) => void;
}) {
  const [text, setText] = useState(dialog.defaultValue ?? "");
  const leave = dialog.type === "beforeunload";
  return (
    <form
      className="browser-notice browser-page-dialog"
      role="alertdialog"
      aria-label="Page dialog"
      onSubmit={(event) => {
        event.preventDefault();
        onAnswer(true, dialog.type === "prompt" ? text : undefined);
      }}
    >
      <span>
        <strong>
          {leave ? "Leave this page?" : `${dialog.origin || "This page"} says:`}
        </strong>{" "}
        {leave ? "Changes you made may not be saved." : dialog.message}
      </span>
      {dialog.type === "prompt" && (
        <input
          aria-label="Answer"
          value={text}
          autoFocus
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <button type="button" onClick={() => onAnswer(false)}>
        {leave ? "Stay" : "Cancel"}
      </button>
      <button type="submit">{leave ? "Leave" : "OK"}</button>
    </form>
  );
}
