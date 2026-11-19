import { localEdition } from "./app/edition";
import { allowQuickEntryDictationShortcut } from "./app/quick-access";
import { openOfficialWindowSettings } from "./official-ui/native/app-menu";
import { readDesktopPreferences, writeDesktopPreferences, type DesktopPreferences } from "./store/desktop-preferences";
import { NativeExtensionHost } from "./connectors/native-extension-host";
import { installEditContextMenu } from "./app/edit-context-menu";
import { emitPrivateDeviceEvent } from "./remote-control/device-public-projection";
import {
  keepCrashStack,
  recordGpuExit,
  startNativeCrashes,
} from "./support/native-crashes";
import { EmailSignInWindows } from "./account/email-sign-in-links";
import { NonessentialServices } from "./account/nonessential-services";
import { startAutoArchive } from "./conversations/auto-archive";
import { readDesktopArchivePullRequests } from "./conversations/auto-archive-pull-requests";
import { developerToolsAllowed } from "./store/developer-settings";
import { nativeTranslator } from "./app/native-i18n";
import { createCloudSync } from "./cloud/cloud-sync";
import { DeviceLink } from "./remote-control/device-link";
import { AccountDeviceStateCache } from "./remote-control/account-device-state";
import { DeviceMethods } from "./remote-control/device-methods";
import { createOfficialRemoteCodeHost } from "./remote-control/official-code";
import { DispatchReceipts } from "./remote-control/dispatch-delivery";
import { dispatchDeliverySend, remoteCodeSend } from "./ipc/conversation-turn-handlers";
import { CodeSendStart } from "./engine/code-send-start";
import {
  deviceLinkId,
  deviceName,
  renewDeviceLinkId,
} from "./remote-control/device-identity";
import { preference } from "../shared/settings-extras";
import { readChatGitHub } from "./git/chat-github";
import { applyHardwareAccelerationPreference } from "./support/troubleshooting";
import { desktopCredentialStorage } from "./account/desktop-credential-storage";
import { routineMailer } from "./routines/routine-mail";
import { uiSchemePrivileges } from "./ui-pack/launch";
import {
  app,
  crashReporter,
  BrowserWindow,
  safeStorage,
  protocol,
  webContents,
  type WebContents,
} from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { EngineRegistry } from "./engine/engine-registry";
import { TerminalController } from "./terminal/terminal-controller";
import { ArtifactPreviews } from "./artifacts/artifact-previews";
import { ArtifactPopouts } from "./artifacts/artifact-popouts";
import { resolveRequestLimits } from "../server/operator-limits";
import type { GatewayRefusal } from "../server/sub2api-errors";
import { publicSettingsOf } from "./store/settings-schema";
import { DesktopIntegration } from "./app/desktop-integration";
import { workspaceRepository } from "./git/git-branch";
import { pendingPolicy } from "../shared/client-policy";
import type {
  AppCommand,
  AppEvent,
  Attachment,
  EnvironmentRef,
  Settings,
  PublicAccount,
} from "../shared/types";
import {
  Listeners,
  type AppContext,
  type AppServices,
  type AppWindowRole,
  type AppWindows,
  type ReplyRated,
} from "./app/app-context";
import { weeklyUsageTurns } from "./ipc/usage";
import { type AccountLifecycle } from "./remote/host";
import { mainState } from "./app/main-state";
import { deactivateAccount, activateAccount } from "./app/account-lifecycle";
import { startApp } from "./app/start-app";
import { notifyOfficialConnectorAuthentication, refreshOfficialConnector } from "./official-ui/window";
import { createDesktopCloudCode } from "./official-ui/api/desktop-cloud-code";
import { registerAppWindow, loadRenderer } from "./app/app-window-registry";
import { openQuickEntry } from "./app/quick-entry-launch";
import { allowedFolder } from "./app/main-folders";
protocol.registerSchemesAsPrivileged([
  { scheme: "claudex-preview", privileges: { standard: true, secure: true } },
  // The window's own interface (docs/desktop-ui-hot-update.md).
  uiSchemePrivileges,
]);
export const artifactPreviews = new ArtifactPreviews();
// A link in a pop-out opens only after the main window confirms it (R-1061).
export const artifactPopouts = new ArtifactPopouts(artifactPreviews, (url) => {
  const main = appWindows.main();
  if (!main) return;
  main.show();
  main.focus();
  sendTo(main, { type: "external-link", url });
});
export const dirname = path.dirname(fileURLToPath(import.meta.url));
app.setName(localEdition ? "Claudex Local" : "Claudex Self-Hosted");
if (process.env.CLAUDEX_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.CLAUDEX_DATA_DIR));
let deviceDesktopPreferences: DesktopPreferences | undefined;
try {
  deviceDesktopPreferences = readDesktopPreferences(app.getPath("userData"));
} catch (error) {
  console.error("Desktop preferences could not be read:", error instanceof Error ? error.message : error);
}
export function getDeviceDesktopPreferences() {
  return deviceDesktopPreferences;
}
export function saveDeviceDesktopPreferences(preferences: DesktopPreferences) {
  writeDesktopPreferences(app.getPath("userData"), preferences);
  deviceDesktopPreferences = preferences;
}
export const desktopCredentials = desktopCredentialStorage(
  app.getPath("userData"),
  process.platform,
  safeStorage,
);
startNativeCrashes(crashReporter, app.getName(), app.getVersion());
// Native JS stacks (desktop 2.37337.1, index.pre.js:14814, 14999).
export const captureSessionStacks = (target: Electron.Session) => {
  target.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    const key =
      Object.keys(headers).find(
        (name) => name.toLowerCase() === "document-policy",
      ) ?? "Document-Policy";
    headers[key] = [
      ...(headers[key] ?? []),
      "include-js-call-stacks-in-crash-reports",
    ];
    callback({ responseHeaders: headers });
  });
};
app.on("session-created", captureSessionStacks);
const crashFeatures = app.commandLine
  .getSwitchValue("enable-features")
  .split(",")
  .filter(Boolean);
