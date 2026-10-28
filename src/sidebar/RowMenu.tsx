import {
  Suspense,
  useContext,
  useEffect,
  useState,
  type RefObject,
} from "react";
import { outputStyleNames } from "../../shared/output-styles";
import { Folder } from "../ui/glyphs";
import type { Conversation, Project } from "../../shared/types";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { ShortcutPlatform } from "../ui/Tooltip";
import { AppContext } from "../app/AppContext";
import { useHost } from "../host/HostContext";
import {
  keepGroupWhileEmpty,
  setConversationGroups,
  useConversationGroups,
} from "./grouping";
import { moveToGroupEntries } from "./move-to-group-entries";

// Kept here for the callers that read it from the row menu.
export { moveToGroupEntries };
import type { PinReorder, RowActions } from "./ConversationRow";
import { sessionPullRequest } from "../../shared/pull-request";
import { openPullRequest } from "../pr/open-pull-request";
import { useOpenLink } from "../ui/ExternalLinks";
import { forkConversationById } from "../app/fork";
import { useInstalledEditors } from "../editors/useInstalledEditors";
import {
  canContinueInCloud,
  requestContinueInCloud,
} from "../app/continue-resume";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { formatText } from "../i18n";
import { exportConversation } from "../conversation/conversation-export";
import {
  cloudSessionUrl,
  openSessionInDesktopApp,
} from "../conversation/cloud-session-links";
import { lazyPiece } from "../ui/lazy-piece";
import { transcriptViewEntries } from "../conversation/ConversationTitle";
import {
  defaultTranscriptView,
  makeTranscriptViewDefault,
} from "../transcript-view/useTranscriptViewActions";
import {
  setTranscriptView,
  transcriptViewFor,
} from "../transcript-view/transcript-view-store";
import {
  openQuickTask,
  quickTaskCapacityMessage,
} from "../cowork/spin-off-store";
import { rowMenuEntries } from "./row-menu-entries";

/** What the row menu may offer; an entry that is false is left out. */
export type RowMenuAbilities = {
  /** Panes side by side (the desktop's Code split view, src/split-view). */
  splitView: boolean;
  /** Separate conversation windows (host capability popOutWindows). */
  newWindow: boolean;
  /** Reveal the working folder (host capability localFolders). */
  folder: boolean;
  /** The terminal panel (host capability localTerminal). */
  terminal: boolean;
  /** Sharing is on for this account and the sidebar opens the dialog. */
  share: boolean;
  /** The conversation has a public link that is not taken down. */
  copyLink: boolean;
  /** The Code session made a pull request (Open PR). */
  pullRequest?: boolean;
  /**
   * Fork: the session has a finished turn to continue from and is not
   * incognito (the same rule as the title bar's menu).
   */
  fork?: boolean;
  /** Export: the transcript can be saved (not an incognito session). */
  export?: boolean;
  /** Open as quick task is greyed: the task is the one on screen. */
  quickTaskDisabled?: boolean;
};

export type RowMenuHandlers = {
  openInSplit: () => void;
  openInWindow: () => void;
  openIn: (target: "terminal" | "folder") => void;
  togglePin: () => void;
  toggleUnread: () => void;
  markCompleted?: () => void;
  suppressTitleOffers?: () => void;
  acceptTitleOffer?: () => void;
  hideNested?: () => void;
  showNested?: () => void;
  detach?: () => void;
  releaseRunner?: () => void;
  rename: () => void;
  share: () => void;
  copyLink: () => void;
  /** Fork (Code): a new session continuing this one. */
  fork?: () => void;
  /** Export (Code): saves the session's transcript. */
  exportConversation?: () => void;
  /**
   * Move up / Move down (Code, a pinned row): one place along Pinned; absent
   * at the end it cannot move toward.
   */
  moveUp?: () => void;
  moveDown?: () => void;
  moveToProject: (projectId: string | null) => void;
  /** Opens the new project dialog (with the typed name) for this conversation. */
  newProject?: (name: string) => void;
  toggleArchive: () => void;
  remove: () => void;
  /** Open PR: the pull request the session made; absent without one. */
  openPr?: () => void;
  /**
   * Open as quick task: the task in a task window on the Cowork page. Absent
   * where there are no task windows.
   */
  openAsQuickTask?: () => void;
  /** Open in ▸ Desktop app: a cloud Code session in the desktop app. */
  openInDesktop?: () => void;
  /** Open in ▸ the editors this computer has (a local Code session's folder). */
  editors?: { name: string; onSelect: () => void }[];
  /** Open in ▸ Continue in ▸ Cloud ("Runs without your computer"). */
  continueInCloud?: () => void;
  /** Go to scheduled task: the task that started this session. */
  goToScheduledTask?: () => void;
  /** Keep computer awake, Only for this session (a switch). */
  keepAwake?: { on: boolean; onToggle: () => void };
  /** Transcript view ▸ for this session (the title menu's rows). */
  transcriptView?: MenuEntry[];
  /** Output style ▸ (the title menu's rows). */
  outputStyle?: MenuEntry[];
  /** Unarchive is running: the row reads Unarchiving… until it is done. */
  unarchiving?: boolean;
};

