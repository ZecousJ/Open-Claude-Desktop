import { useAppDraft } from "../composer/draft-text";
import type { ComposerField } from "../composer/composer-field";
import { api } from "../desktop-api";
import { exportConversation } from "../conversation/conversation-export";
import { Suspense, useEffect, type RefObject } from "react";
import {
  researchUnavailable,
  researchUnavailableMessages,
  researchConnectorEnabled,
} from "../../shared/research";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { modelProtocol } from "../../shared/provider-routes";
import type { Mode } from "../../shared/types";
import { codeSessionSettings } from "../../shared/code-session-permissions";
import { Composer } from "../composer/Composer";
import { ComposerDock } from "../approval/ComposerDock";
import { recentFolders } from "../composer/recentFolders";
import { QueuedBarSlot } from "../composer/QueuedBarSlot";
import { ChatQueuedSlot } from "../composer/ChatQueuedSlot";
import { useModelCatalog } from "../composer/useComposerServices";
import { FolderAccessHost } from "../cowork/FolderAccessDialog";
import "../cowork/folder-access.css";
import { requestFolderAccess } from "../cowork/useFolderAccess";
import { WorkspaceTrustHost } from "../workspace-trust/WorkspaceTrustHost";
import {
  setDraftResearch,
  useResearchDraft,
} from "../research/useResearchDraft";
import { toggleResearch } from "../research/toggle-research";
import { useApp, type AppController } from "./AppContext";
import {
  createMoveProject,
  moveProjectChats,
} from "../collections/projects/project-move";
import { runShell, sendDraft, sendText } from "./composer-send";
import { trackStopping } from "../transcript/turn-stopping";
import { forkConversation } from "./fork";
import { handOffConversation } from "./handOff";
import { useOpenLink } from "../ui/ExternalLinks";
import { rewindConversation } from "./rewind";
import { maxAttachmentsFor } from "../composer/attachment-limits";
import { sideChatAvailability } from "../side-chat/side-chat-model";
import { askSideChatNow } from "../side-chat/side-chat-store";
import { lazyPiece } from "../ui/lazy-piece";
import { postUsageReport } from "../usage-report/usage-report-store";
import {
  folderSelectionStillCurrent,
  markExplicitFolderSelection,
} from "../composer/explicit-folder-selection";
import {
  invalidateNativeDefaultPlace,
  nativePlaceGeneration,
} from "../composer/native-default-place";

/** The branch row loads with the first Code session (its styles come with it). */
const PullRequestBar = lazyPiece(() => import("../pr/PullRequestBar"));

