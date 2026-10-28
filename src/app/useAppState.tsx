import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { windowRole } from "../conversation-window/window-role";
import { surface as buildSurface } from "../../shared/host";
import { initialWebEntry, parseWebRoute, initialWebMode } from "../web/routes";
import type {
  Snapshot,
  Mode,
  Attachment,
  Project,
  AppCommand,
  Conversation,
} from "../../shared/types";
import type { SetStateAction } from "react";
import { deferFileTransition, notesSeenKey, releaseNotesVersion } from "./App";
import { useSidebarVisibility } from "../sidebar/useSidebarVisibility";
import { useFullScreen } from "../host/useFullScreen";
import { usePolicy } from "../policy/PolicyContext";
import { useAnnouncements } from "../policy/Announcements";
import { DraftTextStore } from "../composer/draft-text";
import { useComposerDraft } from "./useComposerDraft";
import type { Settings, Confirmation, AppController } from "./AppContext";
import { useComposerSending } from "../composer/useComposerSending";
import type { Artifact } from "../ui/ArtifactTypes";
import { useToolPanels } from "./useToolPanels";
import { preloadMarkdownRenderer } from "../ui/MarkdownRenderer";
import { preloadArtifactCard } from "../artifacts/LazyArtifactCard";
import type { ComposerField } from "../composer/composer-field";
import { ArtifactPresentation } from "../artifacts/artifact-presentation";
import { useControllerRef } from "./useControllerRef";
import { SettingsWriteQueue } from "./SettingsWriteQueue";
import type { DeepLink } from "../../shared/deep-links";
import { actionVerificationHandled } from "../auth/action-verification-store";
import { useDesktopEvents } from "./useDesktopEvents";
import { useAppearance } from "../settings/useAppearance";
import { researchPolicyOf } from "../../shared/client-policy";
import { setDraftResearch } from "../research/useResearchDraft";
import { projectConnectorOverrides } from "../../shared/project-tools";
import { dismissAllToasts, showToast } from "../ui/toast-store";
import { useAppNavigation } from "./useAppNavigation";

/** What useAppState needs from App.tsx. */
export interface UseAppStateKit {
  accountId: string;
}

