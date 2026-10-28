import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "../ui/glyphs";
import type {
  Announcement,
  AnnouncementAction,
} from "../../shared/announcements-api";
import { announcementDocument } from "./announcementDocument";
import "./announcements.css";
import { useDialogOverlay } from "../ui/dialog-stack";

/**
 * An announcement from the administrator, as claude.ai draws its "New"
 * dialogs: a badge, a serif title, the administrator's HTML, a black main
 * button and a plain second one on the left; an optional picture on the
 * right; a close button. Without a picture it is one narrow column. The HTML
 * is drawn in a sandboxed frame, so it styles itself and cannot run code.
 * Pressing anything closes it for good (the service records which).
 */
export default function AnnouncementDialog({
  announcement,
  onClose,
}: {
  announcement: Announcement;
  onClose: (action: AnnouncementAction) => void;
}) {
  const [dark, setDark] = useState(
    () => document.documentElement.dataset.theme !== "light",
  );
  // The frame follows the theme when it changes while the dialog is open.
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.dataset.theme !== "light"),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  const document_ = useMemo(
    () => announcementDocument(announcement.bodyHtml, dark),
    [announcement.bodyHtml, dark],
  );
  const primary = useRef<HTMLButtonElement>(null);
  const overlay = useDialogOverlay();
  useEffect(() => {
    primary.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose("close");
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [announcement.id, onClose]);
  const press = (action: AnnouncementAction) => {
    if (action === "primary" && announcement.primaryUrl)
      void Promise.resolve(
        window.desktop.openExternal(announcement.primaryUrl),
      ).catch(() => {});
    onClose(action);
  };
  return (
    <div
      {...overlay}
      className="announcement-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose("close");
      }}
    >
      <div
        className={`announcement ${announcement.imageUrl ? "with-image" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={announcement.title || "Announcement"}
      >
        <div className="announcement-text">
          {announcement.badge && (
            <span className="announcement-badge" data-no-translate>
              {announcement.badge}
            </span>
          )}
          {announcement.title && (
            <h2 data-no-translate>{announcement.title}</h2>
          )}
          {announcement.bodyFormat === "text" ? (
            <div
              className="announcement-body announcement-paragraphs"
              data-no-translate
            >
              {announcement.bodyHtml
                .split(/\r?\n/)
                .filter((line) => line.trim())
                .map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
            </div>
          ) : announcement.bodyHtml.trim() ? (
            <iframe
              key={dark ? "dark" : "light"}
              className="announcement-body"
              sandbox=""
              srcDoc={document_}
              title="Announcement"
            />
          ) : (
            <div className="announcement-body" />
          )}
          <div className="announcement-actions">
            {announcement.primaryUrl ? (
              <>
                <button
                  ref={primary}
                  type="button"
                  className="announcement-primary"
                  onClick={() => press("primary")}
                >
                  {announcement.primaryLabel || "Open"}
                </button>
                <button
                  type="button"
                  className="announcement-secondary"
                  onClick={() => press("dismiss")}
                >
                  {announcement.dismissLabel || "Not now"}
                </button>
              </>
            ) : (
              <button
                ref={primary}
                type="button"
                className="announcement-primary"
                onClick={() => press("dismiss")}
              >
                {announcement.primaryLabel || "Done"}
              </button>
            )}
          </div>
        </div>
        {announcement.imageUrl && (
          <img
            className="announcement-image"
            src={announcement.imageUrl}
            alt=""
            referrerPolicy="no-referrer"
          />
        )}
        <button
          type="button"
          className="announcement-close"
          aria-label="Close"
          onClick={() => onClose("close")}
        >
          <X size={20} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