/** The composer of the open conversation or of a new chat, with its approval dock. */
export function ComposerHost({
  projectOverview = false,
}: {
  projectOverview?: boolean;
}) {
  const app = useApp();
  const draftText = useAppDraft(app);
  const {
    snapshot,
    active,
    activeId,
    running,
    sending,
    report,
    openSettingsTab,
  } = app;
  const catalog = useModelCatalog();
  const draftResearch = useResearchDraft();
  // Research (R4): a new Chat's switch lives in the draft store, an open
  // conversation's on the conversation.
  const research =
    (active ? active.mode : app.mode) === "chat" &&
    (active ? Boolean(active.research) : draftResearch);
  const researchReason = researchBlocked(app, catalog);
  const searchIntegrationEnabled = researchConnectorEnabled(
    snapshot.settings,
    app.policy,
    active?.connectorOverrides ?? app.composerDraft.draftConnectors,
  );
  const openLink = useOpenLink();
  const effort = app.effort ?? active?.effort ?? app.project?.defaultEffort;
  const sessionPermissions =
    snapshot.host?.capabilities?.codeSessionPermissions === true &&
    !(active?.scheduledRun && active.scheduledPermission !== undefined);
  const scopedSettings = codeSessionSettings(
    snapshot.settings,
    sessionPermissions
      ? active?.mode === "code"
        ? active.codePermissionMode
        : app.mode === "code"
          ? app.composerDraft?.draftCodePermissionMode
          : undefined
      : undefined,
  );
  const updatePermissions = async (
    patch: Partial<typeof snapshot.settings>,
  ) => {
    if (sessionPermissions && app.mode === "code") {
      const { setSessionCodePermission } =
        await import("./code-permission-state");
      const saved = await setSessionCodePermission(
        app,
        { ...scopedSettings, ...patch },
        active,
      );
      if (!saved)
        throw Object.assign(new Error("Canceled permission change"), {
          name: "CodePermissionCanceled",
        });
    } else await app.updatePreference(patch);
  };
  return (
    <>
      <Composer
        incognito={app.incognitoShown}
        settings={
          effort
            ? {
                ...scopedSettings,
                effort: effort === "ultra" ? "max" : effort,
                codeEffort: effort,
              }
            : scopedSettings
        }
        platform={snapshot.platform as NodeJS.Platform}
        active={active}
        activeId={activeId}
        project={app.project}
        projectOverview={projectOverview}
        projects={snapshot.projects}
        onCodePermissionChange={
          sessionPermissions ? updatePermissions : undefined
        }
        onProject={(id) =>
          void (
            id ? app.addConversationToProject(id) : app.moveToProject(null)
          ).catch(report)
        }
        onCreateProject={(name) =>
          name
            ? void createNamedProject(app, name).catch(report)
            : app.startProject()
        }
        onNewProject={(name) => app.startProject(undefined, name)}
        openSettingsTab={openSettingsTab}
        onNavigate={app.setPage}
        onCompact={() => void compact(app)}
        onFork={(prompt) =>
          void forkConversation(app, prompt ? { prompt } : {})
        }
        onHandOff={() => void handOffConversation(app)}
        onRewind={() => void rewindConversation(app)}
        onSideChat={(question) => {
          const { available, reason } = sideChatAvailability(
            active,
            active?.mode ?? app.mode,
          );
          if (active && available) void askSideChatNow(active.id, question);
          else if (reason) app.notify(reason);
        }}
        onReview={(args) =>
          void import("../review/start-review")
            .then((module) => module.startSessionReview(app, args))
            .catch(report)
        }
        onOpenTasks={active ? () => app.setPanel("background") : undefined}
        onOpenUsage={() => {
          // In a Code session /usage posts the usage report in its
          // transcript, as the live app's does (src/usage-report).
          if (active?.mode === "code") return void postUsageReport(active);
          if (app.remoteAccount) return openSettingsTab("usage");
          app.setActiveId(undefined);
          app.setPage("chat");
        }}
        onRenameSession={(title) => {
          if (!active) return;
          const name = title.trim();
          if (name) void app.patchConversation(active, { title: name });
          else app.setRename({ id: active.id, title: active.title });
        }}
        onGoal={(goal) => {
          if (!active) return;
          const condition = goal.trim();
          if (!condition) {
            void app.patchConversation(active, { goal: null });
            return;
          }
          void app.patchConversation(active, {
            goal: {
              condition,
              setAt: Date.now(),
              iterations: active.goal?.iterations ?? 0,
              ...(active.goal?.lastReason
                ? { lastReason: active.goal.lastReason }
                : {}),
            },
          });
        }}
        onExportSession={() =>
          active && void exportConversation(active, report)
        }
        onToggleDiff={() => app.toolPanels.toggle("changes")}
        onHelp={
          app.policy.links?.help
            ? () => void api.openExternal(app.policy.links!.help!).catch(report)
            : undefined
        }
        firstRun={
          !app.snapshot.conversations.some(
            (conversation) => conversation.mode === "code",
          )
        }
        onStatus={
          active?.mode === "code"
            ? () => void postUsageReport(active, Date.now(), "status")
            : undefined
        }
        webSearch={active ? Boolean(active.webSearch) : app.draftWebSearch}
        webSearchAvailable={
          !running &&
          !sending &&
          (Boolean(active?.webSearch) ||
            app.draftWebSearch ||
            currentProtocol(app) === "responses")
        }
        onWebSearch={() => void toggleWebSearch(app).catch(report)}
        research={research}
        researchAvailable={
          !running && !sending && (research || !researchReason)
        }
        researchUnavailableReason={
          running || sending
            ? "Research can be changed once Claudex finishes."
            : researchReason
        }
        onResearch={() =>
          void toggleResearch(
            app,
            research,
            researchReason,
            !searchIntegrationEnabled,
          ).catch(report)
        }
        draftIdentity={`${activeId ?? app.draftSession}:${app.mode}`}
        artifact={app.artifact}
        narrow={Boolean(app.artifact || app.panel)}
        mode={app.mode}
        setMode={app.setMode}
        providerId={app.providerId}
        setProviderId={app.setProviderId}
        model={app.model}
        setModel={app.setModel}
        text={draftText.text}
        setText={app.setText}
        skillTokens={draftText.skillTokens}
        setSkillTokens={app.setSkillTokens}
        attachments={app.attachments}
        setAttachments={app.setAttachments}
        cwd={app.cwd}
        setCwd={app.setCwd}
        recentFolders={recentFolders(app.listed)}
        running={running}
        sending={sending}
        composer={app.composer}
        pickFiles={() => pickFiles(app)}
        pickFolder={() => pickFolder(app)}
        updatePreference={async (patch) => {
          if (
            (app.project || active?.effort) &&
            (patch.effort || patch.codeEffort)
          ) {
            app.setEffort(patch.effort ?? patch.codeEffort);
            return;
          }
          await app.updatePreference(patch);
        }}
        send={(options) => sendDraft(app, options)}
        onShell={(command) => runShell(app, command)}
        interrupt={() => trackStopping(active, api.interrupt(activeId!))}
        report={report}
        notify={app.notify}
        setSettingsOpen={app.setSettingsOpen}
        queuedBar={
          active?.mode === "code" ? (
            <QueuedBarSlot conversation={active} />
          ) : active ? (
            <ChatQueuedSlot conversation={active} />
          ) : undefined
        }
        branchRow={
          active?.mode === "code" && !active.incognito ? (
            <Suspense fallback={null}>
              <PullRequestBar
                conversation={active}
                send={(text) => sendText(app, text)}
                openLink={openLink}
              />
            </Suspense>
          ) : undefined
        }
        dock={
          active && (
            <ComposerDock
              conversation={active}
              approvals={snapshot.approvals}
              settings={scopedSettings}
              platform={snapshot.platform}
              updatePreference={updatePermissions}
              canSend={() =>
                !app.currentController ||
                (app.currentController.current?.accountId === app.accountId &&
                  app.currentController.current.controllerScope ===
                    app.controllerScope &&
                  app.currentController.current.activeId === active.id)
              }
              onSent={(conversation) => {
                app.follow.current = true;
                app.upsert(conversation);
              }}
              onFocusComposer={() => app.composer.current?.focus()}
              onError={report}
            />
          )
        }
      />
      {/* Cowork asks here before it uses a folder (R11). */}
      <FolderAccessHost platform={snapshot.platform} />
      {/* Code asks here before its first session in a folder. */}
      <WorkspaceTrustHost />
    </>
  );
}

