import { registerPrivacyDataHandlers } from "./privacy-data";
/**
 * Registers every IPC domain with the same AppContext. Each domain has its
 * own file here and its bridge list in `shared/<domain>-api.ts`; a new call
 * goes in its domain's file. Sign-in calls are registered by main
 * (local accounts) or `remote/host.ts` (Sub2API accounts).
 */
import type { AppContext, IpcHandle } from "../app/app-context";
import { registerDispatchHandlers } from "./dispatch";
import { registerChatDevicesUnavailable } from "./chat-devices";
import { registerExternalLinkHandlers } from "../app/external-links";
import { registerEditCommandHandlers } from "../app/edit-commands";
import { registerSupportBundleHandlers } from "../support/support-bundle";
import { registerOfficeAddinHandlers } from "./office-addin";
import { GeneratedBlobs } from "../artifacts/generated-blobs";
import { registerAgentHandlers } from "./agent";
import { registerArtifactLibraryHandlers } from "./artifact-library";
import { registerArtifactHandlers } from "./artifacts";
import { registerBackgroundTerminalHandlers } from "./background-terminals";
import { registerBillingHandlers } from "./billing";
import { registerCodeUsageHandlers } from "./code-usage";
import { registerCollectionHandlers } from "./collections";
import { registerComposerHandlers } from "./composer";
import { registerConversationHandlers } from "./conversations";
import { registerDiagnosticsHandlers } from "./diagnostics";
import { registerModelCatalogHandlers } from "./model-catalog";
import { registerPanelHandlers } from "./panels";
import { registerPolicyHandlers } from "./policy";
import { registerSettingsAccountHandlers } from "./settings-account";
import { registerSettingsDesktopHandlers } from "./settings-desktop";
import { registerMcpSettingsHandlers } from "./settings-mcp";
import { registerCodeEmailHandlers } from "./code-email";
import { registerSpeechHandlers } from "./speech";
import { registerTerminalHandlers } from "./terminal";
import { registerTranscriptionHandlers } from "./transcription";
import { registerUsageHandlers } from "./usage";
import { registerWorkflowHandlers } from "./workflow";
import { registerWorkspaceHandlers } from "./workspace";
import { registerSharingHandlers } from "./sharing";
import { registerWindowsHandlers } from "./windows";
import { registerMemoryHandlers } from "./memory";
import { registerResearchHandlers } from "./research-handlers";
import { registerFaviconHandlers } from "./favicons";
import { registerSshHandlers } from "./ssh-handlers";
import { registerComputerUseHandlers } from "./computer-use";
import { registerCoworkHandlers } from "./cowork";
import { registerWorkspaceTrustHandlers } from "./workspace-trust";
import { registerAppUpdateHandlers } from "./app-update";
import { registerAnnouncementHandlers } from "./announcements";
import { registerOnboardingHandlers } from "./onboarding";
import { registerAccountProfileHandlers } from "./account-profile";
import { registerUsageStatsHandlers } from "./usage-stats";
import { registerServiceStatusHandlers } from "./service-status";
import { registerApiKeyHandlers } from "./api-keys";
import { registerGitHubHandlers } from "./github";
import { registerLinearHandlers } from "./linear";
import { registerArtifactCompleteHandlers } from "./artifacts";
import { registerCloudSyncHandlers } from "./cloud-sync";
import { registerCloudEnvironmentHandlers } from "./cloud-environments";
import { registerCloudContinueHandlers } from "./cloud-continue";
import { registerSimulatorHandlers } from "./simulators";
import { registerSessionLoopHandlers } from "./session-loops";
import { registerTaskBacklogHandlers } from "./task-backlog";

