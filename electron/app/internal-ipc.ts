/** Main-process-only operations. Exact entries, never a prefix exemption. */
export const internalIpcOwners = {
  saveOfficialThemeMode: "app/ipc-register.ts",
  saveOfficialDispatchReceiving: "app/ipc-register.ts",
  officialAnnouncements: "ipc/announcements.ts",
  officialPendingAnnouncements: "ipc/announcements.ts",
  officialMarkAnnouncementRead: "ipc/announcements.ts",
  officialCloseAnnouncement: "ipc/announcements.ts",
  officialZecousMigration: "ipc/zecous-migration.ts",
  officialConfirmZecousMigration: "ipc/zecous-migration.ts",
  officialReleaseCodeNewTask: "ipc/composer.ts",
  officialResolveCodeNewTask: "ipc/composer.ts",
  officialCodeModelProposal: "ipc/composer.ts",
  officialUpdateCodeCloudOffer: "ipc/composer.ts",
  officialClearPreviewBrowsingData: "ipc/panels-browser-tools.ts",
  officialCodeClearHistory: "ipc/composer.ts",
  officialCodeSwitchRewindMark: "ipc/composer.ts",
  officialCodeRewindFiles: "ipc/composer.ts",
  officialCoworkSteer: "ipc/composer.ts",
  officialSessionTransfer: "ipc/session-transfer.ts",
  officialStoreCodeAttachments: "ipc/official-attachments.ts",
  officialRestoreCodeAttachments: "ipc/official-attachments.ts",
  officialSessionFile: "ipc/official-files.ts",
  officialGitRead: "ipc/official-git.ts",
  officialGitBranch: "ipc/official-git.ts",
  officialGitDirectory: "ipc/official-git.ts",
  officialUpdateSessionPullRequests: "ipc/code-pull-requests.ts",
  officialSetPrAutoFixIntent: "ipc/code-pull-requests.ts",
  officialWslTrust: "ipc/workspace.ts",
  officialSshTarget: "ipc/ssh-handlers.ts",
  officialSetSshConfigs: "ipc/ssh-handlers.ts",
  officialPendingSshPrompts: "ipc/ssh-handlers.ts",
  officialCodeWorktreeLifecycle: "ipc/conversation-manage-handlers.ts",
  autoArchiveLocalCode: "ipc/conversation-manage-handlers.ts",
  refreshConnectorTools: "ipc/settings-desktop-connectors.ts",
  revokeConnector: "ipc/settings-desktop-connectors.ts",
  selectChatLeaf: "ipc/conversation-turn-handlers.ts",
  officialChangeSessionFolder: "ipc/official-session-folder.ts",
  officialCodeRoutineRun: "ipc/collections-schedules.ts",
  officialCodeRoutineCancel: "ipc/collections-schedules.ts",
  officialCodeRoutineSnapshot: "ipc/collections-schedules.ts",
  setNativePluginEnabled: "ipc/collections-directory.ts",
  setOrganizationPluginEnabled: "ipc/collections.ts",
  removeOrganizationPlugin: "ipc/collections.ts",
  readOrganizationPluginStates: "ipc/collections.ts",
  readOrganizationPluginDetails: "ipc/collections.ts",
  addNativePluginMarketplace: "ipc/collections-directory.ts",
  removeNativePluginMarketplace: "ipc/collections-directory.ts",
  refreshNativePluginMarketplace: "ipc/collections-directory.ts",
  officialCodeRoutinePolicy: "ipc/collections-schedules.ts",
  officialDevServerLogs: "ipc/panels-browser-tools.ts",
  officialDraftBrowserStart: "ipc/panels.ts",
  officialCloseBrowserPreview: "ipc/panels.ts",
  officialDiscardPreviewFrame: "ipc/panels.ts",
  officialFocusBrowserPreview: "ipc/panels.ts",
  officialConfigurePreviewInput: "ipc/panels.ts",
  officialReopenBrowserTab: "ipc/panels.ts",
  officialReorderBrowserTab: "ipc/panels.ts",
  officialCloseAllBrowserTabs: "ipc/panels.ts",
  officialBrowserOpenFile: "ipc/panels.ts",
  officialPreviewWrittenFiles: "ipc/panels.ts",
  officialDraftTerminalStart: "ipc/terminal.ts",
} as const;
export const internalIpcMethods = Object.keys(internalIpcOwners);
export function isInternalIpcMethod(name: string) {
  return Object.hasOwn(internalIpcOwners, name);
}
type Handler = (...args: any[]) => any;
/** Private handlers enter only the local in-process registry. They must never
 * become app: IPC handlers, routed handlers or cloud/remote method entries. */
export function registerIpcHandler(
  name: string,
  handler: Handler,
  registration: {
    local: Map<string, Handler>;
    routed: Map<string, Handler>;
    route(name: string, handler: Handler): Handler;
    expose(name: string, handler: Handler): void;
  },
) {
  registration.local.set(name, handler);
  if (isInternalIpcMethod(name)) return;
  const routed = registration.route(name, handler);
  registration.routed.set(name, routed);
  registration.expose(name, routed);
}
