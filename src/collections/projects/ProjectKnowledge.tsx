import { t, useT } from "../../i18n";
import {
  useEffect,
  useLayoutEffect,
  useContext,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { ProjectCapabilities } from "../../../shared/project-access";
import type {
  PendingKnowledgeFile,
  ProjectKnowledgePendingAPI,
} from "../../../shared/project-knowledge-pending";
import { knowledgeDocumentExtensions } from "../../../shared/project-knowledge-encoding";
import { AppContext } from "../../app/AppContext";
import {
  knowledgeExtensions,
  type KnowledgeFile,
  type ProjectKnowledge as Knowledge,
} from "../../../shared/collections-api";
import { lazyPiece } from "../../ui/lazy-piece";
import { useZoneDrop } from "../../composer/drop-zones";
import {
  capacityReason,
  knowledgeBatch,
  knowledgeFull,
  knowledgeRefuses,
  sortKnowledgeDrop,
} from "./knowledge-drop";
import { knowledgeFileMatches } from "./knowledge-tree";
import "./knowledge-list.css";
import { projectKnowledgeView } from "./ProjectKnowledgeView";
import { type KnowledgeSnapshot, sourceNames } from "./KnowledgeList";
import { type TextDraft } from "./KnowledgeDialogs";
export const KnowledgeGitHubDialog = lazyPiece(
  () => import("./KnowledgeGitHubDialog"),
  "KnowledgeGitHubDialog",
);
export const KnowledgeMcpDialog = lazyPiece(
  () => import("./KnowledgeMcpDialog"),
  "KnowledgeMcpDialog",
);
export const KnowledgeDriveDialog = lazyPiece(
  () => import("./KnowledgeDriveDialog"),
  "KnowledgeDriveDialog",
);
export const KnowledgePreviewDialog = lazyPiece(
  () => import("./KnowledgePreview"),
  "KnowledgePreviewDialog",
);

export const KnowledgeEncodingDialog = lazyPiece(
  () => import("./KnowledgeEncodingDialog"),
  "KnowledgeEncodingDialog",
);

export { capacityReason, knowledgeFull };

/**
 * Project context, grouped files and selection. Files stay on disk for project
 * chats to read when needed; nothing is pasted into the conversation.
 */
export function ProjectKnowledge({
  projectId,
  onError,
  dropZone,
  initialAdd = false,
  onKnowledgeChange,
  contextDialog = false,
  onCloseContext,
  canEditKnowledgeBase,
}: {
  projectId: string;
  canEditKnowledgeBase?: boolean;
  onError: (error: unknown) => void;
  /**
   * The element files can be dropped on to add them (live: the project's
   * whole settings rail); its drop wins over the composer's page-wide one.
   */
  dropZone?: RefObject<HTMLElement | null>;
  /** The compact hub's Add action opens this existing add menu once loaded. */
  initialAdd?: boolean;
  /** Updates a compact hub after an operation, including one finishing after close. */
  onKnowledgeChange?: (knowledge: Knowledge) => void;
  contextDialog?: boolean;
  onCloseContext?: () => void;
}) {
  useT();
  const knowledgeRoot = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!contextDialog) return;
    const dialog =
      knowledgeRoot.current?.closest<HTMLElement>('[role="dialog"]');
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || document.activeElement !== dialog) return;
      const items = [
        ...(knowledgeRoot.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []),
      ].filter(
        (item) =>
          !item.closest("[hidden], [inert]") &&
          item.getAttribute("tabindex") !== "-1",
      );
      if (!items.length) return;
      event.preventDefault();
      event.stopPropagation();
      (event.shiftKey ? items.at(-1) : items[0])?.focus();
    };
    dialog?.addEventListener("keydown", key);
    return () => dialog?.removeEventListener("keydown", key);
  }, [contextDialog]);
  const app = useContext(AppContext);
  // Static rendering has no host. Client-only effects/actions below validate
  // their owner before using the captured bridge.
  const bridge = (typeof window === "undefined" ? undefined : window.desktop)!;
  const latestOwner = useRef({ app, bridge, projectId });
  latestOwner.current = { app, bridge, projectId };
  const ownsOperation = () => {
    if (typeof window === "undefined" || !bridge) return false;
    const owner = latestOwner.current.app;
    const actor = owner?.currentController
      ? owner.currentController.current
      : owner;
    return (
      latestOwner.current.projectId === projectId &&
      latestOwner.current.bridge === bridge &&
      window.desktop === bridge &&
      actor?.accountId === app?.accountId &&
      actor?.controllerScope === app?.controllerScope &&
      (!owner ||
        Boolean(
          actor?.snapshot.projects.some((project) => project.id === projectId),
        ))
    );
  };
  const [twoPane, setTwoPane] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(min-width: 768px)").matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 768px)");
    const update = () => setTwoPane(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const previewAnchor = useRef<HTMLButtonElement>(null);
  const restorePreviewFocus = useRef(false);
  const closePreview = () => {
    restorePreviewFocus.current = true;
    setPreview(undefined);
  };
  const [preview, setPreview] = useState<{
    file: KnowledgeFile;
    account?: string;
    controller?: object;
    bridge: typeof bridge;
    projectId: string;
  }>();
  const previewOwned = () => {
    if (!preview) return false;
    const owner = latestOwner.current.app;
    const actor = owner?.currentController
      ? owner.currentController.current
      : owner;
    return (
      latestOwner.current.projectId === preview.projectId &&
      window.desktop === preview.bridge &&
      actor?.accountId === preview.account &&
      actor?.controllerScope === preview.controller &&
      (!owner ||
        Boolean(
          actor?.snapshot.projects.some(
            (project) => project.id === preview.projectId,
          ),
        ))
    );
  };
  useLayoutEffect(() => {
    if (!preview && restorePreviewFocus.current) {
      restorePreviewFocus.current = false;
      previewAnchor.current?.focus();
    }
  }, [preview]);
  const previewOpen = Boolean(preview && previewOwned());
  const [knowledge, setKnowledge] = useState<KnowledgeSnapshot>();
  const projectAccess = (
    app?.snapshot.projects.find((project) => project.id === projectId) as
      { capabilities?: ProjectCapabilities } | undefined
  )?.capabilities;
  const canEdit =
    (canEditKnowledgeBase === undefined || canEditKnowledgeBase === true) &&
    (projectAccess === undefined ||
      projectAccess?.canEditKnowledgeBase === true) &&
    (knowledge?.capabilities === undefined ||
      knowledge.capabilities?.canEditKnowledgeBase === true);
  const mutationAllowed = useRef(canEdit);
  mutationAllowed.current = canEdit;
  const ownsMutation = () => ownsOperation() && mutationAllowed.current;
  const pendingAPI = bridge as typeof bridge & ProjectKnowledgePendingAPI;
  const encodingProtocol =
    knowledge?.uploadCapabilities?.encodingSelection === true &&
    [
      pendingAPI?.stageProjectKnowledgeFiles,
      pendingAPI?.previewProjectKnowledgeEncoding,
      pendingAPI?.confirmProjectKnowledgeEncoding,
      pendingAPI?.removeProjectKnowledgePending,
    ].every((method) => typeof method === "function");
  const documentExtraction =
    encodingProtocol &&
    knowledge?.uploadCapabilities?.documentExtraction === true;
  const acceptedExtensions = documentExtraction
    ? [...knowledgeExtensions, ...knowledgeDocumentExtensions]
    : knowledgeExtensions;
  const [encoding, setEncoding] = useState<PendingKnowledgeFile>();
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState<string>();
  const [writing, setWriting] = useState(false);
  // Add text content's fields, kept while the dialog is closed.
  const [draft, setDraft] = useState<TextDraft>({ name: "", text: "" });
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    if (initialAdd && knowledge && canEdit) setMenu(true);
  }, [initialAdd, Boolean(knowledge), canEdit]);
  const [repositories, setRepositories] = useState<string[]>([]);
  const [github, setGithub] = useState(false);
  const [drive, setDrive] = useState(false);
  const [driveServers, setDriveServers] = useState<string[]>([]);
  // Connected MCP servers with resources, and the one being browsed.
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [mcpServer, setMcpServer] = useState<string>();
  const [query, setQuery] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [pending, setPending] = useState<KnowledgeFile[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const selectButton = useRef<HTMLButtonElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const cancelSelection = () => {
    setSelecting(false);
    setSelected(new Set());
    selectionAnchor.current = null;
    selectButton.current?.focus();
  };
  const searchField = useRef<HTMLInputElement>(null);
  const searchFocusIntent = useRef(0);
  // The field is hidden until its row starts opening, so focus waits for it.
  useEffect(() => {
    if (query === null) return;
    const intent = ++searchFocusIntent.current;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          if (searchFocusIntent.current === intent)
            searchField.current?.focus();
        });
      });
    });
    return () => {
      if (searchFocusIntent.current === intent) searchFocusIntent.current++;
      cancelAnimationFrame(frame);
    };
  }, [query === null]);
  const addButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menu || !ownsOperation()) return;
    let live = true;
    void bridge
      .listProjectKnowledgeDriveConnectors?.(projectId)
      .then((servers) => {
        if (live && ownsOperation()) setDriveServers(sourceNames(servers));
      })
      .catch((error) => {
        if (live && ownsOperation()) onError(error);
      });
    void bridge
      .listProjectKnowledgeMcpServers?.(projectId)
      .then((servers) => {
        if (live && ownsOperation()) setMcpServers(sourceNames(servers));
      })
      .catch(() => {
        if (live && ownsOperation()) setMcpServers([]);
      });
    void bridge
      .listProjectKnowledgeRepositories?.(projectId)
      .then((repositories) => {
        if (live && ownsOperation()) setRepositories(sourceNames(repositories));
      })
      .catch((error) => {
        if (live && ownsOperation()) onError(error);
      });
    return () => {
      live = false;
    };
  }, [menu, projectId, bridge, app?.accountId, app?.controllerScope]);
  useEffect(() => {
    let live = true;
    setKnowledge(undefined);
    setBusy(false);
    setSyncing(undefined);
    setPreview(undefined);
    setEncoding(undefined);
    selectionAnchor.current = null;
    setQuery(null);
    setSelecting(false);
    setSelected(new Set());
    setPending([]);
    setRepositories([]);
    setGithub(false);
    setDrive(false);
    setDriveServers([]);
    setMcpServers([]);
    setMcpServer(undefined);
    if (!ownsOperation()) return;
    bridge
      .listProjectKnowledge(projectId)
      .then((value) => live && ownsOperation() && setKnowledge(value))
      .catch((error) => live && ownsOperation() && onError(error));
    return () => {
      live = false;
    };
  }, [projectId, bridge, app?.accountId, app?.controllerScope]);
  const run = async (action: () => Promise<Knowledge>) => {
    if (!ownsMutation()) return;
    setBusy(true);
    try {
      const result = await action();
      if (ownsOperation()) {
        setKnowledge(result);
        onKnowledgeChange?.(result);
      }
    } catch (error) {
      if (ownsOperation()) onError(error);
    } finally {
      if (ownsOperation()) setBusy(false);
    }
  };
  // Dropped files: sorted first, each refusal reported once, the rest uploaded.
  const upload = (files: File[]) => {
    if (!knowledge || !ownsMutation()) return;
    const { accepted, notices } = sortKnowledgeDrop(
      files,
      knowledge,
      acceptedExtensions,
    );
    for (const notice of notices) onError(new Error(notice));
    if (!accepted.length) return;
    setPending(
      accepted.map((file) => ({
        name: file.webkitRelativePath || file.name,
        bytes: file.size,
        addedAt: Date.now(),
      })),
    );
    void run(async () => {
      try {
        let latest = knowledge;
        for (let i = 0; i < accepted.length; i += knowledgeBatch) {
          const batch = await Promise.all(
            accepted.slice(i, i + knowledgeBatch).map(async (file) => ({
              name: file.webkitRelativePath || file.name,
              data: new Uint8Array(await file.arrayBuffer()),
            })),
          );
          if (!ownsMutation()) return latest;
          latest = encodingProtocol
            ? await pendingAPI.stageProjectKnowledgeFiles(projectId, batch)
            : await bridge.addProjectKnowledgeFiles(projectId, batch);
          if (!ownsOperation()) return latest;
          setKnowledge(latest);
          const uploaded = new Set(batch.map((file) => file.name));
          setPending((pending) =>
            pending.filter((file) => !uploaded.has(file.name)),
          );
        }
        return latest;
      } finally {
        if (ownsOperation()) setPending([]);
      }
    });
  };
  const fallbackZone = useRef<HTMLElement>(null);
  const dropState = useZoneDrop(dropZone ?? fallbackZone, {
    enabled: canEdit && Boolean(dropZone) && knowledge !== undefined && !busy,
    refuses: (items) =>
      !items || knowledgeRefuses(items, knowledge, documentExtraction),
    onDrop: (data) => upload(Array.from(data.files)),
  });
  const [zoneElement, setZoneElement] = useState<HTMLElement | null>(null);
  useEffect(() => setZoneElement(dropZone?.current ?? null), [dropZone]);
  const used = knowledge?.bytes ?? 0;
  // The local protocol supplies disk bytes, not the official maxKbTokens.
  // Label this safeguard as storage.
  const limit = knowledge?.limit ?? 1;
  const percent = Math.min(100, (used / limit) * 100);
  const scope = (knowledge?.files ?? [])
    .filter((file) => knowledgeFileMatches(file, query ?? ""))
    .map((file) => file.name);
  const removeSelected = () => {
    const names = [...selected];
    cancelSelection();
    void run(async () => {
      try {
        return await bridge.removeProjectKnowledge(projectId, names);
      } catch {
        throw new Error(t("Couldn’t remove the selected items. Try again."));
      }
    });
  };
  const knowledgeView = projectKnowledgeView({
    acceptedExtensions,
    addButton,
    app,
    bridge,
    busy,
    canEdit,
    cancelSelection,
    closePreview,
    contextDialog,
    draft,
    drive,
    driveServers,
    dropState,
    encoding,
    encodingProtocol,
    github,
    knowledge,
    knowledgeRoot,
    limit,
    mcpServer,
    mcpServers,
    menu,
    onCloseContext,
    onError,
    onKnowledgeChange,
    ownsMutation,
    ownsOperation,
    pending,
    pendingAPI,
    percent,
    preview,
    previewAnchor,
    previewOpen,
    previewOwned,
    projectId,
    query,
    removeSelected,
    repositories,
    run,
    scope,
    searchField,
    searchFocusIntent,
    selectButton,
    selected,
    selecting,
    selectionAnchor,
    setDraft,
    setDrive,
    setEncoding,
    setGithub,
    setKnowledge,
    setMcpServer,
    setMenu,
    setPending,
    setPreview,
    setQuery,
    setSelected,
    setSelecting,
    setSyncing,
    setWriting,
    syncing,
    twoPane,
    upload,
    uploadInput,
    used,
    writing,
    zoneElement,
  });
  return knowledgeView;
}
