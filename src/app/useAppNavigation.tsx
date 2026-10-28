import type { CodeEffort } from "../../shared/types";
import type {
  Mode,
  Conversation,
  Project,
  AppCommand,
  Attachment,
  Snapshot,
} from "../../shared/types";
import { api } from "../desktop-api";
import {
  deferFileTransition,
  mainWindowCommands,
  conversationWindowDisabled,
  listActiveTerminals,
  ignoreTerminalError,
} from "./App";
import { homeMode } from "../home/home-mode";
import { defaultProjectId } from "../composer/project-picker-preferences";
import { draftProjectId } from "./default-draft-project";
import { surface as buildSurface, resolveHost } from "../../shared/host";
import { setDraftResearch } from "../research/useResearchDraft";
import { useEffect, useMemo, useRef } from "react";
import {
  resolvePairedArtifact,
  originPairedArtifact,
  pairedArtifactRouteId,
} from "../artifacts/paired-artifact";
import { draftPlace } from "../composer/draft-store";
import { useNavigationHistory } from "./useNavigationHistory";
import type { NavEntry } from "./navigation-history";
import { t } from "../i18n";
import { codeEntryConversation } from "../../shared/deep-links";
import { requestProject } from "../collections/open-requests";
import { runShellCommand } from "./shell-menu";
import { searchViewEvent } from "../collections/search/palette-events";
import { menuSettingsTab } from "../settings/menu-tab";
import { keyTable } from "../host/keys";
import { useKeyboardCommands } from "./useKeyboardCommands";
import { useTranscriptScroll } from "../transcript/useTranscriptScroll";
import { usePlanPanel } from "../plan/usePlanPanel";
import { useNativeBackgroundTerminals } from "../conversation/useBackgroundTaskPolling";
import { useChatLifecycle } from "../conversation/useChatLifecycle";
import { deleteWording } from "./delete-wording";
import type { Artifact } from "../ui/ArtifactTypes";
import type { ComposerField } from "../composer/composer-field";
import type { AppController, Confirmation } from "./AppContext";
import type { DeepLink } from "../../shared/deep-links";
import type { SidePanel } from "../conversation/ToolSidePanel";
import type { ClientPolicy } from "../../shared/client-policy";
import type { WindowRole } from "../conversation-window/window-role";

/** What useAppNavigation needs from App.tsx. */
export interface UseAppNavigationKit {
  accountId: string;
  active: Conversation | undefined;
  activeId: string | undefined;
  artifact: Artifact | undefined;
  artifactRouteId: string | undefined;
  composer: React.RefObject<ComposerField | null>;
  controllerScope: {};
  conversationWindow: boolean;
  currentController: React.RefObject<AppController | undefined>;
  draftSession: `${string}-${string}-${string}-${string}-${string}`;
  follow: React.RefObject<boolean>;
  incognito: boolean;
  mode: Mode;
  notify: (message: string) => undefined;
  openSettingsTab: (tab: string) => void;
  page: string;
  panel: SidePanel;
  policy: ClientPolicy;
  report: (e: unknown) => void;
  resetDraft: (project?: Project | undefined) => void;
  role: WindowRole;
  runCommand: React.RefObject<
    (
      command: AppCommand,
      conversationId?: string | undefined,
      folder?: string | undefined,
    ) => void
  >;
  runDeepLink: React.RefObject<(link: DeepLink) => void>;
  scroll: React.RefObject<HTMLDivElement | null>;
  selectNext: React.RefObject<boolean>;
  setActiveId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setArtifact: React.Dispatch<React.SetStateAction<Artifact | undefined>>;
  setArtifactRouteId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  setConfirm: React.Dispatch<React.SetStateAction<Confirmation | undefined>>;
  setCwd: React.Dispatch<React.SetStateAction<string | undefined>>;
  setDraftSession: React.Dispatch<
    React.SetStateAction<`${string}-${string}-${string}-${string}-${string}`>
  >;
  setEffort: React.Dispatch<React.SetStateAction<CodeEffort | undefined>>;
  setIncognito: React.Dispatch<React.SetStateAction<boolean>>;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  setModel: React.Dispatch<React.SetStateAction<string>>;
  setPage: React.Dispatch<React.SetStateAction<string>>;
  setPanel: (next: React.SetStateAction<SidePanel | null>) => void;
  setProjectId: React.Dispatch<React.SetStateAction<string | undefined>>;
  setProviderId: React.Dispatch<React.SetStateAction<string>>;
  setSearch: React.Dispatch<React.SetStateAction<string | null>>;
  setSearchEntrypoint: React.Dispatch<
    React.SetStateAction<"default" | "search" | "actions">
  >;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setShortcutsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSnapshot: React.Dispatch<React.SetStateAction<Snapshot | undefined>>;
  setText: (value: React.SetStateAction<string>) => void;
  sidebarView: {
    open: boolean;
    narrow: boolean;
    phone: boolean;
    peekRequested: boolean;
    peekChanged: (open: boolean) => void;
    animating: boolean;
    toggle: () => void;
    show: () => void;
  };
  snapshot: Snapshot | undefined;
  stateRef: React.RefObject<Snapshot | undefined>;
  upsert: (c: Conversation) => void;
}

