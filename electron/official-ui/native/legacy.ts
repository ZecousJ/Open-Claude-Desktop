/**
 * The first native answers (initial states recorded from the official app and
 * a few window calls), for operations no domain module claims yet. Each
 * domain module that takes an operation over makes its line here dead; the
 * file shrinks as electron/official-ui/native/*.ts grows.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, nativeTheme, type BrowserWindow } from "electron";
import type { AdapterContext } from "../api/context";

export function legacyAnswers(
  callerWindow: () => BrowserWindow,
  ctx: AdapterContext,
  features: unknown,
) {
  const unsupported = new Set<string>();
  const theme = () => {
    const mode = ctx.settings().theme;
    const resolved = mode === "system" ? (nativeTheme.shouldUseDarkColors ? "dark" : "light") : mode;
    return { theme: resolved, themeMode: mode, chatFont: "system" };
  };
  const read = (channel: string, args: unknown[] = []): unknown => {
    const window = callerWindow();
    const operation = channel.split("_$_").slice(-2).join(".");
    const has = (...names: string[]) => names.includes(operation);
    const includes = (part: string) => channel.includes(part);
    if (channel.endsWith("AppFeatures_$_getSupportedFeatures")) return features;
    if (channel.endsWith("AppPreferences_$_getPreferences")) return theme();
    if (channel.endsWith("AppPreferences_$_setPreference")) return undefined; // theme and font follow Claudex settings for now
    if (includes("LocalAgentModeSessions_$_getAll") || includes("LocalSessions_$_getAll")) return [];
    if (includes("LocalAgentModeSessions_$_getSessionList")) return { sessions: [], restPending: false };
    if (includes("LocalSessions_$_getSessionList")) return { sessions: [], loadGeneration: 1, archivedPending: false };
    if (includes("WindowState_$_compositing_$store$_getState")) return { software: false };
    if (includes("WindowState_$_deviceLink_$store$_getState")) return { appStartedMs: Date.now(), connected: false, recentGaps: [] };
    if (includes("Custom3pSetup_$_bootstrapState_$store$_getState")) return { configured: false, origin: "none", health: "never" };
    if (includes("Custom3pSetup_$_hybridTransition_$store$_getState")) return { state: "none" };
    if (includes("ManagedConfig_$_managedRendererConfig_$store$_getState")) return { deploymentMode: "1p" };
    if (includes("CliSessionImport_$_cliImport_$store$_getState")) return { seq: 0, stage: "closed" };
    if (includes("LocalAgentModeSessions_$_sessionsBridgeStatus_$store$_getState")) return { conflict: false, dispatchAgentName: null };
    if (includes("Launch_$_activeServers_$store$_getState")) return [];
    if (includes("Simulator_$_attachment_$store$_getState") || includes("Simulator_$_debugAttaching_$store$_getState")) return [];
    if (includes("OfficeAddinFiles_$_connectedFilesState_$store$_getState")) return { files: [], isFeatureEnabled: false };
    if (includes("GrandPrix_$_grandPrixStatus_$store$_getState")) return { paired: {}, installed: {}, displayNames: {}, iconDataUris: {} };
    if (includes("ViolinFret_$_violinFretStatus_$store$_getState")) return { available: false, choice: "unset" };
    if (includes("ClaudeVM_$_apiReachability_$store$_getState")) return { reachability: "unknown", willTryRecover: false };
    if (includes("ClaudeVM_$_hostIPv6Notice_$store$_getState")) return "none";
    if (includes("ClaudeVM_$_edrExtensionNotice_$store$_getState")) return { kind: "none", run: 0 };
    if (includes("_$store$_getState")) return null;
    if (has("BuddyBleTransport.reportState", "ContentStampReporter.report", "DesktopIntl.requestLocaleChange", "WebBuild.reportCommitHash", "LocalSessions.setAvailableCodeModels", "LocalSessions.setAccountBranchPrefix", "LocalSessions.setCodeSettingAvailability", "ClaudeVM.setApiReachabilityProbeEnabled", "LocalSessions.setSessionVisibility", "Launch.setRoutedLinkConfirmReady"))
      return undefined;
    if (has("LocalAgentModeSessions.getDefaultWorkspaceFolders", "LocalAgentModeSessions.getManagedAskToolNames", "Launch.getAllSessionPreviewTabs")) return [];
    if (has("ClaudeVM.isHostLoopModeEnabled", "ClaudeVM.isHostLoopDevOverrideActive", "WindowState.getKeptHidden")) return false;
    if (has("ClaudeVM.getDownloadStatus")) return "not_started";
    if (has("ClaudeVM.getRunningStatus")) return "stopped";
    if (has("DesktopInfo.getSystemInfo")) return { platform: process.platform, arch: process.arch, osVersion: os.release(), appVersion: ctx.appVersion };
    // Window controls the page draws where the native title bar is hidden.
    if (has("WindowControl.close")) { window.close(); return undefined; }
    if (has("WindowControl.focus")) { window.focus(); return undefined; }
    if (has("WindowControl.show", "WindowControl.resize")) {
      if (window.isMinimized()) window.restore();
      window.show();
      return undefined;
    }
    if (channel === "artifact-window-open-gate:state") return false;
    if (has("WindowState.getFullscreen")) return window.isFullScreen();
    if (has("LocalAgentModeSessions.getBridgeConsent")) return false;
    if (has("WindowState.getZoomFactor")) return window.webContents.getZoomFactor();
    if (has("LocalSessions.getLocalMcpServers", "LocalSessions.getSessionCliMcpServers", "LocalSessions.getRemoteBrowserCards", "LocalSessions.getAgents", "LocalSessions.getSSHConfigs", "LocalSessions.getSSHHostToolGrants")) return [];
    if (has("LocalSessions.getContextUsage", "LocalSessions.getDefaultEffort", "Resources.getProjectFileListIfChanged", "DesktopInfo.getDefaultBrowserName")) return null;
    if (has("Extensions.isExtensionsEnabled", "MCP.isLocalDevMcpEnabled", "CoworkFilePreview.isOpenInDefaultAppEnabled", "CoworkFilePreview.isEnabled")) return false;
    if (has("LocalSessions.setThinkingSummariesWanted", "LocalSessions.setBackgroundTasksShortcutArmed", "LocalSessions.setFocusedSession", "LocalSessions.prewarmAuth", "RendererMemoryReporter.report", "Resources.setFindInPageClaimed"))
      return undefined;
    if (has("CCDScheduledTasks.getAllScheduledTasks", "CoworkScheduledTasks.getAllScheduledTasks", "CoworkArtifacts.getAllArtifacts", "LocalSessions.getInstalledEditors")) return [];
    if (has("Launch.getPreviewTabs")) return { tabs: [], activeTabId: "" };
    if (has("WindowManager.RegisterWindow", "WindowManager.UnregisterWindow")) return true;
    if (has("Launch.setPreviewLinkRouting", "CCDScheduledTasks.setEventAckSupported", "CCDScheduledTasks.setHostRunsSupported", "CCDScheduledTasks.markListenerReady", "LocalSessions.replaceEnabledMcpTools", "LocalSessions.replaceRemoteBrowserCards", "Resources.setFocusedCwd", "FindInPageProvider.setProviderActive", "LocalSessions.setVisibility"))
      return undefined;
    if (has("LocalSessions.getSupportedCommands", "LocalSessions.listWslDistros", "LocalSessions.getSSHHostCommands", "LocalSessions.getServedConnectorCalls")) return [];
    if (has("HistoryImport.getImportCapabilities"))
      return { remotePull: false, remotePullConfigured: false, localZip: false, localSessions: false, sessionExport: false, hostLoopRequired: false, cliUpdateRequired: false, hasImportableSessions: false, local1PSessionCount: 0 };
    if (has("LocalAgentModeSessions.getDirectMcpServerStatuses", "Extensions.getInstalledExtensionsWithState", "PluginBridgeMcp.listServers", "CoworkSpaces.getRemoteSessionSpaces", "CoworkSpaces.getAllSpaces", "LocalPlugins.getDownloadedRemotePlugins", "LocalSessions.getRecentFolders")) return [];
    if (has("CliSessionImport.claimMenuStart", "WindowControl.setIncognitoMode", "CoworkScheduledTasks.setEventAckSupported", "CoworkScheduledTasks.markListenerReady", "WindowVibrancy.showUnderSidebar", "WindowVibrancy.clear", "WindowControl.setTrafficLightPosition"))
      return undefined;
    if (has("LocalAgentModeSessions.getSessionMissReason")) return { reason: "not_found" };
    if (has("Custom3pSetup.getLoginDesktop3pStatus")) return null;
    if (has("HistoryImport.getAutoImportStatus")) return { enabled: false, running: false };
    if (has("LimitAutoResume.getLimitAutoResumeState")) return { seq: 0, hostOwns: false, windows: [] };
    if (has("LocalSessions.resolveSessionFile")) return null;
    if (has("DeviceRegistry.getLocalDeviceInfo")) return { deviceId: "00000000-0000-4000-8000-000000000000", platform: process.platform, displayName: os.hostname(), homePath: os.homedir() };
    if (has("DeviceRegistry.noteRegistrationOutcome", "OsEntryPlaces.report")) return undefined;
    if (has("LocalSessions.getBusyShellPtyKeys")) return { live: [], busy: [], unknown: [], probed: false };
    if (has("LocalSessions.getCodeStats")) return null;
    if (has("ForgeState.getForgeStateSnapshot")) return [];
    if (has("ForgeState.setForgeStateVisibleKeys")) return undefined;
    if (has("DeviceRegistry.getAvailability")) return { available: false, isHardwareBacked: false, reason: "no_tpm" };
    if (has("DeviceStorage.getFreeDiskSpace")) { const stat = fs.statfsSync(app.getPath("userData")); return stat.bavail * stat.bsize; }
    if (has("FileSystem.getSystemPath")) return app.getPath("home");
    if (includes("WindowControl_$_report") || includes("Account_$_setAccountDetails") || includes("Account_$_activeAccountChanged") || includes("RendererMemoryTelemetry_$_report") || includes("DesktopIntl_$_setLocale"))
      return undefined;
    if (has("LocalAgentModeSessions.getSupportedCommands", "LocalPlugins.getPlugins", "CustomPlugins.listMarketplaces")) return [];
    // Reports, syncs and claims the renderer fires without reading an answer.
    if (/^[A-Za-z0-9]+\.(?:set|report|sync|claim|refetch|mark|note|ack|notify|record|update|prewarm|release|declare|ready|prepare)(?:[A-Z]|$)/.test(operation)) {
      if (!unsupported.has(channel)) ctx.log("[official-ui] native call accepted without effect:", operation);
      unsupported.add(channel);
      return undefined;
    }
    void args;
    unsupported.add(channel);
    throw new Error(`Native host adapter is not configured: ${operation}`);
  };
  // The op "Domain.method" as the channel suffix the checks above were written against.
  return (op: string, args: unknown[]) => {
    const dot = op.indexOf(".");
    const channel = dot < 0 ? op : `$eipc_message$_legacy_$_ns_$_${op.slice(0, dot)}_$_${op.slice(dot + 1)}`;
    return read(channel, args);
  };
}