if (
  !crashFeatures.includes("DocumentPolicyIncludeJSCallStacksInCrashReports")
) {
  crashFeatures.push("DocumentPolicyIncludeJSCallStacksInCrashReports");
  app.commandLine.appendSwitch("enable-features", crashFeatures.join(","));
}
process.on("uncaughtExceptionMonitor", (error) =>
  keepCrashStack(app.getPath("crashDumps"), error),
);
process.on("unhandledRejection", (error) =>
  keepCrashStack(app.getPath("crashDumps"), error),
);
app.on("child-process-gone", (_event, details) => {
  try {
    recordGpuExit(crashReporter, details);
  } catch {}
});
// Help ▸ Troubleshooting ▸ Disable Hardware Acceleration, before the app is ready.
applyHardwareAccelerationPreference();
/** Scheduled-task e-mail for the signed-in account (electron/routine-mail.ts). */
export const routineMail = routineMailer(() =>
  mainState.remote?.ready && mainState.remoteAccounts?.baseUrl
    ? {
        baseUrl: () => mainState.remoteAccounts?.baseUrl,
        authorized: (call) => mainState.remote!.session.authorized(call),
      }
    : undefined,
);
/**
 * The main window's remembered state file (main-window-state.ts); the app
 * keeps running when the window is closed, so it is read at every launch.
 */
export const mainWindowFile = () =>
  path.join(app.getPath("userData"), "main-window.json");
export const selectedAttachments = new Map<string, Attachment>();
/** Chat, Cowork and GitHub Code conversations in the cloud (docs/cloud-sync.md). */
export const cloudSync = createCloudSync({
  baseUrl: () =>
    mainState.remote?.ready ? mainState.remoteAccounts?.baseUrl : undefined,
  session: () =>
    mainState.remote?.ready ? mainState.remote.session : undefined,
  enabled: () =>
    !!mainState.store && preference(mainState.store.settings, "cloudSync"),
  // Windows only: the main process's observers read the local store.
  push: (event) => {
    publish(event);
  },
  attachment: (id) => selectedAttachments.get(id),
  localStore: () => (mainState.activeAccount ? mainState.store : undefined),
  applyCodeSettings: (store, patch) => {
    if (mainState.accountRetirement.accountRetiring || !mainState.activeAccount || mainState.store !== store)
      return;
    const { codeBranchPrefix, prAutoArchive } = patch;
    if ((codeBranchPrefix === undefined || mainState.store.settings.codeBranchPrefix === codeBranchPrefix) &&
        (prAutoArchive === undefined || mainState.store.settings.prAutoArchive === prAutoArchive))
      return;
    const next = { ...mainState.store.settings, ...patch };
    mainState.store.write("settings.json", next);
    mainState.store.settings = next;
    sendSettings();
  },
  taskPermission: () =>
    mainState.activeAccount
      ? preference(mainState.store.settings, "taskPermission")
      : undefined,
});
/** The window's own handlers by name (before cloud routing): the device link's calls. */
export const localHandlers = new Map<string, (...args: any[]) => any>();
/** The same handlers after cloud routing (a cloud conversation's call goes to the cloud), for in-process callers. */
export const routedHandlers = new Map<string, (...args: any[]) => any>();
export async function routedCall(name: string, ...args: unknown[]) {
  const fn = routedHandlers.get(name) ?? localHandlers.get(name);
  if (!fn) throw new Error("This computer can't do that.");
  return fn(...args);
}
export async function localCall(name: string, ...args: unknown[]) {
  const fn = localHandlers.get(name);
  if (!fn) throw new Error("This computer can't do that.");
  return fn(...args);
}
/** The account's phones control this computer's Code conversations (remote-control/). */
export const accountDevices = new AccountDeviceStateCache(
  () => app.getPath("userData"),
  () => push({ type: "devices-changed" }),
);
export const currentAccountDevices = () =>
  accountDevices.current(
    mainState.activeAccount && mainState.store
      ? {
          profileRoot: mainState.store.root,
          accountScope: mainState.remote
            ? `${new URL(mainState.remote.accounts.baseUrl).origin}:${mainState.remote.session.userId}`
            : `local:${mainState.activeAccount.id}`,
          identity: {
            id: deviceLinkId(app.getPath("userData")),
            name: deviceName(),
            platform: process.platform,
            version: app.getVersion(),
          },
        }
      : undefined,
  );
