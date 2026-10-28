import { ComputerLinkIndicator } from "./ComputerLinkIndicator";
import type { SidePanel } from "./ToolSidePanel";
import { Suspense, useRef, useState } from "react";
import {
  Archive,
  Download,
  Laptop,
  Pencil,
  Pin,
  Trash2,
  X,
} from "../ui/glyphs";
import type { Conversation, Mode, Project } from "../../shared/types";
import { IconButton } from "../ui/Controls";
import { ConversationTitle, type TitleActions } from "./ConversationTitle";
import { ConversationPanelButtons } from "./ConversationPanelButtons";
import { FolderIcon } from "../ui/icons";
import { AppIcon } from "../ui/app-icon";
import "./conversation-header.css";
import { lazyPiece } from "../ui/lazy-piece";
import type { MenuPosition } from "../ui/Menu";
import { foldPanes, useCodePanes } from "../header/code-panes";
import { useHeaderFold } from "../header/useHeaderFold";
import { useRailToggle } from "../session-rail/rail-store";
import { useHost } from "../host/HostContext";
import { formatText, t } from "../i18n";
import { useTooltip } from "../ui/Tooltip";
import { shownFolder } from "../../shared/session-folder";

export interface ConversationShareButton {
  shared: boolean;
  audience?: "link" | "invited";
  ready?: boolean;
  busy?: boolean;
  disabledReason?: string;
  open?: boolean;
  onOpen: () => void;
}

function ChatShareButton({ share }: { share: ConversationShareButton }) {
  const disabled = Boolean(share.disabledReason || share.ready === false);
  const audience =
    share.audience === "invited"
      ? "Only people invited"
      : "Anyone with the link";
  const label = share.shared
    ? formatText("Shared · {audience}", { audience: t(audience) })
    : t("Share");
  const reason = share.disabledReason && t(share.disabledReason);
  const { props, tooltip } = useTooltip(reason ?? label, {
    disabled: Boolean(share.open),
  });
  return (
    <>
      <span className="conversation-share-trigger" {...props}>
        <button
          type="button"
          className={`icon-button panel-toggle conversation-share-button text${disabled ? " unavailable" : ""}`}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={Boolean(share.open)}
          aria-busy={share.busy || undefined}
          disabled={disabled}
          title={reason}
          onClick={() => {
            if (!disabled) share.onOpen();
          }}
        >
          {disabled &&
            share.disabledReason ===
              "Sharing is disabled by your organization." && (
              <AppIcon name="Lock" />
            )}
          Share
        </button>
      </span>
      {tooltip}
    </>
  );
}

// The chat header's usage ring (a Claudex service account's plan limits).
const HeaderUsageRing = lazyPiece(
  () => import("../header/HeaderUsageRing"),
  "HeaderUsageRing",
);

// A Code session's View options, loaded when first opened.
const CodeViewOptions = lazyPiece(
  () => import("../code-view-options/CodeViewOptions"),
);

