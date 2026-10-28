import { awaitsInput } from "../code-tools/AskingRows";
import {
  Suspense,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { Ellipsis, EllipsisVertical } from "../ui/glyphs";
import type { Conversation, Project } from "../../shared/types";
import { surface } from "../../shared/host";
import { t } from "../i18n";
import { formatWebRoute } from "../web/routes";
import type { MenuPosition } from "../ui/Menu";
import { RenameField } from "../ui/RenameField";
import { useTooltip } from "../ui/Tooltip";
import { AppContext } from "../app/AppContext";
import type { useConversationDrag } from "./useConversationDrag";
import { TitleReveal } from "./TitleReveal";
import { StatusDot } from "./StatusDot";
import { AppIcon } from "../ui/app-icon";
import { useJumpHint } from "./jump-hints";
import { rowStatus, type RowPullRequest } from "./row-status";
import { sessionPullRequest } from "../../shared/pull-request";
import { pullRequestDisplayState } from "../../shared/pull-request-status";
import { usePullRequest } from "../pr/pr-status-store";
import { sharedPhaseDelay } from "./title-motion";
import { lazyPiece } from "../ui/lazy-piece";
import type { CodeListView } from "./code-list-view";
import {
  codeMetadata,
  codeEnvironmentGlyph,
  codePlaceDescription,
  CodeEnvironmentMark,
  CodeRowMetadata,
} from "./CodeRowMetadata";
import {
  clearForMenu,
  clearUnlessModified,
  domainOf,
  rowOrder,
  selection,
  useSelected,
} from "./multi-select";

// The menu is most of the row's code and most rows never open it.
const RowMenu = lazyPiece(() => import("./RowMenu"));
const BulkRowMenu = lazyPiece(() => import("./BulkRowMenu"));

export type RowActions = {
  onOpen: (c: Conversation) => void;
  onTogglePin: (c: Conversation) => void;
  onRename: (c: Conversation, title: string) => void;
  /** A null project takes the conversation out of its project. */
  onMoveToProject: (c: Conversation, projectId: string | null) => void;
  onToggleArchive: (c: Conversation) => void;
  onDelete: (c: Conversation) => void;
  onToggleUnread: (c: Conversation) => void;
  onUpdateConversation?: (
    c: Conversation,
    patch: Parameters<
      import("../../shared/types").CoreDesktopAPI["updateConversation"]
    >[1],
  ) => void;
  onOpenIn: (c: Conversation, target: "terminal" | "folder") => void;
  /**
   * Open in new window / Open in ▸ New window (R2). The sidebar hands the
   * composer draft over when the conversation is the one on screen; without
   * a handler the row asks the main process to open (or focus) the window.
   */
  onOpenInWindow?: (c: Conversation) => void;
  /**
   * Open in ▸ Split view, and Alt-click on the row (desktop Code, the
   * original's "Open session in split view" key): the session opens in a
   * pane beside the one on screen. Absent where the window has one pane.
   */
  onOpenInSplit?: (c: Conversation) => void;
  /**
   * Share (R1): opens the Share chat / Share session dialog. The entry shows
   * only when a handler is given and the service lets this account share.
   */
  onShare?: (c: Conversation) => void;
  /** Delete over several selected rows: one confirmation for them all. */
  onDeleteMany?: (ids: string[]) => void;
};

/**
 * A pinned row's Move up and Move down: each moves the row one place along
 * Pinned, and is left out where there is no place to move to.
 */
export type PinReorder = { onMoveUp?: () => void; onMoveDown?: () => void };

export { fileManagerName } from "./file-manager";

/** How often a row asks again about its session's open pull request. */
const prPollMs = 5 * 60_000;

/**
 * The pull request a Code row shows while Show PR status is on: the one the
 * session made, read through the window's shared store, so the branch row and
 * the sidebar agree.
 */
function useRowPullRequest(
  c: Conversation,
  show: boolean,
): RowPullRequest | undefined {
  const ref = useMemo(
    () =>
      show && c.mode === "code" && !c.archived && !c.incognito
        ? sessionPullRequest(c)
        : undefined,
    [show, c.mode, c.archived, c.incognito, c.turns],
  );
  const { pr } = usePullRequest(ref, { maxAge: prPollMs, pollMs: prPollMs });
  return ref && pr
    ? { state: pullRequestDisplayState(pr), number: pr.number }
    : undefined;
}

/**
 * One conversation: a dot, the title fading at the edge, and on hover a ⋮
 * button whose menu is also opened by right-clicking the row. Rename edits
 * the title in place. The dot fills while a reply runs, turns blue when one
 * finished unseen (or was marked unread) and amber while a Code request
 * waits for approval.
 */
export function ConversationRow({
  conversation: c,
  projects,
  selected,
  needsApproval = false,
  actions,
  onKeyboardPin,
  draggable,
  dragControl,
  onNewGroup,
  pinReorder,
  showPrStatus = false,
  codeView,
  ownSection = false,
  hidePlace = false,
  nested = false,
  rowsFor,
}: {
  /** The conversations behind selected ids, for the menu over a selection. */
  rowsFor?: (ids: ReadonlySet<string>) => Conversation[];
  conversation: Conversation;
  projects: Project[];
  selected: boolean;
  /** Code's Show PR status: the session's pull request shows in the dot's place. */
  showPrStatus?: boolean;
  codeView?: CodeListView;
  ownSection?: boolean;
  hidePlace?: boolean;
  /** A session under its parent: its title starts 20px in (data-nested). */
  nested?: boolean;
  needsApproval?: boolean;
  actions: RowActions;
  onKeyboardPin: (event: KeyboardEvent<HTMLElement>) => void;
  draggable: boolean;
  /** The list's drag; it hides and slides the rows itself while dragging. */
  dragControl: ReturnType<typeof useConversationDrag>;
  /** "New group…" in Move to group: the list asks for the name in a dialog. */
  onNewGroup: (c: Conversation | Conversation[]) => void;
  pinReorder?: PinReorder;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  // The menu runs on every selected row when it opens over a selection of
  // several.
  const [bulk, setBulk] = useState<Conversation[]>();
  const picked = useSelected(c.id);
  const openMenu = (position: MenuPosition, single: boolean) => {
    clearForMenu(c.id, single);
    const { keys } = selection.get();
    setBulk(
      !single && keys.size > 1 && keys.has(c.id) ? rowsFor?.(keys) : undefined,
    );
    setMenu(position);
  };
  const [renaming, setRenaming] = useState(false);
  const app = useContext(AppContext);
  const more = useRef<HTMLButtonElement>(null);
  const working = c.turns.some((t) => t.status === "inProgress");
  // The running dot joins the breath every other running dot is in.
  const breath = useMemo(
    () =>
      working
        ? ({ animationDelay: sharedPhaseDelay() } as CSSProperties)
        : undefined,
    [working],
  );
  const pr = useRowPullRequest(c, showPrStatus);
  const status = rowStatus(
    c,
    {
      working,
      needsApproval:
        needsApproval ||
        Boolean(codeView && !working && c.sessionState === "blocked"),
      question: Boolean(app && awaitsInput(app.snapshot.approvals, c.id)),
    },
    pr,
  );
  // A long title shows whole in a tooltip to the right, only while it is cut
  // off.
  const titleTip = useTooltip(c.title, { placement: "right" });
  const Row = surface === "web" ? "a" : "button";
  const metadata =
    codeView && codeMetadata(c, codeView, needsApproval, ownSection);
  return (
    <div
      data-conversation-id={c.id}
      data-code-described={metadata ? "" : undefined}
      data-nested={nested ? "" : undefined}
      data-roving-row=""
      data-section={c.pinned ? "pinned" : "recent"}
      className={`conversation-row ${selected ? "selected" : ""} ${picked ? "multi-selected" : ""} ${menu ? "menu-open" : ""} ${renaming ? "renaming" : ""}`}
      aria-selected={picked || undefined}
      data-drag-shift=""
      onPointerDown={(event) =>
        draggable && !renaming && dragControl.pointerDown(event, c)
      }
      onPointerMove={dragControl.pointerMove}
      onPointerUp={dragControl.pointerUp}
      onPointerCancel={dragControl.pointerCancel}
      onLostPointerCapture={dragControl.lostCapture}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu({ left: event.clientX, top: event.clientY }, false);
      }}
    >
      <Row
        className={`conversation-link ${!c.pinned ? "plain-recent" : ""}`}
        href={
          surface === "web"
            ? formatWebRoute({
                kind: c.mode === "code" ? "code-chat" : "chat",
                id: c.id,
              })
            : undefined
        }
        aria-current={surface === "web" && selected ? "page" : undefined}
        data-roving-item=""
        aria-keyshortcuts="Control+Alt+P Meta+Alt+P"
        aria-description="Control+Alt+P to pin or unpin."
        onKeyDown={onKeyboardPin}
        onClick={(event) => {
          // Web rows keep a real link target, while the existing selection and
          // drag gestures still intercept their ordinary click path. The live
          // sidebar similarly handles modifiers on link rows.
          if (surface === "web") event.preventDefault();
          if (dragControl.click(event)) return;
          const row = event.currentTarget;
          if (event.metaKey || event.ctrlKey)
            return selection.toggle(c.id, domainOf(row));
          if (event.shiftKey)
            return selection.selectRange(c.id, rowOrder(row), domainOf(row));
          clearUnlessModified(event);
          // The second click of a double click renames; it opens nothing.
          if (event.detail > 1) return;
          if (event.altKey && actions.onOpenInSplit && c.mode === "code")
            return actions.onOpenInSplit(c);
          actions.onOpen(c);
        }}
        onDoubleClick={() => setRenaming(true)}
      >
        {/* Current native and web unified frames keep a pinned kind icon
            stable and place activity after the title. O16 shared-21:
            11579–11608,19763–19827,20164–20183. */}
        {c.pinned && (
          <AppIcon name={c.mode === "code" ? "Code" : "ChatMode"} size={16} />
        )}
        {/* A title is a name, not interface text. */}
        <span
          className="row-title-slot"
          data-no-translate
          onPointerEnter={(event) => {
            const slot = event.currentTarget;
            if (slot.scrollWidth > slot.clientWidth)
              titleTip.props.onPointerEnter(event);
          }}
          onPointerLeave={titleTip.props.onPointerLeave}
          onPointerDown={titleTip.props.onPointerDown}
        >
          <TitleReveal text={c.title} />
          {codeView && (status.dot || status.pr || status.archived) && (
            <span className="sr-only" role={status.dot ? "status" : undefined}>
              {t(status.label)}
            </span>
          )}
          {codeView && !c.pinned && !hidePlace && codePlaceDescription(c) && (
            <span className="sr-only">{codePlaceDescription(c)}</span>
          )}
        </span>
        {/* A status ends the row (unread, needs input, a pull request,
           archived); otherwise an unpinned Code row ends in where it runs,
           unless its group already names the place. */}
        {(status.dot ||
          status.archived ||
          status.pr ||
          (codeView && !c.pinned && !hidePlace && codeEnvironmentGlyph(c))) && (
          <span
            className="row-status-trailing"
            aria-hidden={codeView ? true : undefined}
          >
            {status.dot || status.archived || status.pr ? (
              <StatusDot
                status={status}
                breath={breath}
                onToggle={() => actions.onToggleUnread(c)}
              />
            ) : (
              <CodeEnvironmentMark conversation={c} />
            )}
          </span>
        )}
        {metadata && <CodeRowMetadata line={metadata} />}
      </Row>
      {titleTip.tooltip}
      <RowJumpHint id={c.id} />
      {renaming && (
        <RenameField
          className="conversation-rename"
          title={c.title}
          onDone={(title) => {
            setRenaming(false);
            if (title && title !== c.title) actions.onRename(c, title);
          }}
        />
      )}
      <button
        ref={more}
        className="row-more"
        // Reached with → from the row (sidebar/roving.ts), not with Tab.
        tabIndex={-1}
        aria-label={`More options for ${c.title}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={(event) => {
          if (menu) return setMenu(undefined);
          const box = event.currentTarget.getBoundingClientRect();
          openMenu(
            { right: innerWidth - box.right, top: box.bottom + 7 },
            false,
          );
        }}
      >
        {/* A Code row's ⋯ lies flat; a chat's ⋮ stands. */}
        {codeView ? <Ellipsis size={16} /> : <EllipsisVertical size={16} />}
      </button>
      {menu && bulk && (
        <Suspense fallback={null}>
          <BulkRowMenu
            rows={bulk}
            actions={actions}
            onNewGroup={onNewGroup}
            position={menu}
            anchor={more}
            onClose={() => setMenu(undefined)}
          />
        </Suspense>
      )}
      {menu && !bulk && (
        <Suspense fallback={null}>
          <RowMenu
            conversation={c}
            projects={projects}
            actions={actions}
            position={menu}
            anchor={more}
            onRename={() => setRenaming(true)}
            onNewGroup={onNewGroup}
            pinReorder={pinReorder}
            onClose={() => setMenu(undefined)}
          />
        </Suspense>
      )}
    </div>
  );
}

/**
 * The row's number while ⌘ (or Ctrl+Shift) is held (src/sidebar/jump-hints.ts),
 * over its leading dot.
 */
function RowJumpHint({ id }: { id: string }) {
  const digit = useJumpHint(id);
  if (digit === null) return null;
  return (
    <span className="row-jump-hint" aria-hidden="true">
      {digit}
    </span>
  );
}
