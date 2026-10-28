import { Suspense, useEffect, useRef, useState } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import {
  Code2,
  Maximize2,
  Minimize2,
  ChevronDown,
  Clock,
  Eye,
  X,
} from "../ui/glyphs";
import { CopyButton, IconButton } from "../ui/Controls";
import { SegmentedControl } from "../ui/SegmentedControl";
import type { Artifact } from "../ui/ArtifactTypes";
import { artifactKind, kindLabel } from "./artifact-kind";
import { artifactIdentity } from "./artifact-metadata";
import {
  previouslyUnpublishedReason,
  useArtifactPublication,
  useSharingStatus,
} from "./artifact-publication";
import { VersionSwitcher } from "./ArtifactSwitcher";
import type { SharingStatus } from "../../shared/sharing-api";
import "./file-viewer-panel.css";
import { artifactToolIdentity } from "../../shared/artifact-tools";
import { useInlinedHtml } from "./useInlinedHtml";

// Loaded when Publish artifact opens, with its own stylesheet.
const PublishArtifactModal = lazyPiece(
  () => import("./PublishArtifactModal"),
  "PublishArtifactModal",
);
const ArtifactShareDialog = lazyPiece(
  () => import("./ArtifactShareDialog"),
  "ArtifactShareDialog",
);
const ArtifactToolPermissions = lazyPiece(
  () => import("./ArtifactToolPermissions"),
  "ArtifactToolPermissions",
);
const ArtifactFeedbackDialog = lazyPiece(
  () => import("./ArtifactFeedbackDialog"),
  "ArtifactFeedbackDialog",
);

/** Kinds shown as text a public page can render or list as source. */
const unpublishable = new Set(["image", "pdf", "docx", "xlsx", "pptx", "file"]);

/**
 * The file surface's header: Preview/Code, title, copy (or download for a
 * binary file) and its options, expand and close. While the agent rewrites the
 * file only expand and close show, as in the reference. When the Claudex
 * service offers public artifact links (R1), More options also has Publish
 * artifact, which opens the Publish dialog for the file. A file the agent
 * wrote more than once has the version switcher after its title.
 */
