/**
 * Where each `window.desktop` call runs in the web version (web plan §2 #22,
 * W-ARCH §2). Four kinds:
 *
 * - "remote-runner": the browser posts it to Go (`rpc/<method>`), Go relays it
 *   over the runner link to the user's claudex-runner, which runs the same IPC
 *   handler as the desktop app. Only these names are registered on a runner.
 * - "remote-go": served by Go itself (web sign-in session, see
 *   `webGoMethodRoutes` in shared/web-protocol.ts); never reaches a runner.
 * - "browser": the web bridge implements it in the page (clipboard, file
 *   picker, downloads, dictation socket), possibly with the help of other
 *   remote calls or Go endpoints named in `webMethodNotes`.
 * - "absent": does not exist on the web (local folders, terminals, windows,
 *   SSH, computer use…). The bridge throws `notAvailableOnWeb` and the
 *   interface hides the entry that would call it.
 *
 * Core calls are listed one by one. Each domain has a default kind and
 * per-method overrides, so a round-two package that adds a call to an
 * existing domain does not need to edit this file: the call inherits its
 * domain's default and `tests/web-bridge-methods.test.ts` lists it for review
 * (and fails when an inherited remote call looks local). A new domain must
 * be added here, which the compiler enforces.
 */
import type { CoreDesktopAPI } from "./types";
import { coreMethods, domainMethods } from "./desktop-bridge";

export type WebMethodKind =
  "remote-runner" | "remote-go" | "browser" | "absent";

export const webMethodKinds: readonly WebMethodKind[] = [
  "remote-runner",
  "remote-go",
  "browser",
  "absent",
];

/** What the web bridge throws for an absent call (and the runner's shim). */
export const notAvailableOnWeb = "Not available on the web.";

type DomainName = keyof typeof domainMethods;
type DomainMethod<D extends DomainName> = (typeof domainMethods)[D][number];

interface DomainRule<D extends DomainName> {
  default: WebMethodKind;
  overrides?: { [M in DomainMethod<D>]?: WebMethodKind };
}

/** Every core call, by name; a new core call fails to compile until listed. */
export const webCoreMethodKinds: {
  [K in keyof Omit<CoreDesktopAPI, "onEvent">]-?: WebMethodKind;
} = {
  listResumableSessions: "remote-runner",
  probeImportableCliSessions: "remote-runner",
  importAllCliSessions: "remote-runner",
  previewResumeSession: "remote-runner",
  resumeSession: "remote-runner",
  // Web sign-in session (W-AUTH): Go endpoints under /api/v1/claudex/web/auth.
  authStatus: "remote-go",
  registerAccount: "remote-go",
  loginAccount: "remote-go",
  logoutAccount: "remote-go",
  completeTwoFactor: "remote-go",
  cancelTwoFactor: "remote-go",
  sendVerificationCode: "remote-go",
  revokeAllSessions: "remote-go",
  snapshot: "remote-runner",
  conversationTurns: "remote-runner",
  searchConversations: "remote-runner",
  copyText: "browser",
  copyImage: "browser",
  saveSettings: "remote-runner",
  send: "remote-runner",
  interrupt: "remote-runner",
  releaseRunner: "remote-runner",
  retryResponse: "remote-runner",
  discardTurn: "remote-runner",
  editPrompt: "remote-runner",
  selectPromptVersion: "remote-runner",
  selectReplyVersion: "remote-runner",
  updateConversation: "remote-runner",
  setConversationWebSearch: "remote-runner",
  reorderConversations: "remote-runner",
  deleteConversation: "remote-runner",
  discardIncognito: "remote-runner",
  revealConversationFolder: "absent",
  revealConversationFile: "absent",
  // The Files pane reads a cloud Code session's folder on the runner; it
  // saves nothing there (the live web's pane opens files read-only).
  listProjectFolder: "remote-runner",
  readProjectFile: "remote-runner",
  writeProjectFile: "absent",
  searchProjectFiles: "remote-runner",
  installedEditors: "absent",
  openConversationInEditor: "absent",
  saveProject: "remote-runner",
  readProject: "remote-runner",
  projectCreationCapabilities: "remote-runner",
  deleteProject: "remote-runner",
  chooseFolder: "absent",
  chooseFolders: "absent",
  chooseAttachments: "browser",
  approve: "remote-runner",
  exportConversation: "browser",
  revealConversationExport: "absent",
  restartEngine: "absent",
  windowAction: "browser",
};