export function registerIpc(
  handle: IpcHandle,
  ctx: AppContext,
  options?: { mcpLogs?: Parameters<typeof registerMcpSettingsHandlers>[2] },
) {
  registerChatDevicesUnavailable(handle);
  registerDispatchHandlers(handle, ctx);
  registerCloudEnvironmentHandlers(handle, ctx);
  // Conversations, projects and folders.
  registerConversationHandlers(handle, {
    get scheduler() {
      return ctx.scheduler;
    },
    get store() {
      return ctx.store;
    },
    get engine() {
      return ctx.engine;
    },
    get replyFeedback() {
      return ctx.replyFeedback;
    },
    selectedAttachments: ctx.selectedAttachments,
    allowedFolder: (folder) => ctx.allowedFolder(folder),
    noActive: () => ctx.noActive(),
    closeTerminals: async (id) => {
      await ctx.terminals?.closeConversation(id);
    },
    push: (event) => ctx.push(event),
    cliConfigDir: () =>
      ctx.spaceSandbox ? `${ctx.store.root}/claude-config` : undefined,
    get services() {
      return ctx.services;
    },
  });
  registerWorkspaceHandlers(handle, ctx);
  registerComposerHandlers(handle, ctx);
  registerCodeUsageHandlers(handle, ctx);
  // Transcript and agents.
  registerWorkflowHandlers(handle, ctx);
  registerAgentHandlers(handle, ctx);
  // Tool panels.
  registerTerminalHandlers(handle, () => ctx.terminals!);
  registerBackgroundTerminalHandlers(handle, ctx);
  registerSessionLoopHandlers(handle, ctx);
  registerTaskBacklogHandlers(handle, ctx);
  registerPanelHandlers(handle, ctx);
  // Artifacts.
  registerArtifactHandlers(handle, {
    get root() {
      return ctx.store.root;
    },
    get window() {
      return ctx.window;
    },
    push: (event) => ctx.push(event),
    previews: ctx.artifactPreviews,
    get shares() {
      return ctx.artifactShares;
    },
    popouts: ctx.artifactPopouts,
    get blobs() {
      return new GeneratedBlobs(ctx.store.root);
    },
    conversationFolders: (id) => {
      const c = ctx.store.conversations.find((item) => item.id === id);
      return c?.cwd ? [c.cwd] : [];
    },
  });
  registerArtifactLibraryHandlers(
    handle,
    () => ctx.artifactLibrary,
    (identity) => {
      ctx.artifactShares.remove(identity);
      ctx.push({ type: "artifact-shares", shares: ctx.artifactShares.list() });
    },
    ctx,
  );
  // Collection pages.
  registerCollectionHandlers(handle, ctx);
  // Window shell and links.
  registerExternalLinkHandlers(handle, ctx);
  // Settings pages.
  registerSettingsAccountHandlers(handle, ctx);
  registerPrivacyDataHandlers(handle, ctx);
  registerSettingsDesktopHandlers(handle, ctx);
  registerMcpSettingsHandlers(handle, ctx, options?.mcpLogs);
  registerCodeEmailHandlers(handle, ctx);
  // Service data (C2, C4, C5, C6, C7).
  registerPolicyHandlers(handle, ctx);
  registerModelCatalogHandlers(handle, ctx);
  registerUsageHandlers(handle, ctx);
  registerBillingHandlers(handle, ctx);
  registerTranscriptionHandlers(handle, {
    get store() {
      return ctx.store;
    },
    get profileRoot() {
      return ctx.store.root;
    },
    get vaultRoot() {
      return ctx.dataRoot;
    },
    get vaultKey() {
      return ctx.credentials.vaultKey;
    },
    serviceScript: ctx.providerServiceScript,
    limits: () => ctx.requestLimits(),
    voiceAllowed: () => ctx.policy().voice,
  });
  registerSpeechHandlers(handle, ctx);
  registerDiagnosticsHandlers(handle, ctx);
  registerEditCommandHandlers(handle, ctx);
  registerSupportBundleHandlers(handle, ctx);
  registerOfficeAddinHandlers(handle, ctx);
  // Hosted sharing (R1), separate
  // conversation windows (R2), memory (R3), Research and site icons (R4/R5),
  // SSH environments (R9), computer use (R10), Cowork folder access (R11).
  registerSharingHandlers(handle, ctx);
  registerWindowsHandlers(handle, ctx);
  registerMemoryHandlers(handle, ctx);
  registerArtifactCompleteHandlers(handle, ctx);
  registerResearchHandlers(handle, ctx);
  registerFaviconHandlers(handle, ctx);
  registerSshHandlers(handle, ctx);
  registerComputerUseHandlers(handle, ctx);
  registerCoworkHandlers(handle, ctx);
  // Code's workspace trust, recorded in Codex's own config.
  registerWorkspaceTrustHandlers(handle, ctx);
  // Claudex's own updates.
  registerAppUpdateHandlers(handle, ctx);
  registerGitHubHandlers(handle, ctx);
  registerLinearHandlers(handle, ctx);
  registerApiKeyHandlers(handle, ctx);
  registerAnnouncementHandlers(handle, ctx);
  registerOnboardingHandlers(handle, ctx);
  registerAccountProfileHandlers(handle, ctx);
  registerCloudSyncHandlers(handle, ctx);
  // Continue a local Code session in the cloud.
  registerCloudContinueHandlers(handle, ctx);
  registerUsageStatsHandlers(handle, ctx);
  registerServiceStatusHandlers(handle, ctx);
  // Mobile simulators in Code: the panes and Claude's device tools.
  registerSimulatorHandlers(handle, ctx);
}