export const deviceLink = new DeviceLink({
  statusChanged: () => push({ type: "devices-changed" }),
  trustStore: () => {
    try {
      return currentAccountDevices()?.trust;
    } catch (error) {
      console.error(
        "Device access policy:",
        error instanceof Error ? error.message : String(error),
      );
      return undefined;
    }
  },
  onlineChanged: () => integration.updateKeepAwake(),
  registrationObserved: (connected) => {
    try {
      currentAccountDevices()?.registration.observed(connected);
      push({ type: "devices-changed" });
    } catch (error) {
      console.error(
        "Device registration:",
        error instanceof Error ? error.message : String(error),
      );
    }
  },
  mobileNotifications: () =>
    !!mainState.store &&
    preference(mainState.store.settings, "dispatchMobileNotifications"),
  baseUrl: () =>
    mainState.remote?.ready ? mainState.remoteAccounts?.baseUrl : undefined,
  session: () =>
    mainState.remote?.ready && !mainState.accountRetirement.accountRetiring
      ? mainState.remote.session
      : undefined,
  enabled: () => !!mainState.activeAccount && !!mainState.store,
  computerAccess: () =>
    !!mainState.store && preference(mainState.store.settings, "computerAccess"),
  linkId: () => deviceLinkId(app.getPath("userData")),
  renewLinkId: () => void renewDeviceLinkId(app.getPath("userData")),
  name: deviceName,
  platform: process.platform,
  version: app.getVersion(),
  methods: new DeviceMethods(
    {
      officialCode: createOfficialRemoteCodeHost({
        account: () => {
          if (!mainState.activeAccount) throw Error("Sign in to Claudex again.");
          return mainState.activeAccount;
        },
        device: () => deviceLinkId(app.getPath("userData")),
        settings: () => mainState.store.settings,
        directory: () => mainState.store.root,
        viewerScope: () => mainState.store,
        conversations: () => mainState.store.conversations,
        approvals: () => mainState.engine.approvals,
        modelCatalog: (providerId) => {
          const remote = mainState.remote;
          return remote?.ready && remote.backend.provider?.id === providerId
            ? remote.modelCatalog()
            : null;
        },
        codeUltracodeAvailable: ({ environment, providerId, model }) =>
          environment?.kind !== "ssh" &&
          environment?.kind !== "wsl" &&
          mainState.engine.codeUltracodeAvailable(providerId, model),
        assertFolder: (cwd) => {
          if (!fs.statSync(cwd).isDirectory()) throw Error("This Remote Control folder is unavailable.");
          ctx.services.workspaceTrust?.assert({ mode: "code", cwd });
        },
        create: (conversation) => {
          const store = mainState.store;
          store.write("conversations.json", [conversation, ...store.conversations.filter((c) => !c.incognito)]);
          store.conversations.unshift(conversation);
          push({ type: "conversation", conversation: structuredClone(conversation) });
        },
        send: (input, eventId, current) => localCall("send", input, {
          [remoteCodeSend]: { eventId, current, start: new CodeSendStart() },
        }),
        update: (id, changes) => localCall("updateConversation", id, changes),
        delete: (id, current) => localCall("deleteConversation", id, current),
        saveCodeFlags: (conversation, choice, current) =>
          localCall(
            "updateConversation",
            conversation.id,
            {
              model: {
                version: 1,
                expected: {
                  providerId: conversation.providerId,
                  model: conversation.model,
                  effort: conversation.effort ?? null,
                  codeUltracode: conversation.codeUltracode ?? false,
                },
                choice,
              },
            },
            current,
          ),
        interrupt: async (id, target) => {
          const result: unknown = await localCall("interrupt", id, target);
          if (result && typeof result === "object" && "status" in result &&
              (result.status === "accepted" || result.status === "mismatch" || result.status === "already_finished"))
            return { status: result.status };
          throw Error("This computer couldn't confirm the stop.");
        },
        approve: (id, response) => localCall("approve", id, response),
      }),
      addAttachment: (name, data) => localCall("addAttachmentData", name, data),
      dispatchPreferences: async (enabled) => {
        if (enabled !== undefined)
          await localCall("saveSettings", {
            ...mainState.store.settings,
            dispatchMobileNotifications: enabled,
          });
        return preference(
          mainState.store.settings,
          "dispatchMobileNotifications",
        );
      },
      conversations: () =>
        mainState.activeAccount && mainState.store
          ? mainState.store.conversations
          : [],
      approvals: () =>
        mainState.activeAccount && mainState.engine
          ? mainState.engine.approvals
          : [],
      send: async (input, deliveryId, deliveryCurrent) => {
        const store = mainState.store;
        const activation = mainState.accountRetirement.accountActivationIdentity;
        const current = () =>
          mainState.store === store &&
          mainState.accountRetirement.accountActivationIdentity === activation &&
          !mainState.accountRetirement.accountRetiring &&
          (!deliveryCurrent || deliveryCurrent());
        if (!current()) throw Error("Device access changed. Try again.");
        // DeviceMethods passes a folder only after checking it against the
        // folders added for phones: adding one is choosing it with the picker.
        if (input.cwd) selectedFolders.add(input.cwd);
        if (input.cwd && input.mode === "cowork")
          await localCall("grantCoworkFolder", input.cwd, "session");
        if (!current()) throw Error("Device access changed. Try again.");
        return deliveryId
          ? localCall("send", input, { [dispatchDeliverySend]: { id: deliveryId, current } })
          : localCall("send", input);
      },
      interrupt: (id, expected) => localCall("interrupt", id, expected),
      approve: (id, result) => localCall("approve", id, result),
      remoteFolders: () =>
        mainState.activeAccount && mainState.store
          ? preference(mainState.store.settings, "remoteFolders")
          : [],
      models: () => {
        const providers =
          mainState.activeAccount && mainState.store
            ? mainState.store.settings.providers
            : [];
        const models = providers.flatMap((p) =>
          [...new Set([p.model, ...p.models])]
            .filter((id) => id && !id.toLowerCase().startsWith("gpt-image-"))
            .map((id) => ({ providerId: p.id, id })),
        );
        const active = providers.find(
          (p) => p.id === mainState.store?.settings.activeProviderId,
        );
        const fallback = active
          ? models.find(
              (m) => m.providerId === active.id && m.id === active.model,
            )
          : undefined;
        return {
          models,
          ...((fallback ?? models[0])
            ? { default: fallback ?? models[0] }
            : {}),
        };
      },
      update: (id, patch) => localCall("updateConversation", id, patch),
      now: Date.now,
      computerAccess: () =>
        !!mainState.store &&
        preference(mainState.store.settings, "computerAccess"),
      accountGeneration: () => mainState.accountRetirement.accountActivationIdentity,
      codeEnabled: () =>
        !!mainState.store &&
        preference(mainState.store.settings, "remoteControl"),
      chatDevice: {
        scope: () => mainState.store,
        accountScope: () =>
          mainState.remote?.ready && mainState.remote.session
            ? String(mainState.remote.session.userId)
            : undefined,
        save: async (conversation) => {
          if (!mainState.activeAccount || !mainState.store)
            throw new Error("Sign in to Claudex again.");
          conversation.cwd ??= path.join(
            mainState.store.root,
            "workspace",
            "chat-devices",
            conversation.id,
          );
          conversation.environment = { kind: "local" };
          const index = mainState.store.conversations.findIndex(
            (c) => c.id === conversation.id,
          );
          if (index < 0) mainState.store.conversations.unshift(conversation);
          else mainState.store.conversations[index] = conversation;
          mainState.store.flush();
          return conversation;
        },
        release: (id) => localCall("releaseRunner", id),
        releaseCowork: (conversation) => mainState.store.releaseCoworkDeviceBinding(conversation),
        blob: async (digest) =>
          new Uint8Array(
            await fs.promises.readFile(
              path.join(mainState.store.root, "generated-files", digest),
            ),
          ),
      },
    },
    new DispatchReceipts(() => mainState.store.root),
  ),
  log: (message) => console.warn(message),
});
export const selectedFolders = new Set<string>();
/** Remote folders chosen on each SSH host this session (R9). */
export const remoteFolders = new Map<string, Set<string>>();
/** Every engine of the signed-in account; the local one until R9-S3. */
const engines = new EngineRegistry(() => mainState.engine);
/** Services round-two packages share through the context (app-context.ts). */
export const services: AppServices = {
  dispatch: {
    retry: () => {
      deviceLink.disconnect();
      deviceLink.refresh();
    },
    status: () => deviceLink.status(),
    call: (method, args) => deviceLink.callLocal(method, args),
  },
  readChatGitHub: (input) =>
    cloudSync.readChatGitHub(input) ?? readChatGitHub(input),
};
/** Notifications, keep-awake, menu bar and Quick access (Settings). */
let quickDictationRequest = 0;
export const integration = new DesktopIntegration({
  keptAwake: (id, heldMs) => {
    const conversation = mainState.store?.conversations.find(
      (item) => item.id === id,
    );
    if (!conversation || !mainState.activeAccount) return;
    conversation.keptAwake = { heldMs, endedAt: Date.now() };
    mainState.store.schedule();
    push({ type: "conversation", conversation: structuredClone(conversation) });
  },
  suppressed: (reason, conversationId) =>
    console.debug("notification_suppressed", { reason, conversationId }),
  remoteServing: () =>
    !!mainState.activeAccount && !mainState.accountRetirement.accountRetiring &&
    mainState.remote?.ready === true && deviceLink.connected &&
    preference(mainState.store.settings, "remoteControl"),
  // Any focused app window counts as the app being in front (R2).
  window: () => appWindows.focused() ?? mainState.window,
  settings: () =>
    mainState.activeAccount ? mainState.store?.settings : undefined,
  devicePreferences: () => getDeviceDesktopPreferences() ?? {},
  conversations: () =>
    mainState.activeAccount ? mainState.store.conversations : [],
  command: (command, extra) =>
    mainState.window?.webContents.send("app:event", {
      type: "command",
      command,
      ...extra,
    }),
  // The tray menu lists the plan and the last weekly usage the window was told.
  trayStatus: () =>
    mainState.activeAccount
      ? {
          plan: policy().planLabel ?? mainState.activeAccount.plan,
          usagePercent: mainState.trayUsagePercent,
          usageUnavailable: mainState.trayUsageUnavailable,
        }
      : undefined,
  // A permission banner's Allow once answers as the card's button does.
  respond: (id, result) => localCall("approve", id, result),
  // A Code banner is titled with the session's repository, as the original's.
  repoName: (cwd) => workspaceRepository(cwd)?.split("/").at(-1),
  trayIcon: DesktopIntegration.trayIconPath(
    app.isPackaged ? process.resourcesPath : undefined,
    dirname,
  ),
  quickEntry: () => openQuickEntry(),
  quickEntryDictation: (action) => {
    const request = ++quickDictationRequest;
    if (action === "stop") return openQuickEntry(action);
    const owner = mainState.activeAccount;
    const generation = mainState.accountRetirement.accountActivationIdentity;
    if (!owner) return;
    const shortcut = preference(mainState.store.settings, "quickEntryDictationShortcut");
    const openSettings = () => {
      openOfficialWindowSettings(appWindows.main());
    };
    void allowQuickEntryDictationShortcut(shortcut, { openSettings }).then((allowed) => {
      if (allowed && request === quickDictationRequest && owner === mainState.activeAccount &&
          generation === mainState.accountRetirement.accountActivationIdentity &&
          shortcut === preference(mainState.store.settings, "quickEntryDictationShortcut"))
        openQuickEntry(action);
    }).catch((error: unknown) => console.error("Could not start dictation:", error));
  },
});
export const policy = () => mainState.policyHost?.current() ?? pendingPolicy;
export const focusListeners = new Listeners<void>();
export const refusalListeners = new Listeners<GatewayRefusal>();
export const ratingListeners = new Listeners<ReplyRated>();
const eventListeners = new Listeners<AppEvent>();
/** The app's event stream for in-process consumers (the official-interface adapter). */
export const onAppEvent = (listener: (event: AppEvent) => void) => eventListeners.add(listener);
// Local events phones should know go out over the device link.
eventListeners.add((event) => deviceLink.observe(event));
eventListeners.add((event) => {
  if (event.type === "weekly-usage") {
    mainState.trayUsagePercent = event.status?.percent;
    mainState.trayUsageUnavailable = event.unavailable === true;
  }
  // A session's Keep computer awake switch, or a session deleted.
  if (event.type === "conversation" || event.type === "resync")
    integration.refreshKeepAwake();
});
export const settingsListeners = new Listeners<Settings>();
export const activatedListeners = new Listeners<PublicAccount>();
export const deactivatingListeners = new Listeners<void>();
export const nonessentialServices = new NonessentialServices(process.platform);
export const refreshNonessentialServices = () =>
  nonessentialServices.update(
    mainState.store?.settings.disableNonessentialServices === true,
  );
