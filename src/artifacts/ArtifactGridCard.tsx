import { formatText, t } from "../i18n";
import { useContext, useRef, useState } from "react";
import { type LucideIcon } from "lucide-react";
import {
  Code2,
  FileCode2,
  FileText,
  Globe,
  Laptop,
  LockKeyhole,
  MoreHorizontal,
  Pin,
  PinFilled,
  Presentation,
  Table2,
  Workflow,
} from "../ui/glyphs";
import type { Artifact } from "../ui/ArtifactTypes";
import type { ArtifactShareInfo } from "../../shared/types";
import { ArtifactShareContext } from "./artifact-context";
import { artifactIdentity, useArtifactMetadata } from "./artifact-metadata";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { SkeletonGroup, skeletonIndex } from "../ui/Skeleton";
import { artifactKind, canExportPresentation } from "./artifact-kind";
import { galleryTimeText, type GalleryType } from "./gallery";
import { htmlDocument } from "./preview-document";
import { RenameArtifactDialog } from "./RenameArtifactDialog";
import { ArtifactOpenLink } from "./ArtifactOpenLink";
import { AppIcon } from "../ui/app-icon";

export const galleryTypeIcons: Record<GalleryType, LucideIcon> = {
  web: Code2,
  document: FileText,
  diagram: Workflow,
  data: Table2,
  code: FileCode2,
};

/** Why Copy link is off until the artifact has a link. */
export const copyLinkUnavailable =
  "Share this artifact with a link first; it has no link to copy yet.";

/**
 * Pages and SVGs preview live in the card. The frame gets no sandbox
 * permissions at all: no scripts, no forms, no navigation, and the preview
 * document's CSP blocks the network. Everything else shows an excerpt of its
 * text.
 */
export function liveThumbnail(a: Artifact) {
  if (a.blob) return false;
  const kind = artifactKind(a);
  return kind === "html" || kind === "svg";
}

/** The address Copy link copies: the hosted page when public, else the local link. */
export function shareLink(share?: ArtifactShareInfo) {
  if (share?.visibility !== "link") return undefined;
  return share.scope === "public" ? (share.publicUrl ?? share.url) : share.url;
}

/** The card's menu, in the reference's order, plus Download. */
export function gridCardEntries(
  artifact: Artifact,
  link: string | undefined,
  {
    onPin,
    onDuplicate,
    onDelete,
    onDownload,
    onCopyLink,
    onError,
    onRename,
  }: Omit<GridCardActions, "onOpen"> & { onRename: () => void },
): MenuEntry[] {
  return [
    {
      label: artifact.pinned ? "Unpin" : "Pin",
      onSelect: () => void onPin(artifact).catch(onError),
    },
    { label: "Rename", onSelect: onRename },
    {
      label: "Duplicate",
      onSelect: () => void onDuplicate(artifact).catch(onError),
    },
    link
      ? { label: "Copy link", onSelect: () => onCopyLink(link) }
      : { label: "Copy link", disabled: true, title: copyLinkUnavailable },
    { label: "Download", onSelect: () => onDownload(artifact) },
    // Only library copies can be deleted: a conversation's artifact belongs to it.
    ...(artifact.libraryId
      ? ([
          { separator: true },
          {
            label: "Delete",
            danger: true,
            onSelect: () => onDelete(artifact),
          },
        ] as MenuEntry[])
      : []),
  ];
}

export interface GridCardActions {
  onOpen: (artifact: Artifact) => void;
  hrefForArtifact?: (artifact: Artifact) => string;
  onPin: (artifact: Artifact) => Promise<void>;
  onDuplicate: (artifact: Artifact) => Promise<void>;
  onDelete: (artifact: Artifact) => void;
  onDownload: (artifact: Artifact) => void;
  onCopyLink: (url: string) => void;
  onError: (error: unknown) => void;
}

/**
 * A grid card of the Artifacts page: a preview area with the type tile over its
 * bottom edge, a two-line name, access and time, and a ⋯ menu with Pin, Rename,
 * Duplicate, Copy link, Download and Delete.
 */
