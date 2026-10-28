import assert from "node:assert/strict";
import test from "node:test";
import {
  coreMethods,
  desktopMethods,
  domainMethods,
} from "../../shared/desktop-bridge";
import {
  webAbsentMethods,
  webBrowserMethods,
  webDomainRules,
  webInheritedMethods,
  webMethodKind,
  webMethodKinds,
  webMethodNotes,
  webMethodTable,
  webRemoteGoMethods,
  webRemoteRunnerMethods,
} from "../../shared/web-bridge-methods";
import { isWebMethodName, webLimits } from "../../shared/web-protocol";

test("every desktop bridge call has exactly one web kind", () => {
  assert.equal(webMethodTable.size, desktopMethods.length);
  assert.equal(new Set(desktopMethods).size, desktopMethods.length);
  for (const name of desktopMethods) {
    const kind = webMethodKind(name);
    assert.ok(kind && webMethodKinds.includes(kind), `${name} is classified`);
  }
  const lists = [
    webRemoteRunnerMethods,
    webRemoteGoMethods,
    webBrowserMethods,
    webAbsentMethods,
  ];
  assert.equal(
    lists.reduce((sum, list) => sum + list.length, 0),
    desktopMethods.length,
  );
  assert.equal(webMethodKind("onEvent"), undefined);
  assert.equal(webMethodKind("noSuchCall"), undefined);
});

test("overrides and notes name real calls of their domain", () => {
  for (const [domain, rule] of Object.entries(webDomainRules)) {
    const names = new Set<string>(
      domainMethods[domain as keyof typeof domainMethods],
    );
    for (const name of Object.keys(rule.overrides ?? {}))
      assert.ok(names.has(name), `${domain} override ${name} exists`);
  }
  assert.deepEqual(
    Object.keys(webDomainRules).sort(),
    Object.keys(domainMethods).sort(),
  );
  for (const name of Object.keys(webMethodNotes))
    assert.ok(webMethodTable.has(name), `note for ${name} names a call`);
});

test("the runner allow-list fits the link hello frame", () => {
  assert.ok(webRemoteRunnerMethods.length <= webLimits.runnerMethods);
  for (const name of webRemoteRunnerMethods)
    assert.ok(isWebMethodName(name), name);
  // Sorted and unique, so the hello frame is stable across builds.
  assert.deepEqual([...webRemoteRunnerMethods].sort(), webRemoteRunnerMethods);
});

/** Calls that act on this computer: never relayed to a shared server. */
const neverRemote = [
  "getNotificationAuthorizationStatus",
  "requestNotificationAuthorization",
  "openNotificationSettings",
  "supportsNotificationActions",
  "showDesktopNotification",
  "setProjectPromptsWaiting",
  "chooseFolder",
  "chooseFolders",
  "revealConversationFolder",
  "restartEngine",
  "windowAction",
  "storageUsage",
  "clearCacheAndRestart",
  "previewStorageCleanup",
  "runStorageCleanup",
  "cancelStorageCleanup",
  "systemState",
  "setRunOnStartup",
  "revealDataFolder",
  "openMcpConfig",
  "discoverLocalMcp",
  "importLocalMcp",
  "revealSkill",
  "uploadSkill",
  "setupWindowsSandbox",
  "terminalStart",
  "terminalWrite",
  "workspaceGit",
  "popOutArtifact",
  "openExternal",
  "openConversationWindow",
  "sshConnect",
  "sshListDirectory",
  "computerUseScreenshot",
  "computerUsePreview",
  "revealCoworkFolder",
  "copyText",
  "chooseAttachments",
];

test("local-only calls are never remote", () => {
  for (const name of neverRemote) {
    assert.ok(webMethodTable.has(name), `${name} still exists`);
    assert.ok(
      !webMethodKind(name)!.startsWith("remote"),
      `${name} must not run on the server`,
    );
  }
});

