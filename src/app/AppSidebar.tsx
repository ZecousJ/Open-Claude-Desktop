import { requestShare } from "../sharing/share-request";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { api } from "../desktop-api";
import type { Conversation } from "../../shared/types";
import type { WindowHandoff, WindowsAPI } from "../../shared/windows-api";
import type {
  DropPosition,
  SidebarSection,
} from "../../shared/conversation-order";
import { fitSidebarWidth } from "../../shared/sidebar-layout";
import { Sidebar } from "../sidebar/Sidebar";
import { SidebarResizeHandle } from "../sidebar/SidebarResizeHandle";
import { IncognitoBar } from "../incognito/IncognitoBar";
import { WindowNav } from "../sidebar/WindowNav";
import type { RowActions } from "../sidebar/ConversationRow";
import { markedUnreadByHand, needsAttention } from "../conversation/unread";
import { useApp, type AppController } from "./AppContext";
import { useHost } from "../host/HostContext";
import { surface } from "../../shared/host";
import { useSidebarPeek } from "../sidebar/useSidebarPeek";
import { slideMs } from "../sidebar/useSidebarVisibility";
import { openInSplitView } from "../split-view/open-in-split";
import { usePullRequestAutoArchive } from "../pr/auto-archive";
import { openRecharge } from "../settings/billing/recharge";
import { moveProjectChats } from "../collections/projects/project-move";
import { requestScheduleConfirmation } from "../collections/routines/schedule-request";
import { usageAvailable } from "../settings/usage-availability";

/**
 * The window's left side: the sidebar with its resize handle and the
 * controls kept while it is hidden, or the incognito bar in its place.
 */
export function AppSidebar() {
  const app = useApp();
  const {
    snapshot,
    sidebarView,
    navigation,
    incognitoShown,
    listed,
    approvalIds,
    patchConversation,
    openConversation,
    report,
    openSettingsTab,
  } = app;
  const sidebar = sidebarView.open;
  // Collapsed, the sidebar peeks out over the page from the left edge or the
  // toggle (useSidebarPeek); at narrow widths the toggle opens it. The web too,
  // but for a phone's width, where the sidebar is a sheet.
  const card = useRef<HTMLElement | null>(null);
  const peek = useSidebarPeek(
    !sidebar && !incognitoShown && !sidebarView.phone,
    card,
    {
      requested: sidebarView.peekRequested,
      onOpenChange: sidebarView.peekChanged,
      // The web's docked sidebar slides out before the peek takes its place.
      armMs: surface === "web" ? slideMs : 0,
    },
  );
  // Opening a conversation or a page from the card puts it away.
  useEffect(() => peek.hide(), [app.activeId, app.page, app.mode]);
  // The ≡ app menu belongs to desktop windows without a menu bar; a web page
  // has the browser's own menu (an Android phone reported "linux" and showed it).
  const host = useHost();
  const desktop = host.kind === "desktop";
  const appMenu = desktop && snapshot.platform !== "darwin";
  // A session whose pull request merges or closes is archived when auto-archive
  // is on for it.
  usePullRequestAutoArchive(listed, snapshot.settings, (c, merged) =>
    patchConversation(c, {
      archived: true,
      ...(merged && c.worktree ? { prMerged: true } : {}),
    }),
  );
  // Held in a variable so the row menu can take `onOpenInWindow` (Open in
  // new window, Open in ▸ New window) once ConversationRow lists it.
  const rowActions: SidebarRowActions = {
    onOpen: (c) => void openFromSidebar(app, c).catch(report),
    // Panes side by side are the desktop's (the web keeps one pane).
    onOpenInSplit: desktop ? (c) => openInSplitView(app, c) : undefined,
    onOpenInWindow: (c) => void openInWindow(app, c).catch(report),
    onRename: (c, title) => void patchConversation(c, { title }),
    onMoveToProject: (c, projectId) => {
      const project = snapshot.projects.find((value) => value.id === projectId);
      if (project) void moveProjectChats(app, [c], project).catch(report);
      else void patchConversation(c, { projectId });
    },
    onToggleArchive: (c) =>
      void patchConversation(c, {
        archived: !c.archived,
      }),
    onDelete: app.confirmDelete,
    // The History page's confirmation, loaded with it.
    onDeleteMany: (ids) =>
      void import("./CollectionPages").then((pages) =>
        pages.confirmBulkDelete(app, ids, () => undefined),
      ),
    onToggleUnread: (c) => {
      if (c.unread) markedUnreadByHand.delete(c.id);
      else markedUnreadByHand.add(c.id);
      void patchConversation(c, { unread: !c.unread });
    },
    onUpdateConversation: (c, patch) => void patchConversation(c, patch),
    // Share opens the session; its title bar opens the share dialog.
    onShare: (c) => {
      requestShare(c.id);
      openConversation(c);
    },
    onOpenIn: (c, target) => {
      if (target === "folder")
        void api.revealConversationFolder(c.id).catch(report);
      else {
        openConversation(c);
        app.setPanel("terminal");
      }
    },
  };
  return (
    <>
      {incognitoShown && <IncognitoBar onExit={() => app.newChat("chat")} />}
      {!incognitoShown && (
        <Sidebar
          peek={{ state: peek.state, ref: card, props: peek.cardProps }}
          shown={sidebar}
          onToggleSidebar={sidebarView.toggle}
          appMenu={appMenu}
          onBack={navigation.back}
          onForward={navigation.forward}
          conversations={listed}
          activeId={app.activeId}
          activeConversation={app.active}
          approvalIds={approvalIds}
          page={app.page}
          mode={app.mode}
          hiddenNavItems={snapshot.settings.hiddenNavItems}
          onNewChat={app.newChat}
          onSwitchSurface={app.switchSurface}
          onPageChange={(page) => {
            if (page === "scheduled")
              requestScheduleConfirmation({
                description: "",
                openRoutineId: null,
              });
            app.setPage(page);
          }}
          onEditSidebar={() => app.setEditSidebar(true)}
          onSearch={() => {
            app.setSearchEntrypoint("default");
            app.setSearch("");
          }}
          onSettings={() =>
            openSettingsTab(app.mode === "code" ? "code" : "general")
          }
          onUsage={
            usageAvailable(host, app.remoteAccount)
              ? () => openSettingsTab("usage")
              : undefined
          }
          onRecharge={
            app.remoteAccount
              ? () => openRecharge(() => openSettingsTab("billing"))
              : undefined
          }
          onChangelog={app.openReleaseNotes}
          projects={snapshot.projects}
          rowActions={rowActions}
          onReorder={(input) => reorderConversations(app, input)}
          onSignOut={app.onSignOut}
          onError={report}
          settingsName={snapshot.settings.name}
          avatar={snapshot.settings.avatar}
          avatarPhoto={snapshot.settings.avatarPhoto}
          accountEmail={app.accountEmail}
          // Only a plan the administrator named; the service group's name
          // ("codex") is not a plan.
          accountPlan={app.policy.planLabel ?? undefined}
        />
      )}
      {sidebar && !incognitoShown && (
        <SidebarResizeHandle
          width={app.sidebarWidthPreview ?? snapshot.settings.sidebarWidth}
          onPreview={app.setSidebarWidthPreview}
          onHide={sidebarView.toggle}
          onCommit={(value) =>
            void app.updatePreference({
              sidebarWidth: fitSidebarWidth(value, window.innerWidth),
            })
          }
        />
      )}
      {/* Kept while the sidebar shows so it can take over during the slide. */}
      {!incognitoShown && (
        <TopLayer>
          <div
            className="collapsed-chrome"
            aria-hidden={sidebar}
            {...peek.ownerProps}
          >
            <WindowNav
              toggleLabel="Show sidebar"
              onToggleSidebar={
                sidebarView.narrow ? sidebarView.toggle : sidebarView.show
              }
              onBack={navigation.back}
              onForward={navigation.forward}
              dot={needsAttention(listed, approvalIds)}
              appMenu={appMenu}
            />
          </div>
          {peek.state && (
            <div
              className="sidebar-edge-hint"
              data-hint={peek.hint}
              aria-hidden="true"
            />
          )}
        </TopLayer>
      )}
    </>
  );
}

