import type { ArtifactReportsState } from "../../shared/sharing-api";
import { t, formatText } from "../i18n";
import type { Artifact } from "../ui/ArtifactTypes";
import type { DictationPhase } from "../composer/voice/DictationButton";
import type { ArtifactComment } from "../../shared/artifact-notes";
import type { DocumentConnector } from "../../shared/artifact-document";
import type { ArtifactDataUsage } from "../../shared/artifact-data";
import type {
  ArtifactPublication,
  SharingStatus,
} from "../../shared/sharing-api";
import type { PublishCheck } from "./artifact-publication";
import { ArtifactCommentsPane } from "./ArtifactCommentsPane";
import { ArtifactCollaborationHeader } from "./ArtifactCollaborationHeader";

/** What artifactChromeView needs from ArtifactChrome.tsx. */
export interface ArtifactChromeViewKit {
  access: { label: string | undefined; refresh: () => void };
  action: (kind: "export" | "copy" | "refresh") => Promise<void>;
  artifact: Artifact;
  authorInitial: string;
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
  commentPhase: DictationPhase;
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
  comments: ArtifactComment[];
  commentsList: React.RefObject<HTMLElement | null>;
  copiedToProject: boolean;
  documentAction: (
    format: "docx" | "pdf" | "md" | DocumentConnector,
  ) => Promise<void>;
  documentArtifact: boolean;
  documentBusy: boolean;
  draft: { x: number; y: number; left: boolean; lift: number } | undefined;
  draftInput: React.RefObject<HTMLTextAreaElement | null>;
  duplicate: () => Promise<void>;
  duplicateDisabledReason: string | undefined;
  duplicateLabel: string | undefined;
  duplicatePending: boolean;
  expanded: boolean;
  feedbackOpen: boolean;
  finishRename: (commit: boolean) => void;
  header: React.RefObject<HTMLElement | null>;
  identity: string;
  mention: React.RefObject<HTMLSpanElement | null>;
  mentionWidth: number;
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
  noteKey: string;
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
  pulse: { id: string; at: number } | undefined;
  ready: boolean;
  refreshPublication: () => void;
  rename: ((name: string) => Promise<void>) | null | undefined;
  renameDisabledReason: string | undefined;
  renaming: boolean;
  reporting: boolean;
  reportsState: ArtifactReportsState | undefined;
  restoring: boolean;
  save: (next: ArtifactComment[]) => Promise<void>;
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
  sendToAgent: boolean;
  sending: boolean;
  setCommentPhase: React.Dispatch<React.SetStateAction<DictationPhase>>;
  setCopiedToProject: React.Dispatch<React.SetStateAction<boolean>>;
  setDraft: React.Dispatch<
    React.SetStateAction<
      { x: number; y: number; left: boolean; lift: number } | undefined
    >
  >;
  setFeedbackOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMenu: React.Dispatch<
    React.SetStateAction<"filter" | "title" | "comments" | undefined>
  >;
  setName: React.Dispatch<React.SetStateAction<string>>;
  setPermissionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPublishOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPulse: React.Dispatch<
    React.SetStateAction<{ id: string; at: number } | undefined>
  >;
  setRenaming: React.Dispatch<React.SetStateAction<boolean>>;
  setReporting: React.Dispatch<React.SetStateAction<boolean>>;
  setRestoring: React.Dispatch<React.SetStateAction<boolean>>;
  setSendToAgent: React.Dispatch<React.SetStateAction<boolean>>;
  setShowComments: React.Dispatch<React.SetStateAction<boolean>>;
  setShowResolved: React.Dispatch<React.SetStateAction<boolean>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setVersionShareOpen: React.Dispatch<React.SetStateAction<boolean>>;
  shareExport: () => Promise<void>;
  shareLabel: string;
  sharing: SharingStatus | null;
  sharingExport: boolean;
  showComments: boolean;
  showResolved: boolean;
  shownVersion: number;
  siblings: (() => Artifact[]) | undefined;
  standalone: boolean;
  startRename: () => void;
  storageUsage: ArtifactDataUsage | undefined;
  submit: (commentText?: string) => Promise<void>;
  switchList: Artifact[];
  text: string;
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
  visibleComments: ArtifactComment[];
  wasUnpublished: boolean;
}