export function useAppState(kit: UseAppStateKit) {
  const { accountId } = kit;
  // The main window, or one conversation in its own window (R2).
  const role = useMemo(() => windowRole(), []);
  const conversationWindow = role.kind === "conversation";
  const projectWindow = role.kind === "project";
  const initialPlace = useMemo(
    () =>
      buildSurface === "web"
        ? initialWebEntry(
            parseWebRoute(location.pathname, location.search, location.hash),
          )
        : undefined,
    [],
  );
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [activeId, applyActiveId] = useState<string | undefined>(
    initialPlace?.conversationId,
  );
  const [artifactRouteId, setArtifactRouteId] = useState<string | undefined>(
    initialPlace?.artifactId,
  );
  const setActiveId =
    buildSurface === "web"
      ? applyActiveId
      : (next: SetStateAction<string | undefined>) => {
          const value = typeof next === "function" ? next(activeId) : next;
          if (
            value !== activeId &&
            deferFileTransition?.(() => applyActiveId(value))
          )
            return;
          applyActiveId(value);
        };
  const [draftSession, setDraftSession] = useState(() => crypto.randomUUID());
  const [page, applyPage] = useState(
    role.kind === "project" ? "projects" : (initialPlace?.page ?? "chat"),
  );
  const setPage =
    buildSurface === "web"
      ? applyPage
      : (next: SetStateAction<string>) => {
          const value = typeof next === "function" ? next(page) : next;
          if (value !== page && deferFileTransition?.(() => applyPage(value)))
            return;
          applyPage(value);
        };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState("general");
  const [mode, setMode] = useState<Mode>(() =>
    buildSurface === "web"
      ? initialWebMode(
          parseWebRoute(location.pathname, location.search, location.hash),
        )
      : "code",
  );
  const sidebarView = useSidebarVisibility(snapshot?.settings.sidebarWidth);
  const fullScreen = useFullScreen();
  const sidebar = sidebarView.open;
  const [incognito, setIncognito] = useState(false);
  const policy = usePolicy();
  const announcements = useAnnouncements();
  const [editSidebar, setEditSidebar] = useState(false);
  const [sidebarWidthPreview, setSidebarWidthPreview] = useState<number>();
  // The draft lives outside React state: typing re-renders only its subscribers.
  const [draft] = useState(() => new DraftTextStore());
  const { setText, setSkillTokens } = draft;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const composerDraft = useComposerDraft(policy);
  const { draftWebSearch, setDraftWebSearch, resetDraft } = composerDraft;
  const [cwd, setCwd] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Settings["codeEffort"]>();
  const { sending, setSending, beginComposerSend } = useComposerSending(
    `${accountId}\n${activeId ? `conversation:${activeId}` : `draft:${draftSession}`}\n${mode}\n${incognito}`,
  );
  const [error, setError] = useState("");
  // The first snapshot's failure, shown on the boot error page.
  const [bootFailure, setBootFailure] = useState<{ error: unknown }>();
  const onBootFailure = useCallback(
    (error: unknown) => setBootFailure({ error }),
    [],
  );
  const [search, setSearch] = useState<string | null>(null);
  const [searchEntrypoint, setSearchEntrypoint] = useState<
    "default" | "search" | "actions"
  >("default");
  const [artifact, setArtifact] = useState<Artifact>();
  const [artifactWidth, setArtifactWidth] = useState(50);
  const toolPanels = useToolPanels();
  const { panel, setPanel } = toolPanels;
  const [rename, setRename] = useState<{ id: string; title: string }>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation>();
  const [projectEditor, setProjectEditor] = useState<Project>();
  const [projectAssignee, setProjectAssignee] = useState<string>();
  const [releaseNotes, setReleaseNotes] = useState(false);
  // The home link disappears once the current notes have been opened.
  const [notesSeen, setNotesSeen] = useState(() => {
    try {
      return localStorage.getItem(notesSeenKey) === releaseNotesVersion;
    } catch {
      return false;
    }
  });
  const openReleaseNotes = () => {
    setReleaseNotes(true);
    setNotesSeen(true);
    try {
      localStorage.setItem(notesSeenKey, releaseNotesVersion);
    } catch {
      /* The link simply shows again next time. */
    }
  };
  // Replies need the Markdown renderer, which left the first load: fetch it
  // at once, so an opened conversation doesn't wait on it.
  useEffect(() => {
    void preloadMarkdownRenderer();
  }, []);
  // The artifact card left the first load; fetch it once the app is idle.
  useEffect(() => {
    const idle =
      window.requestIdleCallback ??
      ((run: () => void) => setTimeout(run, 2000));
    idle(() => void preloadArtifactCard());
  }, []);
  // An administrator notice's Read opens What's new.
  useEffect(() => {
    if (announcements.openRequest) openReleaseNotes();
  }, [announcements.openRequest]);
  const [connectionDismissed, setConnectionDismissed] = useState(false);
  const composer = useRef<ComposerField>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const selectNext = useRef(false);
  const artifactPresentation = useRef(new ArtifactPresentation());
  useEffect(() => {
    artifactPresentation.current.retainActivitySections(
      snapshot?.conversations ?? [],
    );
  }, [snapshot?.conversations]);
  const presentationContext = useRef({
    activeId,
    page,
    settingsOpen,
    artifact,
  });
  presentationContext.current = { activeId, page, settingsOpen, artifact };
  const stateRef = useRef(snapshot);
  stateRef.current = snapshot;
  const { currentController, controllerScope, exposeController } =
    useControllerRef<AppController>(accountId);
  const settingsWriter = useRef<SettingsWriteQueue<Settings> | undefined>(
    undefined,
  );
  /** Keyboard shortcuts and application-menu items run the same commands. */
  const runCommand = useRef<
    (command: AppCommand, conversationId?: string, folder?: string) => void
  >(() => {});
  /** claudex:// links: a new chat (filled in, never sent), a conversation or a project. */
  const runDeepLink = useRef<(link: DeepLink) => void>(() => {});
  const report = useCallback((e: unknown) => {
    if (!actionVerificationHandled(e))
      setError(e instanceof Error ? e.message : String(e));
  }, []);
  const upsert = useCallback(
    (c: Conversation) =>
      setSnapshot((s) =>
        s
          ? {
              ...s,
              conversations: s.conversations.some((v) => v.id === c.id)
                ? s.conversations.map((v) => (v.id === c.id ? c : v))
                : [c, ...s.conversations],
            }
          : s,
      ),
    [],
  );
  useDesktopEvents({
    latest: stateRef,
    presentation: presentationContext,
    selectNext,
    artifactPresentation,
    runCommand,
    runDeepLink,
    setSnapshot,
    upsert,
    report,
    setActiveId,
    setArtifact,
    setArtifactWidth,
    setPanel,
    setProviderId,
    setModel,
    setError,
    onBootFailure,
  });
  useAppearance(snapshot?.settings);
  const active = snapshot?.conversations.find((c) => c.id === activeId);
  const running = active?.turns.some((t) => t.status === "inProgress") ?? false;
  const project = snapshot?.projects.find((p) => p.id === projectId);
  const projectModelFallback = useRef<
    { providerId: string; model: string } | undefined
  >(undefined);
  useEffect(() => {
    if (activeId) {
      projectModelFallback.current = undefined;
      return;
    }
    if (!project?.defaultModel) {
      const fallback = projectModelFallback.current;
      if (fallback) {
        setProviderId(fallback.providerId);
        setModel(fallback.model);
        projectModelFallback.current = undefined;
      }
      return;
    }
    const provider =
      snapshot?.settings.providers.find(
        (value) =>
          value.id === project.defaultProviderId &&
          [value.model, ...value.models].includes(project.defaultModel!),
      ) ??
      snapshot?.settings.providers.find((value) =>
        [value.model, ...value.models].includes(project.defaultModel!),
      );
    if (!provider) return;
    projectModelFallback.current ??= { providerId, model };
    setProviderId(provider.id);
    setModel(project.defaultModel);
  }, [
    activeId,
    project?.id,
    project?.defaultModel,
    project?.defaultProviderId,
  ]);
  const projectToolsKey = JSON.stringify(project?.tools);
  useEffect(() => {
    if (activeId || !project?.tools) return;
    if (project.tools.webSearch && policy.webSearch) setDraftWebSearch(true);
    if (
      project.tools.research &&
      policy.webSearch &&
      researchPolicyOf(policy).enabled
    )
      setDraftResearch(true);
    composerDraft.setDraftConnectors((current) => ({
      ...current,
      ...projectConnectorOverrides(project),
    }));
  }, [project?.id, projectToolsKey]);
  // Notices stack in the corner (src/ui/toast-store.ts), 6s each.
  const dismissToast = dismissAllToasts;
  const notify = (message: string) => void showToast(message);
  function openSettingsTab(tab: string) {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }
  const {
    incognitoShown,
    openConversation,
    host,
    newChat,
    switchSurface,
    history,
    confirmDelete,
    transcriptScroll,
    activeTerminals,
    dismissPlan,
    placeOfDraft,
  } = useAppNavigation({
    accountId,
    active,
    activeId,
    artifact,
    artifactRouteId,
    composer,
    controllerScope,
    conversationWindow,
    currentController,
    draftSession,
    follow,
    incognito,
    mode,
    notify,
    openSettingsTab,
    page,
    panel,
    policy,
    report,
    resetDraft,
    role,
    runCommand,
    runDeepLink,
    scroll,
    selectNext,
    setActiveId,
    setArtifact,
    setArtifactRouteId,
    setAttachments,
    setConfirm,
    setCwd,
    setDraftSession,
    setEffort,
    setIncognito,
    setMode,
    setModel,
    setPage,
    setPanel,
    setProjectId,
    setProviderId,
    setSearch,
    setSearchEntrypoint,
    setSettingsOpen,
    setShortcutsOpen,
    setSnapshot,
    setText,
    sidebarView,
    snapshot,
    stateRef,
    upsert,
  });
  return {
    currentController,
    controllerScope,
    upsert,
    report,
    active,
    setProjectId,
    snapshot,
    incognitoShown,
    setCwd,
    openSettingsTab,
    artifact,
    setArtifact,
    activeId,
    setSnapshot,
    role,
    openConversation,
    setText,
    setAttachments,
    setProviderId,
    setModel,
    runDeepLink,
    conversationWindow,
    bootFailure,
    artifactPresentation,
    setBootFailure,
    host,
    error,
    setProjectAssignee,
    setProjectEditor,
    settingsWriter,
    stateRef,
    policy,
    setError,
    notify,
    dismissToast,
    page,
    setPage,
    mode,
    setMode,
    setActiveId,
    running,
    newChat,
    switchSurface,
    history,
    sidebarView,
    sidebarWidthPreview,
    setSidebarWidthPreview,
    draftSession,
    draft,
    setSkillTokens,
    attachments,
    draftWebSearch,
    setDraftWebSearch,
    composerDraft,
    cwd,
    projectId,
    project,
    providerId,
    model,
    effort,
    setEffort,
    sending,
    setSending,
    beginComposerSend,
    composer,
    follow,
    selectNext,
    confirmDelete,
    scroll,
    transcriptScroll,
    activeTerminals,
    panel,
    setPanel,
    toolPanels,
    dismissPlan,
    artifactRouteId,
    setArtifactRouteId,
    artifactWidth,
    setArtifactWidth,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    search,
    setSearch,
    searchEntrypoint,
    setSearchEntrypoint,
    rename,
    setRename,
    shortcutsOpen,
    setShortcutsOpen,
    confirm,
    setConfirm,
    projectEditor,
    projectAssignee,
    releaseNotes,
    setReleaseNotes,
    notesSeen,
    openReleaseNotes,
    editSidebar,
    setEditSidebar,
    connectionDismissed,
    setConnectionDismissed,
    exposeController,
    placeOfDraft,
    sidebar,
    projectWindow,
    fullScreen,
  } as const;
}
