import { useGalleryQuery } from "./gallery-query";
import { AppContext } from "../app/AppContext";
import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { lazyPiece } from "../ui/lazy-piece";
import { useSharingStatus } from "./artifact-publication";
import { artifactsPageView } from "./ArtifactsPageView";
export const ImportSharedArtifactDialog = lazyPiece(
  () => import("./ImportSharedArtifactDialog"),
  "ImportSharedArtifactDialog",
);
import { t } from "../i18n";
import { useHost } from "../host/HostContext";
import {
  onArtifactDesignRequest,
  takeArtifactDesignRequest,
} from "../collections/open-requests";
import { type LucideIcon } from "lucide-react";
import { Code2, FileCode2, FileText, Table2, Workflow } from "../ui/glyphs";
import "./gallery.css";
import type { Artifact } from "../ui/components";
import { artifactRoutePath } from "./artifact-route-model";
import {
  artifactNoteKeyOf,
  useArtifactNotes,
  useArtifactNotesLoaded,
} from "./artifact-metadata";
import { downloadArtifact, savedMessage } from "./artifact-actions";
import { artifactFilename } from "./FileViewer";
import {
  gallerySection,
  galleryType,
  matchesQuery,
  matchesOwner,
  type ArtifactOwner,
  type GalleryType,
  galleryTypes,
} from "./gallery";

export const typeIcons: Record<GalleryType, LucideIcon> = {
  web: Code2,
  document: FileText,
  diagram: Workflow,
  data: Table2,
  code: FileCode2,
};
const viewKey = "claudex.artifacts.view";
function storedView(fallback: "list" | "grid"): "list" | "grid" {
  try {
    const stored = localStorage.getItem(viewKey);
    return stored === "grid" || stored === "list" ? stored : fallback;
  } catch {
    return fallback;
  }
}

/** Conditional tabs. */
const owners: { id: ArtifactOwner; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pinned", label: "Pinned" },
  { id: "yours", label: "Yours" },
  { id: "shared", label: "Shared with you" },
  { id: "projects", label: "Projects" },
];

export interface Row {
  artifact: Artifact;
  name: string;
  type: GalleryType;
  /** When it was last opened, or else last changed. */
  time?: number;
  viewed: boolean;
}