export function artifactChromeView(kit: ArtifactChromeViewKit) {
  const {
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
  } = kit;
  const chromeView = (
    <>
      {preparingDownload && (
        <div data-artifact-download-status role="status" aria-live="polite">
          {t("Preparing the file…")}
        </div>
      )}
      <span
        role="status"
        aria-live="polite"
        data-comment-open-said
        className="sr-only"
      >
        {pulse && (
          <span key={pulse.at}>
            {formatText("Opened comment from {name}", { name: authorName })}
          </span>
        )}
      </span>
      <ArtifactCollaborationHeader
        access={access}
        action={action}
        artifact={artifact}
        authorName={authorName}
        canPublish={canPublish}
        cancelRename={cancelRename}
        chatFloating={chatFloating}
        chatGroup={chatGroup}
        chatShown={chatShown}
        commentLabel={commentLabel}
        commentMenuTip={commentMenuTip}
        commentMode={commentMode}
        commentTip={commentTip}
        copiedToProject={copiedToProject}
        documentAction={documentAction}
        documentArtifact={documentArtifact}
        documentBusy={documentBusy}
        duplicate={duplicate}
        duplicateDisabledReason={duplicateDisabledReason}
        duplicateLabel={duplicateLabel}
        duplicatePending={duplicatePending}
        expanded={expanded}
        feedbackOpen={feedbackOpen}
        finishRename={finishRename}
        header={header}
        identity={identity}
        menu={menu}
        menuTrigger={menuTrigger}
        metadata={metadata}
        name={name}
        nameInput={nameInput}
        onAsk={onAsk}
        onClose={onClose}
        onCopyToProject={onCopyToProject}
        onDelete={onDelete}
        onDuplicate={onDuplicate}
        onError={onError}
        onExpand={onExpand}
        onHistory={onHistory}
        onHome={onHome}
        onNotify={onNotify}
        onPin={onPin}
        onPopOut={onPopOut}
        onRestore={onRestore}
        onSwitch={onSwitch}
        onVersion={onVersion}
        openCount={openCount}
        openInWeb={openInWeb}
        openInWebAsTab={openInWebAsTab}
        openLabel={openLabel}
        openPublish={openPublish}
        permissionsOpen={permissionsOpen}
        pinned={pinned}
        preparingDownload={preparingDownload}
        presentationAction={presentationAction}
        publication={publication}
        publishButton={publishButton}
        publishCheck={publishCheck}
        publishDisabled={publishDisabled}
        publishInput={publishInput}
        publishOpen={publishOpen}
        publishReason={publishReason}
        published={published}
        ready={ready}
        refreshPublication={refreshPublication}
        rename={rename}
        renameDisabledReason={renameDisabledReason}
        renaming={renaming}
        reporting={reporting}
        reportsState={reportsState}
        restoring={restoring}
        saved={saved}
        setCopiedToProject={setCopiedToProject}
        setFeedbackOpen={setFeedbackOpen}
        setMenu={setMenu}
        setName={setName}
        setPermissionsOpen={setPermissionsOpen}
        setPublishOpen={setPublishOpen}
        setRenaming={setRenaming}
        setReporting={setReporting}
        setRestoring={setRestoring}
        setShowComments={setShowComments}
        setVersionShareOpen={setVersionShareOpen}
        shareExport={shareExport}
        shareLabel={shareLabel}
        sharing={sharing}
        sharingExport={sharingExport}
        showComments={showComments}
        shownVersion={shownVersion}
        siblings={siblings}
        standalone={standalone}
        startRename={startRename}
        storageUsage={storageUsage}
        switchList={switchList}
        titleButton={titleButton}
        titleMenuLabel={titleMenuLabel}
        toggleChat={toggleChat}
        toggleCommentMode={toggleCommentMode}
        toggleMenu={toggleMenu}
        translateDocument={translateDocument}
        version={version}
        versionHistory={versionHistory}
        versionShareOpen={versionShareOpen}
        versions={versions}
        viewingVersionLabel={viewingVersionLabel}
        wasUnpublished={wasUnpublished}
      />
      <ArtifactCommentsPane
        authorInitial={authorInitial}
        authorName={authorName}
        commentMode={commentMode}
        commentPhase={commentPhase}
        comments={comments}
        commentsList={commentsList}
        draft={draft}
        draftInput={draftInput}
        mention={mention}
        mentionWidth={mentionWidth}
        menu={menu}
        noteKey={noteKey}
        onError={onError}
        pulse={pulse}
        save={save}
        saved={saved}
        sendToAgent={sendToAgent}
        sending={sending}
        setCommentPhase={setCommentPhase}
        setDraft={setDraft}
        setMenu={setMenu}
        setPulse={setPulse}
        setSendToAgent={setSendToAgent}
        setShowComments={setShowComments}
        setShowResolved={setShowResolved}
        setText={setText}
        showComments={showComments}
        showResolved={showResolved}
        submit={submit}
        text={text}
        toggleMenu={toggleMenu}
        visibleComments={visibleComments}
      />
    </>
  );
  return chromeView;
}
