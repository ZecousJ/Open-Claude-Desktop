import { AppIcon } from "../ui/app-icon";
import { t } from "../i18n";
import { IconButton } from "../ui/Controls";
import { Clock, ChevronDown, Maximize2, X } from "../ui/glyphs";
import { ArtifactCurrentUser } from "./ArtifactCurrentUser";
import { CommentBubblesIcon } from "./artifact-icons";
import type { Artifact } from "../ui/ArtifactTypes";
import type { ArtifactComment } from "../../shared/artifact-notes";

/** What ArtifactCollaborationControls needs from ArtifactChromeView.tsx. */
export interface ArtifactCollaborationControlsProps {
  artifact: Artifact;
  authorName: string;
  canPublish: boolean;
  chatFloating: boolean;
  chatGroup: React.JSX.Element | null;
  commentLabel:
    | "Done commenting"
    | "Comment on this artifact"
    | "Comment"
    | "Done viewing"
    | "View comments";
  commentMenuTip: {
    props: {
      "aria-describedby": string | undefined;
      onPointerEnter: (event: { currentTarget: HTMLElement }) => void;
      onPointerLeave: () => void;
      onFocus: (event: React.FocusEvent<HTMLElement, Element>) => void;
      onBlur: () => void;
      onPointerDown: () => void;
      onKeyDown: (event: { key: string }) => void;
    };
    tooltip:
      | false
      | React.ReactElement<unknown, string | React.JSXElementConstructor<any>>
      | React.ReactPortal;
  };
  commentMode: boolean;
  commentTip: {
    props: {
      "aria-describedby": string | undefined;
      onPointerEnter: (event: { currentTarget: HTMLElement }) => void;
      onPointerLeave: () => void;
      onFocus: (event: React.FocusEvent<HTMLElement, Element>) => void;
      onBlur: () => void;
      onPointerDown: () => void;
      onKeyDown: (event: { key: string }) => void;
    };
    tooltip:
      | false
      | React.ReactElement<unknown, string | React.JSXElementConstructor<any>>
      | React.ReactPortal;
  };
  expanded: boolean;
  menu: "filter" | "title" | "comments" | undefined;
  onClose: () => void;
  onError: (e: unknown) => void;
  onExpand: () => void;
  onHistory: (() => void) | undefined;
  onRestore: (() => Promise<void>) | undefined;
  openCount: number;
  openLabel: string;
  openPublish: () => void;
  publishButton: React.RefObject<HTMLButtonElement | null>;
  publishDisabled: boolean;
  publishOpen: boolean;
  publishReason:
    | "This artifact was previously unpublished. Create a new artifact to publish again."
    | "Couldn’t check whether this artifact is already published. Reload the page to try again."
    | undefined;
  published: boolean;
  ready: boolean;
  restoring: boolean;
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
  setMenu: React.Dispatch<
    React.SetStateAction<"filter" | "title" | "comments" | undefined>
  >;
  setRestoring: React.Dispatch<React.SetStateAction<boolean>>;
  setShowComments: React.Dispatch<React.SetStateAction<boolean>>;
  setVersionShareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  shareLabel: string;
  showComments: boolean;
  standalone: boolean;
  toggleCommentMode: () => void;
  toggleMenu: (
    value: "filter" | "title" | "comments" | undefined,
    button: HTMLButtonElement,
  ) => void;
  versionShareOpen: boolean;
  wasUnpublished: boolean;
}

