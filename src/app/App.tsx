import { deferFileTransition as deferEditorTransition } from "../files/file-transitions";
import { activateRoutineReadAccount } from "../collections/routines/routine-read-receipts";
import { activateSettingsWriteAccount } from "../settings/settings-patch-queue";
import { activateQueuedAccount } from "../composer/queue";
import { Capabilities } from "../artifacts/capabilities";
import { preference } from "../../shared/settings-extras";
import { api } from "../desktop-api";
import { Suspense, useLayoutEffect } from "react";
import type { AppCommand, Conversation } from "../../shared/types";
import { Star } from "../ui/Star";
import { WindowControls } from "./WindowControls";
import { ExternalLinks } from "../ui/ExternalLinks";
import { SettingsWriteQueue } from "./SettingsWriteQueue";
import {
  ArtifactMetadataProvider,
  ArtifactConversation,
} from "../artifacts/artifact-metadata";
import {
  ArtifactSelection,
  ArtifactShareContext,
  ArtifactLibraryContext,
} from "../artifacts/artifact-context";
import { ShortcutPlatform } from "../ui/Tooltip";
import { releaseNotes as allReleaseNotes } from "./release-notes";
import {
  type AppController,
  type ConversationPatch,
  type Settings,
} from "./AppContext";
import { DraftEffects } from "./DraftEffects";
import { AppSidebar } from "./AppSidebar";
import { AppPages } from "./AppPages";
import { AppOverlays } from "./AppOverlays";
import { surface as buildSurface } from "../../shared/host";
import { useAppState } from "./useAppState";
import { useAppEffects } from "./useAppEffects";
export const deferFileTransition =
  buildSurface === "web" ? undefined : deferEditorTransition;
import { BootShell } from "../boot/BootShell";
import { BootErrorPage } from "../boot/BootErrorPage";
import { AppScope } from "../host/AppScope";
import { hostClasses, sidebarWidth, windowChrome } from "../host/layout";
import { WebMounts } from "../host/WebMounts";
import { DesktopTitle } from "../host/DesktopTitle";
import { lazyPiece } from "../ui/lazy-piece";

/** The menu bar's pane, file and reopen commands: loaded after first paint
 * (keeps the web app's first load in budget; the web has no menu bar). */
const ShellMenuHost = lazyPiece(
  () => import("./ShellMenuHost"),
  "ShellMenuHost",
  { silent: true },
);
const ChatLoadError = lazyPiece(
  () => import("./ChatLoadError"),
  "ChatLoadError",
);

export const listActiveTerminals = async (id: string) =>
  (await api.listBackgroundTerminals(id)).items;
// The Background tasks panel reports listing failures; the transcript stays quiet.
export const ignoreTerminalError = () => {};

export const notesSeenKey = "claudex.releaseNotesSeen";
/** Commands a separate conversation window hands to the main window (R2). */
export const mainWindowCommands = new Set<AppCommand>([
  "new-chat",
  "incognito",
  "search",
  "search-palette",
  "area-chat",
  "area-code",
  "settings",
  "customize-skills",
  "scheduled-tasks",
  "back",
  "forward",
  "open-folder",
  "open-file",
  "reopen-closed-session",
]);
/** Shortcuts a separate conversation window has no use for: it has no sidebar. */
export const conversationWindowDisabled = new Set<AppCommand>([
  "toggle-sidebar",
]);
/** How long a separate window says its conversation is gone before it closes. */
export const unavailableCloseMs = 2000;
export const releaseNotesVersion = allReleaseNotes[0]?.version ?? "";

/**
 * The signed-in window. App owns the state the window's areas share and
 * hands it to them through AppContext; the areas themselves live in src/app
 * (sidebar, pages, composer, panels, overlays).
 */
