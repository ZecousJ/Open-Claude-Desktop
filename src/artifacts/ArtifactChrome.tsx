import { lazyPiece } from "../ui/lazy-piece";
import { ArtifactSubmenu } from "./ArtifactExportMenu";
import {
  useArtifactMetadata,
  artifactIdentity,
  type ArtifactCommentAccess,
} from "./artifact-metadata";
import { scopedCommentStorageKey } from "./artifact-storage";
import type { ArtifactComment } from "../../shared/artifact-notes";
import { useContext, useEffect, useRef, useState } from "react";
import { Files } from "../ui/glyphs";
import type { Artifact } from "../ui/ArtifactTypes";
import { AppIcon } from "../ui/app-icon";
import { surface } from "../../shared/host";
import { useArtifactReportsState } from "./ReportArtifactDialog";
import { formatText, useLocale } from "../i18n";
import { kindLabel } from "./artifact-kind";
import { type ArtifactDataUsage } from "../../shared/artifact-data";
import {
  guardArtifactNavigation,
  relatedArtifactSessions,
} from "./related-sessions";
import { AppContext } from "../app/AppContext";
import "./file-viewer-panel.css";
import { artifactChromeView } from "./ArtifactChromeView";
import { useArtifactChromeActions } from "./useArtifactChromeActions";
import { useArtifactChromeState } from "./useArtifactChromeState";

export const CommentDictation = lazyPiece(
  () => import("../voice/CommentDictation"),
  "CommentDictation",
);

// Loaded when Publish opens, with its own stylesheet.
export const PublishArtifactModal = lazyPiece(
  () => import("./PublishArtifactModal"),
  "PublishArtifactModal",
);
export const ArtifactShareDialog = lazyPiece(
  () => import("./ArtifactShareDialog"),
  "ArtifactShareDialog",
);
export const ArtifactFeedbackDialog = lazyPiece(
  () => import("./ArtifactFeedbackDialog"),
  "ArtifactFeedbackDialog",
);
export const ArtifactToolPermissions = lazyPiece(
  () => import("./ArtifactToolPermissions"),
  "ArtifactToolPermissions",
);

export type Comment = ArtifactComment;
/** The draft marker (33px), its gap and the 300px box. */
export const draftReach = 39 + 300 + 12;
export const draftHeight = 110;
/** Why Open in web is greyed: the version shown has no public page. */
export const openInWebReason =
  "Only a published artifact has a page on the web";
/** Why Delete artifact is greyed for an artifact in a conversation. */
export const deleteArtifactReason =
  "This artifact is part of its conversation; delete the conversation to remove it";