export function ConversationHeader({
  conversation,
  mode,
  projects,
  panel,
  running,
  titleActions,
  onTogglePanel,
  onRename,
  onPin,
  onExport,
  onArchive,
  onDelete,
  share,
  splitPane,
  platform = "darwin",
}: {
  conversation: Conversation;
  mode: Mode;
  projects: Project[];
  panel: SidePanel | null;
  running: boolean;
  titleActions: TitleActions;
  onTogglePanel: (value: SidePanel) => void;
  onRename: () => void;
  onPin: () => void;
  onExport: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /**
   * The Share button (R1-U1), only when the service offers hosted sharing
   * for this conversation; `shared` when it has a public link.
   */
  share?: ConversationShareButton;
  /**
   * The bar of a pane beside the primary pane in split view: the tool panels
   * belong to the primary pane, so their toggles are left out, and Close pane
   * ends the bar.
   */
  splitPane?: { onClose: () => void };
  /** For the View options shortcut labels. */
  platform?: string;
}) {
  const [menu, setMenu] = useState<MenuPosition>();
  const more = useRef<HTMLButtonElement>(null);
  const bar = useRef<HTMLElement>(null);
  const railToggle = useRailToggle(conversation.id);
  // The panes, and what folds into View options when the bar is narrow: the
  // rail toggle first, then closed panes before open ones, at most seven.
  const panes = useCodePanes(conversation, mode);
  const code = mode === "code" && !splitPane;
  // The web's View options appears only once the bar folds.
  const web = useHost().kind === "web";
  const hidden = useHeaderFold(
    bar,
    code,
    panes.length + 1,
    7,
    `${conversation.title}|${panes.map((pane) => pane.id).join(",")}|${Boolean(share)}`,
    web,
  );
  const railFolded = code && hidden > 0;
  const { inline, folded } = foldPanes(panes, railFolded ? hidden - 1 : hidden);
  // Keep computer awake lives in View options, not the title menu (the
  // original strips it from the title's menu when the bar has its cluster).
  const { keepAwake, ...titleMenu } = titleActions;
  const cloudSession = conversation.environment?.kind === "space";
  return (
    <header
      className={code ? "chat-header code-header" : "chat-header"}
      ref={bar}
    >
      <div>
        {/* A session on this computer leads with the laptop and names its
           folder; a cloud session shows its title alone. */}
        {mode === "code" && !cloudSession && <Laptop size={15} />}
        <ConversationTitle
          conversation={conversation}
          projects={projects}
          running={running}
          actions={mode === "code" ? titleMenu : titleActions}
        />
        {mode !== "code" && (
          <ComputerLinkIndicator conversation={conversation} />
        )}
        {/* A Code session names its folder in a grey chip; it shrinks to the
           folder glyph when the header is narrow. */}
        {/* No folder (a session's own scratch folder) shows no chip and no
           stand-in either; "Developer" here was a placeholder from before the
           captures. */}
        {mode === "code" && shownFolder(conversation.cwd) && !cloudSession && (
          <span className="thread-folder-chip" title={conversation.cwd}>
            <FolderIcon size={14} aria-hidden="true" />
            <span>{folderName(conversation.cwd!)}</span>
          </span>
        )}
      </div>
      <div className="header-actions">
        {/* Chat and Cowork show the plan's usage here; Code has its composer
           ring. */}
        {mode !== "code" && !conversation.incognito && (
          <Suspense fallback={null}>
            <HeaderUsageRing running={running} />
          </Suspense>
        )}
        {!splitPane && (
          <ConversationPanelButtons
            conversation={conversation}
            mode={mode}
            panel={panel}
            onTogglePanel={onTogglePanel}
            panes={mode === "code" ? inline : undefined}
            railFolded={railFolded}
          />
        )}
        {!conversation.incognito &&
          (share ? (
            mode !== "code" ? (
              <ChatShareButton share={share} />
            ) : share.shared ? (
              // Code, shared: a secondary button with the audience's glyph and
              // "Shared", the audience in its tooltip.
              <IconButton
                label="Anyone with the link"
                className="conversation-share-button text shared"
                placement="below"
                onClick={share.onOpen}
              >
                <AppIcon name="Globe" />
                <span>Shared</span>
              </IconButton>
            ) : (
              // Code, not shared: the Share glyph as a ghost icon button.
              <IconButton
                label="Share"
                className="panel-toggle conversation-share-button"
                placement="below"
                onClick={share.onOpen}
              >
                <AppIcon name="Share" />
              </IconButton>
            )
          ) : (
            mode !== "code" && (
              // A Chat header always ends with Share; without hosted sharing it
              // stays greyed and says why. The button reads "Share".
              <ChatShareButton
                share={{
                  shared: false,
                  ready: false,
                  disabledReason: "Sharing isn't available on this service",
                  onOpen() {},
                }}
              />
            )
          ))}
        {/* Only a Code session has ⋮ (View options): the Chat header has none,
           its title menu carries the actions, and a Cowork task's bar ends with
           its panel toggle. */}
        {mode === "code" && (!web || railFolded || folded.length > 0) && (
          <IconButton
            ref={more}
            label="View options"
            className="conversation-more"
            menu
            expanded={Boolean(menu)}
            placement="below"
            onClick={() => {
              if (menu) return setMenu(undefined);
              const box = more.current!.getBoundingClientRect();
              setMenu({
                right: window.innerWidth - box.right,
                top: box.bottom + 4,
              });
            }}
          >
            <AppIcon name="DotsVertical" />
          </IconButton>
        )}
        {menu && (
          <Suspense fallback={null}>
            <CodeViewOptions
              position={menu}
              anchor={more}
              onClose={() => setMenu(undefined)}
              rail={
                railFolded
                  ? {
                      shown: railToggle.onScreen,
                      onToggle: railToggle.toggle,
                    }
                  : undefined
              }
              conversation={conversation}
              panes={folded}
              keepAwake={keepAwake}
            />
          </Suspense>
        )}
        {splitPane && (
          <IconButton label="Close pane" onClick={splitPane.onClose}>
            <X size={16} />
          </IconButton>
        )}
      </div>
    </header>
  );
}

/** The last part of a folder path, as the chip shows it. */
function folderName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