settingsListeners.add(refreshNonessentialServices);
activatedListeners.add(refreshNonessentialServices);
deactivatingListeners.add(() => nonessentialServices.update(false));
deactivatingListeners.add(() => integration.refreshKeepAwake());
const codeVisibility = new Map<BrowserWindow, Set<string>>();
const codeArchiveHolds = new Set<(id: string) => boolean>();
export function registerOfficialCodeArchiveHold(held: (id: string) => boolean) {
  codeArchiveHolds.add(held);
  return () => { codeArchiveHolds.delete(held); };
}
export function setOfficialCodeManualKeepAwake(id: string, enabled: boolean) {
  if (!mainState.activeAccount || mainState.accountRetirement.accountRetiring) return;
  const conversation = mainState.store.conversations.find(row => row.id === id);
  if (!conversation || conversation.mode !== "code" || conversation.archived ||
      conversation.incognito || conversation.environment?.kind === "space") return;
  const holds = integration.manualCodeKeepAwake;
  if (holds.has(id) === enabled) return;
  if (enabled) holds.add(id);
  else holds.delete(id);
  integration.updateKeepAwake();
  publish({ type: "conversation", conversation: structuredClone(conversation) });
}
export function setOfficialCodeVisibility(win: BrowserWindow, id: string, visible: boolean) {
  if (!mainState.activeAccount || mainState.accountRetirement.accountRetiring || win.isDestroyed())
    return;
  const store = mainState.store;
  const conversation = store.conversations.find(row => row.id === id && row.mode === "code" && !row.incognito);
  const ids = codeVisibility.get(win);
  if (!visible) {
    ids?.delete(id);
    return;
  }
  if (!conversation) return;
  if (!ids) {
    codeVisibility.set(win, new Set([id]));
    win.once("closed", () => { codeVisibility.delete(win); });
  } else ids.add(id);
  conversation.codeLastFocusedAt = Date.now();
  store.schedule();
}
activatedListeners.add(() => {
  mainState.autoArchive?.stop();
  const store = mainState.store;
  const account = mainState.activeAccount;
  const current = () => mainState.store === store && mainState.activeAccount === account &&
    !mainState.accountRetirement.accountRetiring;
  const held = (id: string) =>
    integration.manualCodeKeepAwake.has(id) ||
    [...codeVisibility.values()].some(ids => ids.has(id)) ||
    [...codeArchiveHolds].some(check => check(id)) ||
    mainState.engine.approvals.some(approval => approval.conversationId === id) ||
    !!mainState.terminals?.busy(id).length;
  mainState.autoArchive = startAutoArchive({
    settings: () => store.settings,
    conversations: () => current() ? store.conversations : [],
    held: (id) => held(id) || store.conversations.some(child => child.parentSessionId === id &&
      !child.archived && (child.pinned || held(child.id) || child.turns.some(turn => turn.status === "inProgress"))),
    pull: async (c) => {
      const previous = c.pullRequests;
      const refreshed = await readDesktopArchivePullRequests(c);
      const result = refreshed?.filter(pr => !pr.dismissed);
      if (!current() || !store.conversations.includes(c) || c.pullRequests !== previous || !result) return;
      const next = [...(previous ?? []).filter(pr => pr.dismissed), ...result];
      if (JSON.stringify(previous?.map(({ checkedAt, ...pr }) => pr)) !==
          JSON.stringify(next.map(({ checkedAt, ...pr }) => pr))) {
        if (c.codeAutoArchiveExempt && result.some(pr =>
          (pr.state === "open" || pr.state === "draft" || pr.state === "queued") &&
          !c.pullRequests?.some(old => old.number === pr.number && old.repository === pr.repository && old.state === pr.state)))
          delete c.codeAutoArchiveExempt;
        c.pullRequests = next;
        store.schedule();
        push({ type: "conversation", conversation: structuredClone(c) });
      }
      if (result.length && result.every(pr => pr.state === "merged" || pr.state === "closed"))
        return result.every(pr => pr.state === "merged") ? "merged" : "closed";
    },
    archive: (id, reason, eligible) => localCall("autoArchiveLocalCode", id, reason === "merged", eligible),
  });
});
deactivatingListeners.add(() => {
  mainState.autoArchive?.stop();
  mainState.autoArchive = undefined;
  codeVisibility.clear();
});
let archiveSettings: { days: number; pr: boolean } | undefined;
settingsListeners.add(settings => {
  const days = preference(settings, "autoArchiveDays");
  const pr = preference(settings, "prAutoArchive");
  if (archiveSettings?.days === days && archiveSettings.pr === pr) return;
  archiveSettings = { days, pr };
  void mainState.autoArchive?.check();
});
deactivatingListeners.add(() => { archiveSettings = undefined; });
/** The main window and every separate conversation window (R2). */
export const appWindowRoles = new Map<BrowserWindow, AppWindowRole>();
/** The app window whose bridge call is running. */
export const callerWindows = new AsyncLocalStorage<BrowserWindow>();
export const emailLinkWindows = new EmailSignInWindows<BrowserWindow>();
export function appWindowOf(contents: WebContents | null | undefined) {
  if (!contents) return undefined;
  for (const win of appWindowRoles.keys())
    if (!win.isDestroyed() && win.webContents === contents) return win;
}
/** Sends one app window an event, without main-process observers. */
export function sendTo(win: BrowserWindow, event: AppEvent) {
  if (!win.isDestroyed()) win.webContents.send("app:event", event);
}
export const appWindows: AppWindows = {
  main: () =>
    mainState.window && !mainState.window.isDestroyed()
      ? mainState.window
      : undefined,
  all: () => [...appWindowRoles.keys()].filter((win) => !win.isDestroyed()),
  roleOf: (contents) => {
    const win = appWindowOf(contents);
    return win && appWindowRoles.get(win);
  },
  focused: () => {
    const win = BrowserWindow.getFocusedWindow();
    return win && appWindowRoles.has(win) ? win : undefined;
  },
  register: registerAppWindow,
  webPreferences: () => ({
    preload: path.join(dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  }),
  load: async (win, query) => {
    await loadRenderer(win, query);
  },
  send: sendTo,
  closeConversationWindows: () => {
    for (const [win, role] of appWindowRoles)
      if (
        (role.kind === "conversation" || role.kind === "project") &&
        !win.isDestroyed()
      )
        win.close();
  },
};
/** A menu command goes to the focused app window (a separate window forwards what it cannot run). */
export function sendCommand(command: AppCommand) {
  const event: AppEvent = { type: "command", command };
  eventListeners.emit(event);
  const target = appWindows.focused() ?? appWindows.main();
  if (target) sendTo(target, event);
}
export function providerServiceScript() {
  return app.isPackaged
    ? path.join(
        process.resourcesPath,
        "provider-service",
        "provider-service.cjs",
      )
    : path.join(dirname, "../dist-server/provider-service.cjs");
}
export const string = z.string().min(1).max(500);
function publicSettings(): Settings {
  return publicSettingsOf(mainState.store.settings);
}
export function rendererSettings() {
  mainState.rendererBase = publicSettings();
  return mainState.rendererBase;
}
/** Sends an event to every app window and the main-process observers. */
export function push(event: AppEvent) {
  if (event.type === "code-files-written") {
    eventListeners.emit(event);
    return;
  }
  if (
    emitPrivateDeviceEvent(
      event,
      mainState.store?.conversations ?? [],
      (value) => eventListeners.emit(value),
    )
  )
    return;
  publish(cloudSync.localEvent(event));
}
function publish(event: AppEvent) {
  if (event.type === "schedules") integration.observeSchedules(event.schedules);
  if (event.type === "resync" || (event.type === "conversation" && event.conversation.archived))
    integration.updateKeepAwake();
  eventListeners.emit(event);
  for (const win of appWindows.all()) sendTo(win, event);
}
/** Tells the window (and main-process observers) about settings the main process changed. */
export function sendSettings() {
  if (!mainState.activeAccount) return;
  push({ type: "settings", settings: rendererSettings() });
  settingsListeners.emit(mainState.store.settings);
}
export function noActive() {
  if (engines.isBusy())
    throw new Error("Wait for or stop the running task first.");
}
/** The SSH host an environment names; undefined for this computer. */
export function sshHost(environment: EnvironmentRef | undefined) {
  return environment?.kind === "ssh" ? environment.hostId : undefined;
}
/** What every IPC domain and the remote host share (electron/app-context.ts). */
export const ctx: AppContext = {
  notifyOfficialConnectorAuthentication,
  refreshOfficialConnector,
  routineEmailAvailable: () => routineMail.available(),
  get store() {
    return mainState.store;
  },
  cloudProjectIds: () => cloudSync.router.projects,
  officialCodeHelperCloud() {
    const owner = mainState.activeAccount?.id;
    const store = mainState.store;
    const generation = mainState.accountRetirement.accountActivationIdentity;
    if (!owner || generation === undefined || mainState.accountRetirement.accountRetiring) return;
    return createDesktopCloudCode(cloudSync.officialCode, owner, () =>
      mainState.activeAccount?.id === owner && mainState.store === store &&
      mainState.accountRetirement.accountActivationIdentity === generation &&
      !mainState.accountRetirement.accountRetiring);
  },
  get engine() {
    return mainState.engine;
  },
  engines,
  get activeAccount() {
    return mainState.activeAccount;
  },
  get remote() {
    return mainState.remote;
  },
  get credentials() {
    return mainState.credentials;
  },
  get terminals() {
    if (
      !mainState.terminals &&
      !mainState.accountRetirement.accountRetiring &&
      mainState.store &&
      mainState.engine &&
      mainState.activeAccount
    )
      mainState.terminals = new TerminalController(
        mainState.store,
        mainState.engine,
        push,
      );
    return mainState.terminals;
  },
  get scheduler() {
    return mainState.scheduler;
  },
  get replyFeedback() {
    return mainState.replyFeedback;
  },
  get backgroundHistory() {
    return mainState.backgroundHistory;
  },
  get artifactShares() {
    return mainState.artifactShares;
  },
  get artifactLibrary() {
    return mainState.artifactLibrary;
  },
  get mcpConfig() {
    return mainState.mcpConfig;
  },
  get window() {
    // Dialog parents: the window whose bridge call is running, else the main one.
    return callerWindows.getStore() ?? mainState.window;
  },
  appWindows,
  services,
  get dataRoot() {
    return app.getPath("userData");
  },
  get appVersion() {
    return app.getVersion();
  },
  get providerServiceScript() {
    return providerServiceScript();
  },
  get accounts() {
    return mainState.accounts;
  },
  integration,
  artifactPreviews,
  artifactPopouts,
  selectedFolders,
  selectedAttachments,
  remoteFolders,
  allowedFolder,
  engineFor: (conversationId) => engines.forConversation(conversationId),
  callerWindow: () => callerWindows.getStore() ?? appWindows.main(),
  noActive,
  requestLimits: () =>
    resolveRequestLimits(app.getPath("userData"), mainState.activeAccount!.id),
  publicSettings,
  windowSettings: rendererSettings,
  settingsChanged: sendSettings,
  get accountActivationIdentity() {
    return mainState.accountRetirement.accountActivationIdentity;
  },
  get accountRetiring() {
    return mainState.accountRetirement.accountRetiring;
  },
  deactivate: deactivateAccount,
  policy,
  refreshPolicy: () => void mainState.policyHost?.source.refresh(),
  push,
  onWindowFocus: (cb) => focusListeners.add(cb),
  onAccountActivated: (cb) => {
    const remove = activatedListeners.add(cb);
    // A saved session is restored before the domains register: a callback
    // added while an account is signed in runs for it right away.
    const account = mainState.activeAccount;
    if (account)
      queueMicrotask(() => {
        if (mainState.activeAccount === account) cb(account);
      });
    return remove;
  },
  onAccountDeactivating: (cb) => deactivatingListeners.add(cb),
  onRefusal: (cb) => refusalListeners.add(cb),
  onReplyRated: (cb) => ratingListeners.add(cb),
  onEvent: (cb) => eventListeners.add(cb),
  onSettingsChanged: (cb) => settingsListeners.add(cb),
};
const extensionStorageProtected = () =>
  desktopCredentials.cipher.isEncryptionAvailable() &&
  (process.platform !== "linux" ||
    ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
      safeStorage.getSelectedStorageBackend(),
    ));