/**
 * 144 wide as the Code menu; "Open in new window" needs 168 so it is not cut
 * off. The web's menu is 170.5 wide, with icons.
 */
export const rowMenuWidth = (entries: MenuEntry[]) =>
  globalThis.document?.documentElement.dataset.surface === "web"
    ? 170.5
    : entries.some((entry) => "label" in entry && entry.label.length > 16)
      ? 168
      : 144;

/** Sessions being unarchived: the row reads Unarchiving… until they are back. */
export const unarchiving = new Set<string>();

/**
 * Output style ▸ as the title menu draws it (Default, the built-in styles
 * greyed with the reason, New style…).
 */
const NewOutputStyleDialog = lazyPiece(
  () => import("../output-style/NewOutputStyleDialog"),
);

function outputStyleEntries(
  conversation: Conversation,
  onSelect: (name: string) => void,
  onNew: () => void,
): MenuEntry[] {
  const names = outputStyleNames(conversation.customOutputStyles);
  return [
    ...names.map((name) => ({
      label: name === "default" ? "Default" : name,
      checked: (conversation.outputStyle ?? "default") === name,
      onSelect: () => onSelect(name),
    })),
    { separator: true },
    { label: "New style…", onSelect: onNew },
  ];
}

/** What a row last learned about sharing, so a reopened menu is steady. */
type RowShare = { canShare: boolean; link?: string };
const knownShares = new Map<string, RowShare>();

/**
 * Reads, while the menu is open, whether the conversation can be shared and
 * its public link. Nothing is read for an incognito chat; a local account or
 * an unreachable service offers neither entry.
 */
function useRowShare(c: Conversation, open: boolean): RowShare {
  const [share, setShare] = useState<RowShare>(
    () => knownShares.get(c.id) ?? { canShare: false },
  );
  useEffect(() => {
    const api = window.desktop;
    if (!open || c.incognito || !api?.sharingStatus) return;
    let live = true;
    void (async () => {
      const status = await api.sharingStatus().catch(() => null);
      const link = status
        ? await api.conversationShare(c.id).catch(() => null)
        : null;
      const next: RowShare = {
        canShare: Boolean(status?.conversations),
        ...(link?.status === "active" ? { link: link.url } : {}),
      };
      knownShares.set(c.id, next);
      if (live) setShare(next);
    })();
    return () => {
      live = false;
    };
  }, [open, c.id, c.incognito]);
  return share;
}

/**
 * The row's menu, loaded the first time one opens (it is most of the row's
 * code and most rows never open it): builds the entries for the
 * conversation, reads whether it can be shared while open, and lists the
 * person's groups.
 */