test("the web sign-in calls go to Go, the conversation calls to the runner", () => {
  assert.deepEqual([...webRemoteGoMethods].sort(), [
    "authStatus",
    "browserAccounts",
    "cancelTwoFactor",
    "completeTwoFactor",
    "forgetBrowserAccount",
    "loginAccount",
    "loginWithCode",
    "loginWithGoogle",
    "loginWithPasskey",
    "logoutAccount",
    "registerAccount",
    "requestPasswordReset",
    "resetPassword",
    "revokeAllSessions",
    "sendSignInCode",
    "sendVerificationCode",
    "switchAccount",
  ]);
  // Adding an account only marks the tab (src-web/bridge/auth.ts).
  assert.equal(webMethodKind("addAccount"), "browser");
  assert.equal(webMethodKind("cancelAddAccount"), "browser");
  for (const name of [
    "snapshot",
    "send",
    "interrupt",
    "approve",
    "saveSettings",
    "billingInfo",
    "clientPolicy",
    "modelCatalog",
    "memoryStatus",
    "shareConversation",
    "getFavicons",
    "setConversationResearch",
    "loadRemoteImage",
    "createArtifactPreview",
    "customizeSkills",
    "listSkills",
    "coworkFolders",
    "listCoworkFolder",
    "readCoworkFile",
    "readCoworkResource",
    "connectConnector",
    "completeConnectorLogin",
    "readMcpLogs",
    "codeEmailStatus",
  ])
    assert.equal(webMethodKind(name), "remote-runner", name);
  // Every core call is listed explicitly (the type makes that exhaustive).
  for (const name of coreMethods) assert.ok(webMethodKind(name));
});

/**
 * Domain calls that take their domain's default. A round-two package adding
 * a call does not edit the web table; this list is the reviewer's view of
 * what it inherited. It is printed, not frozen, so new calls do not break
 * `npm test`; the check below fails only when an inherited remote call looks
 * like it touches this computer.
 */
