import {
  SwitchArtifactRow,
  openInWebReason,
  deleteArtifactReason,
} from "./ArtifactChrome";
import { RelativeTime } from "../ui/RelativeTime";
import {
  ArtifactExportMenu,
  ArtifactExportNudge,
  ArtifactSubmenu,
  ArtifactVersionMenu,
} from "./ArtifactExportMenu";
import { canExportPresentation } from "./artifact-kind";
import { t } from "../i18n";
import {
  CopyStackIcon,
  CommentBubblesIcon,
  PopOutWindowsIcon,
  TiltedUnpinIcon,
  TiltedPinIcon,
} from "./artifact-icons";
import { ReasonTooltip } from "../ui/Tooltip";
import { AppIcon } from "../ui/app-icon";
import {
  Lock,
  Clock,
  Globe,
  Check,
  Minimize2,
  Maximize2,
  SquareArrowOutUpRight,
  RotateCw,
  Megaphone,
  Flag,
  Trash,
} from "../ui/glyphs";
import { locales } from "../../shared/locales";
import { ArtifactStorageMenu } from "./ArtifactStorageMenu";
import { artifactToolIdentity } from "../../shared/artifact-tools";
import { artifactDataChanged } from "../../shared/artifact-data";
import type { Artifact } from "../ui/ArtifactTypes";
import type { DocumentConnector } from "../../shared/artifact-document";
import type { ArtifactReportsState } from "../../shared/sharing-api";
import type { ArtifactDataUsage } from "../../shared/artifact-data";

/** What ArtifactTitleMenu needs from ArtifactChromeView.tsx. */
export interface ArtifactTitleMenuProps {
  action: (kind: "export" | "copy" | "refresh") => Promise<void>;
  artifact: Artifact;
  canPublish: boolean;
  chatShown: boolean;
  copiedToProject: boolean;
  documentAction: (
    format: "docx" | "pdf" | "md" | DocumentConnector,
  ) => Promise<void>;
  documentArtifact: boolean;
  documentBusy: boolean;
  duplicate: () => Promise<void>;
  duplicateDisabledReason: string | undefined;
  duplicateLabel: string | undefined;
  duplicatePending: boolean;
  expanded: boolean;
  menuTrigger: React.RefObject<HTMLButtonElement | null>;
  metadata: {
    canRename: boolean;
    viewedAt: number | undefined;
    rename: (name: string) => Promise<void>;
    artifact: Artifact;
    updatedAt: number | undefined;
  };
  onAsk: (() => void) | undefined;
  onCopyToProject: (() => Promise<boolean>) | undefined;
  onDelete: ((artifact: Artifact) => void) | undefined;
  onDuplicate: ((artifact: Artifact) => Promise<void>) | undefined;
  onError: (e: unknown) => void;
  onExpand: () => void;
  onPin: ((artifact: Artifact) => Promise<void>) | undefined;
  onPopOut: (() => Promise<void>) | undefined;
  onSwitch: ((artifact: Artifact) => void) | undefined;
  onVersion: ((version: number) => void) | undefined;
  openCount: number;
  openInWeb: () => Promise<void>;
  openInWebAsTab: boolean;
  pinned: boolean;
  preparingDownload: boolean;
  presentationAction: () => Promise<void>;
  publishDisabled: boolean;
  published: boolean;
  rename: ((name: string) => Promise<void>) | null | undefined;
  renameDisabledReason: string | undefined;
  reportsState: ArtifactReportsState | undefined;
  setCopiedToProject: React.Dispatch<React.SetStateAction<boolean>>;
  setFeedbackOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<
    React.SetStateAction<"filter" | "title" | "comments" | undefined>
  >;
  setPermissionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setReporting: React.Dispatch<React.SetStateAction<boolean>>;
  setShowComments: React.Dispatch<React.SetStateAction<boolean>>;
  setVersionShareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  shareExport: () => Promise<void>;
  sharingExport: boolean;
  showComments: boolean;
  shownVersion: number;
  siblings: (() => Artifact[]) | undefined;
  startRename: () => void;
  storageUsage: ArtifactDataUsage | undefined;
  titleMenuLabel: string;
  toggleChat: () => void;
  translateDocument: (localeId: string) => Promise<void>;
  version: Artifact;
  versionHistory: Artifact[] | undefined;
  versions: number;
}

