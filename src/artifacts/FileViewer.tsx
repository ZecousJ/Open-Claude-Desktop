import { BlankArtifactPanel } from "./BlankArtifactPanel";
import {
  useArtifactMetadata,
  useMarkArtifactViewed,
  ArtifactAccountScope,
  type ArtifactCommentAccess,
} from "./artifact-metadata";
import { ArtifactChrome } from "./ArtifactChrome";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../app/AppContext";
import { usePaneExpandToggle } from "../app/pane-expand";
import { relativePath } from "../ui/relative-path";
import { CodeFileHeader, useCodeFileOptions } from "./CodeFileHeader";
import type { Artifact } from "../ui/components";
import { ArtifactPreview } from "./ArtifactPreview";
import { ArtifactSource } from "./ArtifactSource";
import { FileViewerHeader } from "./FileViewerHeader";
import { PanelResizeHandle } from "./PanelResizeHandle";
import { artifactKind, artifactViews, extensionOf } from "./artifact-kind";
import { downloadArtifact, savedMessage } from "./artifact-actions";
import { artifactProjectFile } from "./artifact-project-file";
import { formatText, t } from "../i18n";
import { showToast } from "../ui/toast-store";
import { FloatingChatPanel } from "./FloatingChatPanel";
import {
  artifactWriteKey,
  versionIdOf,
  versionNumber,
} from "./artifact-versions";
import { VersionCompareDialog } from "./VersionCompareDialog";
import { FileHistory } from "./FileHistory";
import { fileLineVersions } from "./file-history";
import { useSheetDrag } from "../ui/sheet-drag";
import { surface } from "../../shared/host";
import { relatedArtifactSessions } from "./related-sessions";
import "./file-viewer-panel.css";
export {
  duplicateArtifact,
  pinArtifact,
  requestArtifactDelete,
} from "./library-actions";

/** The name a download starts with: the file's own name, or the title plus an extension for its language. */
export function artifactFilename(artifact: Artifact) {
  return (
    artifact.filename ??
    (/\.[a-z0-9]+$/i.test(artifact.name)
      ? artifact.name
      : `${artifact.name}.${artifact.language === "text" ? "txt" : artifact.language}`)
  );
}

export function ArtifactPanel(
  props: Parameters<typeof StandardArtifactPanel>[0],
) {
  return props.artifact.blankArtifact ? (
    <BlankArtifactPanel {...props} />
  ) : (
    <StandardArtifactPanel {...props} />
  );
}