export function ArtifactGridCard({
  artifact,
  name,
  type,
  time,
  viewed,
  now,
  onOpen,
  hrefForArtifact,
  onPin,
  onDuplicate,
  onDelete,
  onDownload,
  onCopyLink,
  onError,
}: {
  artifact: Artifact;
  name: string;
  type: GalleryType;
  time?: number;
  viewed: boolean;
  now: number;
} & GridCardActions) {
  const metadata = useArtifactMetadata(artifact);
  const share = useContext(ArtifactShareContext).find(
    (value) => value.identity === artifactIdentity(artifact),
  );
  const [menu, setMenu] = useState<MenuPosition>();
  const [renaming, setRenaming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  // Use the viewer's real presentation capability: collected HTML slide
  // decks/Markdown presentations, and a supported PPTX supplied by a host.
  const presentation = canExportPresentation(artifact);
  const Icon = presentation ? Presentation : galleryTypeIcons[type];
  // A dashboard (a scripted data page) wears its type's violet ChartLine.
  const dashboard = type === "data" && liveThumbnail(artifact);
  const link = shareLink(share);
  const entries = gridCardEntries(artifact, link, {
    onPin,
    onDuplicate,
    onDelete,
    onDownload,
    onCopyLink,
    onError,
    onRename: () => setRenaming(true),
  });
  function rename(next: string) {
    try {
      void metadata.rename(next).catch(onError);
    } catch (error) {
      onError(error);
    }
  }
  const meta = (
    <span className="artifacts-card-meta">
      {link && share?.scope === "public" ? (
        <Globe size={12} aria-label="Anyone with the link" />
      ) : link ? (
        <Laptop size={12} aria-label="Shared with a link" />
      ) : (
        <LockKeyhole
          size={16}
          role="img"
          aria-hidden={false}
          aria-label={t("Private")}
        />
      )}
      {time !== undefined && (
        <span className="artifacts-card-dot" aria-hidden />
      )}
      {time !== undefined && (
        <span className="artifacts-card-time">
          {viewed ? "Viewed" : "Edited"} {galleryTimeText(time, now)}
        </span>
      )}
      <button
        type="button"
        className="artifacts-card-pin"
        aria-label={t(artifact.pinned ? "Unpin" : "Pin")}
        aria-pressed={Boolean(artifact.pinned)}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void onPin(artifact).catch(onError);
        }}
      >
        {artifact.pinned ? <PinFilled size={16} /> : <Pin size={16} />}
      </button>
    </span>
  );
  const preview = (
    <span className="artifacts-card-preview" data-type={type}>
      {share?.screenshotUrl ? (
        <img
          src={share.screenshotUrl}
          alt={name}
          loading="lazy"
          className="artifacts-card-screenshot"
          data-no-translate
        />
      ) : dashboard ? (
        // A dashboard draws itself with scripts, which a thumbnail may not run:
        // its type's tile stands in.
        <span className="artifacts-card-type-media" aria-hidden="true">
          <AppIcon name="ChartLine" size={24} />
        </span>
      ) : liveThumbnail(artifact) ? (
        <iframe
          className="artifacts-card-frame"
          title=""
          aria-hidden="true"
          tabIndex={-1}
          sandbox=""
          loading="lazy"
          srcDoc={htmlDocument(artifact.content)}
        />
      ) : (
        <span
          className="artifacts-card-excerpt"
          aria-hidden="true"
          data-no-translate
        >
          {artifact.content.slice(0, 400)}
        </span>
      )}
      <span
        className="artifacts-tile artifacts-card-tile"
        data-type={type}
        data-presentation={presentation || undefined}
        data-dashboard={dashboard || undefined}
      >
        {dashboard ? (
          <AppIcon name="ChartLine" size={16} />
        ) : (
          <Icon size={16} />
        )}
      </span>
    </span>
  );
  return (
    <li
      className="artifacts-card"
      role="listitem"
      onContextMenu={(event) => {
        // The whole card opens its menu at the pointer; not a menu or dialog
        // portaled out of it.
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        setMenu({ left: event.clientX, top: event.clientY });
      }}
    >
      <ArtifactOpenLink
        className="artifacts-card-main"
        href={hrefForArtifact?.(artifact)}
        onOpen={() => onOpen({ ...artifact, surface: "artifact" })}
      >
        {preview}
        <span className="artifacts-card-name" data-no-translate>
          {name}
        </span>
      </ArtifactOpenLink>
      {meta}
      <button
        ref={more}
        className="artifacts-card-more"
        aria-label={formatText("More options for {title}", { title: name })}
        data-no-translate
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={() => {
          const rect = more.current!.getBoundingClientRect();
          setMenu(
            menu
              ? undefined
              : { right: innerWidth - rect.right, top: rect.bottom + 4 },
          );
        }}
      >
        <MoreHorizontal size={20} />
      </button>
      {menu && (
        <Menu
          label={`Options for ${name}`}
          entries={entries}
          position={menu}
          width={180}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
      {renaming && (
        <RenameArtifactDialog
          name={name}
          onSave={rename}
          onClose={() => setRenaming(false)}
        />
      )}
    </li>
  );
}

/**
 * Placeholder rows while the profile's notes (names, open times) are read, so
 * the list doesn't show stale names and then reorder.
 */
export function ArtifactsSkeleton({ view }: { view: "list" | "grid" }) {
  const items = Array.from({ length: view === "grid" ? 6 : 5 });
  return (
    <SkeletonGroup
      className={`artifacts-skeleton artifacts-skeleton-${view}`}
      motion="wave"
      label="Loading artifacts"
    >
      {items.map((_, index) =>
        view === "grid" ? (
          <span
            key={index}
            className="artifacts-skeleton-card sk-item"
            style={skeletonIndex(index)}
          >
            <span className="artifacts-skeleton-preview" />
            <span className="artifacts-skeleton-bar" />
            <span className="artifacts-skeleton-bar short" />
          </span>
        ) : (
          <span
            key={index}
            className="artifacts-skeleton-row sk-item"
            style={skeletonIndex(index)}
          >
            <span className="artifacts-skeleton-tile" />
            <span className="artifacts-skeleton-text">
              <span className="artifacts-skeleton-bar" />
              <span className="artifacts-skeleton-bar short" />
            </span>
            <span className="artifacts-skeleton-bar end" />
          </span>
        ),
      )}
    </SkeletonGroup>
  );
}
