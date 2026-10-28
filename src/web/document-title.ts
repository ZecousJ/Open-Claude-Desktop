import { useEffect, useRef, useState } from "react";
import type { Conversation, Mode } from "../../shared/types";
import { useApp } from "../app/AppContext";
import { useFavicon } from "./favicon";

/**
 * The browser tab's title (SCRATCH/impl/web/W-UI-design.md §6.2): "<what
 * the window shows> - Claudex", and "Claudex Code" on the Code surface.
 */
export const productName = "Claudex";
export const codeProductName = `${productName} Code`;

/** Titles of the pages with an address (src/web/routes.ts). */
const pageTitles: Record<string, string> = {
  projects: "Projects",
  artifacts: "Artifacts",
  artifact: "Artifact",
  customize: "Customize",
  api: "API",
  status: "Service status",
  shared: "Shared chat",
  history: "Recents",
  scheduled: "Scheduled",
  "not-found": "Page not found",
};

export interface TitleState {
  page: string;
  mode: Mode;
  /** The open conversation, when it is known. */
  conversation?: Pick<Conversation, "title" | "mode">;
  incognitoShown?: boolean;
  settingsOpen?: boolean;
  /**
   * Chats that finished while the tab was in the background; shown as
   * "(n) " in front until the tab is looked at again.
   */
  unseen?: number;
}

/** The tab title of a window state. */
export function documentTitle(state: TitleState): string {
  const prefix = state.unseen ? `(${state.unseen}) ` : "";
  return prefix + baseTitle(state);
}

function baseTitle(state: TitleState): string {
  if (state.settingsOpen) return `Settings - ${productName}`;
  if (state.page === "chat") {
    // An incognito chat's title stays out of the tab (and its history).
    if (state.incognitoShown) return `Incognito chat - ${productName}`;
    const conversation = state.conversation;
    if (conversation) {
      const title = conversation.title.trim() || "New chat";
      return conversation.mode === "code"
        ? `${title} - ${codeProductName}`
        : `${title} - ${productName}`;
    }
    return state.mode === "code" ? codeProductName : productName;
  }
  const page = Object.hasOwn(pageTitles, state.page)
    ? pageTitles[state.page]
    : undefined;
  return page ? `${page} - ${productName}` : productName;
}

/**
 * Conversations that became unread since `baseline` was taken: the chats
 * that finished while the tab was hidden (src/unread.ts marks them).
 */
export function newlyUnread(
  conversations: readonly Conversation[],
  baseline: ReadonlySet<string>,
): number {
  return conversations.filter(
    (c) => c.unread && !c.incognito && !c.archived && !baseline.has(c.id),
  ).length;
}

const unreadIds = (conversations: readonly Conversation[]) =>
  new Set(conversations.filter((c) => c.unread).map((c) => c.id));

/**
 * Sets the browser tab's title and icon from where the window is.
 *
 * Mounted by App on the web only (src/host/WebMounts.tsx), inside
 * AppContext, so it can call useApp().
 */
export function useDocumentTitle(): void {
  const app = useApp();
  const hidden = usePageHidden();
  // The chats already unread when the tab went into the background.
  const baseline = useRef<Set<string> | null>(null);
  if (hidden && !baseline.current)
    baseline.current = unreadIds(app.snapshot.conversations);
  if (!hidden) baseline.current = null;
  const unseen = baseline.current
    ? newlyUnread(app.listed, baseline.current)
    : 0;
  const title = documentTitle({
    page: app.page,
    mode: app.mode,
    conversation: app.active,
    incognitoShown: app.incognitoShown,
    settingsOpen: app.settingsOpen,
    unseen,
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
  useFavicon();
}

/** Whether the tab is in the background (`document.hidden`). */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return hidden;
}
