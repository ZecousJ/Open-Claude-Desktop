import { t, tc } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { ArtifactFrameTabs } from "./ArtifactSwitcher";
import { isEditEndKey } from "../ui/ime";
import { ChevronDown } from "../ui/glyphs";
import { ArtifactCollaborationControls } from "./ArtifactCollaborationControls";
import { ArtifactTitleMenu } from "./ArtifactTitleMenu";
import { Suspense } from "react";
import {
  ArtifactFeedbackDialog,
  ArtifactToolPermissions,
  PublishArtifactModal,
  ArtifactShareDialog,
} from "./ArtifactChrome";
import { ReportArtifactDialog } from "./ReportArtifactDialog";
import { artifactToolIdentity } from "../../shared/artifact-tools";
import type { Artifact } from "../ui/ArtifactTypes";
import type { DocumentConnector } from "../../shared/artifact-document";
import type {
  ArtifactPublication,
  ArtifactReportsState,
  SharingStatus,
} from "../../shared/sharing-api";
import type { PublishCheck } from "./artifact-publication";
import type { ArtifactComment } from "../../shared/artifact-notes";
import type { ArtifactDataUsage } from "../../shared/artifact-data";

/** What ArtifactCollaborationHeader needs from ArtifactChromeView.tsx. */
export interface ArtifactCollaborationHeaderProps {
  access: { label: string | undefined; refresh: () => void };
  action: (kind: "export" | "copy" | "refresh") => Promise<void>;
  artifact: Artifact;
  authorName: string;
  canPublish: boolean;
  cancelRename: React.RefObject<boolean>;
  chatFloating: boolean;
  chatGroup: React.JSX.Element | null;
  chatShown: boolean;
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
  feedbackOpen: boolean;
  finishRename: (commit: boolean) => void;
  header: React.RefObject<HTMLElement | null>;
  identity: string;
  menu: "filter" | "title" | "comments" | undefined;
  menuTrigger: React.RefObject<HTMLButtonElement | null>;
  metadata: {
    canRename: boolean;
    viewedAt: number | undefined;
    rename: (name: string) => Promise<void>;
    artifact: Artifact;
    updatedAt: number | undefined;
  };
  name: string;
  nameInput: React.RefObject<HTMLInputElement | null>;
  onAsk: (() => void) | undefined;
  onClose: () => void;
  onCopyToProject: (() => Promise<boolean>) | undefined;
  onDelete: ((artifact: Artifact) => void) | undefined;
  onDuplicate: ((artifact: Artifact) => Promise<void>) | undefined;
  onError: (e: unknown) => void;
  onExpand: () => void;
  onHistory: (() => void) | undefined;
  onHome: (() => void) | undefined;
  onNotify: ((message: string) => void) | undefined;
  onPin: ((artifact: Artifact) => Promise<void>) | undefined;
  onPopOut: (() => Promise<void>) | undefined;
  onRestore: (() => Promise<void>) | undefined;
  onSwitch: ((artifact: Artifact) => void) | undefined;
  onVersion: ((version: number) => void) | undefined;
  openCount: number;
  openInWeb: () => Promise<void>;
  openInWebAsTab: boolean;
  openLabel: string;
  openPublish: () => void;
  permissionsOpen: boolean;
  pinned: boolean;
  preparingDownload: boolean;
  presentationAction: () => Promise<void>;
  publication: ArtifactPublication | null;
  publishButton: React.RefObject<HTMLButtonElement | null>;
  publishCheck: PublishCheck;
  publishDisabled: boolean;
  publishInput: {
    identity: string;
    title: string;
    language: string;
    content: string;
  };
  publishOpen: boolean;
  publishReason:
    | "This artifact was previously unpublished. Create a new artifact to publish again."
    | "Couldn’t check whether this artifact is already published. Reload the page to try again."
    | undefined;
  published: boolean;
  ready: boolean;
  refreshPublication: () => void;
  rename: ((name: string) => Promise<void>) | null | undefined;
  renameDisabledReason: string | undefined;
  renaming: boolean;
  reporting: boolean;
  reportsState: ArtifactReportsState | undefined;
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
  setCopiedToProject: React.Dispatch<React.SetStateAction<boolean>>;
  setFeedbackOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<
    React.SetStateAction<"filter" | "title" | "comments" | undefined>
  >;
  setName: React.Dispatch<React.SetStateAction<string>>;
  setPermissionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPublishOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setRenaming: React.Dispatch<React.SetStateAction<boolean>>;
  setReporting: React.Dispatch<React.SetStateAction<boolean>>;
  setRestoring: React.Dispatch<React.SetStateAction<boolean>>;
  setShowComments: React.Dispatch<React.SetStateAction<boolean>>;
  setVersionShareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  shareExport: () => Promise<void>;
  shareLabel: string;
  sharing: SharingStatus | null;
  sharingExport: boolean;
  showComments: boolean;
  shownVersion: number;
  siblings: (() => Artifact[]) | undefined;
  standalone: boolean;
  startRename: () => void;
  storageUsage: ArtifactDataUsage | undefined;
  switchList: Artifact[];
  titleButton: React.RefObject<HTMLButtonElement | null>;
  titleMenuLabel: string;
  toggleChat: () => void;
  toggleCommentMode: () => void;
  toggleMenu: (
    value: "filter" | "title" | "comments" | undefined,
    button: HTMLButtonElement,
  ) => void;
  translateDocument: (localeId: string) => Promise<void>;
  version: Artifact;
  versionHistory: Artifact[] | undefined;
  versionShareOpen: boolean;
  versions: number;
  viewingVersionLabel: string | undefined;
  wasUnpublished: boolean;
}