export function FileViewerHeader({
  artifact,
  title,
  modes,
  preview,
  onMode,
  expanded,
  onExpand,
  onClose,
  onDownload,
  versions = 0,
  shownVersion = versions,
  onVersion,
  onCompare,
  onHistory,
  onError = (error) => console.error(error),
}: {
  artifact: Artifact;
  title: string;
  /** Preview and Code are both offered. */
  modes: boolean;
  preview: boolean;
  onMode: (preview: boolean) => void;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
  onDownload: () => void;
  /** How many versions the file has and which is shown (1-based). */
  versions?: number;
  shownVersion?: number;
  onVersion?: (version: number) => void;
  /** Opens Compare with current for an earlier version; absent for a binary file. */
  onCompare?: (version: number) => void;
  onHistory?: () => void;
  /** A Publish failure (the window's notice). */
  onError?: (error: unknown) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [versionMenu, setVersionMenu] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const published = usePublishedFile(artifact);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    function pointer(event: PointerEvent) {
      if (
        !menuRef.current?.contains(event.target as Node) &&
        !menuButton.current?.contains(event.target as Node)
      )
        setMenu(false);
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setMenu(false);
        menuButton.current?.focus();
      }
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key, true);
    };
  }, [menu]);
  useEffect(() => setMenu(false), [artifact.id, expanded]);
  const label = kindLabel(artifact);
  const expand = (
    <IconButton
      label={expanded ? "Collapse" : "Expand"}
      onClick={() => {
        onExpand();
        setMenu(false);
      }}
    >
      {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </IconButton>
  );
  const close = (
    <IconButton label="Close" onClick={onClose}>
      <X size={16} />
    </IconButton>
  );
  if (artifact.generating)
    return (
      <header className="file-viewer-generating-header">
        <div className="file-viewer-controls">
          {expand}
          <IconButton label="Close" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
      </header>
    );
  return (
    <header>
      {modes && (
        <SegmentedControl
          className="file-view-mode"
          label="File view mode"
          value={preview}
          segments={[
            { value: true, label: "Preview", icon: <Eye size={18} /> },
            { value: false, label: "Code", icon: <Code2 size={18} /> },
          ]}
          onChange={onMode}
        />
      )}
      {onHistory && (
        <IconButton label="History" onClick={onHistory}>
          <Clock size={16} />
        </IconButton>
      )}
      <h2 title={title}>
        {title}
        <span> · {label}</span>
      </h2>
      {onVersion && (
        <VersionSwitcher
          count={versions}
          shown={shownVersion}
          open={versionMenu}
          onOpenChange={(open) => {
            setVersionMenu(open);
            if (open) setMenu(false);
          }}
          onChoose={onVersion}
          onCompare={onCompare}
        />
      )}
      <div className="file-viewer-controls">
        <div className="file-copy-anchor">
          {artifact.contentOmitted ? null : artifact.blob ? (
            <div className="file-copy-group">
              <button className="small-action" onClick={onDownload}>
                <span>Download</span>
              </button>
            </div>
          ) : (
            <div className="file-copy-group">
              <CopyButton text={artifact.content} />
              <button
                ref={menuButton}
                className="file-options"
                aria-label="More options"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu((value) => !value)}
              >
                <ChevronDown size={12} />
              </button>
            </div>
          )}
          {menu && (
            <div
              ref={menuRef}
              className="file-viewer-menu"
              role="menu"
              aria-label="More options"
            >
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  menuButton.current?.focus();
                  onDownload();
                }}
              >
                Download as {label}
              </button>
              {published.offer && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setSharing(true);
                  }}
                >
                  Share artifact
                </button>
              )}
              {published.offer && (
                <button
                  role="menuitem"
                  disabled={published.unpublished}
                  title={
                    published.unpublished
                      ? previouslyUnpublishedReason
                      : undefined
                  }
                  onClick={() => {
                    setMenu(false);
                    setPublishing(true);
                  }}
                >
                  <span className="file-viewer-menu-label">
                    Publish artifact
                    {(published.published || published.unpublished) && (
                      <small>
                        {published.unpublished
                          ? "Unpublished"
                          : "Content already published"}
                      </small>
                    )}
                  </span>
                </button>
              )}
              {modes && (
                <button
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    setPermissionsOpen(true);
                  }}
                >
                  Permissions
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setFeedbackOpen(true);
                }}
              >
                Send feedback
              </button>
            </div>
          )}
        </div>
        {expand}
        {close}
      </div>
      {permissionsOpen && (
        <Suspense fallback={null}>
          <ArtifactToolPermissions
            identity={artifactToolIdentity(artifact)}
            onClose={() => setPermissionsOpen(false)}
            onError={onError}
          />
        </Suspense>
      )}
      {feedbackOpen && (
        <Suspense fallback={null}>
          <ArtifactFeedbackDialog
            artifact={artifact}
            onDone={() => {
              setFeedbackOpen(false);
            }}
            onClose={() => setFeedbackOpen(false)}
            onError={onError}
          />
        </Suspense>
      )}
      {publishing && published.offer && (
        <Suspense fallback={null}>
          <PublishArtifactModal
            input={published.input}
            publication={published.publication}
            surface="file"
            usagePolicyUrl={published.usagePolicyUrl}
            embeds={published.embeds}
            onChanged={published.refresh}
            onClose={() => {
              setPublishing(false);
              menuButton.current?.focus();
            }}
            onError={onError}
          />
        </Suspense>
      )}
      {sharing && published.offer && (
        <Suspense fallback={null}>
          <ArtifactShareDialog
            access
            input={published.input}
            onClose={() => setSharing(false)}
            onChanged={published.refresh}
            onError={onError}
          />
        </Suspense>
      )}
    </header>
  );
}

/** Text a public page can render or show as source (not a binary file). */
export function publishableText(artifact: Artifact) {
  return (
    !artifact.blob &&
    !artifact.contentOmitted &&
    !unpublishable.has(artifactKind(artifact))
  );
}
/** The service takes this file as a new or refreshed public link now. */
export function canPublishFile(
  status: SharingStatus | null,
  artifact: Artifact,
) {
  return (
    Boolean(status?.artifacts) &&
    publishableText(artifact) &&
    new TextEncoder().encode(artifact.content).length <=
      (status?.maxArtifactBytes ?? 0)
  );
}

/**
 * The file's publication, and whether More options offers Publish
 * artifact: only with a service that takes artifact links, for text the
 * public page can show, within the service's size limit, once the file's
 * publication has been read. Publishing works on the file's latest version.
 */
function usePublishedFile(artifact: Artifact) {
  const status = useSharingStatus();
  const pinned = Boolean(artifact.versionPinned);
  const page = useInlinedHtml(artifact, artifact.language === "html");
  const input = {
    identity: artifactIdentity(artifact),
    title: artifact.name,
    language: artifact.language,
    content: page.content,
  };
  const canPublish = !pinned && canPublishFile(status, artifact);
  const { check, publication, refresh } = useArtifactPublication(
    input,
    canPublish,
  );
  return {
    offer: canPublish && check === "ok",
    publication,
    published: publication?.share?.status === "active",
    unpublished: Boolean(publication?.unpublished),
    refresh,
    input,
    usagePolicyUrl: status?.usagePolicyUrl,
    embeds: status?.embeds,
  };
}
