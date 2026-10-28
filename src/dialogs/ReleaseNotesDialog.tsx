import { useEffect, useRef } from "react";
import { tc } from "../i18n";
import { serviceReleaseNotes } from "../../shared/client-release";
import { releaseNotes } from "../app/release-notes";
import { Sheet } from "../ui/Sheet";
import {
  AnnouncementBody,
  ServiceMarkdown,
  useAnnouncements,
} from "../policy/Announcements";
import { usePolicy } from "../policy/PolicyContext";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
});

/**
 * What's new: the administrator's announcements first, then the service's notes
 * for its newest release (Markdown without raw HTML or remote images), then the
 * bundled Claudex release notes, each a dated entry with its version pill.
 * Opening the sheet marks the notices read.
 */
export function ReleaseNotesDialog({ onClose }: { onClose: () => void }) {
  const { items, unread, markRead } = useAnnouncements();
  const service = serviceReleaseNotes(usePolicy());
  // The notices unread when the sheet opened; later ones wait for the next open.
  const opened = useRef(unread.map((item) => item.id));
  useEffect(() => markRead(opened.current), [markRead]);
  return (
    <Sheet title="What’s new" onClose={onClose}>
      {items.map((item) => (
        <section
          className="release-notes-version announcement"
          key={`announcement-${item.id}`}
        >
          <header>
            <h3>{item.title}</h3>
            {item.createdAt > 1e12 && (
              <time dateTime={new Date(item.createdAt).toISOString()}>
                {dateFormat.format(item.createdAt)}
              </time>
            )}
          </header>
          <AnnouncementBody text={item.content} />
        </section>
      ))}
      {service && (
        <section
          className="release-notes-version service"
          key={`service-${service.version}`}
        >
          <header>
            <h3>
              {service.publishedAt
                ? dateFormat.format(service.publishedAt)
                : `Claudex ${service.version}`}
            </h3>
            <code>{service.version}</code>
          </header>
          <ServiceMarkdown
            text={service.markdown}
            className="release-notes-service"
            images="never"
          />
        </section>
      )}
      {releaseNotes
        .filter((notes) => notes.version !== service?.version)
        .map((notes) => (
          <section className="release-notes-version" key={notes.version}>
            <header>
              <h3>{notes.date}</h3>
              <code>{notes.version}</code>
            </header>
            {notes.sections.map((section) => (
              <div key={section.title}>
                <h4>{tc("release-section", section.title)}</h4>
                <ul>
                  {section.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        ))}
    </Sheet>
  );
}