export function App({
  accountId,
  accountEmail,
  accountPlan,
  remoteAccount = false,
  legacyArtifactOwner = false,
  onSignOut,
  onSignOutEverywhere,
}: {
  accountId: string;
  accountEmail?: string;
  /** The Sub2API plan name shown beside the account name. */
  accountPlan?: string;
  remoteAccount?: boolean;
  legacyArtifactOwner?: boolean;
  onSignOut?: () => Promise<void>;
  onSignOutEverywhere?: () => Promise<void>;
}) {
  useLayoutEffect(() => activateRoutineReadAccount(accountId), [accountId]);
  useLayoutEffect(() => activateSettingsWriteAccount(accountId), [accountId]);
  useLayoutEffect(() => activateQueuedAccount(accountId), [accountId]);
  const {
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
  } = useAppState({ accountId });
  async function patchConversation(c: Conversation, patch: ConversationPatch) {
    try {
      const updated = await api.updateConversation(c.id, patch);
      if (
        currentController.current?.accountId !== accountId ||
        currentController.current.controllerScope !== controllerScope
      )
        return;
      if (patch.codePermissionMode !== undefined) {
        if (
          updated.codePermissionMode !== patch.codePermissionMode ||
          !Number.isSafeInteger(updated.codePermissionRevision)
        )
          throw Error("Session permissions could not be saved.");
        const { applyCodePermissionResponse } =
          await import("./code-permission-state");
        applyCodePermissionResponse(app, updated);
        return;
      }
      upsert(updated);
    } catch (e) {
      if (
        currentController.current?.accountId !== accountId ||
        currentController.current.controllerScope !== controllerScope
      )
        return;
      report(e);
    }
  }
  const {
    lockedUnavailable,
    listed,
    approvalIds,
    moveToProject,
    addConversationToProject,
  } = useAppEffects({
    active,
    activeId,
    artifact,
    conversationWindow,
    incognitoShown,
    openConversation,
    openSettingsTab,
    report,
    role,
    runDeepLink,
    setArtifact,
    setAttachments,
    setCwd,
    setModel,
    setProjectId,
    setProviderId,
    setSnapshot,
    setText,
    snapshot,
    upsert,
  });
  // Keep the themed background until workspace data arrives; a failure says why.
  // The workspace did not load: the original's boot error page in its place
  // (src/boot/BootErrorPage.tsx).
  if (
    !snapshot &&
    bootFailure &&
    (conversationWindow ||
      (buildSurface === "web" && /^\/(chat|code)\//.test(location.pathname)))
  )
    return (
      <Suspense fallback={null}>
        <ChatLoadError
          session={
            buildSurface === "web" && location.pathname.startsWith("/code/")
          }
          onRetry={async () => {
            const fresh = await api.snapshot();
            artifactPresentation.current.seed(fresh.conversations);
            setSnapshot(fresh);
            setBootFailure(undefined);
            setProviderId(fresh.settings.activeProviderId);
            setModel(
              fresh.settings.providers.find(
                (provider) => provider.id === fresh.settings.activeProviderId,
              )?.model ?? "",
            );
          }}
        />
      </Suspense>
    );
  if (!snapshot && bootFailure)
    return (
      <BootErrorPage
        error={bootFailure.error}
        answered={host.kind === "desktop"}
        onLogOut={onSignOut && (() => void onSignOut().catch(report))}
      />
    );
  if (!snapshot && !error) return <BootShell native={buildSurface !== "web"} />;
  if (!snapshot)
    return (
      <div className="boot">
        <Star size={52} />
        <h2>Claudex</h2>
        <p className="error-text">{error}</p>
      </div>
    );
  const startProject = (assignTo?: string, name?: string) => {
    setProjectAssignee(assignTo);
    setProjectEditor({
      id: crypto.randomUUID(),
      name: name ?? "",
      description: "",
      instructions: "",
      createdAt: Date.now(),
    });
  };
  async function updatePreference(patch: Partial<Settings>) {
    try {
      if (!settingsWriter.current)
        settingsWriter.current = new SettingsWriteQueue(
          () => stateRef.current!.settings,
          (settings) =>
            setSnapshot((current) =>
              current ? { ...current, settings } : current,
            ),
          (settings) => api.saveSettings(settings),
          async () => (await api.snapshot()).settings,
        );
      await settingsWriter.current.update(patch);
    } catch (e) {
      report(e);
    }
  }
  const app: AppController = {
    currentController,
    controllerScope,
    windowRole: role,
    lockedUnavailable,
    host,
    accountId,
    accountEmail,
    accountPlan,
    remoteAccount,
    onSignOut:
      onSignOut &&
      (() => {
        if (deferFileTransition?.(() => void onSignOut().catch(report)))
          return Promise.resolve();
        return onSignOut();
      }),
    onSignOutEverywhere:
      onSignOutEverywhere &&
      (() => {
        if (
          deferFileTransition?.(() => void onSignOutEverywhere().catch(report))
        )
          return Promise.resolve();
        return onSignOutEverywhere();
      }),
    policy,
    snapshot,
    setSnapshot,
    latest: stateRef,
    listed,
    approvalIds,
    upsert,
    patchConversation,
    updatePreference,
    error,
    setError,
    report,
    notify,
    dismissToast,
    page,
    setPage,
    mode,
    setMode,
    activeId,
    setActiveId,
    active,
    running,
    incognitoShown,
    newChat,
    switchSurface,
    openConversation,
    navigation: history,
    sidebarView,
    sidebarWidthPreview,
    setSidebarWidthPreview,
    draftSession,
    draft,
    get text() {
      return draft.text;
    },
    setText,
    get skillTokens() {
      return draft.skillTokens;
    },
    setSkillTokens,
    attachments,
    setAttachments,
    draftWebSearch,
    setDraftWebSearch,
    composerDraft,
    cwd,
    setCwd,
    projectId,
    setProjectId,
    project,
    providerId,
    setProviderId,
    model,
    setModel,
    effort,
    setEffort,
    sending,
    setSending,
    beginComposerSend,
    composer,
    follow,
    selectNext,
    confirmDelete,
    startProject,
    moveToProject,
    addConversationToProject,
    scroll,
    transcriptScroll,
    activeTerminals,
    panel,
    setPanel,
    toolPanels,
    dismissPlan,
    artifact,
    artifactRouteId,
    setArtifactRouteId,
    setArtifact,
    artifactWidth,
    setArtifactWidth,
    artifactPresentation,
    settingsOpen,
    setSettingsOpen,
    settingsTab,
    openSettingsTab,
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
    setProjectEditor,
    projectAssignee,
    setProjectAssignee,
    releaseNotes,
    setReleaseNotes,
    notesSeen,
    openReleaseNotes,
    editSidebar,
    setEditSidebar,
    connectionDismissed,
    setConnectionDismissed,
  };
  const chrome = windowChrome(host, snapshot.platform);
  exposeController(app);
  const capabilities = {
    artifacts:
      mode !== "chat" ||
      preference(snapshot.settings, "chatExecution") ||
      preference(snapshot.settings, "artifacts"),
    aiArtifacts: preference(snapshot.settings, "aiArtifacts"),
    inlineVisualizations: preference(snapshot.settings, "inlineVisualizations"),
  };
  return (
    <AppScope app={app}>
      <DraftEffects
        draft={draft}
        owner={accountId}
        place={placeOfDraft}
        attachments={attachments}
        setAttachments={setAttachments}
        composer={composer}
        mode={mode}
        activeId={activeId}
        textSize={snapshot?.settings.transcriptTextSize}
      />
      <ExternalLinks onError={report}>
        <ArtifactMetadataProvider
          accountId={accountId}
          accountEmail={accountEmail}
          legacyOwner={legacyArtifactOwner}
          conversationIds={new Set(snapshot.conversations.map((c) => c.id))}
        >
          <ArtifactConversation.Provider value={activeId}>
            <ArtifactSelection.Provider value={artifact}>
              <ArtifactShareContext.Provider
                value={snapshot.artifactShares ?? []}
              >
                <ArtifactLibraryContext.Provider
                  value={snapshot.artifactLibrary}
                >
                  <ShortcutPlatform.Provider value={snapshot.platform}>
                    <Capabilities.Provider value={capabilities}>
                      <div
                        className={`app ${sidebar && !incognitoShown && !conversationWindow && !projectWindow ? "" : "sidebar-hidden"} ${sidebarView.animating ? "sidebar-animating" : ""}${sidebarView.narrow ? " sidebar-narrow" : ""} ${incognitoShown ? "incognito-app" : ""}${conversationWindow || projectWindow ? " conversation-window" : ""} mode-${mode === "code" ? "code" : "chat"} ${hostClasses(host, snapshot.platform)}${fullScreen && snapshot.platform === "darwin" ? " full-screen" : ""}`}
                        data-execution-mode={mode}
                        onClick={(event) => {
                          // Phone layout (95-web.css): the sheet closes after a
                          // row is chosen.
                          if (
                            buildSurface !== "web" ||
                            !sidebar ||
                            !sidebarView.phone
                          )
                            return;
                          const target = event.target as Element;
                          if (
                            target === event.currentTarget ||
                            target.closest(
                              ".sidebar .conversation-link, .sidebar .main-nav a, .sidebar .main-nav > button",
                            )
                          )
                            sidebarView.toggle();
                        }}
                        style={
                          {
                            "--sidebar-width": `min(${sidebarWidth(host, snapshot.settings.sidebarWidth, sidebarWidthPreview)}px, max(200px, calc(100vw - 420px)))`,
                            // The web's peek is the stored width, however
                            // narrow the window (sidebar.css).
                            "--sidebar-peek-width": `${snapshot.settings.sidebarWidth}px`,
                          } as React.CSSProperties
                        }
                      >
                        {chrome.dragSurface && (
                          <div className="window-drag-surface" />
                        )}
                        {buildSurface === "web" && <WebMounts />}
                        {buildSurface !== "web" && !conversationWindow && (
                          <DesktopTitle />
                        )}
                        {!conversationWindow && !projectWindow && (
                          <AppSidebar />
                        )}
                        <AppPages />
                        <AppOverlays />
                        <Suspense fallback={null}>
                          <ShellMenuHost />
                        </Suspense>
                        {/* Last: Electron reads app regions in document order,
                           so a drag region later in the page (a conversation's
                           title bar) took the caption buttons' place on Windows
                           and they could not be clicked. */}
                        {chrome.controls && <WindowControls />}
                        {/* The top layer: buttons over the pages' drag
                            regions (the collapsed sidebar's ≡, toggle, back
                            and forward) portal here, after every page. */}
                        <div className="app-chrome-layer" />
                      </div>
                    </Capabilities.Provider>
                  </ShortcutPlatform.Provider>
                </ArtifactLibraryContext.Provider>
              </ArtifactShareContext.Provider>
            </ArtifactSelection.Provider>
          </ArtifactConversation.Provider>
        </ArtifactMetadataProvider>
      </ExternalLinks>
    </AppScope>
  );
}
