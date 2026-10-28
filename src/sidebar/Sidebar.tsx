import { surface } from "../../shared/host";
import type { Conversation, Mode, Project } from "../../shared/types";
import { AccountMenu } from "./AccountMenu";
import { ConversationList, type ReorderInput } from "./ConversationList";
import type { RowActions } from "./ConversationRow";
import { MainNav } from "./MainNav";
import { SurfaceSwitch } from "./SurfaceSwitch";
import { WebSidebarHeader } from "./WebSidebarHeader";
import { NativeChatSearch } from "./NativeChatSearch";
import { WindowNav } from "./WindowNav";
import { AppIcon } from "../ui/app-icon";
import { useT } from "../i18n";
import { AppContext } from "../app/AppContext";
import { SidebarLoadBoundary } from "./SidebarLoadBoundary";
import {
  useContext,
  useMemo,
  useRef,
  type HTMLAttributes,
  type RefObject,
} from "react";
import { useSwipeClose } from "../ui/swipe-close";
import { keyName, ShortcutPlatform } from "../ui/Tooltip";

export function Sidebar({
  onToggleSidebar,
  onBack,
  onForward,
  conversations,
  activeId,
  activeConversation,
  approvalIds,
  page,
  mode,
  hiddenNavItems,
  onNewChat,
  onSwitchSurface,
  onPageChange,
  onEditSidebar,
  onSearch,
  onSettings,
  onUsage,
  onRecharge,
  onChangelog,
  projects,
  rowActions,
  onReorder,
  onSignOut,
  onError,
  settingsName,
  avatar,
  avatarPhoto,
  accountEmail,
  accountPlan,
  appMenu,
  peek,
  shown = true,
}: {
  /** The sidebar is open (not hidden or collapsed). */
  shown?: boolean;
  /**
   * The collapsed sidebar's peek card (useSidebarPeek): its state, the
   * element it watches and its keyboard handlers.
   */
  peek?: {
    state?: "open" | "closed";
    ref: RefObject<HTMLElement | null>;
    props: Pick<HTMLAttributes<HTMLElement>, "onKeyDown" | "onBlur">;
  };
  onToggleSidebar: () => void;
  /** Absent when there is nothing to go back to. */
  /** ≡ app menu first in the sidebar head (Windows and Linux). */
  appMenu?: boolean;
  onBack?: () => void;
  /** Absent when there is nothing to go forward to. */
  onForward?: () => void;
  conversations: Conversation[];
  activeId?: string;
  activeConversation?: Conversation;
  approvalIds: ReadonlySet<string>;
  page: string;
  mode: Mode;
  hiddenNavItems?: string[];
  onNewChat: (mode?: Mode) => void;
  /** The Chat | Code switch; a new conversation when not given. */
  onSwitchSurface?: (mode: Mode) => void;
  onPageChange: (page: string) => void;
  onEditSidebar: () => void;
  onSearch: () => void;
  onSettings: () => void;
  onUsage?: () => void;
  /** The account menu's recharge entry (service accounts). */
  onRecharge?: () => void;
  onChangelog: () => void;
  projects: Project[];
  rowActions: Omit<RowActions, "onTogglePin">;
  onReorder: (input: ReorderInput) => Promise<void>;
  onSignOut?: () => Promise<void>;
  onError: (error: unknown) => void;
  settingsName: string;
  avatar?: number;
  avatarPhoto?: string;
  accountEmail?: string;
  accountPlan?: string;
}) {
  const t = useT();
  const app = useContext(AppContext);
  const bridge = typeof window === "undefined" ? undefined : window.desktop;
  const listScope = useMemo(
    () => ({}),
    [app?.accountId, app?.controllerScope, bridge, mode],
  );
  const platform = useContext(ShortcutPlatform);
  // A phone's sidebar sheet goes away with a swipe to the left.
  const own = useRef<HTMLElement>(null);
  const sheet = peek?.ref ?? own;
  useSwipeClose(sheet, onToggleSidebar, surface === "web");
  return (
    <aside
      className="sidebar"
      ref={sheet}
      data-peek={peek?.state}
      aria-label="Sidebar"
      {...peek?.props}
    >
      {surface === "web" ? (
        <WebSidebarHeader
          mode={mode}
          conversations={conversations}
          approvalIds={approvalIds}
          onToggleSidebar={onToggleSidebar}
          onSwitch={onSwitchSurface ?? onNewChat}
        />
      ) : (
        <div className="sidebar-chrome">
          <WindowNav
            toggleLabel="Hide sidebar"
            onToggleSidebar={onToggleSidebar}
            onBack={onBack}
            onForward={onForward}
            appMenu={appMenu}
          />
          <SurfaceSwitch
            mode={mode}
            conversations={conversations}
            approvalIds={approvalIds}
            onSwitch={onSwitchSurface ?? onNewChat}
            tabKeys
          />
        </div>
      )}
      <div className="sidebar-body">
        {surface !== "web" && mode !== "code" && (
          <NativeChatSearch onSearch={onSearch} />
        )}
        {(surface === "web" || mode === "code") && (
          // The account's current sidebar-field branch, verified on a fresh
          // 1440px page. Its feature result is cached; it is not a breakpoint.
          <button
            className="web-sidebar-search"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onSearch}
          >
            <AppIcon name="Search" />
            <span>{t("Search")}</span>
            <kbd aria-hidden="true">{keyName(platform, "mod")} K</kbd>
          </button>
        )}
        <MainNav
          mode={mode}
          page={page}
          activeConversation={activeConversation}
          hiddenItems={hiddenNavItems}
          onNewChat={() => onNewChat()}
          onPageChange={onPageChange}
          onEditSidebar={onEditSidebar}
        />
        <SidebarLoadBoundary scope={listScope}>
          <ConversationList
            conversations={conversations}
            projects={projects}
            activeId={activeId}
            approvalIds={approvalIds}
            page={page}
            mode={mode}
            onPageChange={onPageChange}
            onSearch={onSearch}
            onReorder={onReorder}
            onError={onError}
            pinTipAllowed={shown && !peek?.state}
            {...rowActions}
          />
        </SidebarLoadBoundary>
        <AccountMenu
          name={settingsName}
          avatar={avatar}
          avatarPhoto={avatarPhoto}
          email={accountEmail}
          plan={accountPlan}
          mode={mode}
          conversation={page === "chat" ? activeConversation : undefined}
          onSettings={onSettings}
          onUsage={onUsage}
          onRecharge={onRecharge}
          onChangelog={onChangelog}
          onSignOut={onSignOut}
          onError={onError}
        />
      </div>
    </aside>
  );
}
