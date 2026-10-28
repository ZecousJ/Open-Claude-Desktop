import { useEffect, useRef, useState, type ReactNode } from "react";
import { Spinner } from "../ui/Spinner";
import { t } from "../i18n";
import { PreviewGlyph, type PreviewGlyphName } from "./preview-glyphs";

/**
 * The pane's centred notice: an lg glyph drawn 28px in text-muted, the title in
 * body primary and the body in footnote muted (both 36ch, 4px apart), the
 * actions 4px apart, 12px gaps and padding.
 */
export function PreviewNotice({
  icon,
  title,
  body,
  actions,
}: {
  icon: Extract<PreviewGlyphName, "GlobeLg" | "CacheLg">;
  title: ReactNode;
  body?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="preview-notice" role="status">
      <PreviewGlyph name={icon} box={28} className="preview-notice-icon" />
      <div className="preview-notice-text">
        <p className="preview-notice-title">{title}</p>
        {body && <p className="preview-notice-body">{body}</p>}
      </div>
      {actions && <div className="preview-notice-actions">{actions}</div>}
    </div>
  );
}

/**
 * Browser tools are off (the original's `setting-off`): what they do and a
 * secondary button that turns them on.
 */
export function BrowserToolsOff({ onTurnOn }: { onTurnOn: () => void }) {
  return (
    <PreviewNotice
      icon="GlobeLg"
      title={t("Browser tools are turned off")}
      body={t(
        "They let Claudex start your dev server and open pages here. Once they’re on, Claudex can use them in new sessions on your computer.",
      )}
      actions={
        <button type="button" className="preview-button" onClick={onTurnOn}>
          {t("Turn on Browser tools")}
        </button>
      }
    />
  );
}

/** A start that was declined at its approval (the original's `not-started`). */
export function DevServerNotStarted({
  busy,
  onRetry,
}: {
  busy: boolean;
  onRetry: () => void;
}) {
  return (
    <PreviewNotice
      icon="CacheLg"
      title={t("Dev server wasn’t started")}
      body={t("It needs your approval to start.")}
      actions={
        <button
          type="button"
          className="preview-button"
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={onRetry}
        >
          {t("Try again")}
        </button>
      }
    />
  );
}

/** The last line of an error's output, for the failed card's log row. */
export function lastLogLine(message: string) {
  const lines = message
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

/**
 * Dev server failed to start: the Warning glyph at xl in text-disabled, the
 * title, the last line of the error in a row of its own (code muted on alpha-1)
 * with a Copy error log button that turns into Copied for 1.5s, and Try again.
 * The original adds "Error details were sent to Claude"; nothing is sent here,
 * so that line is left out.
 */
export function DevServerFailedCard({
  message,
  busy,
  onRetry,
}: {
  message: string;
  busy: boolean;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const line = lastLogLine(message);
  const copy = async () => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(message);
    } catch {
      setCopied(false);
      return;
    }
    setCopied(true);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="preview-card-wrap" role="status">
      <div className="preview-failed">
        <PreviewGlyph name="WarningXl" className="preview-disabled-icon" />
        <p className="preview-failed-title">
          {t("Dev server failed to start")}
        </p>
        {line && (
          <div className="preview-log-row">
            <span>{line}</span>
            <button
              type="button"
              className="preview-icon-button"
              aria-label={copied ? t("Copied") : t("Copy error log")}
              title={copied ? t("Copied") : t("Copy error log")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void copy()}
            >
              <PreviewGlyph name={copied ? "Check" : "Copy"} />
            </button>
          </div>
        )}
        {onRetry && (
          <div className="preview-notice-actions">
            <button
              type="button"
              className="preview-button"
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={onRetry}
            >
              {t("Try again")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The page's dev server stopped: a row on alpha-1 with Cache, the server's name
 * in body secondary, "Stopped" in footnote muted and an xxs secondary Restart,
 * and under it the caption.
 */
export function DevServerStoppedCard({
  name,
  busy,
  onRestart,
}: {
  name: string;
  busy: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="preview-card-wrap" role="status">
      <div className="preview-stopped">
        <div className="preview-stopped-row">
          <PreviewGlyph name="Cache" className="preview-stopped-icon" />
          <span className="preview-stopped-name">{name}</span>
          <span className="preview-stopped-state">{t("Stopped")}</span>
          <button
            type="button"
            className="preview-button xxs"
            aria-label={`${t("Restart")} ${name}`}
            aria-busy={busy || undefined}
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onRestart}
          >
            {t("Restart")}
          </button>
        </div>
        <p className="preview-stopped-caption">
          {t("The dev server stopped. Restart it, or close the preview.")}
        </p>
      </div>
    </div>
  );
}

/** The last frame, not a running page. */
export function RestoredPreview({
  tab,
  busy,
  onRestart,
  onDismiss,
}: {
  tab: import("../../shared/browser").BrowserTabState;
  busy: boolean;
  onRestart: () => void;
  onDismiss: () => void;
}) {
  if (!tab.restored) return null;
  const name = tab.restored.serverName ?? tab.title;
  return (
    <div className="preview-last-frame" data-testid="preview-last-frame">
      <img
        src={`data:image/jpeg;base64,${tab.restored.jpegBase64}`}
        alt={t("The last page this preview showed before the app closed")}
        draggable={false}
      />
      <div className="preview-last-frame-backdrop" aria-hidden="true" />
      <div className="preview-card-wrap" role="status">
        <div className="preview-stopped preview-restored-card">
          <div className="preview-stopped-row">
            <PreviewGlyph name="Cache" className="preview-stopped-icon" />
            <span className="preview-stopped-name">{name}</span>
            <span className="preview-stopped-state">{t("Stopped")}</span>
            <button
              type="button"
              className="preview-button xxs"
              disabled={busy}
              aria-busy={busy || undefined}
              aria-label={`${t("Restart")} ${name}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onRestart}
            >
              {t("Restart")}
            </button>
          </div>
          <p className="preview-stopped-caption">
            {t("Showing the page from before the app closed.")}
          </p>
          <button
            type="button"
            className="preview-button preview-restored-dismiss"
            onClick={onDismiss}
          >
            {t("Show start page")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** While a server the pane started comes up (the original's spinner and "Setting up preview"). */
export function SettingUpPreview() {
  return (
    <div className="preview-setting-up">
      <div role="status">
        <Spinner inheritColor size={20} className="spin" aria-hidden="true" />
        <span>{t("Setting up preview")}</span>
      </div>
    </div>
  );
}
