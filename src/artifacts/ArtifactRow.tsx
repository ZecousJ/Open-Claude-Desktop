import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ArtifactsIcon } from "../ui/icons";
import { formatText } from "../i18n";
import {
  Laptop,
  LockKeyhole,
  MoreVertical,
  Pin,
  Globe,
  PinFilled,
  Check,
} from "../ui/glyphs";
import { ArtifactShareContext } from "./artifact-context";
import { gridCardEntries, shareLink } from "./ArtifactGridCard";
import { RenameArtifactDialog } from "./RenameArtifactDialog";
import "./gallery.css";
import type { Artifact } from "../ui/components";
import { ArtifactOpenLink } from "./ArtifactOpenLink";
import { artifactIdentity, useArtifactMetadata } from "./artifact-metadata";
import { Menu, type MenuPosition } from "../ui/Menu";
import { galleryTimeText, galleryTypes, type GalleryType } from "./gallery";
import { typeIcons } from "./ArtifactsPage";
import type { Row } from "./ArtifactsPage";

/** One artifact: type tile, name, access and when it was opened, and its menu. */
export function ArtifactRow({
  row,
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
  row: Row;
  now: number;
  onOpen: (artifact: Artifact) => void;
  hrefForArtifact?: (artifact: Artifact) => string;
  onPin: (artifact: Artifact) => Promise<void>;
  onDuplicate: (artifact: Artifact) => Promise<void>;
  onDelete: (artifact: Artifact) => void;
  onDownload: (artifact: Artifact) => void;
  onCopyLink: (url: string) => void;
  onError: (error: unknown) => void;
}) {
  const { artifact } = row;
  const metadata = useArtifactMetadata(artifact);
  const share = useContext(ArtifactShareContext).find(
    (value) => value.identity === artifactIdentity(artifact),
  );
  const [menu, setMenu] = useState<MenuPosition>();
  const [renaming, setRenaming] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const Icon = typeIcons[row.type];
  const shared = share?.visibility === "link";
  const hosted = shared && share?.scope === "public";
  // The grid card's menu: the original has one menu for both views.
  const entries = gridCardEntries(artifact, shareLink(share), {
    onPin,
    onDuplicate,
    onDelete,
    onDownload,
    onCopyLink,
    onError,
    onRename: () => setRenaming(true),
  });
  function rename(name: string) {
    try {
      void metadata.rename(name).catch(onError);
    } catch (error) {
      onError(error);
    }
  }
  return (
    <div
      className="artifacts-row"
      role="listitem"
      onContextMenu={(event) => {
        // The whole row opens its menu at the pointer; not a menu or dialog
        // portaled out of it.
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        setMenu({ left: event.clientX, top: event.clientY });
      }}
    >
      <ArtifactOpenLink
        className="artifacts-row-main"
        href={hrefForArtifact?.(artifact)}
        onOpen={() => onOpen({ ...artifact, surface: "artifact" })}
      >
        <span className="artifacts-tile" data-type={row.type}>
          <Icon size={18} />
        </span>
        <span className="artifacts-row-name" data-no-translate>
          {row.name}
        </span>
        <span className="artifacts-row-meta">
          {hosted ? (
            <Globe size={13} aria-label="Anyone with the link" />
          ) : shared ? (
            <Laptop size={13} aria-label="Shared on this computer" />
          ) : (
            <LockKeyhole size={13} aria-label="Only you" />
          )}
          {row.time !== undefined && (
            <>
              <i aria-hidden="true">·</i>
              {row.viewed ? "Viewed" : "Edited"}{" "}
              {galleryTimeText(row.time, now)}
            </>
          )}
        </span>
      </ArtifactOpenLink>
      {/* A pin beside the time, shown on hover or focus and always while pinned. */}
      <button
        className="artifacts-row-pin"
        aria-pressed={Boolean(artifact.pinned)}
        aria-label={artifact.pinned ? "Unpin" : "Pin"}
        onClick={() => void onPin(artifact).catch(onError)}
      >
        {artifact.pinned ? <PinFilled size={15} /> : <Pin size={15} />}
      </button>
      <button
        ref={more}
        className="artifacts-row-more"
        aria-label={formatText("More options for {title}", { title: row.name })}
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
        <MoreVertical size={17} />
      </button>
      {menu && (
        <Menu
          label={`Options for ${row.name}`}
          entries={entries}
          position={menu}
          width={180}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
      {renaming && (
        <RenameArtifactDialog
          name={row.name}
          onSave={rename}
          onClose={() => setRenaming(false)}
        />
      )}
    </div>
  );
}

/** The type filter: every type with how many artifacts it has. */
export function TypeMenu({
  type,
  counts,
  total,
  onChoose,
  onClose,
}: {
  type?: GalleryType;
  counts: ReadonlyMap<GalleryType, number>;
  total: number;
  onChoose: (type: GalleryType | undefined) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
    function pointer(event: PointerEvent) {
      if (!(event.target as Element).closest(".artifacts-type-anchor"))
        onClose();
    }
    function key(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const buttons = [
          ...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
        ];
        const index = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const step = event.key === "ArrowDown" ? 1 : -1;
        buttons[(index + step + buttons.length) % buttons.length]?.focus();
      }
    }
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const item = (
    value: GalleryType | undefined,
    label: string,
    icon: ReactNode,
    count: number,
  ) => (
    <button
      key={value ?? "all"}
      role="menuitemradio"
      aria-checked={type === value}
      onClick={() => onChoose(value)}
    >
      {icon}
      <span className="artifacts-type-label">{label}</span>
      {type === value ? <Check size={16} /> : <small>{count}</small>}
    </button>
  );
  return (
    <div
      ref={box}
      className="artifacts-type-menu"
      role="menu"
      aria-label="Artifact types"
    >
      {item(
        undefined,
        "All types",
        <ArtifactsIcon size={20} className="artifacts-type-all" />,
        total,
      )}
      {galleryTypes.map(({ type: value, label }) => {
        const Icon = typeIcons[value];
        return item(
          value,
          label,
          <span className="artifacts-type-icon" data-type={value}>
            <Icon size={value === "code" ? 14 : 11} />
          </span>,
          counts.get(value) ?? 0,
        );
      })}
    </div>
  );
}
