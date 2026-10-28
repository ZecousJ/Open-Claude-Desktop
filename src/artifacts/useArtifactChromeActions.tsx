import { openCommentCount } from "./comment-thread";
import { formatText, t } from "../i18n";
import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { useTooltip } from "../ui/Tooltip";
import type { DictationPhase } from "../composer/voice/DictationButton";
import { artifactChatLabel } from "./related-sessions";
import { Minimize2 } from "../ui/glyphs";
import { AppIcon } from "../ui/app-icon";
import { PopOutChatIcon } from "./FloatingChatPanel";
import { artifactNoteKeyOf } from "./artifact-metadata";
import { readComments } from "./ArtifactChrome";
import { scopedCommentValue, forgetStoredComments } from "./artifact-storage";
import type { Comment } from "./ArtifactChrome";
import { downloadArtifact, savedMessage } from "./artifact-actions";
import { markdownFence } from "./ArtifactSource";
import type { Artifact } from "../ui/ArtifactTypes";
import type { ArtifactComment } from "../../shared/artifact-notes";
import type { AppController } from "../app/AppContext";
import type { ArtifactPublication } from "../../shared/sharing-api";

/** What useArtifactChromeActions needs from ArtifactChrome.tsx. */
export interface UseArtifactChromeActionsKit {
  account: {
    id: string;
    email?: string | undefined;
    legacyOwner: boolean;
    conversationIds: ReadonlySet<string>;
  };
  app: AppController | undefined;
  artifact: Artifact;
  authorName: string;
  chatFloating: boolean;
  chatSessionCount: number | undefined;
  commentMode: boolean;
  expanded: boolean;
  menu: "filter" | "title" | "comments" | undefined;
  onClose: () => void;
  onComment: ((text: string) => Promise<void>) | undefined;
  onError: (e: unknown) => void;
  onExpand: () => void;
  onNotify: ((message: string) => void) | undefined;
  onRefresh: () => void;
  onToggleChatFloat: (() => void) | undefined;
  openStandaloneChat: () => void;
  preparingDownload: boolean;
  publication: ArtifactPublication | null;
  publishInput: {
    identity: string;
    title: string;
    language: string;
    content: string;
  };
  published: boolean;
  ready: boolean;
  refreshPublication: () => void;
  saved: {
    loaded: boolean;
    comments: ArtifactComment[] | undefined;
    canRead: boolean;
    canWrite: boolean;
    readOnly: boolean;
    isCurrent: () => boolean;
    writable: () => boolean;
    save: (comments: ArtifactComment[]) => Promise<void>;
  };
  setCommentMode: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<
    React.SetStateAction<"filter" | "title" | "comments" | undefined>
  >;
  setPreparingDownload: React.Dispatch<React.SetStateAction<boolean>>;
  setSharingExport: React.Dispatch<React.SetStateAction<boolean>>;
  sharingExport: boolean;
  shown: Artifact;
  shownVersion: number;
  standalone: boolean;
  versions: number;
}