const reviewedInherited = new Set([
  // settings-account
  "accountProfile",
  "setFullName",
  "deleteAccount",
  // Account → Active sessions: the runner asks the service with the
  // browser session's own access token (the service marks it current).
  "activeSessions",
  "endActiveSession",
  "sharedArtifacts",
  "stopSharingArtifact",
  // settings-desktop (absent)
  "storageUsage",
  "clearCacheAndRestart",
  "previewStorageCleanup",
  "runStorageCleanup",
  "cancelStorageCleanup",
  "systemState",
  "setRunOnStartup",
  "revealDataFolder",
  "openMcpConfig",
  "uploadSkill",
  "revealSkill",
  "setupWindowsSandbox",
  // policy, usage, billing, model-catalog, diagnostics
  "clientPolicy",
  "announcements",
  "onboardingState",
  "saveOnboarding",
  "markAnnouncementRead",
  "weeklyUsageStatus",
  "dismissWeeklyUsage",
  "planUsage",
  "billingInfo",
  "redeemCode",
  "billingCheckout",
  "startPayment",
  "reopenPayment",
  "billingOrders",
  "billingOrder",
  "cancelOrder",
  "modelCatalog",
  "refreshModels",
  "setReplyFeedback",
  "reportingStatus",
  "submitReplyFeedback",
  // voice (browser)
  "requestMicrophone",
  "startDictation",
  "dictationAudio",
  "finishDictation",
  "cancelDictation",
  // code-usage, composer, agent
  "usageSummary",
  "codeUsageDashboard",
  "compactConversation",
  "forkConversation",
  "handOffConversation",
  "askSideChat",
  "interruptSideChat",
  "endSideChat",
  "startReview",
  "runShellCommand",
  "rewindConversation",
  "swapRewind",
  "steerTurn",
  "addAttachmentData",
  "attachmentPreview",
  "stopWorkflowAgent",
  "refreshWorkflowAgents",
  "readWorkflowAgent",
  "stopWorkflowRun",
  // panels (absent)
  "terminalList",
  "terminalEnsure",
  "terminalStart",
  "terminalWrite",
  "terminalResize",
  "terminalBusy",
  "terminalClose",
  "listBackgroundTerminals",
  "stopBackgroundTerminal",
  "clearFinishedBackgroundTasks",
  // artifacts
  "artifactNotes",
  "updateArtifactNote",
  "importArtifactNotes",
  "duplicateArtifact",
  "deleteArtifactCopy",
  "pinArtifact",
  "syncArtifactShare",
  "setArtifactShare",
  "createArtifactPreview",
  "releaseArtifactPreview",
  "readGeneratedFile",
  "imageGenerationSnapshot",
  // collections (absent)
  // external-links (browser)
  "openExternal",
  "openUpdateDownload",
  // sharing
  "sharingStatus",
  "conversationShare",
  "shareConversation",
  "unshareConversation",
  "publishArtifact",
  "artifactPublication",
  "unpublishArtifact",
  "artifactEmbed",
  "setArtifactEmbedDomains",
  "hostedShares",
  "revokeShare",
  // Report artifact: the runner signs in to the service as the user.
  "artifactReportsState",
  "reportArtifact",
  // windows, ssh, computer-use, cowork (absent)
  "openConversationWindow",
  "returnToMainWindow",
  "setWindowPinned",
  "takeWindowHandoff",
  "reportWindowVisibility",
  "forwardToMainWindow",
  "conversationWindows",
  "sshListHosts",
  "sshToolGrants",
  "sshRemoveToolGrant",
  "sshClearToolGrants",
  "sshSaveHost",
  "sshDeleteHost",
  "sshConnect",
  "sshDisconnect",
  "sshStatus",
  "sshTestHost",
  "sshAnswerPrompt",
  "sshListDirectory",
  "sshChooseFolder",
  "computerUseState",
  "saveComputerUseSettings",
  "computerUseInstalledApps",
  "requestComputerUsePermission",
  "openComputerUsePermissionSettings",
  "relaunchForPermissions",
  "answerComputerUseAccess",
  "stopComputerUse",
  "computerUsePreview",
  "computerUseScreenshot",
  "trustedCoworkFolders",
  "addTrustedCoworkFolder",
  "removeTrustedCoworkFolder",
  "revealCoworkFolder",
  // workspace-trust (absent: the runner's sandboxes trust their folders)
  "checkWorkspaceTrust",
  "saveWorkspaceTrust",
  "trustedWorkspaces",
  "addTrustedWorkspace",
  "removeTrustedWorkspace",
  // memory, research, favicons
  "memoryStatus",
  "setMemoryPrefs",
  "memoryDoc",
  "saveMemoryDoc",
  "removeMemoryEdit",
  "updateMemoryEdits",
  "previewMemoryImport",
  "resetMemory",
  "setConversationResearch",
  "readResearchReport",
  "getFavicons",
]);

/** Names that suggest a call acts on this computer. */
const localLooking =
  /folder|reveal|choose|terminal|window|shell|path|disk|local|clipboard|launch|open(?!Share)/i;

test("inherited calls are listed for review", (t) => {
  const unreviewed = webInheritedMethods.filter(
    (name) => !reviewedInherited.has(name),
  );
  if (unreviewed.length)
    t.diagnostic(
      `Review the web kind of new calls: ${unreviewed
        .map((name) => `${name} (${webMethodKind(name)})`)
        .join(", ")}`,
    );
  const suspicious = webInheritedMethods.filter(
    (name) =>
      webMethodKind(name) === "remote-runner" &&
      !reviewedInherited.has(name) &&
      localLooking.test(name),
  );
  assert.deepEqual(
    suspicious,
    [],
    "an inherited remote-runner call looks local: give it an explicit kind in shared/web-bridge-methods.ts",
  );
  for (const name of reviewedInherited)
    if (webMethodTable.has(name))
      assert.ok(webInheritedMethods.includes(name), `${name} is inherited`);
});