export function ArtifactsPage({
  artifacts,
  artifact,
  onOpenArtifact,
  onImportArtifact,
  onChat,
  onCreate,
  onComment,
  onTryFix,
  authorName,
  onShareRequestConsumed,
  onDuplicate,
  onPin,
  onDelete,
  width,
  onResize,
  onClose,
  onError,
  onNotify,
  siblings,
  onSwitch,
  versionsOf,
  pinnedTabEnabled,
  projectsTabEnabled,
  sharedTabEnabled = true,
  projects = [],
  emptyVariant = "artifacts",
  onOpenDesign,
}: {
  artifacts: Artifact[];
  artifact?: Artifact;
  onOpenArtifact: (artifact: Artifact) => void;
  onImportArtifact?: (token: string) => Promise<void>;
  /** Chat on a full-page artifact: its conversation, with it beside. */
  onChat?: (artifact: Artifact) => void;
  onCreate: (
    prompt?: string,
    kind?: import("../../shared/artifact-output").ArtifactOutputKind,
  ) => void;
  onComment: (text: string) => Promise<void>;
  onTryFix?: (error: string) => Promise<void>;
  authorName: string;
  onShareRequestConsumed: () => void;
  onDuplicate: (artifact: Artifact) => Promise<void>;
  onPin: (artifact: Artifact) => Promise<void>;
  onDelete: (artifact: Artifact) => void;
  width: number;
  onResize: (width: number) => void;
  onClose: () => void;
  onError: (error: unknown) => void;
  onNotify: (message: string) => void;
  siblings?: () => Artifact[];
  onSwitch?: (artifact: Artifact) => void;
  versionsOf?: (artifact: Artifact) => Artifact[];
  pinnedTabEnabled?: boolean;
  projectsTabEnabled?: boolean;
  sharedTabEnabled?: boolean;
  projects?: { id: string; name: string }[];
  emptyVariant?: "artifacts" | "first";
  /** Supply only when the host has a real Design destination. */
  onOpenDesign?: () => void;
}) {
  const host = useHost();
  const panelId = useId();
  const notes = useArtifactNotes();
  const sharing = useSharingStatus();
  const [importing, setImporting] = useState(false);
  const notesLoaded = useArtifactNotesLoaded();
  const [view, setView] = useState(() =>
    storedView(host.kind === "web" ? "grid" : "list"),
  );
  const {
    search: query,
    setSearch: setQuery,
    clearSearch,
    owner,
    setOwner,
    groupBy,
    setGroupBy,
  } = useGalleryQuery(host.kind === "web");
  const [searchOpen, setSearching] = useState(false);
  const searching = searchOpen || Boolean(query);
  const [type, setType] = useState<GalleryType>();
  const [typeMenu, setTypeMenu] = useState(false);
  // Group by's and New's menus, at their buttons.
  const [toolMenu, setToolMenu] = useState<{
    kind: "group" | "new";
    rect: DOMRect;
  }>();
  const [designMode, setDesignMode] = useState(takeArtifactDesignRequest);
  useEffect(
    () =>
      onArtifactDesignRequest(() => setDesignMode(takeArtifactDesignRequest())),
    [],
  );
  const tabs = owners.filter(({ id }) =>
    id === "pinned"
      ? (pinnedTabEnabled ??
        (host.kind !== "web" &&
          (owner === "pinned" || artifacts.some((a) => a.pinned))))
      : id === "projects"
        ? (projectsTabEnabled ?? host.kind !== "web")
        : id === "yours" || id === "shared"
          ? sharedTabEnabled
          : true,
  );
  const selectedOwner = tabs.some(({ id }) => id === owner) ? owner : "all";
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searching) search.current?.focus();
  }, [searching]);
  const rows = useMemo<Row[]>(
    () =>
      artifacts.map((a) => {
        const note = notes[artifactNoteKeyOf(a)];
        const time = note?.viewedAt ?? a.updatedAt;
        return {
          artifact: a,
          name: note?.name ?? a.name,
          type: galleryType(a),
          time: Number.isFinite(time) ? time : undefined,
          viewed: note?.viewedAt !== undefined,
        };
      }),
    [artifacts, notes],
  );
  const counts = useMemo(() => {
    const counts = new Map<GalleryType, number>();
    for (const row of rows)
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
    return counts;
  }, [rows]);
  const owned = rows
    .filter((row) => matchesOwner(row.artifact, selectedOwner))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const sharedSearchCapped = selectedOwner === "shared" && owned.length > 60;
  const searchable = sharedSearchCapped ? owned.slice(0, 60) : owned;
  const shown = searchable
    .filter((row) => !type || row.type === type)
    .filter((row) => matchesQuery(row.name, row.artifact, query))
    .sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  const now = Date.now();
  // The rows' sections: the Projects tab by project; otherwise as Group by
  // says (None: one unheaded run newest first; Date edited: Pinned, then by
  // day; Owner: yours, then shared with you; Type: by kind).
  const sections: { id: string; label: string; rows: Row[] }[] = [];
  const grouping = selectedOwner === "projects" ? "project" : groupBy;
  if (grouping === "none") {
    if (shown.length) sections.push({ id: "all", label: "", rows: shown });
  } else if (grouping === "owner") {
    const yours = shown.filter((row) => !row.artifact.sharedWithYou);
    const shared = shown.filter((row) => row.artifact.sharedWithYou);
    if (yours.length)
      sections.push({ id: "yours", label: "Yours", rows: yours });
    if (shared.length)
      sections.push({ id: "shared", label: "Shared with you", rows: shared });
  } else if (grouping === "type") {
    for (const { type: kind, label } of galleryTypes) {
      const rows = shown.filter((row) => row.type === kind);
      if (rows.length) sections.push({ id: kind, label, rows });
    }
  } else {
    const pinned = shown.filter((row) => row.artifact.pinned);
    if (pinned.length && grouping === "date")
      sections.push({ id: "pinned", label: "Pinned", rows: pinned });
    for (const row of shown) {
      if (row.artifact.pinned && grouping === "date") continue;
      const label =
        grouping === "project"
          ? (projects.find((project) => project.id === row.artifact.projectId)
              ?.name ?? t("Projects"))
          : row.time === undefined
            ? "Earlier"
            : gallerySection(row.time, now);
      const sectionId =
        grouping === "project" ? row.artifact.projectId! : label;
      // Rows are newest first, so a section's rows are next to each other.
      const last =
        grouping === "project"
          ? sections.find((section) => section.id === sectionId)
          : sections.at(-1);
      if (last?.id === sectionId) last.rows.push(row);
      else sections.push({ id: sectionId, label, rows: [row] });
    }
  }
  const setStoredView = (value: "list" | "grid") => {
    setView(value);
    try {
      localStorage.setItem(viewKey, value);
    } catch {
      // The choice lasts until the page is left.
    }
  };
  const app = useContext(AppContext);
  const designAuthority = {
    account: app?.accountId,
    scope: app?.controllerScope,
    page: app?.page,
    bridge: typeof window === "undefined" ? undefined : window.desktop,
  };
  const openDesign = () => {
    const current = app?.currentController
      ? app.currentController.current
      : app;
    if (
      typeof window !== "undefined" &&
      window.desktop !== designAuthority.bridge
    )
      return;
    if (
      app &&
      (!current ||
        current.accountId !== designAuthority.account ||
        current.controllerScope !== designAuthority.scope ||
        current.page !== designAuthority.page)
    )
      return;
    onOpenDesign?.();
  };
  const actions = {
    onOpen: onOpenArtifact,
    hrefForArtifact: host.kind === "web" ? artifactRoutePath : undefined,
    onPin,
    onDuplicate,
    onDelete,
    onDownload: (a: Artifact) =>
      void downloadArtifact(a, artifactFilename(a), () => {
        const now = app?.currentController?.current ?? app;
        return (
          !app ||
          Boolean(
            now &&
            now.accountId === app.accountId &&
            now.controllerScope === app.controllerScope,
          )
        );
      })
        .then((saved) => saved && onNotify(savedMessage(saved)))
        .catch(onError),
    onCopyLink: (url: string) =>
      void window.desktop
        .copyText(url)
        .then(() => onNotify("Link copied"))
        .catch(onError),
    onError,
  };
  const TypeIcon = type ? typeIcons[type] : undefined;
  const artifactsPageViewView = artifactsPageView({
    actions,
    artifact,
    artifacts,
    authorName,
    clearSearch,
    counts,
    designMode,
    emptyVariant,
    host,
    importing,
    notesLoaded,
    now,
    onChat,
    onClose,
    onComment,
    onCreate,
    onDelete,
    onDuplicate,
    onError,
    onImportArtifact,
    onNotify,
    onOpenDesign,
    onPin,
    onResize,
    onShareRequestConsumed,
    onSwitch,
    onTryFix,
    openDesign,
    owner,
    groupBy,
    setGroupBy,
    panelId,
    query,
    rows,
    search,
    searching,
    sections,
    selectedOwner,
    setImporting,
    setOwner,
    setQuery,
    setSearching,
    setStoredView,
    setType,
    setTypeMenu,
    toolMenu,
    setToolMenu,
    sharedSearchCapped,
    sharing,
    shown,
    siblings,
    tabs,
    type,
    typeMenu,
    versionsOf,
    view,
    width,
  });
  return artifactsPageViewView;
}