export function ArtifactTitleMenu({
  action,
  artifact,
  canPublish,
  chatShown,
  copiedToProject,
  documentAction,
  documentArtifact,
  documentBusy,
  duplicate,
  duplicateDisabledReason,
  duplicateLabel,
  duplicatePending,
  expanded,
  menuTrigger,
  metadata,
  onAsk,
  onCopyToProject,
  onDelete,
  onDuplicate,
  onError,
  onExpand,
  onPin,
  onPopOut,
  onSwitch,
  onVersion,
  openCount,
  openInWeb,
  openInWebAsTab,
  pinned,
  preparingDownload,
  presentationAction,
  publishDisabled,
  published,
  rename,
  renameDisabledReason,
  reportsState,
  setCopiedToProject,
  setFeedbackOpen,
  setMenu,
  setPermissionsOpen,
  setReporting,
  setShowComments,
  setVersionShareOpen,
  shareExport,
  sharingExport,
  showComments,
  shownVersion,
  siblings,
  startRename,
  storageUsage,
  titleMenuLabel,
  toggleChat,
  translateDocument,
  version,
  versionHistory,
  versions,
}: ArtifactTitleMenuProps) {
  return (
    <div
      className="artifact-chrome-menu artifact-title-menu"
      role="menu"
      aria-label={titleMenuLabel}
    >
      <SwitchArtifactRow
        artifact={artifact}
        siblings={siblings}
        onSwitch={
          onSwitch
            ? (value) => {
                setMenu(undefined);
                onSwitch(value);
              }
            : undefined
        }
      />
      <div className="artifact-menu-meta">
        <span>Artifact by you</span>
        {metadata.updatedAt && (
          <span>
            Updated <RelativeTime createdAt={metadata.updatedAt} />
          </span>
        )}
      </div>
      <div role="separator" />
      <ArtifactExportMenu
        onDownload={() => void action("export")}
        document={documentArtifact}
        presentation={canExportPresentation(version)}
        onPresentationExport={() => void presentationAction()}
        busy={documentBusy || preparingDownload}
        onDocumentExport={(format) => void documentAction(format)}
        onCloudExport={(connector) => void documentAction(connector)}
        nudge={
          canPublish && !publishDisabled ? (
            <ArtifactExportNudge
              shared={published}
              busy={sharingExport}
              onShare={() => void shareExport()}
            />
          ) : undefined
        }
      />
      {/* Project copy belongs to Copy. */}
      {onCopyToProject ? (
        <ArtifactSubmenu
          label={t("Copy")}
          icon={<CopyStackIcon size={15} />}
          items={[
            {
              key: "markdown",
              label: t("Copy as Markdown"),
              onSelect: () => void action("copy"),
            },
            {
              key: "project",
              label: t(
                copiedToProject ? "Copied to project" : "Copy to project",
              ),
              disabled: copiedToProject,
              onSelect: () => {
                setMenu(undefined);
                void onCopyToProject().then(setCopiedToProject).catch(onError);
              },
            },
          ]}
        />
      ) : (
        <button role="menuitem" onClick={() => void action("copy")}>
          <CopyStackIcon size={15} />
          {t("Copy as Markdown")}
        </button>
      )}
      <div role="separator" />
      <ReasonTooltip reason={rename ? undefined : renameDisabledReason}>
        {(props) => (
          <button
            {...props}
            role="menuitem"
            data-testid="frame-title-menu-rename"
            disabled={!rename}
            aria-description={rename ? undefined : renameDisabledReason}
            onClick={startRename}
          >
            <AppIcon name="Edit" />
            Rename
          </button>
        )}
      </ReasonTooltip>
      {onDuplicate && (
        <ReasonTooltip reason={duplicateDisabledReason}>
          {(props) => (
            <button
              {...props}
              role="menuitem"
              data-testid="frame-title-menu-duplicate"
              disabled={
                duplicateDisabledReason !== undefined || duplicatePending
              }
              aria-description={duplicateDisabledReason}
              onClick={() => void duplicate()}
            >
              <AppIcon name="Copy" />
              {duplicateLabel ?? t("Duplicate")}
            </button>
          )}
        </ReasonTooltip>
      )}
      {/* Verbs before talk and window rows. */}
      <button
        role="menuitem"
        data-testid="frame-title-menu-share"
        disabled={!canPublish || Boolean(artifact.generating)}
        onClick={() => {
          setMenu(undefined);
          setVersionShareOpen(true);
        }}
      >
        <AppIcon name="Share" />
        {t("Share")}
      </button>
      <button
        role="menuitem"
        data-testid="frame-title-menu-permissions"
        onClick={() => {
          setMenu(undefined);
          setPermissionsOpen(true);
        }}
      >
        <Lock size={15} />
        {t("Permissions")}
      </button>
      {onVersion && versions > 0 && (
        <ArtifactVersionMenu
          count={versions}
          history={versionHistory}
          shown={shownVersion}
          onChoose={(version) => {
            setMenu(undefined);
            menuTrigger.current?.focus();
            onVersion(version);
          }}
        />
      )}
      {(!onVersion || versions === 0) && (
        <button
          role="menuitem"
          data-testid="frame-title-menu-versions"
          disabled
        >
          <Clock size={15} />
          {t("Version history")}
        </button>
      )}
      {documentArtifact && (
        <ArtifactSubmenu
          label={t("Language")}
          icon={<Globe size={15} />}
          items={locales.map((locale) => ({
            key: locale.id,
            label: locale.native,
            disabled: documentBusy,
            onSelect: () => void translateDocument(locale.id),
          }))}
        />
      )}
      <div role="separator" />
      <button
        role="menuitemcheckbox"
        aria-checked={showComments}
        data-testid="frame-title-menu-comments"
        onClick={() => {
          setMenu(undefined);
          setShowComments(!showComments);
        }}
      >
        <CommentBubblesIcon size={15} />
        {t("Show all comments")}
        {openCount > 0 && (
          <span className="artifact-menu-count">{openCount}</span>
        )}
        <span className="artifact-menu-checkbox">
          {showComments && <Check size={12} />}
        </span>
      </button>
      {onAsk && (
        <button
          role="menuitem"
          onClick={() => {
            setMenu(undefined);
            onAsk();
          }}
        >
          <AppIcon name="Chats" />
          {t("Ask Claudex")}
        </button>
      )}
      {/* Pop out and Open in web. Only an artifact with a public link has a page
         on the web: otherwise Open in web is greyed with the reason. */}
      <div role="separator" />
      <button
        role="menuitem"
        data-testid="frame-title-menu-expand"
        onClick={() => {
          setMenu(undefined);
          onExpand();
        }}
      >
        {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        {t(expanded ? "Collapse" : "Expand")}
      </button>
      {onPopOut && (
        <button
          role="menuitem"
          onClick={() => {
            setMenu(undefined);
            menuTrigger.current?.focus();
            void onPopOut().catch(onError);
          }}
        >
          <PopOutWindowsIcon size={15} />
          Pop out
        </button>
      )}
      <button
        role="menuitem"
        disabled={!published}
        title={published ? undefined : openInWebReason}
        onClick={() => {
          setMenu(undefined);
          menuTrigger.current?.focus();
          void openInWeb().catch(onError);
        }}
      >
        <SquareArrowOutUpRight size={15} />
        {openInWebAsTab ? t("Open in new tab") : t("Open in web")}
      </button>
      <div role="separator" />
      <button role="menuitem" onClick={() => void action("refresh")}>
        <RotateCw size={15} />
        Refresh
      </button>
      {onPin && (
        <button
          role="menuitem"
          onClick={() => {
            setMenu(undefined);
            void onPin(artifact).catch(onError);
          }}
        >
          {pinned ? <TiltedUnpinIcon size={15} /> : <TiltedPinIcon size={15} />}
          {pinned ? "Unpin" : "Pin"}
        </button>
      )}
      <div role="separator" />
      <button
        role="menuitemcheckbox"
        aria-checked={chatShown}
        data-testid="frame-title-menu-chat"
        onClick={toggleChat}
      >
        <AppIcon name="Chats" />
        {t("Show chat")}
        <span className="artifact-menu-checkbox">
          {chatShown && <Check size={12} />}
        </span>
      </button>
      {artifact.conversationId && (
        <button
          role="menuitem"
          onClick={() => {
            setMenu(undefined);
            setFeedbackOpen(true);
          }}
        >
          <Megaphone size={15} />
          {t("Send feedback")}
        </button>
      )}
      {storageUsage && (
        <>
          <div role="separator" />
          <ArtifactStorageMenu
            usage={storageUsage}
            onRequestLimit={async () => {
              const identity = artifactToolIdentity(artifact);
              await window.desktop.requestArtifactStorageLimit(identity);
              window.dispatchEvent(
                new CustomEvent(artifactDataChanged, {
                  detail: identity,
                }),
              );
            }}
            onError={onError}
          />
        </>
      )}
      {/* A report target and renderer are required. */}
      <div role="separator" />
      {reportsState === "open" &&
        typeof window !== "undefined" &&
        Boolean(window.desktop?.reportArtifact) && (
          <>
            <button
              role="menuitem"
              data-testid="frame-title-menu-report"
              onClick={() => {
                setMenu(undefined);
                setReporting(true);
              }}
            >
              <Flag size={15} />
              Report artifact
            </button>
          </>
        )}
      {/* Only library copies can be deleted: an artifact in a conversation is
         part of that conversation, so there the row is greyed with the reason. */}
      <>
        <button
          role="menuitem"
          className="artifact-menu-delete"
          disabled={!artifact.libraryId || !onDelete}
          title={artifact.libraryId ? undefined : deleteArtifactReason}
          onClick={() => {
            setMenu(undefined);
            onDelete?.(artifact);
          }}
        >
          <Trash size={15} />
          Delete artifact
        </button>
      </>
    </div>
  );
}