/** Where an earlier version kept this artifact's comments in window storage. */
export function commentStorageKey(artifact: Artifact, accountId: string) {
  return scopedCommentStorageKey(
    accountId,
    artifact.conversationId ?? "",
    artifact.sourcePath ?? artifact.id,
  );
}
export function readComments(value: string | null): Comment[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed
          .filter(
            (c): c is Comment =>
              !!c &&
              typeof c === "object" &&
              typeof c.id === "string" &&
              typeof c.text === "string" &&
              c.text.length <= 10000 &&
              Number.isFinite(c.x) &&
              c.x >= 0 &&
              c.x <= 1 &&
              Number.isFinite(c.y) &&
              c.y >= 0 &&
              c.y <= 1 &&
              Number.isFinite(c.createdAt) &&
              typeof c.resolved === "boolean",
          )
          .slice(-500)
      : [];
  } catch {
    return [];
  }
}
export function ArtifactChrome({
  artifact,
  authorName = "You",
  expanded,
  standalone = false,
  relatedSessionCount,
  commentAccess,
  onHome,
  onExpand,
  onClose,
  onRefresh,
  onError,
  onComment,
  onAsk,
  onShareRequestConsumed,
  onDuplicate,
  duplicateLabel,
  duplicateDisabledReason,
  duplicateBusy = false,
  onRename,
  renameDisabledReason,
  openInWebAsTab = surface === "web",
  onPin,
  onDelete,
  onPopOut,
  onNotify,
  chatFloating = false,
  onToggleChatFloat,
  siblings,
  onSwitch,
  versions = 0,
  versionHistory,
  shownVersion = versions,
  onVersion,
  onRestore,
  onHistory,
  shown = artifact,
  onCopyToProject,
}: {
  artifact: Artifact;
  authorName?: string;
  expanded: boolean;
  /** The existing full-page web artifact; embedded/native chrome stays separate. */
  standalone?: boolean;
  relatedSessionCount?: number;
  /** Explicit effective note/document rights; never inferred from sharing audience. */
  commentAccess?: ArtifactCommentAccess;
  onHome?: () => void;
  onExpand: () => void;
  onClose: () => void;
  onRefresh: () => void;
  onError: (e: unknown) => void;
  /** Confirms a finished copy or download. */
  onNotify?: (message: string) => void;
  onComment?: (text: string) => Promise<void>;
  onAsk?: () => void;
  onShareRequestConsumed?: () => void;
  onDuplicate?: (artifact: Artifact) => Promise<void>;
  duplicateLabel?: string;
  duplicateDisabledReason?: string;
  duplicateBusy?: boolean;
  onRename?: ((name: string) => Promise<void>) | null;
  renameDisabledReason?: string;
  openInWebAsTab?: boolean;
  onPin?: (artifact: Artifact) => Promise<void>;
  onDelete?: (artifact: Artifact) => void;
  onPopOut?: () => Promise<void>;
  /** Whether the conversation floats over the expanded artifact. */
  chatFloating?: boolean;
  /**
   * Floats the conversation over the expanded artifact, or puts it away.
   * Absent where no conversation is beside the artifact.
   */
  onToggleChatFloat?: () => void;
  /**
   * The artifacts of this artifact's conversation, for Switch artifact. Called
   * while the title menu is open.
   */
  siblings?: () => Artifact[];
  onSwitch?: (artifact: Artifact) => void;
  /** The version switcher: how many versions this file has, which is shown. */
  versions?: number;
  versionHistory?: Artifact[];
  shownVersion?: number;
  onVersion?: (version: number) => void;
  onRestore?: () => Promise<void>;
  onHistory?: () => void;
  /** What the panel shows (an earlier version); Download and Copy take it. */
  shown?: Artifact;
  /**
   * Copy to project: adds the shown version to the conversation's project;
   * true when it was added. Absent where there is no project or the artifact
   * is not text.
   */
  onCopyToProject?: () => Promise<boolean>;
}) {
  useLocale();
  const app = useContext(AppContext);
  const chatSessionCount =
    relatedSessionCount ??
    (app ? relatedArtifactSessions(app.snapshot, artifact).length : undefined);
  const openStandaloneChat = app
    ? guardArtifactNavigation(app, artifact, onExpand)
    : onExpand;
  // "Copied to project" shows (greyed) for 12 seconds after, as the original does.
  const [copiedToProject, setCopiedToProject] = useState(false);
  const [preparingDownload, setPreparingDownload] = useState(false);
  const [sharingExport, setSharingExport] = useState(false);
  const [documentBusy, setDocumentBusy] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [storageUsage, setStorageUsage] = useState<ArtifactDataUsage>();
  useEffect(() => {
    if (!copiedToProject) return;
    const timer = setTimeout(() => setCopiedToProject(false), 12_000);
    return () => clearTimeout(timer);
  }, [copiedToProject]);
  useEffect(() => setCopiedToProject(false), [artifactIdentity(artifact)]);
  const metadata = useArtifactMetadata(artifact);
  const rename =
    onRename === undefined
      ? metadata.canRename
        ? metadata.rename
        : undefined
      : onRename;
  const reportsState = useArtifactReportsState(true);
  const [duplicating, setDuplicating] = useState(false);
  const duplicatePending = duplicateBusy || duplicating;
  const duplicateInFlight = useRef(false);
  const {
    account,
    commentMode,
    menu,
    publication,
    publishInput,
    published,
    ready,
    refreshPublication,
    saved,
    setCommentMode,
    setMenu,
    access,
    canPublish,
    cancelRename,
    documentAction,
    documentArtifact,
    duplicate,
    finishRename,
    identity,
    name,
    nameInput,
    openInWeb,
    openPublish,
    permissionsOpen,
    pinned,
    presentationAction,
    publishButton,
    publishCheck,
    publishDisabled,
    publishOpen,
    publishReason,
    renaming,
    reporting,
    restoring,
    setName,
    setPermissionsOpen,
    setPublishOpen,
    setRenaming,
    setReporting,
    setRestoring,
    setVersionShareOpen,
    shareLabel,
    sharing,
    startRename,
    switchList,
    titleButton,
    translateDocument,
    version,
    versionShareOpen,
    wasUnpublished,
  } = useArtifactChromeState({
    artifact,
    commentAccess,
    documentBusy,
    duplicateDisabledReason,
    duplicateInFlight,
    duplicatePending,
    metadata,
    onComment,
    onDuplicate,
    onError,
    onNotify,
    onShareRequestConsumed,
    onSwitch,
    rename,
    setDocumentBusy,
    setDuplicating,
    setStorageUsage,
    shown,
    siblings,
    standalone,
  });
  const {
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
  } = useArtifactChromeActions({
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
  });
  const chromeView = artifactChromeView({
    access,
    action,
    artifact,
    authorInitial,
    authorName,
    canPublish,
    cancelRename,
    chatFloating,
    chatGroup,
    chatShown,
    commentLabel,
    commentMenuTip,
    commentMode,
    commentPhase,
    commentTip,
    comments,
    commentsList,
    copiedToProject,
    documentAction,
    documentArtifact,
    documentBusy,
    draft,
    draftInput,
    duplicate,
    duplicateDisabledReason,
    duplicateLabel,
    duplicatePending,
    expanded,
    feedbackOpen,
    finishRename,
    header,
    identity,
    mention,
    mentionWidth,
    menu,
    menuTrigger,
    metadata,
    name,
    nameInput,
    noteKey,
    onAsk,
    onClose,
    onCopyToProject,
    onDelete,
    onDuplicate,
    onError,
    onExpand,
    onHistory,
    onHome,
    onNotify,
    onPin,
    onPopOut,
    onRestore,
    onSwitch,
    onVersion,
    openCount,
    openInWeb,
    openInWebAsTab,
    openLabel,
    openPublish,
    permissionsOpen,
    pinned,
    preparingDownload,
    presentationAction,
    publication,
    publishButton,
    publishCheck,
    publishDisabled,
    publishInput,
    publishOpen,
    publishReason,
    published,
    pulse,
    ready,
    refreshPublication,
    rename,
    renameDisabledReason,
    renaming,
    reporting,
    reportsState,
    restoring,
    save,
    saved,
    sendToAgent,
    sending,
    setCommentPhase,
    setCopiedToProject,
    setDraft,
    setFeedbackOpen,
    setMenu,
    setName,
    setPermissionsOpen,
    setPublishOpen,
    setPulse,
    setRenaming,
    setReporting,
    setRestoring,
    setSendToAgent,
    setShowComments,
    setShowResolved,
    setText,
    setVersionShareOpen,
    shareExport,
    shareLabel,
    sharing,
    sharingExport,
    showComments,
    showResolved,
    shownVersion,
    siblings,
    standalone,
    startRename,
    storageUsage,
    submit,
    switchList,
    text,
    titleButton,
    titleMenuLabel,
    toggleChat,
    toggleCommentMode,
    toggleMenu,
    translateDocument,
    version,
    versionHistory,
    versionShareOpen,
    versions,
    viewingVersionLabel,
    visibleComments,
    wasUnpublished,
  });
  return chromeView;
}

/** Frame switcher rows. */
export function SwitchArtifactRow({
  artifact,
  siblings,
  onSwitch,
}: {
  artifact: Artifact;
  siblings?: () => Artifact[];
  onSwitch?: (artifact: Artifact) => void;
}) {
  const list = siblings?.() ?? [];
  if (!onSwitch || list.length < 2) return null;
  const current = artifactIdentity(artifact);
  return (
    <>
      <ArtifactSubmenu
        label="Switch artifact"
        icon={<Files size={15} />}
        count={list.length}
        testId="frame-title-menu-switcher"
        spokenCount={formatText("Switch artifact, {count} artifacts", {
          count: list.length,
        })}
        items={list.map((item) => ({
          key: artifactIdentity(item),
          label: item.name,
          noTranslate: true,
          icon: <AppIcon name="Artifacts" />,
          title:
            kindLabel(item).toLowerCase() === item.name.trim().toLowerCase()
              ? undefined
              : kindLabel(item),
          checked: artifactIdentity(item) === current,
          onSelect: () => {
            if (artifactIdentity(item) !== current) onSwitch(item);
          },
        }))}
      />
      <div role="separator" />
    </>
  );
}