/**
 * Renders into the app's last child (App.tsx `.app-chrome-layer`). Electron
 * builds a frameless window's drag area from app regions in document order, so
 * a page's title bar took the collapsed sidebar's buttons into the drag area on
 * Windows, Linux and macOS; after every page they stay clickable. Inline until
 * the layer exists.
 */
function TopLayer({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<Element | null>(null);
  useLayoutEffect(() => {
    setLayer(document.querySelector(".app-chrome-layer"));
  }, []);
  return layer ? createPortal(children, layer) : <>{children}</>;
}

/** The sidebar's row actions, with the separate-window entry (R2). */
type SidebarRowActions = Omit<RowActions, "onTogglePin"> & {
  onOpenInWindow: (c: Conversation) => void;
};

/** What opening a conversation in its own window reads from the app. */
type WindowOpener = Pick<
  AppController,
  | "page"
  | "activeId"
  | "text"
  | "attachments"
  | "providerId"
  | "model"
  | "newChat"
  | "openConversation"
>;

/**
 * A sidebar click: a conversation that already has its own window is
 * brought forward there instead of showing in both windows (R2 Q1).
 */
export async function openFromSidebar(
  app: Pick<WindowOpener, "openConversation">,
  c: Conversation,
  desktop: Pick<
    WindowsAPI,
    "conversationWindows" | "openConversationWindow"
  > = api,
) {
  // A bridge without separate windows (or a failed lookup) opens it here.
  const open = c.incognito
    ? []
    : await Promise.resolve()
        .then(() => desktop.conversationWindows())
        .catch((): string[] => []);
  if (open.includes(c.id)) await desktop.openConversationWindow(c.id);
  else app.openConversation(c);
}

/**
 * Open in new window (R2): the conversation moves to its own window. When
 * the main window shows it, the composer's draft goes with it and the main
 * window starts a new chat of the same kind; a draft the window cannot take
 * (an attachment no longer available) stays here and the window opens
 * without it.
 */
export async function openInWindow(
  app: WindowOpener,
  c: Conversation,
  desktop: Pick<WindowsAPI, "openConversationWindow"> = api,
) {
  // Incognito chats stay in the main window (they are never listed).
  if (c.incognito) return;
  if (app.page !== "chat" || app.activeId !== c.id)
    return desktop.openConversationWindow(c.id);
  const handoff: WindowHandoff = {
    text: app.text,
    attachmentIds: app.attachments.map((a) => a.id),
    ...(app.providerId ? { providerId: app.providerId } : {}),
    ...(app.model ? { model: app.model } : {}),
  };
  const drafted = handoff.text !== "" || handoff.attachmentIds.length > 0;
  try {
    await desktop.openConversationWindow(c.id, drafted ? handoff : undefined);
  } catch (error) {
    if (!drafted) throw error;
    await desktop.openConversationWindow(c.id);
    return;
  }
  app.newChat(c.mode);
}

async function reorderConversations(
  app: AppController,
  input: {
    sourceId: string;
    targetId?: string;
    section: SidebarSection;
    position: DropPosition;
  },
) {
  const conversations = await api.reorderConversations(input);
  app.setSnapshot((current) =>
    current ? { ...current, conversations } : current,
  );
}
