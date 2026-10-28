import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InfoIcon } from "../ui/icons";
import { AppIcon } from "../ui/app-icon";
import { Spinner } from "../ui/Spinner";
import { t } from "../i18n";
import { ReasonTooltip } from "../ui/Tooltip";
import type { Mode } from "../../shared/types";

/** Why a reply's buttons wait: another response is still being written. */
export const waitingForResponse =
  "Waiting for a previous response to finish...";

export interface ReplyBannerButton {
  label: string;
  onClick: () => void;
  primary?: boolean;
  /** The action is under way: its label gives way to a spinner and it cannot be pressed again. */
  busy?: boolean;
}

/**
 * A line under a reply that did not end normally: a failure's reason, the
 * output limit, a stop with nothing written. The original shows these as a
 * neutral banner inside the conversation, the sentence on the left and
 * secondary buttons on the right, and while another response is still being
 * written the buttons stay but are disabled with "Waiting for a previous
 * response to finish...".
 */
export function ReplyBanner({
  mode,
  role = "status",
  buttons = [],
  disabledReason,
  actionAlign = "first-line",
  warning = false,
  onDismiss,
  children,
}: {
  mode: Mode;
  role?: "status" | "alert";
  buttons?: ReplyBannerButton[];
  /** Set while the buttons cannot be used; shown as their tooltip. */
  disabledReason?: string;
  /** "center": the buttons sit across the middle of a text of several
      lines (a title over a sentence) instead of on its first line. */
  actionAlign?: "first-line" | "center";
  /** The Warning glyph in place of Info. */
  warning?: boolean;
  /** A close button at the end of the first line, after the buttons. */
  onDismiss?: () => void;
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const actions = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  useLayoutEffect(() => {
    const root = container.current;
    const content = text.current;
    const controls = actions.current;
    if (!root || !content || !controls || typeof ResizeObserver === "undefined")
      return;
    const measure = () => {
      const lineHeight = Number.parseFloat(
        getComputedStyle(content).lineHeight,
      );
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
      const top = controls.getBoundingClientRect().top;
      const box = content.getBoundingClientRect();
      // Centered buttons have wrapped once they start under the text.
      setWrapped(
        actionAlign === "center"
          ? top >= box.bottom - 1
          : top - box.top > lineHeight / 2,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [buttons.length, actionAlign]);
  return (
    <div
      ref={container}
      className={`reply-banner ${mode === "code" ? "code" : "chat"}`}
      data-cds="Banner"
      data-prose-box=""
      data-icon-layout="first-line"
      data-cta-layout={wrapped ? "wrapped" : "inline"}
      data-action-align={actionAlign}
      data-dismissible={onDismiss ? "" : undefined}
      data-notice="reply"
      data-testid="message-warning"
      role={role}
    >
      <span className="reply-banner-icon">
        {warning ? <AppIcon name="Warning" /> : <InfoIcon />}
      </span>
      <div className="reply-banner-body">
        <div ref={text} className="reply-banner-text">
          {children}
        </div>
        {buttons.length > 0 && (
          <span ref={actions} className="reply-banner-actions">
            {buttons.map((button) => (
              <ReasonTooltip
                key={button.label}
                reason={disabledReason}
                placement="above"
              >
                {(tooltip) => (
                  <button
                    {...tooltip}
                    type="button"
                    className="reply-banner-action"
                    aria-disabled={disabledReason ? true : undefined}
                    aria-busy={button.busy || undefined}
                    data-disabled={disabledReason ? true : undefined}
                    onClick={() => {
                      if (!disabledReason && !button.busy) button.onClick();
                    }}
                  >
                    {button.busy ? (
                      <>
                        <span style={{ visibility: "hidden" }}>
                          {button.label}
                        </span>
                        <Spinner inheritColor size={14} label={t("Checking")} />
                      </>
                    ) : (
                      button.label
                    )}
                  </button>
                )}
              </ReasonTooltip>
            ))}
          </span>
        )}
      </div>
      {onDismiss && (
        <span className="reply-banner-dismiss-slot">
          <button
            className="auth-issue-dismiss"
            aria-label={t("Dismiss")}
            type="button"
            onClick={onDismiss}
          >
            <AppIcon name="X" />
          </button>
        </span>
      )}
    </div>
  );
}
