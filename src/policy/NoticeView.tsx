import { useLayoutEffect, useRef, useState } from "react";
import {
  CloseIcon,
  CloseSmallIcon,
  InfoIcon,
  UsageGaugeIcon,
} from "../ui/icons";
import { DownloadTrayIcon } from "./policy-icons";
import { Anthropicon } from "../ui/anthropicons";
import { useT } from "../i18n";
import type {
  ComposerNoticeVariant,
  NoticeContent,
  NoticeSurface,
} from "./notice-content";

/** Below this width a narrowed notice puts its buttons on a second row. */
const narrowFrameBelow = 520;

const icons = {
  gauge: UsageGaugeIcon,
  info: InfoIcon,
  download: DownloadTrayIcon,
  coffee: ({ className }: { className?: string }) => (
    <Anthropicon name="CoffeeCup" className={className} />
  ),
};

/**
 * One notice above the composer, in the frame of its surface and place
 * (usage-limit-banner.css): Chat and Cowork use the outlined box (R-Chat
 * home, S-0006, S-0008), which puts its button on a second row without the
 * icon when narrowed by a side panel (S-0006 progress panel); Code uses the
 * filled strip at home (R-0338) and, in a conversation, a card whose button
 * sits under the text (R-Code-会话行右键-Move-to-group, R-Code-Browser单面板).
 */
export function NoticeView({
  content,
  surface,
  variant,
  onAction,
  onSecondary,
  onDismiss,
}: {
  content: NoticeContent;
  surface: NoticeSurface;
  variant: ComposerNoticeVariant;
  onAction?: () => void;
  onSecondary?: () => void;
  onDismiss?: () => void;
}) {
  const t = useT();
  const Icon = icons[content.icon];
  // A side panel's narrow frame (S-0006) only once the column is too narrow
  // for one row (owner, 2026-10-03: Retry fell to a second row in a wide
  // column).
  const box = useRef<HTMLDivElement>(null);
  const [roomy, setRoomy] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || variant !== "narrow") return;
    const measure = () =>
      setRoomy(el.getBoundingClientRect().width >= narrowFrameBelow);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [variant]);
  const shown = variant === "narrow" && roomy ? "conversation" : variant;
  // An administrator's announcement is their own words; the rest is ours.
  const shownText = (text: string) =>
    content.kind === "announcement" ? text : t(text);
  const iconShown = !(surface === "chat" && shown === "narrow");
  const continueLast = content.secondary?.kind === "continue";
  const secondary = content.secondary && onSecondary && (
    <button
      type="button"
      className={`usage-banner-more ${continueLast ? "usage-banner-primary" : "usage-banner-notify"}`}
      onClick={onSecondary}
      disabled={content.secondary.disabled}
    >
      {t(content.secondary.label)}
    </button>
  );
  return (
    <div
      ref={box}
      className={`usage-banner ${surface} ${shown} ${content.tone}`}
      data-notice={content.kind}
      role={content.role}
      aria-live={content.role === "status" ? "polite" : undefined}
    >
      {iconShown && <Icon className="usage-banner-icon" />}
      <span className="usage-banner-text">
        <span className="usage-banner-title">{shownText(content.title)}</span>
        {content.detail && (
          <span className="usage-banner-detail">
            {shownText(content.detail)}
          </span>
        )}
      </span>
      <span className="usage-banner-actions">
        {/* Continue, the primary button, sits right of Retry (owner,
            2026-10-03); other secondary buttons come first. */}
        {!continueLast && secondary}
        {content.action && (
          <button
            type="button"
            className="usage-banner-more"
            onClick={onAction}
            disabled={content.action.disabled}
          >
            {t(content.action.label)}
          </button>
        )}
        {continueLast && secondary}
      </span>
      {content.dismissible && (
        <button
          type="button"
          className="usage-banner-close"
          aria-label={t("Dismiss")}
          onClick={onDismiss}
        >
          {surface === "code" ? <CloseSmallIcon /> : <CloseIcon />}
        </button>
      )}
    </div>
  );
}
