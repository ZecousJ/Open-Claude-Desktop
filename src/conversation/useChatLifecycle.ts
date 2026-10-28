import { useEffect, useRef } from "react";
import type { Conversation, Snapshot } from "../../shared/types";
import { markedUnreadByHand } from "./unread";

/**
 * What happens when the shown chat changes: an incognito chat that is no
 * longer shown is discarded (and incognito ends once a page or a saved chat
 * replaces it), and opening a chat clears its unread mark. Marking the open
 * chat unread keeps the mark until the next visit. A reply that finished
 * while the window was hidden is read once the window shows again.
 */
export function useChatLifecycle({
  active,
  page,
  incognito,
  endIncognito,
  setSnapshot,
  upsert,
  report,
}: {
  active?: Conversation;
  page: string;
  incognito: boolean;
  endIncognito: () => void;
  setSnapshot: (
    update: (s: Snapshot | undefined) => Snapshot | undefined,
  ) => void;
  upsert: (c: Conversation) => void;
  report: (e: unknown) => void;
}) {
  const api = window.desktop;
  const shownIncognito = useRef<string | undefined>(undefined);
  useEffect(() => {
    const previous = shownIncognito.current;
    const current =
      active?.incognito && page === "chat" ? active.id : undefined;
    shownIncognito.current = current;
    if (!previous || previous === current) return;
    void api.discardIncognito(previous).catch(report);
    setSnapshot((s) =>
      s
        ? {
            ...s,
            conversations: s.conversations.filter((c) => c.id !== previous),
          }
        : s,
    );
  }, [active?.id, active?.incognito, page]);
  useEffect(() => {
    if (incognito && (page !== "chat" || (active && !active.incognito)))
      endIncognito();
  }, [incognito, page, active?.id]);
  const markRead = (c: Conversation) =>
    void api
      .updateConversation(c.id, { unread: false })
      .then(upsert)
      .catch(report);
  // Opening a chat reads it. While it is on screen, an unread mark another
  // window or device set (the reply finished where it was not shown) is read at
  // once; one set here by hand stays until the next visit.
  const visited = useRef<string | undefined>(undefined);
  useEffect(() => {
    const open = page === "chat" ? active?.id : undefined;
    const opened = open !== visited.current;
    visited.current = open;
    if (!open || !active?.unread) return;
    if (opened) {
      markedUnreadByHand.delete(open);
      markRead(active);
    } else if (
      !markedUnreadByHand.has(open) &&
      document.visibilityState !== "hidden"
    )
      markRead(active);
  }, [active?.id, active?.unread, page]);
  // A reply that finished while the window was hidden marks even the open
  // chat unread; coming back to it reads it, unless it was already unread.
  const shown = useRef({ active, page });
  shown.current = { active, page };
  useEffect(() => {
    let hiddenWith: { id: string; unread: boolean } | undefined;
    const change = () => {
      const { active, page } = shown.current;
      const open = page === "chat" ? active : undefined;
      if (document.visibilityState === "hidden") {
        hiddenWith = open && { id: open.id, unread: Boolean(open.unread) };
        return;
      }
      if (open?.unread && hiddenWith?.id === open.id && !hiddenWith.unread)
        markRead(open);
      hiddenWith = undefined;
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
}