/** Each domain's default and the calls that differ from it. */
export const webDomainRules: { [D in DomainName]-?: DomainRule<D> } = {
  "privacy-data": { default: "remote-runner" },
  "desktop-extensions": { default: "absent" },
  dispatch: { default: "remote-runner" },
  "settings-account": {
    default: "remote-runner",
    overrides: {
      exportData: "browser",
      // Importing reads files and folders on this computer.
      importSources: "absent",
      claudeAiImportSignIn: "absent",
      claudeAiImportFetch: "absent",
      claudeAiImportCancel: "absent",
      importAddSource: "absent",
      importRemoveSource: "absent",
      importRun: "absent",
      importHistory: "absent",
      importRemovePreview: "absent",
      importRemove: "absent",
    },
  },
  "code-email": {
    default: "remote-runner",
    overrides: { codeEmailStatus: "remote-runner" },
  },
  "settings-desktop": {
    default: "absent",
    overrides: {
      readMcpLogs: "remote-runner",
      discoverLocalMcp: "absent",
      importLocalMcp: "absent",
      mcpServers: "remote-runner",
      listMcp: "remote-runner",
      addCustomConnector: "remote-runner",
      removeConnector: "remote-runner",
      setConnectorTool: "remote-runner",
      setConnectorToolPermission: "remote-runner",
      forgetConnectorApprovals: "remote-runner",
      connectConnector: "remote-runner",
      completeConnectorLogin: "remote-runner",
      listSkills: "remote-runner",
      saveSkill: "remote-runner",
      setSkillEnabled: "remote-runner",
      deleteSkill: "remote-runner",
      duplicateSkill: "remote-runner",
      renameSkill: "remote-runner",
      installSkillFiles: "remote-runner",
      skillUploadCapabilities: "remote-runner",
      importSkillFiles: "remote-runner",
    },
  },
  policy: { default: "remote-runner" },
  usage: { default: "remote-runner" },
  billing: { default: "remote-runner" },
  "model-catalog": { default: "remote-runner" },
  voice: {
    default: "browser",
    overrides: { voiceAvailability: "remote-runner" },
  },
  diagnostics: { default: "remote-runner" },
  "edit-commands": { default: "absent" },
  "office-addin": { default: "absent" },
  "support-bundle": {
    default: "remote-runner",
    overrides: {
      captureFeedbackScreenshot: "absent",
      revealSupportBundle: "absent",
    },
  },
  "code-usage": {
    default: "remote-runner",
    overrides: {
      workspaceGit: "absent",
      folderBranches: "absent",
      folderChanges: "absent",
      switchFolderBranch: "absent",
      resolveFolderChanges: "absent",
      folderPullRequest: "absent",
    },
  },
  // Code restore writes this computer's files.
  composer: {
    default: "remote-runner",
    overrides: { restoreRewindCode: "absent" },
  },
  agent: { default: "remote-runner" },
  // Terminal, Browser and background terminals are this computer's; the
  // Changes panel reads the session's folder in the runner's sandbox.
  panels: {
    default: "absent",
    overrides: {
      getTaskBacklog: "remote-runner",
      dismissTaskBacklogItem: "remote-runner",
      backgroundTaskSuggestions: "remote-runner",
      popBackgroundTaskSuggestion: "remote-runner",
      popBackgroundTaskSuggestionById: "remote-runner",
      launchBackgroundTaskSuggestion: "remote-runner",
      listSessionLoops: "remote-runner",
      createSessionLoop: "remote-runner",
      stopSessionLoop: "remote-runner",
      workingTreeChanges: "remote-runner",
      gitBranches: "remote-runner",
      codeGitStatus: "remote-runner",
    },
  },
  artifacts: {
    default: "remote-runner",
    overrides: {
      popOutArtifact: "absent",
      chooseLocalFile: "absent",
      saveArtifact: "browser",
      saveArtifactBytes: "browser",
      saveMcpResourceFile: "browser",
      exportDocumentPdf: "browser",
      saveGeneratedFile: "browser",
    },
  },
  // Scheduled tasks run in the runner's own scheduler (routine-wakes.ts
  // wakes the user when one is due); groups, project knowledge and skills are
  // the user's own files on the runner.
  collections: {
    default: "absent",
    overrides: {
      customizeSkills: "remote-runner",
      customizeSearch: "remote-runner",
      listSchedules: "remote-runner",
      querySchedules: "remote-runner",
      readSchedule: "remote-runner",
      routineCapabilities: "remote-runner",
      routineBrowserPermissions: "remote-runner",
      clearRoutineBrowserPermissions: "remote-runner",
      routineWorkspace: "remote-runner",
      routineMigration: "absent",
      migrateRoutine: "absent",
      beginRoutineMigration: "absent",
      restoreRoutineMigration: "absent",
      importRoutineMigration: "remote-runner",
      deleteRoutineMigration: "remote-runner",
      saveSchedule: "remote-runner",
      deleteSchedule: "remote-runner",
      runSchedule: "remote-runner",
      routineApiToken: "remote-runner",
      routineRuns: "remote-runner",
      routineRunsPage: "remote-runner",
      routineSchedulePreview: "remote-runner",
      removeRoutineApproval: "remote-runner",
      markRoutineRunRead: "remote-runner",
      securityFindings: "remote-runner",
      triageSecurityFinding: "remote-runner",
      proposeScheduledTask: "remote-runner",
      listConversationGroups: "remote-runner",
      createConversationGroup: "remote-runner",
      moveConversationToGroup: "remote-runner",
      renameConversationGroup: "remote-runner",
      deleteConversationGroup: "remote-runner",
      listProjectKnowledge: "remote-runner",
      stageProjectKnowledgeFiles: "remote-runner",
      previewProjectKnowledgeEncoding: "remote-runner",
      confirmProjectKnowledgeEncoding: "remote-runner",
      removeProjectKnowledgePending: "remote-runner",
      readProjectKnowledge: "remote-runner",
      listProjectKnowledgeRepositories: "remote-runner",
      listProjectKnowledgeRepositoryFiles: "remote-runner",
      addProjectKnowledgeRepositoryFiles: "remote-runner",
      syncProjectKnowledge: "remote-runner",
      listProjectKnowledgeMcpServers: "remote-runner",
      listProjectKnowledgeMcpResources: "remote-runner",
      resolveProjectKnowledgeMcpUrl: "remote-runner",
      addProjectKnowledgeMcpResource: "remote-runner",
      listProjectKnowledgeDriveConnectors: "remote-runner",
      searchProjectKnowledgeDrive: "remote-runner",
      addProjectKnowledgeDriveFiles: "remote-runner",
      addProjectKnowledge: "browser",
      addProjectKnowledgeFiles: "remote-runner",
      addProjectKnowledgeText: "remote-runner",
      removeProjectKnowledge: "remote-runner",
      readSkill: "remote-runner",
      readSkillFile: "remote-runner",
      listDesignSystems: "remote-runner",
      saveDesignSystem: "remote-runner",
      deleteDesignSystem: "remote-runner",
      generateDesignSystem: "remote-runner",
      listPlugins: "remote-runner",
      uploadPlugin: "remote-runner",
      listDirectorySubmissions: "remote-runner",
      listApprovedDirectory: "remote-runner",
      saveDirectorySubmission: "remote-runner",
      deleteDirectorySubmission: "remote-runner",
      verifyDirectorySubmissionTools: "remote-runner",
      readPlugin: "remote-runner",
      installPlugin: "remote-runner",
      uninstallPlugin: "remote-runner",
      addPluginMarketplace: "remote-runner",
      removePluginMarketplace: "remote-runner",
      upgradePluginMarketplaces: "remote-runner",
      setPluginMarketplaceAutoSync: "remote-runner",
      // The copy goes to the personal marketplace in the home folder of the
      // computer running the agent; a runner's home is shared by its users.
      duplicatePlugin: "absent",
      // Rename moves files in that same personal marketplace.
      renamePlugin: "absent",
    },
  },
  "external-links": {
    default: "browser",
    overrides: {
      loadRemoteImage: "remote-runner",
      setRoutedLinkConfirmReady: "absent",
      resolveRoutedLinkConfirm: "absent",
    },
  },
  sharing: {
    default: "remote-runner",
    overrides: { openShare: "browser" },
  },
  windows: { default: "absent" },
  memory: { default: "remote-runner" },
  research: {
    default: "remote-runner",
    overrides: { saveResearchReport: "browser" },
  },
  favicons: { default: "remote-runner" },
  ssh: { default: "absent" },
  "computer-use": { default: "absent" },
  // Simulators and emulators run on the person's own computer.
  simulators: { default: "absent" },
  cowork: {
    default: "absent",
    overrides: {
      listCoworkDevices: "browser",
      coworkFolders: "remote-runner",
      listTaskFolderDirectory: "remote-runner",
      coworkFolderAccess: "remote-runner",
      grantCoworkFolder: "remote-runner",
      listCoworkFolder: "remote-runner",
      readCoworkFile: "remote-runner",
      readCoworkInstructions: "remote-runner",
      writeCoworkInstructions: "remote-runner",
      readCoworkResource: "remote-runner",
    },
  },
  // Settings → Account: each online computer's device access, read and
  // tightened through its verified relay (src-web/bridge/cowork-devices.ts).
  "device-trust": { default: "browser" },
  // The runner's sandboxes trust their own workspaces: no prompt on the web.
  "workspace-trust": { default: "absent" },
  // The web version is not installed: nothing to update or hand off.
  "app-update": { default: "absent" },
  // Password reset, email codes and passkeys: the web sign-in session (W-AUTH).
  "sign-in": {
    default: "remote-go",
    // Adding an account only marks this tab: the sign-in page shows while
    // the current account stays signed in.
    overrides: {
      addAccount: "browser",
      cancelAddAccount: "browser",
      accountPasskeys: "browser",
      setUpPasskey: "browser",
      cancelGoogleSignIn: "browser",
      // The web app is served by its service: there is no other to choose.
      setServiceAddress: "absent",
    },
  },
  // The GitHub connection: the page calls Go endpoints under
  // /api/v1/claudex/web/github (shared/web-client/github.ts).
  github: {
    default: "browser",
    overrides: {
      githubCliStatus: "absent",
      githubReview: "remote-runner",
      githubReviewThreads: "absent",
      githubReplyReviewThread: "absent",
      githubResolveReviewThread: "absent",
    },
  },
  linear: { default: "remote-runner" },
  // The API page: the keys are the service's own key endpoints, called from
  // the page with the session's token; the group in use is a setting the
  // user's runner reads when it lists models.
  // Pop-up announcements: the service's own endpoints, called from the page
  // with the session's token.
  announcements: { default: "browser" },
  // The first-run onboarding: the service's own endpoint, called from the
  // page with the session's token.
  onboarding: { default: "browser" },
  // The account's activity (Settings → Usage): the service's usage endpoints, called
  // from the page with the session's token.
  "usage-stats": { default: "browser" },
  // The Service status page: the service's status endpoint, called from the page.
  "service-status": { default: "browser" },
  // The account step after sign-up: the service's profile endpoint, called
  // from the page with the session's token.
  "account-profile": { default: "browser" },
  // Moving a desktop conversation to the cloud: the runner stores it.
  "cloud-sync": {
    default: "remote-runner",
    overrides: { linkCoworkTaskToComputer: "absent" },
  },
  "cloud-environments": { default: "remote-runner" },
  "chat-devices": { default: "remote-runner" },
  // Continue in cloud reads and pushes a folder on the person's computer.
  "cloud-continue": { default: "absent" },
  "api-keys": {
    default: "browser",
    overrides: {
      apiGroups: "remote-runner",
      setApiGroup: "remote-runner",
      setImageModel: "remote-runner",
    },
  },
};