export const nativeExtensions = new NativeExtensionHost({
  ctx,
  cipher: {
    isEncryptionAvailable: extensionStorageProtected,
    recognizes: desktopCredentials.cipher.recognizes,
    encryptString(value) {
      if (!extensionStorageProtected())
        throw Error("Encrypted storage is required for extension settings.");
      return desktopCredentials.cipher.encryptString(value);
    },
    decryptString(value) {
      if (!extensionStorageProtected())
        throw Error("Encrypted storage is required for extension settings.");
      return desktopCredentials.cipher.decryptString(value);
    },
  },
  helperPath: path.join(
    path.dirname(providerServiceScript()),
    "mcp-stdio-wrapper.cjs",
  ),
  node: { executable: process.execPath, electron: true },
  systemDirs: () => ({
    HOME: app.getPath("home"),
    DESKTOP: app.getPath("desktop"),
    DOCUMENTS: app.getPath("documents"),
    DOWNLOADS: app.getPath("downloads"),
  }),
});
export const lifecycle: AccountLifecycle = {
  // The device link waits for the service session (remote.ready).
  ready: () => {
    deviceLink.refresh();
    void cloudSync.codeSettings.refresh().catch(() => {});
  },
  activate: activateAccount,
  deactivate: deactivateAccount,
};
/** Conversations with a turn in progress, so a finished turn refreshes the weekly usage banner. */
export const usageTurns = weeklyUsageTurns(ctx);
const developerSettingsFile = () =>
  path.join(app.getPath("userData"), "developer_settings.json");