export function ArtifactCollaborationHeader({
  access,
  action,
  artifact,
  authorName,
  canPublish,
  cancelRename,
  chatFloating,
  chatGroup,
  chatShown,
  commentLabel,
  commentMenuTip,
  commentMode,
  commentTip,
  copiedToProject,
  documentAction,
  documentArtifact,
  documentBusy,
  duplicate,
  duplicateDisabledReason,
  duplicateLabel,
  duplicatePending,
  expanded,
  feedbackOpen,
  finishRename,
  header,
  identity,
  menu,
  menuTrigger,
  metadata,
  name,
  nameInput,
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
  ready,
  refreshPublication,
  rename,
  renameDisabledReason,
  renaming,
  reporting,
  reportsState,
  restoring,
  saved,
  setCopiedToProject,
  setFeedbackOpen,
  setMenu,
  setName,
  setPermissionsOpen,
  setPublishOpen,
  setRenaming,
  setReporting,
  setRestoring,
  setShowComments,
  setVersionShareOpen,
  shareExport,
  shareLabel,
  sharing,
  sharingExport,
  showComments,
  shownVersion,
  siblings,
  standalone,
  startRename,
  storageUsage,
  switchList,
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
  wasUnpublished,
}: ArtifactCollaborationHeaderProps) {
  return (
    <header
      ref={header}
      className="artifact-collaboration-header"
      data-standalone={standalone || undefined}
    >
      {standalone && onHome && (
        <a
          href="/new"
          className="artifact-home-link"
          aria-label={tc("link", "Home")}
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            onHome();
          }}
        >
          <AppIcon name="Home" size={16} />
        </a>
      )}
      {switchList.length > 1 && !renaming ? (
        <ArtifactFrameTabs
          artifact={artifact}
          artifacts={switchList}
          onSwitch={(value) => {
            setMenu(undefined);
            onSwitch!(value);
          }}
          menuOpen={menu === "title"}
          activeMenuLabel={viewingVersionLabel ? titleMenuLabel : undefined}
          activeVersionLabel={viewingVersionLabel}
          onActiveTabPress={(button) => toggleMenu("title", button)}
          onClose={onClose}
        />
      ) : renaming ? (
        <input
          ref={nameInput}
          className="artifact-title-input"
          aria-label="Artifact name"
          maxLength={200}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            if (isEditEndKey(e, "Escape")) {
              e.preventDefault();
              e.stopPropagation();
              cancelRename.current = true;
              setRenaming(false);
              requestAnimationFrame(() => {
                titleButton.current?.focus();
                cancelRename.current = false;
              });
            }
            if (isEditEndKey(e, "Enter")) {
              e.preventDefault();
              finishRename(true);
            }
          }}
        />
      ) : (
        <button
          ref={titleButton}
          className="artifact-title-options"
          aria-label={titleMenuLabel}
          aria-haspopup="menu"
          aria-expanded={menu === "title"}
          onClick={(e) => toggleMenu("title", e.currentTarget)}
          onDoubleClick={startRename}
        >
          <span>{artifact.name}</span>
          {viewingVersionLabel && (
            <span className="artifact-viewing-version">
              {viewingVersionLabel}
            </span>
          )}
          <ChevronDown size={12} />
        </button>
      )}
      <span className="artifact-header-gap" />
      <ArtifactCollaborationControls
        artifact={artifact}
        authorName={authorName}
        canPublish={canPublish}
        chatFloating={chatFloating}
        chatGroup={chatGroup}
        commentLabel={commentLabel}
        commentMenuTip={commentMenuTip}
        commentMode={commentMode}
        commentTip={commentTip}
        expanded={expanded}
        menu={menu}
        onClose={onClose}
        onError={onError}
        onExpand={onExpand}
        onHistory={onHistory}
        onRestore={onRestore}
        openCount={openCount}
        openLabel={openLabel}
        openPublish={openPublish}
        publishButton={publishButton}
        publishDisabled={publishDisabled}
        publishOpen={publishOpen}
        publishReason={publishReason}
        published={published}
        ready={ready}
        restoring={restoring}
        saved={saved}
        setMenu={setMenu}
        setRestoring={setRestoring}
        setShowComments={setShowComments}
        setVersionShareOpen={setVersionShareOpen}
        shareLabel={shareLabel}
        showComments={showComments}
        standalone={standalone}
        toggleCommentMode={toggleCommentMode}
        toggleMenu={toggleMenu}
        versionShareOpen={versionShareOpen}
        wasUnpublished={wasUnpublished}
      />
      {menu === "title" && (
        <ArtifactTitleMenu
          action={action}
          artifact={artifact}
          canPublish={canPublish}
          chatShown={chatShown}
          copiedToProject={copiedToProject}
          documentAction={documentAction}
          documentArtifact={documentArtifact}
          documentBusy={documentBusy}
          duplicate={duplicate}
          duplicateDisabledReason={duplicateDisabledReason}
          duplicateLabel={duplicateLabel}
          duplicatePending={duplicatePending}
          expanded={expanded}
          menuTrigger={menuTrigger}
          metadata={metadata}
          onAsk={onAsk}
          onCopyToProject={onCopyToProject}
          onDelete={onDelete}
          onDuplicate={onDuplicate}
          onError={onError}
          onExpand={onExpand}
          onPin={onPin}
          onPopOut={onPopOut}
          onSwitch={onSwitch}
          onVersion={onVersion}
          openCount={openCount}
          openInWeb={openInWeb}
          openInWebAsTab={openInWebAsTab}
          pinned={pinned}
          preparingDownload={preparingDownload}
          presentationAction={presentationAction}
          publishDisabled={publishDisabled}
          published={published}
          rename={rename}
          renameDisabledReason={renameDisabledReason}
          reportsState={reportsState}
          setCopiedToProject={setCopiedToProject}
          setFeedbackOpen={setFeedbackOpen}
          setMenu={setMenu}
          setPermissionsOpen={setPermissionsOpen}
          setReporting={setReporting}
          setShowComments={setShowComments}
          setVersionShareOpen={setVersionShareOpen}
          shareExport={shareExport}
          sharingExport={sharingExport}
          showComments={showComments}
          shownVersion={shownVersion}
          siblings={siblings}
          startRename={startRename}
          storageUsage={storageUsage}
          titleMenuLabel={titleMenuLabel}
          toggleChat={toggleChat}
          translateDocument={translateDocument}
          version={version}
          versionHistory={versionHistory}
          versions={versions}
        />
      )}

      {feedbackOpen && (
        <Suspense fallback={null}>
          <ArtifactFeedbackDialog
            artifact={version}
            onError={onError}
            onClose={() => setFeedbackOpen(false)}
            onDone={(message) => {
              setFeedbackOpen(false);
              onNotify?.(t(message));
            }}
          />
        </Suspense>
      )}
      {reporting && (
        <ReportArtifactDialog
          name={artifact.name}
          artifact={{
            identity,
            title: artifact.name,
            language: artifact.language,
            content: artifact.content,
            blob: artifact.blob,
            bytes: artifact.bytes,
          }}
          onSent={(message) => onNotify?.(message)}
          onClose={() => {
            setReporting(false);
            menuTrigger.current?.focus();
          }}
        />
      )}
      {permissionsOpen && (
        <Suspense fallback={null}>
          <ArtifactToolPermissions
            identity={artifactToolIdentity(artifact)}
            onClose={() => setPermissionsOpen(false)}
            onError={onError}
          />
        </Suspense>
      )}
      {publishOpen && canPublish && publishCheck === "ok" && (
        <Suspense fallback={null}>
          <PublishArtifactModal
            input={publishInput}
            publication={publication}
            surface="artifact"
            usagePolicyUrl={sharing?.usagePolicyUrl}
            embeds={sharing?.embeds}
            onChanged={() => {
              refreshPublication();
              access.refresh();
            }}
            onClose={() => {
              setPublishOpen(false);
              publishButton.current?.focus();
            }}
            onError={onError}
          />
        </Suspense>
      )}
      {versionShareOpen && canPublish && (
        <Suspense fallback={null}>
          <ArtifactShareDialog
            access
            input={publishInput}
            latestInput={{
              identity,
              title: artifact.name,
              language: artifact.language,
              content: artifact.content,
            }}
            onClose={() => setVersionShareOpen(false)}
            onChanged={() => {
              refreshPublication();
              access.refresh();
            }}
            onError={onError}
          />
        </Suspense>
      )}
    </header>
  );
}