/**
 * How the web bridge (or runner) serves the calls that are not a plain relay.
 * Keys are method names; the test checks that each names a real call.
 */
export const webMethodNotes: Record<string, string> = {
  authStatus:
    "Restores the tab's account from its own refresh cookie (POST auth/refresh {account}) and reports the account; signed out, also the accounts used in this browser.",
  browserAccounts:
    "The accounts remembered in this browser (localStorage) marked with the account cookies POST auth/accounts reports.",
  switchAccount:
    "POST auth/refresh {account} with the chosen account's cookie; the tab keeps that account across reloads (sessionStorage).",
  addAccount:
    "Marks the tab as adding an account (sessionStorage); the page then loads the sign-in page while the current account stays signed in.",
  cancelAddAccount: "Clears the tab's adding mark.",
  forgetBrowserAccount:
    "POST auth/logout {account} without a bearer (its cookie only), then forgets the account in this browser.",
  copyText:
    "navigator.clipboard.write with text/plain and text/html when rich text is given, else writeText.",
  copyImage:
    "navigator.clipboard.write with image/png, converting other image formats on a canvas.",
  chooseAttachments:
    "Hidden <input type=file multiple>; files are uploaded in 1 MiB chunks to uploads and returned as Attachment rows.",
  exportConversation:
    "Downloads a Code session's JSON transcript and metadata from the tab's snapshot; other conversations download Markdown (or the server export when not cached). Returns the file name.",
  windowAction: "No-op: a browser tab has no window buttons.",
  exportData: "Downloads the account export the server builds from webstore.",
  requestMicrophone: "navigator.mediaDevices.getUserMedia.",
  openMicrophoneSettings:
    "No-op: microphone permissions are managed by the browser's site settings.",
  startDictation:
    "Opens the dictation socket to Go with a one-time web ticket (W-VOICE).",
  dictationAudio: "Sends PCM over the dictation socket.",
  finishDictation: "Finishes the dictation socket.",
  cancelDictation: "Closes the dictation socket.",
  workingTreeChanges:
    "Runs git in the user's sandbox on the session's folder (runner/src/sandbox-git.ts), never on the runner host.",
  codeGitStatus: "As workingTreeChanges (read-only git in the sandbox).",
  listProjectFolder:
    "Lists one folder of a cloud Code session's own folder on the runner (electron/projects/project-files.ts: inside it only, links leaving it refused).",
  readProjectFile: "As listProjectFolder; read-only on the web.",
  searchProjectFiles: "As listProjectFolder.",
  gitBranches: "As workingTreeChanges (read-only git in the sandbox).",
  saveArtifact: "Browser download of the given content.",
  artifactComplete:
    "Answered through the user's own engine gateway on the runner (key, model list and limits apply); 20 calls a minute.",
  addProjectKnowledge:
    "Hidden <input type=file multiple> for text files and PDFs, then addProjectKnowledgeFiles (remote-runner) with the bytes.",
  mentionFiles:
    "Lists a Code session's folder in the runner's workspace (never a folder the browser names); links leading out of it are left out.",
  listSlashCommands:
    "Custom prompts from the user's own codex-home, read without following links, and the engine's enabled skills.",
  readCustomPrompt: "As listSlashCommands.",
  saveGeneratedFile:
    "readGeneratedFile (remote-runner) for the bytes, then a browser download.",
  createArtifactPreview:
    "The runner stores the preview; the result is a signed /api/v1/claudex/web/preview/<id>?k= URL instead of claudex-preview:.",
  openExternal:
    "window.open(url, '_blank', 'noopener,noreferrer') after shared/external-links.ts validation.",
  openUpdateDownload: "Opens the desktop download page when one is configured.",
  openShare: "Opens the share's public /s/ page in a new tab.",
  githubStatus:
    "GET /api/v1/claudex/web/github (the user's GitHub connection).",
  githubConnect:
    "POST /api/v1/claudex/web/github/connect; the page then opens the GitHub address it returns.",
  githubDisconnect: "DELETE /api/v1/claudex/web/github.",
  githubRepositories: "GET /api/v1/claudex/web/github/repos (paged, search).",
  githubBranches: "GET /api/v1/claudex/web/github/branches.",
  githubIssues:
    "GET /api/v1/claudex/web/github/issues (the open issues of a repository).",
  githubIssue: "GET /api/v1/claudex/web/github/issue (one issue's text).",
  githubPullRequest:
    "GET /api/v1/claudex/web/github/pull (a pull request's state and checks).",
  githubPullRequestAction:
    "POST /api/v1/claudex/web/github/pull/action (merge, auto-merge, ready for review, back to draft) with the user's own GitHub connection.",
  apiKeys:
    "GET /api/v1/keys (paged), without the keys Claudex made for its own devices.",
  createApiKey: "POST /api/v1/keys with the name and the group.",
  deleteApiKey: "DELETE /api/v1/keys/<id>.",
  saveResearchReport:
    "readResearchReport (remote-runner), then a browser download of the Markdown.",
  startPayment:
    "The runner cannot open a browser: payment pages arrive as an open-url frame (same tab).",
  reopenPayment: "As startPayment.",
  uploadSkill:
    "Absent: the web's Upload skill page reads the files itself and sends installSkillFiles.",
  installSkillFiles:
    "The page's files travel as bytes (over 256 KiB through uploads); the runner unpacks them into the user's own skills folder, after checking that folder is not a link out of the profile.",
  readSkill:
    "Only a SKILL.md the runtime lists, and only inside the user's own profile (electron/skill-private.ts).",
  readSkillFile: "As readSkill, and inside the skill's own folder.",
  // Remote calls whose desktop handler assumes one trusted local user.
  saveSettings:
    "The runner keeps desktop-only settings out (local stdio MCP servers, folders, engine paths): the engine runs on a shared host.",
  mcpServers:
    "Lists the user's remote connectors; there is no configuration file, so configPath is empty.",
  addCustomConnector:
    "Only an https address the sandbox's proxy could reach; the bearer token stays in a 0600 file of the profile and reaches the server as an Authorization header (connectors.ts), never the settings or the page.",
  removeConnector: "As addCustomConnector; the token is forgotten too.",
  setConnectorTool: "Writes disabled_tools of the user's own connector.",
  setConnectorToolPermission:
    "Writes disabled_tools and the tool's approval_mode of the user's own connector; Always allow needs the policy's approvalsAlwaysAllow.",
  forgetConnectorApprovals:
    'Removes the approval_mode "approve" entries of the user\'s own connectors.',
  connectConnector:
    "PKCE OAuth returns to the signed-in web page; state, verifier and tokens stay in the user's runner context.",
  listMcp: "As mcpServers.",
  imageGenerationSnapshot:
    "Takes a transcript path: the runner resolves it only inside this user's own engine home.",
  viewedImageSnapshot:
    "Takes a conversation id and a path: read only inside that conversation's own working folder.",
  attachmentPreview: "Attachment ids resolve only to this user's own uploads.",
  loadRemoteImage:
    "Fetched from the runner host: the public-address check of electron/remote-image.ts (every hop) must stay on.",
  getFavicons: "As loadRemoteImage: public addresses only.",
  deleteAccount:
    "Deletes only the authenticated account through the service, then ends the runner session.",
};