export default function RowMenu({
  conversation: c,
  projects,
  actions,
  position,
  anchor,
  onRename,
  onNewGroup,
  pinReorder,
  onClose,
}: {
  conversation: Conversation;
  projects: Project[];
  actions: RowActions;
  position: MenuPosition;
  anchor: RefObject<HTMLElement | null>;
  onRename: () => void;
  /** "New group…" in Move to group: the list asks for the name in a dialog. */
  onNewGroup: (c: Conversation) => void;
  /** A pinned row's Move up and Move down (the list knows its neighbours). */
  pinReorder?: PinReorder;
  onClose: () => void;
}) {
  const groups = useConversationGroups();
  const app = useContext(AppContext);
  const platform = useContext(ShortcutPlatform);
  const host = useHost();
  const [newStyle, setNewStyle] = useState(false);
  const share = useRowShare(c, true);
  // An unarchived session leaves the pending list once it is back.
  if (!c.archived) unarchiving.delete(c.id);
  const cloudCode = c.mode === "code" && host.kind === "web";
  const localCode =
    c.mode === "code" &&
    !!c.cwd &&
    (!c.environment || c.environment.kind === "local");
  const editors = useInstalledEditors(
    localCode && host.capabilities.localFolders,
  );
  const openLink = useOpenLink();
  const pullRequest =
    c.mode === "code" && !c.incognito ? sessionPullRequest(c) : undefined;
  // Move to group: the person's groups with the current one checked, then
  // Ungrouped (when the conversation is in one) and New group…; the first nine
  // take the keys 1 to 9.
  const groupId = groups.members[c.id];
  // The group it leaves stays in view in this window, even once empty. A pinned
  // conversation moved into a group leaves Pinned, as a drag into the group
  // does.
  const moveTo = (target: string | null) => {
    if (c.pinned && target !== null) actions.onTogglePin(c);
    void window.desktop
      .moveConversationToGroup(c.id, target)
      .then((next) => {
        if (groupId && groupId !== target) keepGroupWhileEmpty(groupId);
        setConversationGroups(next);
      })
      .catch((error) => app?.report(error));
  };
  const moveToGroup: MenuEntry = {
    label: "Move to group",
    icon: <Folder size={20} strokeWidth={1.5} />,
    submenu: moveToGroupEntries({
      groups: groups.groups,
      groupId,
      moveTo,
      newGroup: () => onNewGroup(c),
    }),
  };
  const entries = rowMenuEntries({
    conversation: c,
    projects,
    platform,
    surface: host.kind,
    can: {
      splitView: Boolean(actions.onOpenInSplit),
      newWindow: host.capabilities.popOutWindows,
      folder: host.capabilities.localFolders,
      terminal: host.capabilities.localTerminal,
      share: share.canShare && Boolean(actions.onShare),
      // A web Code session's own address is always its link.
      copyLink: Boolean(share.link) || cloudCode,
      pullRequest: Boolean(pullRequest),
      fork: !c.incognito && c.turns.length > 0,
      export: !c.incognito,
      quickTaskDisabled: app?.activeId === c.id,
    },
    moveToGroup,
    nestedSessionCount: app?.snapshot.conversations.filter(
      (value) => value.parentSessionId === c.id,
    ).length,
    on: {
      openInSplit: () => actions.onOpenInSplit?.(c),
      openInWindow: () =>
        actions.onOpenInWindow
          ? actions.onOpenInWindow(c)
          : void window.desktop
              .openConversationWindow(c.id)
              .catch((error) => app?.report(error)),
      openIn: (target) => actions.onOpenIn(c, target),
      togglePin: () => actions.onTogglePin(c),
      toggleUnread: () => actions.onToggleUnread(c),
      ...(actions.onUpdateConversation
        ? {
            markCompleted: () =>
              void actions.onUpdateConversation?.(c, {
                completedAt: Date.now(),
              }),
            suppressTitleOffers: () =>
              void actions.onUpdateConversation?.(c, {
                titleOffersSuppressed: true,
              }),
            acceptTitleOffer: () =>
              c.titleOffer &&
              void actions.onUpdateConversation?.(c, {
                titleOfferResponse: { at: c.titleOffer.at, action: "accept" },
              }),
            hideNested: () =>
              void actions.onUpdateConversation?.(c, {
                nestedSessionsHidden: true,
              }),
            showNested: () =>
              void actions.onUpdateConversation?.(c, {
                nestedSessionsHidden: false,
              }),
            detach: () =>
              void actions.onUpdateConversation?.(c, { parentSessionId: null }),
          }
        : {}),
      ...(app && c.mode === "code" && !c.runnerReleasedAt
        ? {
            releaseRunner: () =>
              app.setConfirm({
                title: "Release runner?",
                body:
                  host.kind === "desktop"
                    ? "Your session will pause and the runner will be freed for other work. Any uncommitted files on the runner will be lost. Click in the message box or start typing to resume — it may pick up a different runner."
                    : "Your session will pause and the runner will be freed for other work. Any uncommitted files on the runner will be lost. Send a message to resume — it may pick up a different runner.",
                confirm: "Release",
                action: async () => {
                  const next = await window.desktop.releaseRunner(c.id);
                  app.upsert(next);
                },
              }),
          }
        : {}),
      rename: onRename,
      share: () => actions.onShare?.(c),
      // The menu may show a link remembered from an earlier opening; copy
      // only what the service says is live now, so a link taken down or
      // stopped since is never handed out.
      copyLink: () =>
        cloudCode
          ? void window.desktop
              .copyText(cloudSessionUrl(c.id))
              .then(() => app?.notify("Link copied to clipboard."))
              .catch((error) => app?.report(error))
          : void window.desktop
              .conversationShare(c.id)
              .then((current) => {
                if (current?.status !== "active") {
                  knownShares.set(c.id, {
                    canShare: share.canShare,
                  });
                  return;
                }
                // An invited-only chat is read at its invitation link, as the
                // title menu and the share popover copy it.
                return window.desktop.copyText(
                  c.mode !== "code" && current.access === "invited"
                    ? (current.inviteUrl ?? current.url)
                    : current.url,
                );
              })
              .catch((error) => app?.report(error)),
      ...(pinReorder?.onMoveUp ? { moveUp: pinReorder.onMoveUp } : {}),
      ...(pinReorder?.onMoveDown ? { moveDown: pinReorder.onMoveDown } : {}),
      fork: () => {
        if (app) void forkConversationById(app, c.id);
      },
      exportConversation: () =>
        void exportConversation(c, (error) => app?.report(error)),
      moveToProject: (projectId) => actions.onMoveToProject(c, projectId),
      ...(app
        ? { newProject: (name: string) => app.startProject(c.id, name) }
        : {}),
      toggleArchive: () => {
        if (c.archived) unarchiving.add(c.id);
        actions.onToggleArchive(c);
      },
      remove: () => actions.onDelete(c),
      // The task windows live on the Cowork page of the main window.
      ...(localCode &&
      host.capabilities.localFolders &&
      window.desktop?.openConversationInEditor
        ? {
            editors: editors.map((editor) => ({
              name: editor.name,
              onSelect: () =>
                void window.desktop
                  .openConversationInEditor(c.id, editor.kind)
                  .then((opened) => {
                    if (!opened)
                      app?.report(
                        new Error(
                          formatText("Couldn’t open this in {editor}.", {
                            editor: editor.name,
                          }),
                        ),
                      );
                  })
                  .catch((error) => app?.report(error)),
            })),
          }
        : {}),
      ...(cloudCode
        ? { openInDesktop: () => openSessionInDesktopApp(c.id) }
        : {}),
      ...(app && canContinueInCloud(c, host.capabilities.localCode)
        ? {
            continueInCloud: () => {
              app.openConversation(c);
              // The header opens the dialog for the session on screen.
              setTimeout(() => requestContinueInCloud(c.id), 0);
            },
          }
        : {}),
      ...(app && (c.scheduledTaskId || c.scheduledRun)
        ? {
            goToScheduledTask: () => {
              if (c.scheduledTaskId)
                requestScheduleConfirmation({
                  description: "",
                  openRoutineId: c.scheduledTaskId,
                });
              app.setPage("scheduled");
            },
          }
        : {}),
      ...(app &&
      localCode &&
      host.capabilities.localCode &&
      host.kind === "desktop"
        ? {
            keepAwake: {
              on: Boolean(c.keepAwake),
              onToggle: () =>
                void window.desktop
                  .updateConversation(c.id, { keepAwake: !c.keepAwake })
                  .then((next) => app.upsert(next))
                  .catch((error) => app.report(error)),
            },
          }
        : {}),
      ...(app && c.mode === "code"
        ? {
            transcriptView: transcriptViewEntries({
              view: transcriptViewFor(c.id, defaultTranscriptView(app)),
              defaultView: defaultTranscriptView(app),
              onSelect: (next) => setTranscriptView(c.id, next),
              onMakeDefault: () =>
                makeTranscriptViewDefault(
                  app,
                  transcriptViewFor(c.id, defaultTranscriptView(app)),
                ),
            }),
            outputStyle: outputStyleEntries(
              c,
              (name) =>
                void app
                  .patchConversation(c, { outputStyle: name })
                  .catch(app.report),
              () => setNewStyle(true),
            ),
            unarchiving: unarchiving.has(c.id),
          }
        : {}),
      ...(app && app.windowRole.kind !== "conversation"
        ? {
            openAsQuickTask: () => {
              if (!openQuickTask("session_menu", { sessionId: c.id }))
                app.report(new Error(quickTaskCapacityMessage));
            },
          }
        : {}),
      openPr: () =>
        pullRequest &&
        openPullRequest(pullRequest.url, app?.snapshot.settings, openLink),
    },
  });
  return (
    <>
      <Menu
        label={`Options for ${c.title}`}
        // The web shows the single-key hints too.
        showRootHints
        className="row-menu"
        entries={entries}
        position={position}
        width={rowMenuWidth(entries)}
        anchors={[anchor]}
        onClose={onClose}
      />
      {newStyle && app && (
        <Suspense fallback={null}>
          <NewOutputStyleDialog
            onClose={() => setNewStyle(false)}
            onSave={(name, prompt) => {
              setNewStyle(false);
              void app
                .patchConversation(c, {
                  outputStyle: name,
                  customOutputStyles: {
                    ...(c.customOutputStyles ?? {}),
                    [name]: { name, prompt },
                  },
                })
                .catch(app.report);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