installEditContextMenu(app, {
  allowed: () => developerToolsAllowed(developerSettingsFile(), policy()),
  inspectLabel: () => mainState.inspectLabel,
  translate: (value) => mainState.editTranslate(value),
});
ctx.onEvent((event) => {
  if (
    mainState.activeAccount &&
    (event.type === "settings" || event.type === "policy")
  )
    void nativeTranslator(preference(mainState.store.settings, "locale"))
      .then((translate) => {
        mainState.inspectLabel = translate("Inspect Element");
        mainState.editTranslate = translate;
      })
      .catch(console.error);
  if (
    event.type !== "policy" ||
    developerToolsAllowed(developerSettingsFile(), policy())
  )
    return;
  for (const contents of webContents.getAllWebContents())
    if (!contents.isDestroyed() && contents.isDevToolsOpened())
      contents.closeDevTools();
});
app.on("web-contents-created", (_event, contents) => {
  const devToolsAllowed = () =>
    developerToolsAllowed(developerSettingsFile(), policy());
  contents.on("devtools-opened", () => {
    if (!devToolsAllowed()) contents.closeDevTools();
  });
  contents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.key.toLowerCase() === "i" &&
      (input.meta || input.control) &&
      input.alt &&
      !input.shift &&
      devToolsAllowed()
    ) {
      event.preventDefault();
      contents.openDevTools({ mode: "undocked" });
    }
  });
});
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else startApp();
