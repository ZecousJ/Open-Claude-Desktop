import { privacyDataMethods } from "./privacy-data-api";
import { extensionLifecycleMethods } from "./desktop-extensions-api";
/**
 * Every call the preload bridge exposes as `window.desktop`: the core calls
 * and each domain's `shared/<domain>-api.ts` list. A domain adds a call to
 * its own interface and list; this file changes only for a new domain.
 */
import type { CoreDesktopAPI } from "./types";
import { isStorageFullError, storageFullMessage } from "./turn-errors";
import { bridgeMethods } from "./bridge-methods";
import { settingsAccountMethods } from "./settings-api";
import { settingsDesktopMethods } from "./settings-desktop-api";
import { policyMethods } from "./policy-api";
import { usageMethods } from "./usage-api";
import { billingMethods } from "./billing-api";
import { modelCatalogMethods } from "./model-catalog-api";
import { voiceMethods } from "./voice-api";
import { diagnosticsMethods } from "./diagnostics-api";
import { codeUsageMethods } from "./code-usage-api";
import { composerMethods } from "./composer-api";
import { agentMethods } from "./agent-api";
import { panelsMethods } from "./panels-api";
import { artifactsMethods } from "./artifacts-api";
import { collectionsMethods } from "./collections-api";
import { externalLinksMethods } from "./external-links-api";
import { editCommandsMethods } from "./edit-commands-api";
import { supportBundleMethods } from "./support-bundle-api";
import { officeAddinMethods } from "./office-addin-api";
import { sharingMethods } from "./sharing-api";
import { windowsMethods } from "./windows-api";
import { memoryMethods } from "./memory-api";
import { researchMethods } from "./research-api";
import { faviconMethods } from "./favicon-api";
import { sshMethods } from "./ssh-api";
import { computerUseMethods } from "./computer-use-api";
import { coworkMethods } from "./cowork-api";
import { deviceTrustBridgeMethods } from "./remote-devices";
import { workspaceTrustMethods } from "./workspace-trust-api";
import { appUpdateMethods } from "./app-update-api";
import { signInMethods } from "./sign-in-api";
import { apiKeysMethods } from "./api-keys-api";
import { announcementsMethods } from "./announcements-api";
import { onboardingMethods } from "./onboarding-api";
import { cloudSyncMethods } from "./cloud-sync-api";
import { chatDevicesMethods } from "./chat-devices-api";
import { cloudEnvironmentsMethods } from "./cloud-environments-api";
import { cloudContinueMethods } from "./cloud-continue-api";
import { usageStatsMethods } from "./usage-stats-api";
import { serviceStatusMethods } from "./service-status-api";
import { githubMethods } from "./github-api";
import { linearMethods } from "./linear-api";
import { simulatorsMethods } from "./simulators-api";
import { accountProfileMethods } from "./account-profile-api";
import { dispatchMethods } from "./dispatch-api";
import { codeEmailMethods } from "./code-email-api";

export const coreMethods = bridgeMethods<Omit<CoreDesktopAPI, "onEvent">>({
  listResumableSessions: true,
  probeImportableCliSessions: true,
  importAllCliSessions: true,
  previewResumeSession: true,
  resumeSession: true,
  authStatus: true,
  registerAccount: true,
  loginAccount: true,
  logoutAccount: true,
  completeTwoFactor: true,
  cancelTwoFactor: true,
  sendVerificationCode: true,
  revokeAllSessions: true,
  snapshot: true,
  conversationTurns: true,
  searchConversations: true,
  copyText: true,
  copyImage: true,
  saveSettings: true,
  send: true,
  interrupt: true,
  releaseRunner: true,
  retryResponse: true,
  discardTurn: true,
  editPrompt: true,
  selectPromptVersion: true,
  selectReplyVersion: true,
  updateConversation: true,
  setConversationWebSearch: true,
  reorderConversations: true,
  deleteConversation: true,
  discardIncognito: true,
  revealConversationFolder: true,
  revealConversationFile: true,
  listProjectFolder: true,
  readProjectFile: true,
  writeProjectFile: true,
  searchProjectFiles: true,
  installedEditors: true,
  openConversationInEditor: true,
  saveProject: true,
  readProject: true,
  projectCreationCapabilities: true,
  deleteProject: true,
  chooseFolder: true,
  chooseFolders: true,
  chooseAttachments: true,
  approve: true,
  exportConversation: true,
  revealConversationExport: true,
  restartEngine: true,
  windowAction: true,
});

/** Each domain's calls. */
export const domainMethods = {
  "privacy-data": privacyDataMethods,
  "desktop-extensions": extensionLifecycleMethods,
  "device-trust": deviceTrustBridgeMethods,
  dispatch: dispatchMethods,
  linear: linearMethods,
  "settings-account": settingsAccountMethods,
  "settings-desktop": settingsDesktopMethods,
  "code-email": codeEmailMethods,
  policy: policyMethods,
  usage: usageMethods,
  billing: billingMethods,
  "model-catalog": modelCatalogMethods,
  voice: voiceMethods,
  diagnostics: diagnosticsMethods,
  "edit-commands": editCommandsMethods,
  "support-bundle": supportBundleMethods,
  "office-addin": officeAddinMethods,
  "code-usage": codeUsageMethods,
  composer: composerMethods,
  agent: agentMethods,
  panels: panelsMethods,
  artifacts: artifactsMethods,
  collections: collectionsMethods,
  "external-links": externalLinksMethods,
  sharing: sharingMethods,
  windows: windowsMethods,
  memory: memoryMethods,
  research: researchMethods,
  favicons: faviconMethods,
  ssh: sshMethods,
  "computer-use": computerUseMethods,
  cowork: coworkMethods,
  // Code's "Trust this workspace?" and Codex's trusted projects.
  "workspace-trust": workspaceTrustMethods,
  // Claudex's own updates.
  "app-update": appUpdateMethods,
  // The sign-in page's other ways in.
  "sign-in": signInMethods,
  // The GitHub connection of Code on the web (package W-GITHUB).
  github: githubMethods,
  // The API page: the service group in use and the account's API keys.
  "api-keys": apiKeysMethods,
  // Pop-up announcements from the administrator.
  announcements: announcementsMethods,
  // The first-run onboarding after sign-up.
  onboarding: onboardingMethods,
  // The account's activity: totals, providers, trend, models, requests.
  "usage-stats": usageStatsMethods,
  "service-status": serviceStatusMethods,
  // Moving the desktop's conversations to the cloud (docs/cloud-sync.md P5).
  "cloud-sync": cloudSyncMethods,
  "chat-devices": chatDevicesMethods,
  "cloud-environments": cloudEnvironmentsMethods,
  // Continuing a local Code session in the cloud (shared/cloud-continue-api.ts).
  "cloud-continue": cloudContinueMethods,
  // Mobile simulators in Code: the iOS Simulator and Android Emulator panes.
  simulators: simulatorsMethods,
  // The account step after sign-up: name, birthday, terms.
  "account-profile": accountProfileMethods,
} satisfies Record<string, string[]>;

export const desktopMethods: string[] = [
  ...coreMethods,
  ...Object.values(domainMethods).flat(),
];

/**
 * The main process's own message for a failed bridge call. Electron wraps
 * it as "Error invoking remote method 'app:…': Error: …", which the window
 * would otherwise show as is.
 */
export function bridgeErrorMessage(error: unknown) {
  if (isStorageFullError(error)) return storageFullMessage;
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/,
    "",
  );
}