export function useAppNavigation(kit: UseAppNavigationKit) {
  const {
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
  } = kit;
  // The conversation last shown in each area of the sidebar's Chat | Code
  // switch, so switching back returns to it.
  const lastShown = useRef<{ chat?: string; code?: string }>({});
  useEffect(() => {
    if (page !== "chat" || incognito || !activeId) return;
    // By the conversation's own mode: while a switch is under way the
    // window's mode can still be the area being left.
    const shown = snapshot?.conversations.find((c) => c.id === activeId);
    if (!shown) return;
    lastShown.current[shown.mode === "code" ? "code" : "chat"] = activeId;
  }, [page, activeId, incognito, snapshot?.conversations]);
  /** The sidebar's Chat | Code switch: back to that area's last conversation. */
  function switchSurface(nextMode: Mode) {
    const area = nextMode === "code" ? "code" : "chat";
    const id = lastShown.current[area];
    const back =
      id &&
      stateRef.current?.conversations.find(
        (c) =>
          c.id === id &&
          !c.archived &&
          !c.incognito &&
          (c.mode === "code") === (area === "code"),
      );
    if (back) openConversation(back);
    else newChat(nextMode);
  }
  function newChat(
    nextMode = mode,
    nextProject?: string,
    nextIncognito = false,
    afterStart?: (created?: { draftSession: string; mode: Mode }) => void,
  ) {
    // A separate window keeps its one conversation; the main window starts the chat.
    if (conversationWindow)
      return void api
        .forwardToMainWindow(nextIncognito ? "incognito" : "new-chat")
        .catch(report);
    if (
      deferFileTransition?.(() =>
        newChat(nextMode, nextProject, nextIncognito, afterStart),
      )
    )
      return;
    selectNext.current = false;
    const executionMode = homeMode(nextMode, host, nextIncognito);
    const rememberedProject = defaultProjectId(accountId);
    nextProject = draftProjectId({
      mode: executionMode,
      incognito: nextIncognito,
      explicitId: nextProject,
      defaultId:
        buildSurface !== "web" &&
        snapshot?.projects.some((p) => p.id === rememberedProject && p.cwd)
          ? undefined
          : rememberedProject,
      projects: snapshot?.projects ?? [],
    });
    setIncognito(nextIncognito && executionMode === "chat");
    setActiveId(undefined);
    const nextDraftSession = crypto.randomUUID();
    setDraftSession(nextDraftSession);
    setPage("chat");
    setMode(executionMode);
    setProjectId(nextProject);
    setEffort(undefined);
    // The home's unsent draft comes back (src/composer/draft-store.ts); a
    // conversation's draft stays with it.
    resetDraft(
      snapshot?.projects.find((project) => project.id === nextProject),
    );
    setDraftResearch(
      Boolean(
        snapshot?.projects.find((project) => project.id === nextProject)?.tools
          ?.research,
      ),
    );
    setArtifact(undefined);
    setPanel(null);
    setCwd(snapshot?.projects.find((p) => p.id === nextProject)?.cwd);
    follow.current = true;
    setTimeout(() => composer.current?.focus(), 30);
    afterStart?.({ draftSession: nextDraftSession, mode: executionMode });
  }
  useEffect(() => {
    if (buildSurface === "web" || activeId || mode === "code" || incognito)
      return;
    // New native drafts authorize remembered local folders after the live
    // controller commits. Preferences never substitute for folder access.
    void import("../composer/native-default-place")
      .then(({ applyNativeDefaultPlace }) =>
        applyNativeDefaultPlace(currentController, {
          accountId,
          scope: controllerScope,
          draftSession,
        }),
      )
      .catch(report);
  }, [accountId, controllerScope, draftSession, activeId, mode, incognito]);
  const conversationOpeningBridge = window.desktop;
  function openConversation(
    c: Conversation,
    options?: { artifactId?: string | null },
  ) {
    const current = currentController.current;
    if (
      !current ||
      current.accountId !== accountId ||
      current.controllerScope !== controllerScope ||
      window.desktop !== conversationOpeningBridge
    )
      return;
    if (c.blankArtifact || options?.artifactId !== undefined) {
      if (
        current.page !== page ||
        current.activeId !== activeId ||
        current.mode !== mode
      )
        return;
      c =
        current.snapshot.conversations.find((value) => value.id === c.id) ?? c;
    }
    // A separate window hands any other conversation to the main window.
    if (role.kind === "conversation" && c.id !== role.conversationId)
      return void api
        .forwardToMainWindow({ openConversation: c.id })
        .catch(report);
    if (deferFileTransition?.(() => openConversation(c, options))) return;
    const paired =
      c.mode === "code"
        ? undefined
        : options?.artifactId === null
          ? undefined
          : options?.artifactId
            ? resolvePairedArtifact(current.snapshot, c.id, options.artifactId)
            : originPairedArtifact(current.snapshot, c.id);
    if (
      c.blankArtifact &&
      current.page === "chat" &&
      current.activeId === c.id &&
      current.mode === c.mode
    ) {
      setArtifact(paired);
      return;
    }

    selectNext.current = false;
    if (!c.incognito) setIncognito(false);
    setActiveId(c.id);
    setPage("chat");
    setMode(c.mode);
    setProviderId(c.providerId);
    setModel(c.model);
    setEffort(c.effort);
    setProjectId(c.projectId);
    setCwd(c.cwd);
    setText("");
    setAttachments([]);
    setSearch(null);
    setArtifact(paired);
    setPanel(null);
    follow.current = true;
    // The conversation's composer takes the focus, as the live chat page does;
    // not on a touch screen, where it would raise the keyboard.
    if (!globalThis.matchMedia?.("(pointer: coarse)").matches)
      setTimeout(() => {
        const field = composer.current;
        if (
          field &&
          document.activeElement !== field &&
          !field.closest("[inert]")
        )
          field.focus({ preventScroll: true });
      }, 30);
  }
  const surface = (value: Mode) => (value === "code" ? "code" : "chat");
  const incognitoShown = incognito && mode === "chat" && page === "chat";
  // Each conversation and each home keeps its own unsent draft.
  const placeOfDraft = draftPlace({
    conversationId: activeId,
    mode,
    incognito: active ? active.incognito : incognito && mode === "chat",
  });
  const history = useNavigationHistory({
    beforeMove: deferFileTransition,
    location: {
      page,
      surface: surface(mode),
      conversationId: activeId,
      artifactId:
        page === "chat"
          ? pairedArtifactRouteId(artifact, activeId)
          : artifactRouteId,
    },
    record: !incognitoShown,
    valid: (entry) =>
      !entry.conversationId ||
      Boolean(
        stateRef.current?.conversations.some(
          (c) => c.id === entry.conversationId && !c.incognito,
        ),
      ),
    apply: (entry: NavEntry) => {
      const c = stateRef.current?.conversations.find(
        (value) => value.id === entry.conversationId,
      );
      if (entry.page === "chat" && c)
        openConversation(c, { artifactId: entry.artifactId ?? null });
      else if (entry.page === "chat")
        newChat(entry.surface === surface(mode) ? mode : entry.surface);
      else {
        setIncognito(false);
        if (entry.page === "artifact") setArtifactRouteId(entry.artifactId);
        if (entry.surface !== surface(mode)) setMode(entry.surface);
        setPage(entry.page);
      }
    },
  });
  runDeepLink.current = (link) => {
    if (conversationWindow) return;
    if (link.kind === "ssh" || link.kind === "ssh-error") {
      void import("../ssh/open-link")
        .then(({ openSshLink }) => openSshLink(link, notify, t))
        .catch(report);
      return;
    }
    if (deferFileTransition?.(() => runDeepLink.current(link))) return;
    const conversations = stateRef.current?.conversations ?? [];
    const open = (id: string) => {
      const c = conversations.find(
        (value) => value.id === id && !value.incognito,
      );
      if (c) openConversation(c);
      return Boolean(c);
    };
    if (
      link.kind === "needs-input" ||
      (link.kind === "conversation" && link.id === "last")
    ) {
      const waiting = new Set(
        (stateRef.current?.approvals ?? []).map(
          (approval) => approval.conversationId,
        ),
      );
      const target = codeEntryConversation(link, conversations, waiting);
      if (target) openConversation(target);
      else newChat("code");
      return;
    }
    if (link.kind === "conversation") {
      if (!open(link.id)) notify(t("This conversation isn’t available."));
      return;
    }
    if (link.kind === "project") {
      if (!stateRef.current?.projects.some((p) => p.id === link.id))
        return notify(t("This project isn’t available."));
      if (mode === "code") setMode("chat");
      requestProject(link.id);
      setPage("projects");
      return;
    }
    newChat(link.mode);
    if (link.folder) setCwd(link.folder);
    if (link.prompt) setText(link.prompt);
  };
  runCommand.current = (command, conversationId, folder) => {
    if (command === "new-code-session-in") {
      if (conversationWindow || !folder) return;
      if (
        deferFileTransition?.(() =>
          runCommand.current(command, conversationId, folder),
        )
      )
        return;
      newChat("code");
      setCwd(folder);
      return;
    }
    if (command === "open-conversation") {
      const c = stateRef.current?.conversations.find(
        (value) => value.id === conversationId && !value.incognito,
      );
      if (c) openConversation(c);
      return;
    }
    if (conversationWindow) {
      if (mainWindowCommands.has(command))
        void api.forwardToMainWindow(command).catch(report);
      if (command === "shortcuts") setShortcutsOpen(true);
      return;
    }
    // Panes, Open File… and Reopen Closed Session need the window's state.
    if (runShellCommand(command)) return;
    // ⌘K opens the palette or closes it; ⇧⌘K opens it on Search.
    if (command === "search") {
      setSearchEntrypoint("default");
      setSearch((current) => (current === null ? "" : null));
    }
    if (command === "search-palette") {
      setSearchEntrypoint("search");
      setSearch((current) => current ?? "");
      window.dispatchEvent(new Event(searchViewEvent));
    }
    if (command === "new-chat") newChat();
    // ⇧⌘I enters incognito from Chat, or leaves it. The administrator can turn
    // incognito off; leaving it always works.
    if (command === "incognito" && (policy.incognito || incognitoShown))
      newChat("chat", undefined, !incognitoShown);
    // Settings… opens Claudex Code's page from Code, System's elsewhere.
    if (command === "settings")
      openSettingsTab(menuSettingsTab(mode === "code" && page === "chat"));
    if (command === "customize-skills") {
      setSettingsOpen(false);
      setPage("customize");
      window.dispatchEvent(new Event("claudex:customize-skills"));
    }
    if (command === "scheduled-tasks") {
      setSettingsOpen(false);
      setPage("scheduled");
    }
    if (command === "toggle-sidebar") sidebarView.toggle();
    // The web app shows no keyboard shortcuts (src/ui/Tooltip.tsx).
    if (command === "shortcuts" && buildSurface !== "web")
      setShortcutsOpen(true);
    if (command === "back") history.back?.();
    if (command === "forward") history.forward?.();
    // File ▸ Open Folder…: a new Code session in the folder chosen.
    if (command === "open-folder")
      void api
        .chooseFolder()
        .then((folder) => {
          if (!folder) return;
          const open = () => {
            newChat("code");
            setCwd(folder);
          };
          if (!deferFileTransition?.(open)) open();
        })
        .catch(report);
  };
  // The build's surface, with what the snapshot says this host can do.
  const host = useMemo(
    () => resolveHost(buildSurface, snapshot?.host),
    [snapshot?.host],
  );
  const keys = useMemo(
    () => keyTable(host.kind, snapshot?.platform),
    [host.kind, snapshot?.platform],
  );
  // The desktop's platform, for stylesheets that tell them apart.
  useEffect(() => {
    if (host.kind !== "desktop" || !snapshot?.platform) return;
    document.documentElement.dataset.platform = snapshot.platform;
  }, [host.kind, snapshot?.platform]);
  useKeyboardCommands(
    runCommand,
    setSearch,
    conversationWindow ? conversationWindowDisabled : undefined,
    keys,
  );
  const transcriptScroll = useTranscriptScroll(scroll, follow, active, mode);
  const dismissPlan = usePlanPanel(
    active,
    Boolean(panel || artifact),
    setPanel,
  );
  // Background terminals of the open Code task, for its inline rows and badge.
  const { terminals: activeTerminals } = useNativeBackgroundTerminals(
    active?.mode === "code" ? [active] : [],
    active?.id,
    snapshot?.engine.state === "ready",
    listActiveTerminals,
    ignoreTerminalError,
  );
  useChatLifecycle({
    active,
    page,
    incognito,
    endIncognito: () => setIncognito(false),
    setSnapshot,
    upsert,
    report,
  });
  /** Asks first; deleting the open conversation returns to a new chat. */
  function confirmDelete(c: Conversation) {
    setConfirm({
      ...deleteWording(c),
      action: async () => {
        await api.deleteConversation(c.id);
        setSnapshot((current) =>
          current
            ? {
                ...current,
                conversations: current.conversations.filter(
                  (value) => value.id !== c.id,
                ),
              }
            : current,
        );
        if (c.id === activeId) newChat();
      },
    });
  }
  return {
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
  } as const;
}
