import { registerPrivacyDataHandlers } from "./privacy-data";
/**
 * Registers every IPC domain with the same AppContext. Each domain's file
 * (and its `shared/<domain>-api.ts` bridge list) belongs to one package
 * (docs/ui-workpackages.md); a package adds calls in its own file and never
 * edits this one or `electron/main.ts`. Sign-in calls are registered by main
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
import { registerProductFeedbackHandlers } from "./product-feedback";
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
import { registerZecousMigrationHandlers } from "./zecous-migration";
import { registerAccountProfileHandlers } from "./account-profile";
import { registerUsageStatsHandlers } from "./usage-stats";
import { registerServiceStatusHandlers } from "./service-status";
import { loadKnowledgeCatalog, registerKnowledgeHandlers } from "./knowledge";
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
import { registerOfficialGitHandlers } from "./official-git";
import { registerCodePullRequestHandlers } from "./code-pull-requests";
import { registerOfficialFileHandlers } from "./official-files";
import { registerOfficialAttachmentHandlers } from "./official-attachments";
import { registerOfficialSessionFolder } from './official-session-folder';

export function registerIpc(
  handle: IpcHandle,
  ctx: AppContext,
  options?: {
    mcpLogs?: Parameters<typeof registerMcpSettingsHandlers>[2];
    prepareExtensionUpgrade?: Parameters<typeof registerSettingsDesktopHandlers>[2];
    publishExtensionServers?: Parameters<typeof registerSettingsDesktopHandlers>[3];
    prepareExtensionMaintenance?: Parameters<typeof registerSettingsDesktopHandlers>[4];
    dispatchOfficialLayout?: Parameters<typeof registerWindowsHandlers>[3];
  },
) {
  registerOfficialFileHandlers(handle, ctx);
  registerOfficialAttachmentHandlers(handle, ctx);
  registerOfficialSessionFolder(handle,ctx);
  registerChatDevicesUnavailable(handle);
  registerDispatchHandlers(handle, ctx);
  registerCloudEnvironmentHandlers(handle, ctx);
  // Retire asynchronous imports even when the same account/store is reactivated.
  let conversationAccountGeneration = 0;
  ctx.onAccountActivated(() => { conversationAccountGeneration++; });
  ctx.onAccountDeactivating(() => { conversationAccountGeneration++; });
  registerCodePullRequestHandlers(handle, ctx, () => conversationAccountGeneration);
  // Conversations, projects and folders (C7, WP4b).
  registerConversationHandlers(handle, {
    accountGeneration: () => conversationAccountGeneration,
    knowledgeCatalog: () => loadKnowledgeCatalog(ctx),
    get accountActivationIdentity() { return ctx.accountActivationIdentity; },
    get accountRetiring() { return ctx.accountRetiring; },
    get activeAccount() { return ctx.activeAccount; },
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
    policy: () => ctx.policy(),
    allowedFolder: (folder) => ctx.allowedFolder(folder),
    noActive: () => ctx.noActive(),
    closeTerminals: async (id) => {
      await ctx.terminals?.closeConversation(id);
    },
    push: (event) => ctx.push(event),
    get services() {
      return ctx.services;
    },
  });
  registerWorkspaceHandlers(handle, ctx);
  registerComposerHandlers(handle, ctx);
  registerCodeUsageHandlers(handle, ctx);
  // Transcript and agents (WP5a).
  registerWorkflowHandlers(handle, ctx);
  registerAgentHandlers(handle, ctx);
  // Tool panels (WP5b).
  registerTerminalHandlers(handle, () => ctx.terminals!, ctx);
  registerBackgroundTerminalHandlers(handle, ctx);
  registerSessionLoopHandlers(handle, ctx);
  registerTaskBacklogHandlers(handle, ctx);
  registerPanelHandlers(handle, ctx);
  registerOfficialGitHandlers(handle, ctx);
  // Artifacts (WP6).
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
  // Collection pages (WP7).
  registerCollectionHandlers(handle, ctx);
  // Window shell and links (WP1).
  registerExternalLinkHandlers(handle, ctx);
  // Settings pages (WP2, WP3).
  registerSettingsAccountHandlers(handle, ctx);
  registerPrivacyDataHandlers(handle, ctx);
  registerSettingsDesktopHandlers(handle, ctx, options?.prepareExtensionUpgrade, options?.publishExtensionServers, options?.prepareExtensionMaintenance);
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
  registerProductFeedbackHandlers(handle, ctx);
  registerEditCommandHandlers(handle, ctx);
  registerSupportBundleHandlers(handle, ctx);
  registerOfficeAddinHandlers(handle, ctx);
  // Round two (docs/ui-workpackages.md §9): hosted sharing (R1), separate
  // conversation windows (R2), memory (R3), Research and site icons (R4/R5),
  // SSH environments (R9), computer use (R10), Cowork folder access (R11).
  registerSharingHandlers(handle, ctx);
  registerWindowsHandlers(handle, ctx, undefined, options?.dispatchOfficialLayout);
  registerMemoryHandlers(handle, ctx);
  registerArtifactCompleteHandlers(handle, ctx);
  registerResearchHandlers(handle, ctx);
  registerFaviconHandlers(handle, ctx);
  registerSshHandlers(handle, ctx);
  registerComputerUseHandlers(handle, ctx);
  registerCoworkHandlers(handle, ctx);
  // Code's workspace trust, recorded in Codex's own config.
  registerWorkspaceTrustHandlers(handle, ctx);
  // Claudex's own updates and the ZecousAI sign-in hint (package OTA).
  registerAppUpdateHandlers(handle, ctx);
  registerGitHubHandlers(handle, ctx);
  registerLinearHandlers(handle, ctx);
  registerApiKeyHandlers(handle, ctx);
  registerAnnouncementHandlers(handle, ctx);
  registerOnboardingHandlers(handle, ctx);
  registerZecousMigrationHandlers(handle, ctx);
  registerAccountProfileHandlers(handle, ctx);
  registerCloudSyncHandlers(handle, ctx);
  // Continue a local Code session in the cloud.
  registerCloudContinueHandlers(handle, ctx);
  registerUsageStatsHandlers(handle, ctx);
  registerServiceStatusHandlers(handle, ctx);
  registerKnowledgeHandlers(handle, ctx);
  // Mobile simulators in Code: the panes and Claude's device tools.
  registerSimulatorHandlers(handle, ctx);
}