export function ArtifactCollaborationControls({
  artifact,
  authorName,
  canPublish,
  chatFloating,
  chatGroup,
  commentLabel,
  commentMenuTip,
  commentMode,
  commentTip,
  expanded,
  menu,
  onClose,
  onError,
  onExpand,
  onHistory,
  onRestore,
  openCount,
  openLabel,
  openPublish,
  publishButton,
  publishDisabled,
  publishOpen,
  publishReason,
  published,
  ready,
  restoring,
  saved,
  setMenu,
  setRestoring,
  setShowComments,
  setVersionShareOpen,
  shareLabel,
  showComments,
  standalone,
  toggleCommentMode,
  toggleMenu,
  versionShareOpen,
  wasUnpublished,
}: ArtifactCollaborationControlsProps) {
  return (
    <div className="artifact-collaboration-controls">
      {onRestore && (
        <button
          type="button"
          className="artifact-restore-button"
          disabled={restoring || Boolean(artifact.generating)}
          onClick={() => {
            if (restoring) return;
            setRestoring(true);
            void onRestore()
              .catch(onError)
              .finally(() => setRestoring(false));
          }}
        >
          <AppIcon name="ArrowClockwise" />
          {t("Restore")}
        </button>
      )}
      {onHistory && (
        <IconButton label="History" onClick={onHistory}>
          <Clock size={16} />
        </IconButton>
      )}
      {!standalone && chatGroup}
      {standalone && <ArtifactCurrentUser name={authorName} />}
      <div className="artifact-comment-anchor" data-ready={ready}>
        <div className="artifact-comment-buttons">
          <button
            {...commentTip.props}
            className={commentMode ? "is-active" : ""}
            aria-label={t(commentLabel)}
            disabled={!saved.canRead || !saved.loaded}
            title={
              !saved.canRead
                ? t("Comments aren’t available for this artifact.")
                : saved.readOnly
                  ? t("Commenting isn’t available with view-only access.")
                  : undefined
            }
            aria-keyshortcuts="c"
            aria-pressed={saved.canWrite ? commentMode : showComments}
            onClick={toggleCommentMode}
          >
            <CommentBubblesIcon size={16} filled={commentMode} />
            {openCount > 0 && !commentMode && (
              <>
                <span className="artifact-comment-open-dot" aria-hidden />
                <span className="sr-only">{openLabel}</span>
              </>
            )}
          </button>
          <button
            {...commentMenuTip.props}
            aria-label="More comment options"
            aria-haspopup="menu"
            aria-expanded={menu === "comments"}
            disabled={!saved.canRead || !saved.loaded}
            onClick={(e) => toggleMenu("comments", e.currentTarget)}
          >
            <ChevronDown size={12} />
          </button>
          {commentTip.tooltip}
          {commentMenuTip.tooltip}
        </div>
        {menu === "comments" && (
          <div
            className="artifact-chrome-menu artifact-comments-menu"
            role="menu"
          >
            {/* One item that shows or hides the list, with the open count while
               it is hidden. */}
            <button
              role="menuitem"
              onClick={() => {
                setShowComments(!showComments);
                setMenu(undefined);
              }}
            >
              {showComments ? "Hide comments" : "Show all comments"}
              {!showComments && openCount > 0 && (
                <span className="artifact-menu-count">{openCount}</span>
              )}
            </button>
          </div>
        )}
      </div>
      {standalone && chatGroup}
      {/* Publish / Published: only where the service takes artifact links, as
         the reference shows it only when it can publish. */}
      {canPublish && (
        <button
          className="artifact-share-button"
          data-standalone={standalone || undefined}
          aria-label={shareLabel}
          aria-haspopup="dialog"
          aria-expanded={versionShareOpen}
          disabled={Boolean(artifact.generating)}
          onClick={() => setVersionShareOpen(true)}
        >
          {t("Share")}
        </button>
      )}
      {canPublish && (
        <button
          ref={publishButton}
          className="artifact-share-button artifact-publish-button"
          data-open={publishOpen}
          disabled={publishDisabled}
          title={publishReason}
          aria-haspopup="dialog"
          aria-expanded={publishOpen}
          onClick={openPublish}
        >
          {published && !wasUnpublished ? "Published" : "Publish"}
        </button>
      )}
      {!expanded && (
        <IconButton label="Expand" onClick={onExpand}>
          <Maximize2 size={16} />
        </IconButton>
      )}
      {/* Expanded, the reference offers only Chat to leave, and Close again
         while the chat floats. */}
      {(!expanded || chatFloating) && (
        <IconButton label="Close" onClick={onClose}>
          <X size={15} />
        </IconButton>
      )}
    </div>
  );
}
