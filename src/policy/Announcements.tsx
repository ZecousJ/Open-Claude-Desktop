import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MarkdownRenderer as ReactMarkdown } from "../ui/MarkdownRenderer";
import type { Announcement } from "../../shared/client-policy";
import { externalUrl, useOpenLink } from "../ui/ExternalLinks";
import { MarkdownImage, MarkdownImageLabel } from "../ui/MarkdownImage";
import { NoticeView } from "./NoticeView";
import { announcementNotice } from "./notice-content";

/** Refreshed on window focus at most this often. */
const refreshMs = 60_000;

export interface AnnouncementFeed {
  items: Announcement[];
  unread: Announcement[];
  markRead: (ids: string[]) => void;
}

/**
 * The service's list with the notices this window marked read and the
 * service has not confirmed yet kept read, so an answer to an earlier
 * request does not bring back a notice the person already put away.
 */
export function withLocalReads(
  items: Announcement[],
  markedRead: ReadonlySet<string>,
): Announcement[] {
  return items.map((item) =>
    !item.read && markedRead.has(item.id) ? { ...item, read: true } : item,
  );
}

/**
 * Administrator notices: Sub2API announcements (`GET /api/v1/announcements`,
 * read with `POST /announcements/:id/read`) or, for local accounts, the
 * operator policy file. Loaded at the start, on window focus (at most every
 * minute) and when the service changed; an unreachable service shows none.
 * Marking read shows at once; the service's answer then replaces the list,
 * and a failed request leaves the notice unread on the next load.
 */
export function useAnnouncementFeed(): AnnouncementFeed {
  const [items, setItems] = useState<Announcement[]>([]);
  const markedRead = useRef(new Set<string>());
  useEffect(() => {
    let live = true;
    let loadedAt = 0;
    const load = () => {
      loadedAt = Date.now();
      Promise.resolve(window.desktop?.announcements?.())
        .then(
          (value) =>
            live &&
            setItems(
              withLocalReads(
                Array.isArray(value) ? value : [],
                markedRead.current,
              ),
            ),
        )
        .catch(() => {});
    };
    load();
    const focus = () => {
      if (Date.now() - loadedAt >= refreshMs) load();
    };
    window.addEventListener("focus", focus);
    const off = window.desktop?.onEvent?.((event) => {
      if (event.type === "service-changed") load();
    });
    return () => {
      live = false;
      off?.();
      window.removeEventListener("focus", focus);
    };
  }, []);
  const markRead = useCallback((ids: string[]) => {
    if (!ids.length) return;
    for (const id of ids) markedRead.current.add(id);
    setItems((current) => withLocalReads(current, markedRead.current));
    for (const id of ids)
      void Promise.resolve(window.desktop?.markAnnouncementRead?.(id))
        .then((value) => {
          markedRead.current.delete(id);
          if (Array.isArray(value))
            setItems(withLocalReads(value, markedRead.current));
        })
        .catch(() => markedRead.current.delete(id));
  }, []);
  return useMemo(
    () => ({ items, unread: items.filter((item) => !item.read), markRead }),
    [items, markRead],
  );
}

type Context = AnnouncementFeed & {
  /** Counts requests to show What's new; the app opens the sheet on change. */
  openRequest: number;
  open: () => void;
};
const Announcements = createContext<Context>({
  items: [],
  unread: [],
  markRead: () => {},
  openRequest: 0,
  open: () => {},
});
export const useAnnouncements = () => useContext(Announcements);
/** Holds the signed-in account's notices for the sidebar, composer and What's new. */
export function AnnouncementsProvider({ children }: { children: ReactNode }) {
  const feed = useAnnouncementFeed();
  const [openRequest, setOpenRequest] = useState(0);
  const value = useMemo(
    () => ({
      ...feed,
      openRequest,
      open: () => setOpenRequest((count) => count + 1),
    }),
    [feed, openRequest],
  );
  return (
    <Announcements.Provider value={value}>{children}</Announcements.Provider>
  );
}

/**
 * Markdown the service wrote (announcements, release notes). Raw HTML is
 * dropped (no rehype-raw), links ask before leaving and follow the external
 * link policy; remote images load on request, or for release notes never.
 */
export function ServiceMarkdown({
  text,
  className,
  images = "on-request",
}: {
  text: string;
  className: string;
  images?: "on-request" | "never";
}) {
  const openLink = useOpenLink();
  return (
    <div className={`markdown ${className}`}>
      <ReactMarkdown
        preset="gfm"
        skipHtml
        components={{
          img: images === "never" ? MarkdownImageLabel : MarkdownImage,
          a: ({ href, children }) => {
            const url = externalUrl(href);
            return (
              <a
                href={url}
                onClick={(event) => {
                  event.preventDefault();
                  if (url) openLink(url);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** An announcement's Markdown: links ask before leaving, images load on request. */
export function AnnouncementBody({ text }: { text: string }) {
  return <ServiceMarkdown text={text} className="announcement-body" />;
}

/**
 * The newest unread popup-mode notice above the home composer, in the Chat or
 * Code banner frame. Read opens What's new; the cross marks it read.
 */
export function AnnouncementBanner({ variant }: { variant: "chat" | "code" }) {
  const { unread, markRead, open } = useAnnouncements();
  const notice = unread.find((item) => item.popup);
  const content = announcementNotice(unread);
  if (!notice || !content) return null;
  return (
    <NoticeView
      content={content}
      surface={variant}
      variant="home"
      onAction={open}
      onDismiss={() => markRead([notice.id])}
    />
  );
}