export function useArtifactChromeActions(kit: UseArtifactChromeActionsKit) {
  const {
    account,
    app,
    artifact,
    authorName,
    chatFloating,
    chatSessionCount,
    commentMode,
    expanded,
    menu,
    onClose,
    onComment,
    onError,
    onExpand,
    onNotify,
    onRefresh,
    onToggleChatFloat,
    openStandaloneChat,
    preparingDownload,
    publication,
    publishInput,
    published,
    ready,
    refreshPublication,
    saved,
    setCommentMode,
    setMenu,
    setPreparingDownload,
    setSharingExport,
    sharingExport,
    shown,
    shownVersion,
    standalone,
    versions,
  } = kit;
  const comments = saved.comments ?? [];
  // The comment button says how many comments are still open, and shows a dot
  // for them while not commenting.
  const openCount = openCommentCount(comments);
  const openLabel = formatText(
    openCount === 1 ? "{count} open comment" : "{count} open comments",
    { count: openCount },
  );
  // Comment and its ⌄ have no text, so they carry the same delayed tooltip as
  // Expand and Close.
  const [showComments, setShowComments] = useState(false);
  const commentLabel = !saved.readOnly
    ? commentMode
      ? "Done commenting"
      : standalone
        ? "Comment on this artifact"
        : "Comment"
    : showComments
      ? "Done viewing"
      : "View comments";
  const commentTip = useTooltip(
    saved.canWrite && !commentMode && openCount ? openLabel : commentLabel,
  );
  const commentMenuTip = useTooltip("More comment options", {
    disabled: menu === "comments",
  });
  const chatShown = !expanded || chatFloating;
  function toggleChat() {
    setMenu(undefined);
    if (chatFloating && onToggleChatFloat) onToggleChatFloat();
    else onExpand();
  }
  const [showResolved, setShowResolved] = useState(false);
  // A pin's comment, jumped to in All comments: it rings once (1.3s).
  const [pulse, setPulse] = useState<{ id: string; at: number }>();
  const commentsList = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!pulse) return;
    commentsList.current
      ?.querySelector(`[data-comment-id="${CSS.escape(pulse.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => setPulse(undefined), 1300);
    return () => clearTimeout(timer);
  }, [pulse]);
  const [draft, setDraft] = useState<{
    x: number;
    y: number;
    /** Open the box to the left of the marker. */
    left: boolean;
    /** Raise the box so it stays inside the preview. */
    lift: number;
  }>();
  const mention = useRef<HTMLSpanElement>(null);
  const [mentionWidth, setMentionWidth] = useState(0);
  const [text, setText] = useState("");
  const [commentPhase, setCommentPhase] = useState<DictationPhase>("idle");
  const [sendToAgent, setSendToAgent] = useState(true);
  const [sending, setSending] = useState(false);
  const visibleComments = comments.filter((c) => showResolved || !c.resolved);
  const chatGroup = expanded ? (
    <div className="artifact-chat-group">
      <button
        className="artifact-chat-button"
        aria-label={
          standalone ? artifactChatLabel(chatSessionCount) : undefined
        }
        onClick={standalone ? openStandaloneChat : onExpand}
      >
        {chatFloating ? <Minimize2 size={14} /> : <AppIcon name="Chats" />}
        {t(chatFloating || standalone ? "Chat" : "Show chat")}
      </button>
      {onToggleChatFloat && (
        <button
          className="artifact-popout-chat"
          aria-label={t("Pop out chat")}
          aria-pressed={chatFloating}
          onClick={onToggleChatFloat}
        >
          <PopOutChatIcon size={14} />
        </button>
      )}
    </div>
  ) : null;
  const authorInitial = authorName.trim().slice(0, 1).toUpperCase() || "Y";
  // c53f61dc1:1443–1459 supplies a viewing label only for an older
  // snapshot; a current artifact with history must retain the plain title.
  const numberedOlder =
    Number.isInteger(shownVersion) &&
    shownVersion > 0 &&
    shownVersion < versions;
  const viewingVersionLabel = numberedOlder
    ? formatText("Version {number}", { number: shownVersion })
    : shown?.versionPinned
      ? t("Older version")
      : undefined;
  const titleMenuLabel = viewingVersionLabel
    ? formatText("{menuLabel}, {title}, {version}", {
        menuLabel: t("Artifact options"),
        title: artifact.name,
        version: viewingVersionLabel,
      })
    : formatText("{menuLabel}, {title}", {
        menuLabel: t("Artifact options"),
        title: artifact.name,
      });
  // The typed text starts after the @Claudex mention on its first line.
  useLayoutEffect(() => {
    setMentionWidth(mention.current ? mention.current.offsetWidth + 6 : 0);
  }, [draft, sendToAgent]);
  const noteKey = artifactNoteKeyOf(artifact);
  const header = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!saved.canWrite) {
      setDraft(undefined);
      setText("");
      setCommentMode(false);
    }
    if (!saved.canRead) setShowComments(false);
  }, [saved.canRead, saved.canWrite]);
  useEffect(() => {
    setDraft(undefined);
    setText("");
    setCommentMode(false);
    setShowComments(false);
  }, [noteKey, account.id, app?.controllerScope]);
  // Comments an earlier version kept in window storage move to the account
  // profile the first time their artifact is opened.
  const unsaved = saved.loaded && saved.comments === undefined;
  useEffect(() => {
    if (!unsaved || !saved.canWrite || typeof localStorage === "undefined")
      return;
    const conversationId = artifact.conversationId ?? "",
      source = artifact.sourcePath ?? artifact.id;
    const stored = readComments(
      scopedCommentValue(
        localStorage,
        account.id,
        conversationId,
        source,
        account.legacyOwner,
        account.conversationIds,
      ),
    );
    if (!stored.length) return;
    void saved
      .save(stored)
      .then(() => {
        if (!saved.isCurrent()) return;
        forgetStoredComments(
          localStorage,
          account.id,
          conversationId,
          source,
          account.legacyOwner,
        );
      })
      .catch((error) => {
        if (saved.isCurrent()) onError(error);
      });
  }, [noteKey, unsaved, account.id, account.legacyOwner, saved.canWrite]);
  useEffect(() => {
    if (draft) draftInput.current?.focus();
  }, [draft]);
  useEffect(() => {
    if (!menu) return;
    const panel = document.querySelector<HTMLElement>(".artifact-chrome-menu");
    panel?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    function pointer(e: PointerEvent) {
      if (
        !(e.target as Element).closest(".artifact-chrome-menu") &&
        !menuTrigger.current?.contains(e.target as Node)
      )
        setMenu(undefined);
    }
    function keyboard(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if ((e.target as Element).closest(".artifact-export-submenu")) return;
        e.preventDefault();
        setMenu(undefined);
        menuTrigger.current?.focus();
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        const scope = (e.target as Element).closest(".artifact-chrome-menu");
        const buttons = [
          ...(scope?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) ?? []),
        ].filter((b) => b.closest(".artifact-chrome-menu") === scope);
        if (!buttons.length) return;
        e.preventDefault();
        let i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        i =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? buttons.length - 1
              : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
                buttons.length;
        buttons[i].focus();
      }
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", keyboard);
    };
  }, [menu]);
  function toggleMenu(value: typeof menu, button: HTMLButtonElement) {
    menuTrigger.current = button;
    setMenu(menu === value ? undefined : value);
  }
  function save(next: Comment[]) {
    return saved.save(next);
  }
  function toggleCommentMode() {
    const state = keys.current;
    if (!state.isCurrent() || !state.canRead || !state.loaded) return;
    if (state.canWrite) setCommentMode((on) => !on);
    else {
      setShowComments((shown) => !shown);
      setCommentMode(false);
    }
    setDraft(undefined);
    setMenu(undefined);
  }
  // Keyboard, after the original's: C alone starts and ends commenting unless a
  // field has the keys; Esc steps back, first from a draft, then from comment
  // mode, then from the list. Both act only while focus is in this panel or
  // nowhere, and not under a dialog or a menu, which take Esc first.
  const keys = useRef({
    draft,
    commentMode,
    showComments,
    menu,
    ready,
    canRead: saved.canRead,
    canWrite: saved.canWrite,
    isCurrent: saved.isCurrent,
    loaded: saved.loaded,
  });
  const close = useRef(onClose);
  close.current = onClose;
  keys.current = {
    draft,
    commentMode,
    showComments,
    menu,
    ready,
    canRead: saved.canRead,
    canWrite: saved.canWrite,
    isCurrent: saved.isCurrent,
    loaded: saved.loaded,
  };
  useEffect(() => {
    function inReach(target: EventTarget | null) {
      const element = target as Element | null;
      if (!element || element === document.body) return true;
      return (
        element === document.documentElement ||
        Boolean(element.closest?.(".artifact-panel"))
      );
    }
    function key(event: KeyboardEvent) {
      const state = keys.current;
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        !inReach(event.target) ||
        document.querySelector("[aria-modal='true'], [role='menu']")
      )
        return;
      if (event.key === "Escape") {
        if (state.menu) return;
        if (state.draft) setDraft(undefined);
        else if (state.commentMode) setCommentMode(false);
        else if (state.showComments) setShowComments(false);
        // With nothing else to step back from, Escape in the viewer closes it.
        else if (
          event.target instanceof Element &&
          event.target.closest(".artifact-panel") &&
          !event.target.closest(
            "input, textarea, select, [contenteditable], [contenteditable='true']",
          )
        )
          close.current();
        else return;
        event.preventDefault();
        return;
      }
      if (
        (event.key === "c" || event.key === "C") &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        state.ready
      ) {
        const target = event.target as HTMLElement | null;
        if (
          target?.closest?.(
            "input, textarea, select, [contenteditable], [contenteditable='true']",
          )
        )
          return;
        event.preventDefault();
        toggleCommentMode();
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);
  async function submit(commentText = text) {
    if (!draft || !commentText.trim() || sending || !saved.writable()) return;
    setSending(true);
    try {
      if (sendToAgent) {
        if (!onComment)
          throw Error("Connect a conversation to send this comment.");
        await onComment(commentText.trim());
      }
      if (!saved.writable()) return;
      await save([
        ...comments,
        {
          id: crypto.randomUUID(),
          text: commentText.trim(),
          ...draft,
          createdAt: Date.now(),
          resolved: false,
        },
      ]);
      if (!saved.isCurrent()) return;
      setDraft(undefined);
      setText("");
      setCommentMode(false);
      setShowComments(true);
    } catch (e) {
      if (saved.isCurrent()) onError(e);
    } finally {
      if (saved.isCurrent()) setSending(false);
    }
  }
  async function action(kind: "export" | "copy" | "refresh") {
    if (kind === "export" && preparingDownload) return;
    setMenu(undefined);
    menuTrigger.current?.focus();
    try {
      if (kind === "export") {
        setPreparingDownload(true);
        try {
          const saved = await downloadArtifact(
            shown,
            shown.filename ?? `${shown.name}.${shown.language}`,
          );
          if (saved) onNotify?.(savedMessage(saved));
        } finally {
          setPreparingDownload(false);
        }
      }
      if (kind === "copy") {
        const fence = markdownFence(shown.content);
        await window.desktop.copyText(
          `# ${artifact.name}\n\n${fence}${artifact.language}\n${shown.content}\n${fence}`,
        );
        onNotify?.("Copied as Markdown");
      }
      if (kind === "refresh") onRefresh();
    } catch (e) {
      onError(e);
    }
  }
  async function shareExport() {
    if (sharingExport) return;
    setSharingExport(true);
    try {
      const link = published
        ? publication?.share
        : await window.desktop.publishArtifact(publishInput);
      if (link?.status === "active") {
        await window.desktop.copyText(link.url);
        onNotify?.(t("Link copied"));
      }
      refreshPublication();
    } catch (error) {
      onError(error);
    } finally {
      setSharingExport(false);
    }
  }
  return {
    action,
    authorInitial,
    chatGroup,
    chatShown,
    commentLabel,
    commentMenuTip,
    commentPhase,
    commentTip,
    comments,
    commentsList,
    draft,
    draftInput,
    header,
    mention,
    mentionWidth,
    menuTrigger,
    noteKey,
    openCount,
    openLabel,
    pulse,
    save,
    sendToAgent,
    sending,
    setCommentPhase,
    setDraft,
    setPulse,
    setSendToAgent,
    setShowComments,
    setShowResolved,
    setText,
    shareExport,
    showComments,
    showResolved,
    submit,
    text,
    titleMenuLabel,
    toggleChat,
    toggleCommentMode,
    toggleMenu,
    viewingVersionLabel,
    visibleComments,
  } as const;
}