function StandardArtifactPanel({
  artifact,
  onClose,
  onError,
  width = 50,
  onResize,
  onComment,
  onTryFix,
  authorName = "You",
  onShareRequestConsumed,
  onDuplicate,
  onPin,
  onDelete,
  onNotify,
  chatBeside = false,
  fullPage = false,
  onHome,
  onChat,
  siblings,
  onSwitch,
  versionsOf,
  onRestore,
  commentAccess,
}: {
  artifact: Artifact;
  commentAccess?: ArtifactCommentAccess;
  onClose: () => void;
  onError: (e: unknown) => void;
  /** Shows a short confirmation (copied, saved). */
  onNotify?: (message: string) => void;
  width?: number;
  onResize?: (width: number) => void;
  onComment?: (text: string) => Promise<void>;
  /** Asks the agent in the artifact's conversation to fix a preview error. */
  onTryFix?: (error: string) => Promise<void>;
  authorName?: string;
  onShareRequestConsumed?: () => void;
  onDuplicate?: (artifact: Artifact) => Promise<void>;
  onPin?: (artifact: Artifact) => Promise<void>;
  onDelete?: (artifact: Artifact) => void;
  /**
   * Whether the artifact's conversation is on screen beside it, so that
   * expanded it can float over the artifact.
   */
  chatBeside?: boolean;
  /**
   * Opened from the Artifacts gallery: the artifact takes the page, and Chat
   * goes to its conversation (onChat) instead of docking.
   */
  fullPage?: boolean;
  onHome?: () => void;
  onChat?: () => void;
  /** The conversation's artifacts, for the title menu's Switch artifact. */
  siblings?: () => Artifact[];
  onSwitch?: (artifact: Artifact) => void;
  /**
   * An artifact's versions, oldest first: one per write of a generated file;
   * none for anything else.
   */
  versionsOf?: (artifact: Artifact) => Artifact[];
  onRestore?: (artifact: Artifact) => Promise<boolean>;
}) {
  artifact = useArtifactMetadata(artifact).artifact;
  // Collaboration (comments, share, library actions) works on text documents.
  const collaboration = artifact.surface === "artifact" && !artifact.blob;
  const identity = `${artifact.libraryId ?? artifact.conversationId ?? ""}:${artifact.sourcePath ?? artifact.id}:${artifact.surface ?? "file"}`;
  const kind = artifactKind(artifact);
  // A file from a Code session opens in the editor-style panel.
  const app = useContext(AppContext);
  const account = useContext(ArtifactAccountScope);
  const owner = app?.snapshot.conversations.find(
    (c) => c.id === (artifact.conversationId ?? app.activeId),
  );
  const codeSession = !collaboration && owner?.mode === "code";
  // Code and Cowork files read as documents (the contents rail); a
  // conversation's own artifacts keep the chat's Markdown column.
  const asDocument =
    !collaboration && (owner?.mode === "code" || owner?.mode === "cowork");
  const [codeOptions, setCodeOptions] = useCodeFileOptions();
  const views = artifactViews(kind);
  const [refresh, setRefresh] = useState(0);
  // Preview/Code and Expand belong to the file on screen: another file opens
  // in its own default view from its first frame, never in the last file's.
  const viewKey = `${app?.accountId ?? account.id}:${identity}:${views.preview}`;
  // A Code session's file opens on its source, the eye previews it.
  const firstView = codeSession ? !views.source : views.preview;
  const [mode, setMode] = useState({ viewKey, preview: firstView });
  const preview = mode.viewKey === viewKey ? mode.preview : firstView;
  const setPreview = (value: boolean) => setMode({ viewKey, preview: value });
  const [expandedKey, setExpandedKey] = useState<string>();
  const expanded = fullPage || expandedKey === viewKey;
  // The floating chat belongs to the expanded file: it goes with Chat, with
  // another file, or when the conversation leaves the screen.
  const [floatKey, setFloatKey] = useState<string>();
  const chatFloating =
    chatBeside && expanded && collaboration && floatKey === viewKey;
  const toggleExpanded = () => {
    setFloatKey(undefined);
    setExpandedKey(expanded ? undefined : viewKey);
  };
  const toggleChatFloat = () => setFloatKey(chatFloating ? undefined : viewKey);
  // The version switcher: an earlier snapshot of the file shows in place of
  // the latest until Latest is chosen again or another file opens. The
  // header's share and comments stay with the file itself.
  const versions = useMemo(
    () => versionsOf?.(artifact) ?? [],
    // History can gain a write even when the file ID, digest and capture time
    // repeat. The host's callback changes when its snapshot changes too.
    [
      viewKey,
      artifact.id,
      artifact.sourceDigest,
      artifact.updatedAt,
      versionsOf,
    ],
  );
  // A transcript's explicit snapshot is the initial selection. A new card
  // click resets local history navigation even when it names the same file.
  const selectionKey = `${viewKey}:${artifact.versionPinned ? artifactWriteKey(artifact) : "latest"}`;
  const [chosen, setChosen] = useState<{
    viewKey: string;
    versionId?: string;
  }>();
  // Discard navigation from the previous card, so returning to that card
  // cannot revive a version picked before another write was opened.
  useEffect(() => setChosen(undefined), [selectionKey]);
  const [historyKey, setHistoryKey] = useState<string>();
  const [blame, setBlame] = useState<{ viewKey: string; line: number }>();
  const historyOpen = historyKey === viewKey;
  const toggleHistory =
    versions.length && views.source
      ? () => {
          setHistoryKey(historyOpen ? undefined : viewKey);
          setBlame(undefined);
          setPreview(false);
        }
      : undefined;
  const lineVersions = useMemo(
    () => (historyOpen ? fileLineVersions(versions) : []),
    [versions, historyOpen],
  );
  const pinned =
    chosen?.viewKey === selectionKey
      ? chosen.versionId
        ? versions.find((value) => versionIdOf(value) === chosen.versionId)
        : versions.at(-1)
      : artifact.versionPinned
        ? (versions.find(
            (value) =>
              value.id === artifact.id &&
              value.sourceDigest === artifact.sourceDigest &&
              value.updatedAt === artifact.updatedAt,
          ) ??
          versions.find(
            (value) => value.sourceDigest === artifact.sourceDigest,
          ))
        : undefined;
  const shown: Artifact = pinned
    ? {
        ...artifact,
        id: pinned.id,
        content: pinned.content,
        sourceDigest: pinned.sourceDigest,
        updatedAt: pinned.updatedAt,
        bytes: pinned.bytes,
        mime: pinned.mime,
        blob: pinned.blob,
        contentOmitted: pinned.contentOmitted,
        versionPinned: pinned !== versions.at(-1),
      }
    : artifact;
  const shownVersion =
    versionNumber(versions, versionIdOf(pinned ?? shown)) ?? versions.length;
  const chooseVersion = (number: number) => {
    const version = versions[number - 1];
    setChosen(
      !version
        ? undefined
        : {
            viewKey: selectionKey,
            versionId:
              number === versions.length ? undefined : versionIdOf(version),
          },
    );
  };
  // Compare with current: an earlier text version against the latest one, in a
  // dialog. A binary file has no lines to compare.
  const [comparing, setComparing] = useState<{
    viewKey: string;
    number: number;
  }>();
  const compared =
    comparing?.viewKey === viewKey ? versions[comparing.number - 1] : undefined;
  const compare =
    versions.length > 1 && !artifact.blob
      ? (number: number) => setComparing({ viewKey, number })
      : undefined;
  const root = useRef<HTMLElement>(null);
  // On a phone the panel is a sheet that a drag down closes.
  useSheetDrag(root, onClose, surface === "web" && !expanded, identity);
  const markViewed = useMarkArtifactViewed();
  const viewed = useRef(artifact);
  viewed.current = artifact;
  // "Viewed …" in Artifacts: once per opening, not per content update. A
  // failure only leaves the older time; renaming or commenting reports it.
  useEffect(() => {
    void markViewed(viewed.current).catch(() => {});
  }, [identity]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const target = root.current;
    // Without scrolling: the panel may still be sliding in from off to the
    // right, and Safari scrolled the page to it (ui/spring-panels.ts).
    target?.focus({ preventScroll: true });
    return () => {
      if (target?.contains(document.activeElement) && previous?.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, [identity]);
  const filename = artifactFilename(artifact);
  const extension = extensionOf(artifact.filename ?? artifact.name);
  const title = extension
    ? artifact.name.replace(new RegExp(`\\.${extension}$`, "i"), "")
    : artifact.name;
  const download = () =>
    void downloadArtifact(shown, filename)
      .then((saved) => saved && onNotify?.(savedMessage(saved)))
      .catch(onError);
  // Copy to project: adds the version shown, as a text file, to the project its
  // conversation belongs to.
  const projectId =
    collaboration && !codeSession ? owner?.projectId : undefined;
  const projectFile = artifactProjectFile(shown);
  const copyToProject =
    projectId &&
    projectFile &&
    !artifact.generating &&
    typeof window !== "undefined" &&
    window.desktop?.addProjectKnowledgeFiles
      ? async () => {
          try {
            await window.desktop.addProjectKnowledgeFiles(projectId, [
              projectFile,
            ]);
            return true;
          } catch (error) {
            showToast(
              formatText("Error adding artifact to project: {error}", {
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            return false;
          }
        }
      : undefined;
  usePaneExpandToggle("artifact", toggleExpanded);
  const showPreview = preview || !views.source;
  // The account's editable current frame retains its shell while writing.
  // Imported/view-only and pinned-version surfaces keep their own renderer.
  // Keep the known title: source titlePending is an uncached metadata read, not
  // the agent writing a file.
  const pendingFrame =
    collaboration &&
    Boolean(artifact.generating) &&
    !artifact.sharedWithYou &&
    !artifact.versionPinned &&
    !shown.versionPinned;
  return (
    <aside
      ref={root}
      className={`${fullPage || !app?.active ? "" : "work-panel "}artifact-panel file-viewer${expanded && !fullPage && app?.active ? " expanded" : ""}${collaboration ? " artifact-collaboration" : ""}${
        codeSession
          ? ` code-file-panel${codeOptions.wordWrap ? "" : " no-wrap"}${codeOptions.showWhitespace ? " show-whitespace" : ""}${codeOptions.scrollPastEnd ? " scroll-past-end" : ""}`
          : ""
      }`}
      style={
        codeSession
          ? ({ "--code-tab-size": codeOptions.tabSize } as React.CSSProperties)
          : undefined
      }
      data-expanded={expanded}
      data-standalone={
        (fullPage && surface === "web" && collaboration) || undefined
      }
      data-chat-float={chatFloating || undefined}
      tabIndex={-1}
      aria-label={`${collaboration ? "Artifact panel" : "File viewer"}: ${title}`}
    >
      {!expanded && (
        <PanelResizeHandle width={width} panel={root} onResize={onResize} />
      )}
      {collaboration && (!artifact.generating || pendingFrame) ? (
        <ArtifactChrome
          artifact={artifact}
          authorName={authorName}
          expanded={expanded}
          standalone={fullPage && surface === "web"}
          commentAccess={commentAccess}
          relatedSessionCount={
            app
              ? relatedArtifactSessions(app.snapshot, artifact).length
              : undefined
          }
          onHome={onHome}
          onExpand={fullPage ? (onChat ?? onClose) : toggleExpanded}
          onClose={onClose}
          onRefresh={() => setRefresh((v) => v + 1)}
          onError={onError}
          onComment={onComment}
          onAsk={
            app || onChat
              ? () => {
                  if (fullPage) onChat?.();
                  else if (expanded) toggleExpanded();
                  requestAnimationFrame(() =>
                    app?.composer.current?.focus({ preventScroll: true }),
                  );
                }
              : undefined
          }
          onShareRequestConsumed={onShareRequestConsumed}
          onDuplicate={onDuplicate}
          onPin={onPin}
          onDelete={onDelete}
          onNotify={onNotify}
          chatFloating={chatFloating}
          onToggleChatFloat={chatBeside ? toggleChatFloat : undefined}
          siblings={siblings}
          onSwitch={onSwitch}
          versions={versions.length}
          versionHistory={versions}
          shownVersion={shownVersion}
          onVersion={chooseVersion}
          onRestore={
            shown.versionPinned && onRestore
              ? async () => {
                  if (await onRestore(shown)) {
                    setChosen({ viewKey: selectionKey });
                    setRefresh((value) => value + 1);
                  }
                }
              : undefined
          }
          onHistory={toggleHistory}
          shown={shown}
          onCopyToProject={copyToProject}
          onPopOut={
            surface !== "web" &&
            typeof window !== "undefined" &&
            window.desktop?.popOutArtifact
              ? async () => {
                  const { popoutDocument } = await import("./popout-document");
                  const { readSnapshot } = await import("./useGeneratedBytes");
                  let snapshot: Promise<string> | undefined;
                  const bytes = () =>
                    (snapshot ??= readSnapshot(
                      shown,
                      app?.accountId ?? account.id,
                    ));
                  await window.desktop.popOutArtifact(
                    artifact.name,
                    await popoutDocument(shown, bytes),
                    {
                      filename,
                      ...(shown.blob && !shown.contentOmitted
                        ? { sourceBase64: await bytes() }
                        : shown.contentOmitted
                          ? {}
                          : { source: shown.content }),
                      language: shown.language,
                      previewDownload: kind === "file",
                      pdfLabel: t("Download as PDF"),
                      pdfError: t(
                        "Couldn’t download this artifact. Try again.",
                      ),
                    },
                  );
                }
              : undefined
          }
        />
      ) : codeSession && !artifact.generating ? (
        <CodeFileHeader
          filename={filename}
          path={relativePath(artifact.sourcePath, owner?.cwd) ?? filename}
          canPreview={views.preview && views.source}
          preview={showPreview}
          onPreview={setPreview}
          expanded={expanded}
          onExpand={toggleExpanded}
          onClose={onClose}
          options={codeOptions}
          onOptions={setCodeOptions}
          platform={app?.snapshot.platform ?? ""}
          onHistory={toggleHistory}
        />
      ) : (
        <FileViewerHeader
          artifact={shown}
          title={title}
          modes={views.preview && views.source}
          preview={showPreview}
          onMode={setPreview}
          expanded={expanded}
          onExpand={toggleExpanded}
          onClose={onClose}
          onDownload={download}
          onHistory={toggleHistory}
          versions={versions.length}
          shownVersion={shownVersion}
          onVersion={chooseVersion}
          onCompare={compare}
          onError={onError}
        />
      )}
      {artifact.generating ? (
        <div className="file-preview file-preview-generating">
          <div
            className="file-preview-loading"
            role="status"
            aria-label="Generating"
          >
            <span className="generating-ring" />
          </div>
        </div>
      ) : showPreview ? (
        <ArtifactPreview
          artifact={shown}
          refresh={refresh}
          onError={onError}
          onTryFix={onTryFix}
          onDownload={download}
          asDocument={asDocument}
        />
      ) : (
        <div className="file-history-layout">
          <ArtifactSource
            artifact={shown}
            showWhitespace={codeSession && codeOptions.showWhitespace}
            onLineSelect={
              historyOpen && !pinned
                ? (line) => setBlame({ viewKey, line })
                : undefined
            }
          />
          {historyOpen && (
            <FileHistory
              path={filename}
              versions={versions}
              activeVersion={shownVersion}
              line={blame?.viewKey === viewKey ? blame.line : undefined}
              lineVersion={
                blame?.viewKey === viewKey
                  ? lineVersions[blame.line]
                  : undefined
              }
              author={formatText("Unknown")}
              onSelect={(version) => {
                chooseVersion(version);
                setBlame(undefined);
              }}
              onClearBlame={() => setBlame(undefined)}
            />
          )}
        </div>
      )}
      {compared && comparing && (
        <VersionCompareDialog
          name={filename}
          before={compared.content}
          after={(versions.at(-1) ?? artifact).content}
          from={comparing.number}
          to={versions.length}
          onClose={() => setComparing(undefined)}
        />
      )}
      {chatFloating && (
        <FloatingChatPanel
          onDock={toggleExpanded}
          onClose={() => {
            // Close chat leaves with its button: keep focus in the panel.
            setFloatKey(undefined);
            root.current?.focus();
          }}
        />
      )}
    </aside>
  );
}