function buildTable() {
  const kinds = new Map<string, WebMethodKind>();
  const inherited: string[] = [];
  for (const name of coreMethods) kinds.set(name, webCoreMethodKinds[name]);
  for (const domain of Object.keys(domainMethods) as DomainName[]) {
    const rule = webDomainRules[domain] as DomainRule<DomainName>;
    const overrides = (rule.overrides ?? {}) as Record<string, WebMethodKind>;
    for (const name of domainMethods[domain] as string[]) {
      const explicit = overrides[name];
      if (!explicit) inherited.push(name);
      kinds.set(name, explicit ?? rule.default);
    }
  }
  return { kinds, inherited };
}

const table = buildTable();

/** Every bridge call (except onEvent) with its web kind. */
export const webMethodTable: ReadonlyMap<string, WebMethodKind> = table.kinds;

/** Domain calls that take their domain's default: reviewed in the test. */
export const webInheritedMethods: readonly string[] = table.inherited;

/** Kind of one call; undefined for a name the desktop bridge does not have. */
export function webMethodKind(name: string): WebMethodKind | undefined {
  return webMethodTable.get(name);
}

export function webMethodsOfKind(kind: WebMethodKind): string[] {
  return [...webMethodTable]
    .filter(([, k]) => k === kind)
    .map(([name]) => name)
    .sort();
}

/** The allow-list a runner registers and advertises in its hello frame. */
export const webRemoteRunnerMethods: readonly string[] =
  webMethodsOfKind("remote-runner");
export const webRemoteGoMethods: readonly string[] =
  webMethodsOfKind("remote-go");
export const webBrowserMethods: readonly string[] = webMethodsOfKind("browser");
export const webAbsentMethods: readonly string[] = webMethodsOfKind("absent");
