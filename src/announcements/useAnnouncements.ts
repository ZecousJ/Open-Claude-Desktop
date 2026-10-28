import { useCallback, useEffect, useState } from "react";
import { api } from "../desktop-api";
import type {
  Announcement,
  AnnouncementAction,
} from "../../shared/announcements-api";

/** How often a window asks again while it stays open. */
const refreshMs = 10 * 60_000;

/**
 * The announcements this person has not closed, oldest first. Asked for when
 * the window opens, every ten minutes, and when it comes back to the front;
 * `close` reports the button pressed and takes the announcement off the list
 * at once (the service records it, so it doesn't return).
 */
export function useAnnouncements(accountId: string) {
  const [items, setItems] = useState<Announcement[]>([]);
  const [closed] = useState(() => new Set<number>());
  const load = useCallback(() => {
    Promise.resolve()
      .then(() => api.pendingAnnouncements())
      .then(
        (list) =>
          setItems(
            Array.isArray(list)
              ? list.filter((item) => !closed.has(item.id))
              : [],
          ),
        () => {},
      );
  }, [closed]);
  useEffect(() => {
    setItems([]);
    if (!accountId) return;
    load();
    const timer = setInterval(load, refreshMs);
    const visible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [accountId, load]);
  const close = useCallback(
    (item: Announcement, action: AnnouncementAction) => {
      closed.add(item.id);
      setItems((list) => list.filter((entry) => entry.id !== item.id));
      void Promise.resolve()
        .then(() => api.closeAnnouncement(item.id, action))
        .catch(() => closed.delete(item.id));
    },
    [closed],
  );
  return { items, close };
}
