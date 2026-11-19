import { initialCaptionOverlay } from "../../app/caption-overlay";
import { officialBootColors, recordOfficialBootColors, recordOfficialBootSurface } from "../../app/official-startup-shell";
import { app, dialog, Menu, MessageChannelMain, powerMonitor, shell, systemPreferences } from "electron";
/**
 * Builds the native host for the official window: every domain module
 * registers its operations, and the recorded first answers (legacy.ts) cover
 * what no module claims yet.
 */
import type { AdapterContext } from "../api/context";
import { NativeHost, NativeRefusal } from "./host";
import { legacyAnswers } from "./legacy";
import { registerPreferences } from "./preferences";
import { registerCodeSandbox } from "./code-sandbox";
import { registerOfficialComputerUse } from "./computer-use";
import { registerComputerUseLivePreview } from "./computer-use-live-preview";
import { registerOfficialDictation } from "./dictation";
import { registerDevice } from "./device";
import { registerRemoteControl } from "./remote-control";
import { registerResources } from "./resources";
import { registerSshPrompts } from "./ssh-prompts";
import { registerExtensions } from "./extensions";
import { registerExperimentalCodeSessions } from "./code-sessions";
import { registerCodeSessionPresets } from "./code-session-presets";
import { registerCodeDetectedProjects } from "./code-detected-projects";
import { registerCodeCustomGroups } from "./code-custom-groups";
import { registerCodeSessionEnvironment } from "./code-session-environment";
import { registerExperimentalCoworkSessions } from "./cowork-sessions";
import { registerCodeTerminals } from "./code-terminals";
import { registerCodeEditors } from "./code-editors";
import { registerCodeLimitAutoResumeNative } from "./code-limit-auto-resume";
import { registerCoworkMemory } from "./memory";
import { registerLocalScheduleReads } from "./schedules";
import { registerCliResume } from "./cli-resume";
import { registerHistoryTransfer } from "./history-transfer";
import { registerNativePluginReads } from "./plugin-reads";
import { registerDesktopIntl } from "./intl";
import { registerGit } from "./git";
import { registerBrowserNavigation } from "./browser-navigation";
import { registerWindowActivity } from "./window-activity";
import { registerHostPower } from "./power";
import { registerAutoUpdater } from "./auto-updater";
import { registerOfficialAppMenu } from "./app-menu";
import { registerCodeFiles } from "./files";
import { registerLaunch } from "./launch";
import { registerLocalConnectors } from "./local-connectors";
import { registerProductFeedback } from "./product-feedback";
import { registerSupportBundle } from "./support-bundle";
import {registerPdfPreview} from './pdf-preview';
import { registerNativeFileDownloads } from "./file-downloads";
import { createDirectMcpBridge } from "./direct-mcp";
import { registerQuickEntry } from "./quick-entry";
import { registerDesktopNotifications } from "./desktop-notifications";
import { registerWindowLayout, type WindowLayoutIntegration } from "./window-layout";
import { officialLocalServerName } from "../../connectors/extension-identity";