/**
 * Grows the composer with its text: Code up to 380 px, Chat and Cowork up to
 * 370 px, which makes the whole box 434 px.
 */
export function useComposerAutosize(
  composer: RefObject<ComposerField | null>,
  text: string,
  mode: Mode,
  activeId: string | undefined,
  /** Settings → Transcript text size: a new size re-measures the box. */
  textSize?: string,
) {
  useEffect(() => {
    if (composer.current) fitComposer(composer.current, mode);
  }, [text, mode, activeId, textSize]);
  // Code's box also follows its width: a narrower window or sidebar wraps the
  // text onto more lines, which the draft's own autosize (above) does not see.
  // Chat's conversation box has its own observer (useComposerMorph.ts).
  useEffect(() => {
    const field = composer.current;
    if (
      mode !== "code" ||
      !field ||
      field.resizeToContent ||
      typeof ResizeObserver === "undefined"
    )
      return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (!field.isConnected) {
        observer.disconnect();
        return;
      }
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fitComposer(field, mode);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [mode, activeId]);
}

function fitComposer(field: ComposerField, mode: Mode) {
  if (field.resizeToContent) {
    field.resizeToContent();
    return;
  }
  // Measured at height 0, not "auto": a flex item at "auto" stretches to its
  // row, so a row held tall by a sibling read back as a 380px text area.
  field.style.height = "0px";
  const height = Math.min(field.scrollHeight, mode === "code" ? 380 : 370);
  field.style.height = height + "px";
  // The Chat/Cowork home moves its block up as the box grows.
  field
    .closest<HTMLElement>(".chat-home")
    ?.style.setProperty("--composer-grow", `${Math.max(0, height - 22)}px`);
}

/** /compact: Codex summarizes the open conversation into a shorter context. */
async function compact(app: AppController) {
  const { active } = app;
  if (!active) return;
  if (app.running) {
    app.notify("Wait for Claudex to finish before compacting.");
    return;
  }
  try {
    app.follow.current = true;
    app.upsert(await api.compactConversation(active.id));
  } catch (e) {
    app.report(e);
  }
}

function currentProvider(app: AppController) {
  return app.snapshot.settings.providers.find((p) => p.id === app.providerId);
}

/** The protocol of the selected model (its service group's, MG). */
function currentProtocol(app: AppController) {
  const provider = currentProvider(app);
  return provider && modelProtocol(provider, app.model);
}

async function toggleWebSearch(app: AppController) {
  const { active } = app;
  if (active?.webSearch) {
    app.upsert(await api.setConversationWebSearch(active.id, false));
    return;
  }
  if (!active && app.draftWebSearch) {
    app.setDraftWebSearch(false);
    if (
      !researchConnectorEnabled(
        app.snapshot.settings,
        app.policy,
        app.composerDraft.draftConnectors,
      )
    )
      setDraftResearch(false);
    return;
  }
  if (currentProtocol(app) !== "responses") {
    app.notify("Web search requires a Responses-compatible model service.");
    return;
  }
  if (active)
    app.upsert(
      await api.setConversationWebSearch(
        active.id,
        true,
        app.providerId,
        app.model,
      ),
    );
  else app.setDraftWebSearch(true);
}

/** Why Research can't be turned on here, or undefined when it can. */
function researchBlocked(app: AppController, catalog: ModelCatalog | null) {
  const { active } = app;
  const providerId = active?.providerId ?? app.providerId;
  const model = active?.model ?? app.model;
  const reason = researchUnavailable({
    policy: app.policy,
    mode: active?.mode ?? app.mode,
    incognito: active ? active.incognito : app.incognitoShown,
    provider: app.snapshot.settings.providers.find((p) => p.id === providerId),
    model,
    catalogItem: catalog?.items.find((item) => item.id === model),
    searchIntegrationEnabled: researchConnectorEnabled(
      app.snapshot.settings,
      app.policy,
      active?.connectorOverrides ?? app.composerDraft.draftConnectors,
    ),
  });
  // Model compatibility still gates Research in the official app.
  if (reason === "service")
    return "Enable a search integration to use research";
  if (reason === "model") return "Select a different model to use this feature";
  return reason && researchUnavailableMessages[reason];
}

/**
 * "Create project <name>" in the Add to project menu: a project with that name
 * and no description, chosen for the composer at once.
 */
async function createNamedProject(app: AppController, name: string) {
  const saved = await createMoveProject(app, name);
  if (app.active) await moveProjectChats(app, [app.active], saved);
  app.setProjectId(saved.id);
}

async function pickFiles(app: AppController) {
  try {
    app.setAttachments((v) => v);
    const files = await api.chooseAttachments();
    app.setAttachments((v) =>
      [...v, ...files].slice(0, maxAttachmentsFor(app.mode)),
    );
  } catch (e) {
    app.report(e);
  }
}

async function pickFolder(app: AppController) {
  const generation = invalidateNativeDefaultPlace(app);
  const current = () =>
    folderSelectionStillCurrent(app) &&
    nativePlaceGeneration(app) === generation;
  try {
    const folder = await api.chooseFolder();
    if (!folder || !current()) return;
    // Cowork asks before it uses a folder; Cancel keeps the previous one.
    if (
      app.mode !== "code" &&
      (await requestFolderAccess(folder, { notify: app.notify })) !== "granted"
    )
      return;
    if (!current()) return;
    if (app.mode !== "code") markExplicitFolderSelection(app);
    app.setCwd(folder);
  } catch (e) {
    if (current()) app.report(e);
  }
}