/** One host for every official window of the app (created with the first one). */
export function createNativeHost(origin: string, ctx: AdapterContext, features: unknown, dictation?: {
  availability: Parameters<typeof registerOfficialDictation>[1];
  credential: Parameters<typeof registerOfficialDictation>[2];
}, notificationIntegration?: Parameters<typeof registerDesktopNotifications>[1], windowLayout?: WindowLayoutIntegration) {
  const host = new NativeHost(origin, ctx);
  host.on("claudex:export-account-data", async (options: unknown) => {
    if (!host.ctx.localCall) throw Error("Account export is unavailable.");
    return typeof await host.ctx.localCall("exportData", options) === "string";
  });
  if (windowLayout) registerWindowLayout(host, windowLayout);
  registerCodeSessionPresets(host);
  registerCodeCustomGroups(host);
  registerCodeSessionEnvironment(host);
  const isDetectedFolder = registerCodeDetectedProjects(host, app.getPath("home"));
  if (notificationIntegration) registerDesktopNotifications(host, notificationIntegration);
  const quickEntry = registerQuickEntry(host);
  host.on("WindowControl.setThemeMode", (mode: unknown) => {
    if (!host.ctx.account()?.id || host.ctx.isCurrent?.() === false || !host.ctx.localCall)
      throw Error("This account window has retired.");
    return host.ctx.localCall("saveOfficialThemeMode", mode);
  });
  for (const [op, field] of [
    ["reportFrameLayout", "layout"],
    ["reportSidebarPlaceholder", "shapes"],
  ] as const) {
    host.on("WindowControl." + op, (value: unknown) => {
      if (host.caller !== host.window) return;
      const profile = host.ctx.stateDirectory?.();
      if (profile) recordOfficialBootSurface(profile, field, value);
    });
  }
  host.on("WindowControl.reportBootPlaceholderColors", (value: unknown) => {
    const window = host.caller;
    const parsed = officialBootColors.safeParse(value);
    if (!window || !parsed.success) return;
    const colors = parsed.data;
    if (process.platform === "win32")
      window.setTitleBarOverlay({ ...initialCaptionOverlay(colors.dark), color: "#00000000" });
    if (window === host.window) {
      const profile = host.ctx.stateDirectory?.();
      if (profile) recordOfficialBootColors(profile, colors);
    }
  });
  const cleanups: (() => void)[] = [];
  if (dictation) cleanups.push(registerOfficialDictation(host, dictation.availability, dictation.credential));
  let direct: ReturnType<typeof createDirectMcpBridge> | undefined;
  let directIdentity: unknown;
  let directOwner: string | undefined;
  let directSettings = new Map<string, string>();
  const resetDirect = () => {
    direct?.dispose();
    direct = undefined;
    directIdentity = undefined;
    directOwner = undefined;
    directSettings.clear();
  };
  const settingsSnapshot = () => new Map(
    Object.entries(ctx.settings().mcpServers ?? {}).map(([name, value]) => [name, JSON.stringify(value)]),
  );
  const directBridge = () => {
    const owner = ctx.account()?.id;
    const identity = ctx.sessionIdentity?.();
    if (!owner || !identity || !ctx.localMcpConfig || ctx.isCurrent?.() === false)
      throw Error("Local MCP servers are unavailable.");
    if (direct && (directIdentity !== identity || directOwner !== owner)) resetDirect();
    if (!direct) {
      directIdentity = identity;
      directOwner = owner;
      directSettings = settingsSnapshot();
      direct = createDirectMcpBridge({
        mcpConfig: ctx.localMcpConfig,
        isCurrent: () => ctx.isCurrent?.() !== false && ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity,
      });
    }
    return direct;
  };
  const directNames = () => {
    const configured = ctx.settings().mcpServers ?? {};
    const names = directBridge().list().map((name) => [officialLocalServerName(name, configured[name]), name] as const);
    if (new Set(names.map(([name]) => name)).size !== names.length)
      throw Error("Local MCP server names are not unique.");
    return new Map(names);
  };
  host.on("list-mcp-servers", () => [...directNames().keys()]);
  host.on("connect-to-mcp-server", (name: unknown) => {
    if (typeof name !== "string") throw Error("Invalid MCP server name.");
    const window = host.caller;
    if (!window || window.isDestroyed()) throw Error("The account window has retired.");
    const { port1, port2 } = new MessageChannelMain();
    try {
      const serverName = directNames().get(name);
      if (!serverName) throw Error("MCP server is unavailable.");
      directBridge().connect(serverName, port1);
      window.webContents.postMessage("mcp-server-connected", { serverName: name, uuid: name }, [port2]);
    } catch (error) {
      port1.close();
      port2.close();
      throw error;
    }
  });
  cleanups.push(ctx.onEvent((event) => {
    if (!direct) return;
    if (ctx.account()?.id !== directOwner || ctx.sessionIdentity?.() !== directIdentity || ctx.isCurrent?.() === false) {
      resetDirect();
      return;
    }
    if (event.type !== "settings" && event.type !== "policy") return;
    const next = settingsSnapshot();
    for (const name of new Set([...directSettings.keys(), ...next.keys()])) {
      if (event.type === "policy" || directSettings.get(name) !== next.get(name)) {
        direct.retireServer(name);
        const previous = directSettings.get(name);
        const current = next.get(name);
        for (const alias of new Set([
          previous === undefined ? name : officialLocalServerName(name, JSON.parse(previous)),
          current === undefined ? name : officialLocalServerName(name, JSON.parse(current)),
        ])) host.broadcastRaw("mcp-server-auto-reconnect", alias);
      }
    }
    directSettings = next;
  }));
  if (ctx.onAccountDeactivating) cleanups.push(ctx.onAccountDeactivating(resetDirect));
  cleanups.push(resetDirect);
  const preferences = registerPreferences(host, features, registerOfficialComputerUse(host, systemPreferences));
  cleanups.push(preferences.dispose);
  cleanups.push(registerComputerUseLivePreview(host, ctx));
  host.answer(false, "FramebufferPreview.requestFramePort");
  host.answer([], "FramebufferPreview.listSources");
  host.on("FramebufferPreview.attach", () => {
    throw new NativeRefusal("unavailable", "FramebufferPreview not available in this window");
  });
  host.answer(undefined, "FramebufferPreview.detach", "FramebufferPreview.setStreamHints", "FramebufferPreview.sendPointer", "FramebufferPreview.sendKey", "FramebufferPreview.sendScroll");
  cleanups.push(registerCodeSandbox(host));
  cleanups.push(registerDesktopIntl(host));
  registerDevice(host);
  cleanups.push(registerRemoteControl(host, powerMonitor));
  registerWindowActivity(host);
  cleanups.push(registerHostPower(host));
  cleanups.push(registerAutoUpdater(host));
  registerBrowserNavigation(host);
  registerOfficialAppMenu(host, () => Menu.getApplicationMenu());
  const focusCodeFiles = registerResources(host);
  cleanups.push(registerSshPrompts(host));
  registerNativeFileDownloads(host, {
    downloadsDirectory: () => app.getPath("downloads"),
    revealFile: filename => shell.showItemInFolder(filename),
    openFile: filename => shell.openPath(filename),
    confirmOpen: async (filename, window) => {
      if (!window || window.isDestroyed()) return false;
      const result = await dialog.showMessageBox(window, {
        type: "question", buttons: ["Cancel", "Allow"], defaultId: 0, cancelId: 0,
        title: "File access request", message: "Allow Claudex to open this file?",
        detail: `${filename}\n\nThis will open the file with your default application.`,
      });
      return result.response === 1;
    },
  });
  registerLocalConnectors(host);
  cleanups.push(registerProductFeedback(host));
  const supportBundle = registerSupportBundle(host);
  cleanups.push(supportBundle.dispose);
  cleanups.push(registerCodeFiles(host));
  cleanups.push(registerPdfPreview(host));
  registerExtensions(host);
  registerCoworkMemory(host);
  cleanups.push(registerLocalScheduleReads(host));
  host.on("LocalSessions.probeImportableCliSessions", () => ({ count: 0 }));
  host.on("LocalSessions.importAllCliSessions", () => undefined);
  registerCliResume(host);
  registerHistoryTransfer(host);
  registerNativePluginReads(host, (code, message) => new NativeRefusal(code, message));
  cleanups.push(registerExperimentalCodeSessions(host, isDetectedFolder));
  cleanups.push(registerExperimentalCoworkSessions(host));
  cleanups.push(registerCodeTerminals(host));
  registerCodeEditors(host);
  cleanups.push(registerCodeLimitAutoResumeNative(host));
  cleanups.push(registerGit(host));
  cleanups.push(registerLaunch(host, focusCodeFiles, preferences.autoOpenFiles, preferences.resetChromeImportPrompt));
  host.fallback = legacyAnswers(() => host.caller ?? host.window!, host.ctx, features);
  host.start();
  return {
    host,
    quickEntry,
    supportBundle,
    unsupported: host.unanswered(),
    dispose: () => {
      for (const cleanup of cleanups) cleanup();
      host.dispose();
    },
  };
}
