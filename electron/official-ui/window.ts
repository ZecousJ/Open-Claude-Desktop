import { officialRendererPacks, watchOfficialRenderer } from "../ui-pack/official-launch";
import {
  isOwnedDesign,
  officialDesignArtifactRoute,
  officialDesignWorkspacePath,
  officialDesignWorkspaceDestination,
} from "../../shared/official-design-artifacts";
import { defaultClaudexServiceUrl } from "../../shared/claudex-service";
import { createOfficialBlankDesign, type OfficialDesignCreationInput } from "./design-creation";
import { openDesignWindow } from "./design-window";
import { organizationKnowledgeRequest } from "./api/organization-projects";
import { officialWindowPlacement, writeOfficialBootSurface } from "../app/official-startup-shell";
import { readMainWindowState, trackMainWindow, type MainWindowState } from "../app/main-window-state";
import type { StealthWindow } from "../updates/stealth";
import { createDesktopCloudCode } from "./api/desktop-cloud-code";
import { termsPath } from "../../shared/account-profile-api";
import { codeExecutionSettings } from "../../shared/code-session-permissions";
import { codeApprovalIsStopping } from "../engine/code-interrupt-scope";
import { ownedSideQuestionGateway } from "../engine/side-question-gateway-host";
import { installOfficialClipboardWritePermission } from "./clipboard-write-permission";
import { createOfficialDictation } from "./native/dictation";
import { DictationSessions, voiceAvailability } from "../voice/dictation";
import { createCommandDeclineHost } from "./command-decline-host";
import { chatComputerUseHost } from "./api/chat-computer-use";
import type { ComputerUseState } from "../../shared/computer-use";
import { engineChatElicitation } from "./api/chat-elicitation-engine";
import { availableChatPermissionModes } from "../../shared/chat-permission-mode";
import { createCodeCommandPermissionHost } from "./code-command-permission-host";
import { attachmentImageSize } from "./native/image-size";
import {accountBrowserStorage, prepareAccountBrowserStorage} from "./account-browser-storage";
import { restoreLegacyDrafts, type DraftDestination } from "./legacy-draft-migration";
import {createStaticArtifactPreviewHost} from "./preview/static-host";
import {openStaticArtifactPreview} from "./preview/static-session";
import { nativeTranslator } from "../app/native-i18n";
import { mainWindowChrome } from "../app/main-window-chrome";
import { quickEntryDictationSupported } from "../app/quick-access";
import { officialNativeQuickAccessAvailable } from "../app/official-native-quick-access";
import { computerUseFeatures } from "./native/computer-use";
import { browserPolicyOf } from "../../shared/client-policy";
import { codeLimitAutoResumeFor } from "../engine/code-limit-auto-resume";
import { chromeExtensionControls } from "../browser/chrome-extension-registration";
import { applyZoom } from "../app/window-zoom";
import { gatewayCompleter } from "../memory/completion";
import { classicSourcesForMelange, readyMelangeForAccount } from "../memory/melange-host";
import { preference } from "../../shared/settings-extras";
import { connectorUuid } from "./api/connector-auth";
import { loadKnowledgeOffer } from "../ipc/knowledge";
import { hiwonderKnowledgeAllowed } from "../../shared/knowledge-api";
import type { ApiManagement } from "../../shared/official-api-management";
import { pluginOrganizationServicePath } from "../../shared/official-plugin-organizations";
/**
 * The window that runs the official front-end against Claudex
 * (docs/official-ui-client.md): its own session partition carrying the launch
 * cookie, the official preload with the recorded desktop capabilities, the
 * official window manager for popups, and no network beyond the loopback
 * origin. Packaged clients use the bundled interface.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import {
  app,
  dialog,
  BrowserWindow,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
} from "electron";
import { connectorSignInUrl } from "../connectors/connector-owner";
import { mainState } from "../app/main-state";
import { clampOfficialLayoutToDisplays, SessionPopouts } from "../app/session-popouts";
import { WindowLayoutCommands } from "../app/window-layout";
import type { LayoutCommand } from "../../shared/window-layout";
import { retireQuickEntry } from "../app/quick-entry-launch";
import { readDesktopArchivePullRequests } from "../conversations/auto-archive-pull-requests";
import { persistEmptyChat } from "./api/chat-creation";
import { conversationPageId } from "./api/conversations";
import { cloudCodeSessionKey, isOwnedCloudCoworkSession } from "./api/cloud-code-history";
import { isOwnedCloudCodeSession } from "./api/code-session-ownership";
import { createOfficialRemoteCodeController } from "../../shared/official-remote-code-controller";
import type { DeviceInfo } from "../../shared/remote-devices";
import {
  dirname,
  mainWindowFile,
  localCall,
  onAppEvent,
  push,
  routedCall,
  selectedFolders,
  callerWindows,
  ctx,
  deactivatingListeners,
  cloudSync,
  deviceLink,
  integration,
  registerOfficialCodeArchiveHold,
  setOfficialCodeManualKeepAwake,
  setOfficialCodeVisibility,
} from "../main";
import {
  checkoutContents,
  evalInCheckoutWindow,
  openCheckoutWindow,
} from "./checkout-window";
import type { Conversation, Snapshot } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { createNativeAccountApi } from "./api/native-account-api";
import { codeMcpAppAllowsTool } from "./api/code-mcp-app-scope";
import { ensureFileRegistry } from "./api/files";
import { inAdapterScope, newAdapterScope, type AdapterScope } from "./api/scope";
import { onAccountTransition, pendingAccountTransitions, signingOut } from "../app/account-transition-events";
import { coverSigningOutWindow } from "../app/sign-in-handoff";
import { createRetirementCoordinator } from "./retirement-coordinator";
import { createOfficialActivationLease, type OfficialActivationLease } from "./activation-lease";
import { authorizeRetiredTerminalResponse } from "./response-lease";
import { stageOfficialWindow } from "./staged-window";
import { createAccountSnapshotCache } from "./account-snapshot-cache";
import { setStateDir } from "./api/state";
import { officialStartupRoute } from "./startup-route";
import { organizationUuid, type AdapterContext } from "./api/context";
import { createNativeHost } from "./native/index";
import { officialLocale, officialLocaleMessages } from "./locale";
import type { OfficialQuickEntrySubmission } from "./native/quick-entry";
import { addDispatchFolder, changeDispatchTrust, readDispatchReceiving, removeDispatchFolder, setDispatchReceiving } from "./native/remote-control";
import type { DispatchAPI } from "../../shared/dispatch-api";
import { bindNativeCommandContext } from "./native-command-context";
import { remoteConnectorSkillsFor } from "../connectors/remote-skills";
import {nativePdfPreviewState,captureNativePdfPreview} from './native/pdf-preview';
import { createUserContentHandler, userContentOrigin } from "./usercontent";
import { createDocumentPreviewService, nativeDocumentPreviewMaxBytes } from "./document-preview";
import { convertOfficeDocument } from "../workspace/office-conversion";
import { openOfficialShareLink } from "./open-share-link";
import type { DeepLink } from "../../shared/deep-links";
import { officialDeepLinkRoute } from "./deep-link-route";
import {
  cookieName,
  startOfficialUiServer,
  type OfficialUiServer,
} from "./server";

const require = createRequire(import.meta.url);
interface ActivationRuntime {
  apiScope: AdapterScope;
  lease: OfficialActivationLease;
  storage: ReturnType<typeof accountBrowserStorage>;
  storageReady: Promise<void>;
  draftImport?: Promise<void>;
  preparations: Set<Promise<void>>;
  storageReleased?: boolean;
  storageFailed?: boolean;
  startupCloseFailed?: boolean;
  serverClosed?: boolean;
  session: Electron.Session;
  server?: OfficialUiServer;
  desktopCloudCode?: AdapterContext["officialDesktopCloudCode"];
  dictation?: ReturnType<typeof createOfficialDictation>;
  codeCommandPermissions?: AdapterContext["codeCommandPermissions"];
  starting?: Promise<OfficialUiServer>;
  windows: Set<BrowserWindow>;
  layout: SessionPopouts;
  layoutCommands: WindowLayoutCommands;
  layoutOwner?: BrowserWindow;
  retire(): void;
  retiredWindows: Set<BrowserWindow>;
  ownerIds: Set<number>;
  responsesDone?: Promise<unknown>;
  closing?: Promise<void>;
  managedInstances: Set<{ destroy(options: { emitClosed: boolean }): void }>;
}
let currentRuntime: ActivationRuntime | undefined;
let composerDictation: DictationSessions | undefined;
export function officialNativeDictationCredential() {
  const active = currentRuntime;
  return active?.server && active.dictation?.nativeCredential(active.server.origin) || null;
}
const retiredRuntimes = new Set<ActivationRuntime>();
const recoveryCoordinator = createRetirementCoordinator({
  pendingOperations: pendingAccountTransitions,
  hasActiveAccount: () => !!mainState.activeAccount,
  recover: (current) => showOfficialRecoveryWindow(current),
  diagnostic: () => console.error("Account interface recovery could not be confirmed."),
  mayReportStalled: () => !mainState.activeAccount || mainState.accountRetirement.accountRetiring,
  stalled: (current) => {
    const locale = mainState.store ? preference(mainState.store.settings, "locale") : "en-US";
    void nativeTranslator(locale).then(t => {
      if (!current()) return;
      return dialog.showMessageBox({
        type: "error",
        message: t("Account transition not confirmed"),
        detail: t("The account transition has not finished. The previous interface remains locked. No account action has been retried."),
      });
    }).catch(() => console.error("Account interface recovery could not be confirmed."));
  },
});
onAccountTransition((event) => {
  if (event.type === "deactivated" || event.type === "forced-signed-out") {
    for (const runtime of retiredRuntimes) {
      if (runtime.lease.identity.store !== event.store || runtime.lease.identity.generation !== event.generation) continue;
      if (event.type === "deactivated") recoveryCoordinator.deactivated(runtime);
      else recoveryCoordinator.signedOut(runtime);
    }
  } else if (event.type === "settled") {
    for (const runtime of retiredRuntimes)
      if (runtime.lease.identity.store === event.store && runtime.lease.identity.generation === event.generation) recoveryCoordinator.settled(runtime);
    recoveryCoordinator.poke();
  }
});
// Forced sign-out completion is bound to its captured Store, never inferred
// from a generic late renderer event without account identity.

function cleanupRetiredWindows(runtime: ActivationRuntime) {
  if (runtime.storageReleased) return;
  // The upstream manager indexes owner WebContents IDs. Remove only this
  // captured runtime's entries before fallible destruction; never global clear.
  for (const [key, record] of [...(windowManager?.pendingWindows ?? [])])
    if (ownsManagerRecord(runtime, record.ownerWebContentsId) && windowManager!.pendingWindows!.get(key) === record) windowManager!.pendingWindows!.delete(key);
  for (const [key, record] of [...(windowManager?.windows ?? [])]) {
    if (!ownsManagerRecord(runtime, record.ownerWebContentsId) || windowManager!.windows!.get(key) !== record) continue;
    windowManager!.windows!.delete(key);
    runtime.managedInstances.add(record.instance);
  }
  for (const instance of runtime.managedInstances) {
    try { instance.destroy({ emitClosed: false }); runtime.managedInstances.delete(instance); }
    catch { console.error("Retired managed window cleanup was not confirmed."); }
  }
  const windows = new Set([...runtime.retiredWindows, ...BrowserWindow.getAllWindows().filter(w => w.webContents.session === runtime.session)]);
  for (const win of windows) {
    if (win === mainState.window || win.isDestroyed()) continue;
    try { win.destroy(); } catch { console.error("Retired account window cleanup was not confirmed."); }
  }
  // Keep the old listener answering 410 while any old document remains alive.
  // Cross-account origins are never reused in this process; the same account
  // may reuse its origin only after the storage handoff confirms destruction.
  if (runtime.preparations.size || BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.webContents.session === runtime.session) || runtime.managedInstances.size) return;
  runtime.closing ??= (runtime.server?.close() ?? Promise.resolve()).then(() => {
    runtime.serverClosed = true;
    runtime.storageReleased = true;
    retiredRuntimes.delete(runtime);
    for (const id of runtime.ownerIds) if (managerOwnerBindings.get(id) === runtime) managerOwnerBindings.delete(id);
  }).catch(() => {
    runtime.closing = undefined;
    console.error("Retired account server cleanup was not confirmed.");
  });
}
export function isRetiredOfficialWindow(win: BrowserWindow | undefined) {
  return !!win && !win.isDestroyed() && !!windowRuntime.get(win.webContents) && !windowRuntime.get(win.webContents)!.lease.current();
}
export async function showOfficialRecoveryWindow(allowed: () => boolean = () => true) {
  const generation = mainState.accountRetirement.accountActivationIdentity;
  const store = mainState.store;
  const account = mainState.activeAccount?.id;
  const current = () => allowed() && !(mainState.activeAccount && mainState.accountRetirement.accountRetiring) && pendingAccountTransitions() === 0 &&
    mainState.accountRetirement.accountActivationIdentity === generation && mainState.store === store &&
    mainState.activeAccount?.id === account;
  if (!current()) return;
  if (account) await createOfficialWindow();
  else {
    const { createWindow } = await import("../app/main-window");
    if (!current()) return;
    await createWindow({ stage: { current } });
  }
  if (!current()) return;
  for (const runtime of retiredRuntimes) {
    await runtime.responsesDone;
    if (!current()) return;
    cleanupRetiredWindows(runtime);
  }
}
const windowRuntime = new WeakMap<Electron.WebContents, ActivationRuntime>();
function activeLayoutOwner() {
  const win = currentRuntime?.layoutOwner;
  if (win && !win.isDestroyed() && currentRuntime?.lease.current()) return win;
}

export function dispatchOfficialLayoutCommand(
  command: Omit<LayoutCommand, "requestId" | "deadline" | "mainWindowHidden">,
) {
  const win = activeLayoutOwner();
  const host = native?.host;
  if (!win || !host || mainState.window !== win || mainState.quitting) return;
  const runtime = windowRuntime.get(win.webContents);
  return runtime?.layoutCommands.dispatch(
    win.webContents,
    command,
    win.isMinimized() || !win.isVisible(),
    (request) => host.emitTo(win, "WindowLayout", "layoutCommand", request),
  );
}
const managerOwnerBindings = new Map<number, ActivationRuntime>();
function ownsManagerRecord(runtime: ActivationRuntime, ownerId: number) {
  return runtime.ownerIds.has(ownerId) && managerOwnerBindings.get(ownerId) === runtime;
}
const managerOrigins: string[] = [];
const usedPorts = new Set<number>();
const portOwners = new Map<number, string>();
function activationIdentity() {
  return mainState.activeAccount && mainState.store ? {
    owner: mainState.activeAccount.id, store: mainState.store,
    generation: mainState.accountRetirement.accountActivationIdentity,
    active: mainState.accountRetirement.accountRetiring === false,
  } : undefined;
}
function runtimeForAccount(): ActivationRuntime {
  if (currentRuntime?.lease.current() && !currentRuntime.storageFailed) return currentRuntime;
  currentRuntime?.retire();
  const identity = activationIdentity();
  if (!identity) throw new Error("Sign in to open the interface.");
  const lease = createOfficialActivationLease(identity, activationIdentity);
  const storage = accountBrowserStorage(identity.owner, mainState.store.root, app.getPath("userData"));
  const layoutFile = path.join(mainState.store.root, "official-ui", "session-popouts.json");
  const previous = [...retiredRuntimes].filter(r => r.storage.key === storage.key);
  const runtime: ActivationRuntime = {
    lease, storage, storageReady: Promise.resolve(), preparations: new Set(), session: session.fromPartition(storage.partition), windows: new Set(),
    layout: new SessionPopouts(() => layoutFile), layoutCommands: new WindowLayoutCommands(),
    retiredWindows: new Set(), ownerIds: new Set(), managedInstances: new Set(), retire() {},
    apiScope: newAdapterScope(identity.owner, mainState.store.root, identity.store),
  };
  currentRuntime = runtime;
  let retired = false;
  const retire = (discardLayout = false) => {
    if (retired) return;
    retired = true;
    if (discardLayout) runtime.layout.discard();
    runtime.layoutCommands.dispose();
    lease.retire();
    if (runtime.server) {
      const index = managerOrigins.indexOf(runtime.server.origin);
      if (index >= 0) managerOrigins.splice(index, 1);
    }
    stop();
    retiredRuntimes.add(runtime);
    for (const [key, record] of [...(windowManager?.pendingWindows ?? [])])
      if (ownsManagerRecord(runtime, record.ownerWebContentsId) && windowManager!.pendingWindows!.get(key) === record) windowManager!.pendingWindows!.delete(key);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.session !== runtime.session || win.isDestroyed()) continue;
      runtime.retiredWindows.add(win);
      let covered = false;
      if (!mainState.quitting && signingOut() && win === mainState.window && win.isVisible() && !win.isMinimized()) {
        try {
          coverSigningOutWindow(win, nativeTheme.shouldUseDarkColors);
          covered = true;
        } catch { console.error("Sign-out window cover could not be shown."); }
      }
      try { win.setEnabled(false); } catch { console.error("Retired account window disable was not confirmed."); }
      if (!covered) {
        try { win.hide(); } catch { console.error("Retired account window hide was not confirmed."); }
      }
    }
    runtime.responsesDone = lease.settleResponses(5000).then((outcome) => {
      if (outcome.timedOut || outcome.unconfirmed)
        console.error("Retired account response handoff was not confirmed; its own responses were closed.");
    });
    recoveryCoordinator.retire(runtime, runtime.responsesDone);
    // Revoke authority now, but preserve the existing logout response/window
    // until the host-owned transition coordinator can complete its handoff.
    for (const win of runtime.windows) {
      if (officialWindows.get(win.webContents.id) === win) officialWindows.delete(win.webContents.id);
      try { native?.host.detach(win); }
      catch { console.error("Official native window cleanup was not confirmed."); }
    }
  };
  const stop = deactivatingListeners.add(() => retire(!mainState.quitting));
  runtime.retire = retire;
  runtime.storageReady = prepareAccountBrowserStorage(previous.map(old => ({
    settle: () => old.responsesDone ?? Promise.resolve(),
    closePending: async () => {
      await Promise.all([...old.preparations]);
      try { await old.starting; } catch { if (old.startupCloseFailed) throw new Error("Retired account server cleanup was not confirmed."); }
    },
    destroy: () => {
      cleanupRetiredWindows(old);
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.webContents.session === old.session && !win.isDestroyed()) win.destroy();
      }
    },
    hasDocuments: () => old.managedInstances.size > 0 || BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.webContents.session === old.session),
    closeServer: async () => {
      await old.closing;
      if (!old.serverClosed) { await old.server?.close(); old.serverClosed = true; }
      old.storageReleased = true; retiredRuntimes.delete(old);
    },
  })), () => lease.current());
  // A failed barrier is observed by every window creation, never detached rejection.
  void runtime.storageReady.catch(() => { runtime.storageFailed = true; });
  return runtime;
}
const previewProtocols = new WeakSet<Electron.Session>();
const documentRuntime = process.platform === "linux"
  ? "/usr/lib/libreoffice"
  : app.isPackaged
    ? path.join(process.resourcesPath, "document-runtime")
    : path.join(app.getAppPath(), "build", process.platform === "win32" ? "document-runtime-win" : "document-runtime");
const documentPreview = createDocumentPreviewService({
  maxBytes: nativeDocumentPreviewMaxBytes,
  currentSession: () => mainState.activeAccount ? mainState.store : undefined,
  convert: (data, extension, signal) => convertOfficeDocument({
    runtime: documentRuntime, data, extension, output: "pdf", signal,
  }),
});

/** The official manager's auxiliary windows can hide on close and veto app.quit. */
export function prepareOfficialUiQuit() {
  retireQuickEntry();
  windowManager?.destroy();
}

/**
 * End-to-end test runs (tests/official-ui-e2e): windows stay hidden and never
 * take focus, extra windows can be opened through the debug channel, and a
 * signed-out start exits instead of showing the sign-in window.
 */
export function officialUiE2e() {
  return process.env.CLAUDEX_OFFICIAL_UI_E2E === "1";
}

/** build/official-ui in development, resources/official-ui when packaged. */
export function officialUiRoot() {
  const candidates = [
    process.env.CLAUDEX_OFFICIAL_UI_ROOT,
    app.isPackaged
      ? path.join(process.resourcesPath, "official-ui")
      : undefined,
    path.join(dirname, "../build/official-ui"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) =>
    fs.existsSync(path.join(p, "ui", "index.html")),
  );
  if (!found)
    throw new Error(
      "The official interface bundle is missing; run `node scripts/build-official-ui.mjs`.",
    );
  return found;
}

/** Merged reads/ratings are scoped to the actual owner, store and activation. */
const snapshotCache = createAccountSnapshotCache({
  current: () => ({
    owner: mainState.activeAccount?.id,
    store: mainState.store,
    generation: mainState.accountRetirement.accountActivationIdentity,
    active: mainState.accountRetirement.accountRetiring === false,
  }),
  read: () => routedCall("snapshot") as Promise<Snapshot>,
});
let snapshotWatch: (() => void) | undefined;
function readSnapshot(fresh = false): Promise<Snapshot> {
  snapshotWatch ??= onAppEvent(() => snapshotCache.invalidate());
  return snapshotCache.read(fresh);
}

function reactConversationDrafts(runtime: ActivationRuntime, ids: string[]) {
  const owner = runtime.lease.identity.owner;
  const router = cloudSync.router;
  const local = new Map(mainState.store.conversations.map((c) => [c.id, c]));
  const remote = new Map(router.last?.conversations.map((c) => [c.id, c]));
  const destinations = new Map<string, DraftDestination>();
  for (const id of ids) {
    const cloud = router.isCloudConversation(id);
    const conversation = cloud ? remote.get(id) : local.get(id);
    if (!conversation) continue;
    const route = officialDeepLinkRoute({ kind: "conversation", id }, owner, {
      conversations: [conversation],
      approvals: [],
    });
    if (route === "/recents") continue;
    if (conversation.mode === "code") {
      if (!cloud && route.startsWith("/epitaxy/local_"))
        destinations.set(id, { kind: "code", id: `epitaxy-local_${id}` });
      else if (cloud && isOwnedCloudCodeSession(conversation, owner))
        destinations.set(id, {
          kind: "code",
          id: `epitaxy-session_${cloudCodeSessionKey(conversation, owner)}`,
        });
    } else if (!cloud && route.startsWith("/cowork/local_"))
      destinations.set(id, { kind: "chat", id: `local_${id}` });
    else if (cloud && isOwnedCloudCoworkSession(conversation, owner))
      destinations.set(id, {
        kind: "chat",
        id: `session_${cloudCodeSessionKey(conversation, owner)}`,
      });
    else
      destinations.set(id, {
        kind: "chat",
        id: inAdapterScope(runtime.apiScope, () => conversationPageId(id)),
      });
  }
  return destinations;
}

function adapterContext(root: string, ownerRuntime?: ActivationRuntime): AdapterContext {
  const officialRemoteControlOrigin = () => {
    const service = ctx.remote?.ready ? ctx.remote.accounts.baseUrl : undefined;
    if (!service) return undefined;
    return process.env.CLAUDEX_OFFICIAL_DISPATCH_WEB_ORIGIN ||
      (new URL(service).origin === "https://claudex.zecous.cn" ? "https://test-claudex.zecous.cn" : undefined);
  };
  return {
    get designArtifacts() {
      const runtime = ownerRuntime ?? currentRuntime;
      const store = ctx.store;
      const current = () => Boolean(runtime?.lease.current()) && !ctx.accountRetiring &&
        ctx.store === store;
      if (!current()) return undefined;
      const { providers, activeProviderId } = store.settings;
      const provider = providers.find(candidate => candidate.id === activeProviderId) ?? providers[0];
      if (!provider?.model) return undefined;
      return {
        async create(input: OfficialDesignCreationInput) {
          if (!current()) throw Error("The account changed.");
          const result = await createOfficialBlankDesign(input, [provider],
            args => routedCall("createBlankArtifact", args));
          if (!current()) throw Error("The account changed.");
          return result;
        },
      };
    },
    get officialDesktopCloudCode() {
      const runtime = ownerRuntime ?? currentRuntime;
      return runtime?.lease.current() ? runtime.desktopCloudCode : undefined;
    },
    officialRemoteControlOrigin,
    async deviceRegistryRequest(request) {
      const { remote } = ctx;
      const runtime = currentRuntime;
      const current = () => !!runtime?.lease.current() && ctx.remote === remote && !ctx.accountRetiring;
      if (!remote?.ready || !current())
        throw new DOMException("The active account changed.", "AbortError");
      const route = "/claudex/signing-devices" +
        ("id" in request ? "/" + encodeURIComponent(request.id) : request.method === "GET" && request.forRemoval ? "?for_removal=true" : "");
      return remote.session.authorized((token) => remote.backend.client.call(route, {
        token,
        method: request.method,
        ...("body" in request && { body: request.body }),
      }), current);
    },
    async readPluginOrganization(target) {
      const { remote } = ctx;
      const runtime = currentRuntime;
      const current = () => !!runtime?.lease.current() && ctx.remote === remote && !ctx.accountRetiring;
      if (!remote?.ready || !current())
        throw new DOMException("The active account changed.", "AbortError");
      const route = pluginOrganizationServicePath(target);
      return await remote.session.authorized((token) => remote.backend.client.call(route, { token }), current);
    },
    get organizationProjects(): AdapterContext["organizationProjects"] {
      const { remote } = ctx;
      const runtime = currentRuntime;
      const current = () => !!runtime?.lease.current() && ctx.remote === remote && !ctx.accountRetiring;
      if (!remote?.ready || !current()) return undefined;
      const configuredOrigin = officialRemoteControlOrigin() ?? remote.accounts.baseUrl;
      const share = URL.canParse(configuredOrigin) ? new URL(configuredOrigin) : undefined;
      return {
        baseUrl: remote.accounts.baseUrl,
        shareOrigin: share && (share.protocol === "https:" || share.hostname === "127.0.0.1") ? share.origin : undefined,
        call: (route, method, body) => remote.session.authorized(token =>
          remote.backend.client.call(route, { token, method, body }), current),
        readKnowledge: route => remote.session.authorized(token =>
          organizationKnowledgeRequest(remote.backend.client, token, route), current),
        uploadKnowledge: (route, bytes, mediaType) => remote.session.authorized(token =>
          organizationKnowledgeRequest(remote.backend.client, token, route, { bytes, mediaType }), current),
      };
    },
    setOrganizationPluginEnabled: (id, enabled) => localCall("setOrganizationPluginEnabled", id, enabled),
    removeOrganizationPlugin: (id) => localCall("removeOrganizationPlugin", id),
    readOrganizationPluginStates: (candidates) => localCall("readOrganizationPluginStates", candidates),
    readOrganizationPluginDetails: (id) => localCall("readOrganizationPluginDetails", id),
    localRemoteControlStatus: () => ctx.remote?.ready ? deviceLink.remoteControlStatus() : undefined,
    get dispatch(): AdapterContext["dispatch"] {
      const runtime = currentRuntime;
      if (!ctx.remote?.ready || !runtime?.lease.current()) return undefined;
      const call = <Name extends keyof DispatchAPI>(name: Name, ...args: Parameters<DispatchAPI[Name]>) => {
        if (!runtime.lease.current()) throw new DOMException("The active account changed.", "AbortError");
        return localCall(name, ...args) as ReturnType<DispatchAPI[Name]>;
      };
      return {
        status: async (retry) => {
          const status = await call("dispatchStatus", retry);
          if (!status.local?.id || !runtime.lease.current()) return status;
          const officialOrigin = officialRemoteControlOrigin();
          if (!officialOrigin) return status;
          const phone = new URL("/cowork/agent", officialOrigin);
          phone.searchParams.set("device", status.local.id);
          return { ...status, phoneLink: phone.href };
        },
        tasks: (id) => call("dispatchTasks", id),
        directories: (id) => call("dispatchDirectories", id),
        deliver: (input) => call("dispatchDeliver", input),
        details: (input) => call("dispatchDetails", input),
        followUp: (input) => call("dispatchFollowUp", input),
        approve: (input) => call("dispatchApprove", input),
        interrupt: (input) => call("dispatchInterrupt", input),
        trust: (id) => call("dispatchTrust", id),
        retry: (id) => call("dispatchRetry", id),
        remove: (id) => call("dispatchRemove", id),
      };
    },
    get zecousMigration(): AdapterContext["zecousMigration"] {
      const runtime = currentRuntime;
      if (!ctx.remote?.ready || !runtime?.lease.current()) return undefined;
      const call = <Result,>(name: string, ...args: unknown[]) => {
        if (!runtime.lease.current()) throw new DOMException("The active account changed.", "AbortError");
        return localCall(name, ...args) as Promise<Result>;
      };
      return {
        status: (options) => call("officialZecousMigration", options?.refreshOnDone),
        confirm: () => call("officialConfirmZecousMigration"),
      };
    },
    get announcements(): AdapterContext["announcements"] {
      const runtime = currentRuntime;
      if (!ctx.remote?.ready || !runtime?.lease.current()) return undefined;
      const call = <Result,>(name: string, ...args: unknown[]) => {
        if (!runtime.lease.current()) throw new DOMException("The active account changed.", "AbortError");
        return localCall(name, ...args) as Promise<Result>;
      };
      return {
        notices: () => call("officialAnnouncements"),
        pending: () => call("officialPendingAnnouncements"),
        markRead: (id) => call("officialMarkAnnouncementRead", id),
        close: (id, action) => call("officialCloseAnnouncement", id, action),
      };
    },
    get serviceStatus(): AdapterContext["serviceStatus"] {
      const runtime = currentRuntime;
      if (!ctx.remote?.ready || !runtime?.lease.current()) return undefined;
      return async (query) => {
        if (!runtime.lease.current()) throw new DOMException("The active account changed.", "AbortError");
        return localCall("serviceStatus", query) as ReturnType<NonNullable<AdapterContext["serviceStatus"]>>;
      };
    },
    get apiManagement(): ApiManagement | undefined {
      const runtime = currentRuntime;
      const remote = ctx.remote;
      if (!remote?.ready || !runtime?.lease.current()) return undefined;
      const call = <Name extends keyof ApiManagement>(name: Name, ...args: Parameters<ApiManagement[Name]>) => {
        if (!runtime.lease.current()) throw new DOMException("The active account changed.", "AbortError");
        return localCall(name, ...args) as ReturnType<ApiManagement[Name]>;
      };
      return {
        balance: async () => {
          const { client, session } = remote.backend;
          const current = () => runtime.lease.current() && ctx.remote === remote;
          const profile = await session.authorized((token) => client.profile(token), current);
          if (!current()) throw new DOMException("The active account changed.", "AbortError");
          return profile.balance;
        },
        apiGroups: (fresh) => call("apiGroups", fresh),
        groupRates: () => call("groupRates"),
        apiKeys: () => call("apiKeys"),
        setApiGroup: (provider, group) => call("setApiGroup", provider, group),
        createApiKey: (input) => call("createApiKey", input),
        deleteApiKey: (id) => call("deleteApiKey", id),
        sendActionVerification: () => call("sendActionVerification"),
        confirmActionVerification: (code) => call("confirmActionVerification", code),
      };
    },
    webSearchAllowed: () => ctx.policy().webSearch,
    codeLimitAutoResume: codeLimitAutoResumeFor(ctx),
    codeLocalSandboxState: () => ({
      available: mainState.engine.environment.kind === "local",
      policyLocked: false,
      ...(process.platform === "win32" && { windowsInstalled: mainState.engine.windowsSandbox.isReady }),
    }),
    computerUseSettingsState: () => ctx.services.computerUse?.settingsState?.(),
    computerUseActivity: () => ctx.services.computerUse?.currentActivity?.() ?? null,
    revokeComputerUseGrant: async (id, appId) =>
      ctx.services.computerUse?.revokeGrant?.(id, appId),
    remoteReachabilityPreferenceAvailable: () =>
      mainState.remote?.ready === true && !mainState.accountRetirement.accountRetiring &&
      preference(mainState.store.settings, "remoteControl"),
    builtInBrowserSettingsAvailable: () =>
      !!mainState.activeAccount &&
      !mainState.accountRetirement.accountRetiring &&
      browserPolicyOf(ctx.policy()).enabled,
    chromeExtension: chromeExtensionControls(ctx),
    localMcpConfig: () => {
      const configured = mainState.store.settings.mcpServers;
      const runtime = JSON.parse(mainState.engine.mcpConfig()) as Record<string, unknown>;
      return JSON.stringify(Object.fromEntries(Object.entries(runtime).filter(([name]) => {
        const server = configured[name];
        return server && typeof server === "object" && "command" in server && typeof server.command === "string" && !("url" in server && server.url);
      })));
    },
    onAccountDeactivating: (listener) => deactivatingListeners.add(listener),
    artifactPublishing: () => ctx.services.sharing?.hosted,
    knowledgeOffer: async () => {
      const runtime = currentRuntime;
      if (!runtime?.lease.current() || mainState.accountRetirement.accountRetiring)
        return undefined;
      const offer = await loadKnowledgeOffer(ctx);
      return offer && runtime.lease.current() && !mainState.accountRetirement.accountRetiring &&
        hiwonderKnowledgeAllowed(ctx.policy(), offer.baseUrl)
        ? offer
        : undefined;
    },
    get allowDirectorySubmissions() {
      return !!ctx.remote?.ready && currentRuntime?.lease.current() === true;
    },
    get directoryTermsUrl() {
      return ctx.remote?.ready ? new URL(termsPath, ctx.remote.backend.accounts.baseUrl).href : undefined;
    },
    documentPreviewToken: () => documentPreview.issueToken(),
    documentRuntime,
    readWorkspaceDownload: (request) => cloudSync.readWorkspaceDownload(request),
    forwardOfficialCodeTrigger: (request) => cloudSync.forwardOfficialCodeTrigger(request),
    refreshOfficialCodeSettings: () => cloudSync.codeSettings.refresh(),
    saveOfficialCodeSettings: (patch) => cloudSync.codeSettings.save(patch),
    officialCodeSettingsCloudLinked: () => cloudSync.codeSettingsLinked(),
    root,
    melange: () => readyMelangeForAccount(ctx),
    memoryPreferenceActions: () => ctx.services.memory?.service.preferenceActions(),
    connectorAlwaysAllow: () => ctx.policy().approvalsAlwaysAllow,
    remoteConnectorSkills: () => remoteConnectorSkillsFor(mainState.store),
    readMemorySettings: () => ctx.services.memory?.service.readSettings() ?? Promise.resolve(undefined),
    classicMelangeSources: () => classicSourcesForMelange(ctx),
    account: () => mainState.activeAccount,
    locationMetadataAvailable: () => mainState.remote?.ready === true,
    browserAccountsAvailable: () => mainState.remote?.ready === true &&
      mainState.remoteAccounts?.canHoldAccounts === true,
    settings: () => mainState.store.settings,
    codeUltracodeAvailable: (providerId, model, id) => {
      if (!mainState.activeAccount || mainState.accountRetirement.accountRetiring) return false;
      const conversation = id ? mainState.store.conversations.find((row) => row.id === id) : undefined;
      if (id && (!conversation || conversation.mode !== "code" || conversation.cloudHosted ||
        conversation.environment?.kind === "wsl" || conversation.environment?.kind === "ssh")) return false;
      return mainState.engine.codeUltracodeAvailable(providerId, model);
    },
    defaultWorkspace: () => mainState.engine.defaultWorkspace,
    createEmptyChat: (input) => {
      const { check } = snapshotCache.capture();
      const store = mainState.store;
      return persistEmptyChat(input, store,
        () => {
          try { check(); return !mainState.accountRetirement.accountRetiring; }
          catch { return false; }
        },
        () => ({ cwd: mainState.engine.defaultWorkspace }),
        (conversation) => push({ type: "conversation", conversation: structuredClone(conversation) }),
      );
    },
    createScratchWorkspace: () => {
      if (!mainState.activeAccount) throw Error("Sign in to continue.");
      const cwd = path.join(
        mainState.engine.defaultWorkspace,
        "sessions",
        randomUUID(),
      );
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      selectedFolders.add(cwd);
      return { cwd };
    },
    stateDirectory: () => mainState.store.root,
    codeSessionEnvironmentStore: () => mainState.store,
    sessionIdentity: () => mainState.store,
    withOfficialApiScope: (operation) => {
      const runtime = currentRuntime;
      if (!runtime?.lease.current())
        throw Error("The account session changed. Reopen the window.");
      return inAdapterScope(runtime.apiScope, () => {
        ensureFileRegistry();
        return operation();
      });
    },
    isCurrent: () => mainState.accountRetirement.accountRetiring === false && !!mainState.activeAccount,
    listConversations: async () => (await readSnapshot()).conversations,
    localListConversations: async () =>
      structuredClone(mainState.store.conversations.filter(
        (c) => c.mode !== "code" || !cloudSync.router.isCloudConversation(c.id),
      )),
    localLoadConversation: async (id) => {
      const { check } = snapshotCache.capture();
      const store = mainState.store;
      const found = store.conversations.find(
        (conversation) => conversation.id === id,
      );
      if (!found || (found.mode === "code" && cloudSync.router.isCloudConversation(id)))
        return undefined;
      const read = (await localCall("conversationTurns", id)) as Pick<
        Conversation,
        "turns" | "savedBranches"
      >;
      check();
      return {
        ...found,
        turns: read.turns,
        savedBranches: read.savedBranches ?? found.savedBranches,
        slim: false,
      };
    },
    warmCodeSession: async (expected) => {
      const { check } = snapshotCache.capture();
      const { store } = mainState;
      const conversation = store.conversations.find(({ id }) => id === expected.id);
      if (!conversation || cloudSync.router.isCloudConversation(expected.id))
        throw Error("The Code session is no longer on this computer.");
      const environment = conversation.environment;
      const connection = environment?.kind === "ssh"
        ? ctx.services.ssh?.existing(environment.hostId)
        : undefined;
      if (environment?.kind === "ssh" && connection?.status.state !== "ready")
        throw Error("The Code session's host is disconnected.");
      const engine = ctx.engineFor(conversation.id);
      await engine.warmCodeSession(conversation, expected, () => {
        check();
        return !mainState.accountRetirement.accountRetiring && ctx.engines.all().includes(engine);
      });
    },
    sshCodeEnvironment: (conversation) => {
      const environment = conversation.environment;
      const ssh = ctx.services.ssh;
      if (environment?.kind !== "ssh" || !conversation.cwd || !ssh?.allowed()) return;
      const host = ssh.hosts.get(environment.hostId);
      if (!host) return;
      return {
        remoteTarget: {
          kind: "ssh",
          sshHost: host.destination,
          sshPort: host.port,
          sshIdentityFile: host.identityFile,
          remoteCwd: conversation.cwd,
        },
        homePath: ssh.existing(host.id)?.probe?.home,
      };
    },
    reconnectSshCodeSession: async (expected, trigger, canContinue) => {
      const { check } = snapshotCache.capture();
      const current = mainState.store.conversations.find(({ id }) => id === expected.id);
      const ssh = ctx.services.ssh;
      if (current?.archived || current?.createdAt !== expected.createdAt ||
          current?.environment?.kind !== "ssh" ||
          expected.environment?.kind !== "ssh" ||
          current.environment.hostId !== expected.environment.hostId ||
          !ssh?.allowed()) return false;
      check();
      const hostId = current.environment.hostId;
      const status = await (trigger === "open"
        ? ssh.existing(hostId)?.tryForOpening()
        : ssh.connect(hostId));
      check();
      const connection = ssh.existing(hostId);
      if (!connection?.live()) return status?.state === "ready";
      const previous = expected.turns.at(-1);
      if (previous?.sshCut && current.turns.at(-1)?.id === previous.id && canContinue()) {
        const engine = ctx.engineFor(current.id);
        await engine.resumeSshCodeCut(current, () => {
          check();
          return ctx.engines.all().includes(engine);
        }, canContinue).catch((error) => {
          check();
          console.warn("Code SSH continuation failed", error instanceof Error ? error.message : error);
        });
      }
      return true;
    },
    loadConversation: async (id) => {
      const { check } = snapshotCache.capture();
      let found = (await readSnapshot()).conversations.find((c) => c.id === id);
      check();
      // A conversation made since the cached read: read again once.
      if (!found && (snapshotCache.age() ?? 0) > 200)
        found = (await readSnapshot(true)).conversations.find(
          (c) => c.id === id,
        );
      check();
      if (!found) return undefined;
      const read = (await routedCall("conversationTurns", id)) as Pick<
        Conversation,
        "turns" | "savedBranches"
      >;
      check();
      return {
        ...found,
        turns: read.turns,
        savedBranches: read.savedBranches ?? found.savedBranches,
        slim: false,
      };
    },
    snapshot: (fresh) => readSnapshot(!!fresh),
    isCloudConversation: (id) => cloudSync.router.isCloudConversation(id),
    captureOfficialOrganizationProjectChat() {
      const runtime = currentRuntime;
      const active = cloudSync.officialCode.capture();
      if (!runtime?.lease.current() || !active) return undefined;
      const check = (signal: AbortSignal) => {
        signal.throwIfAborted();
        if (!runtime.lease.current() || !active.current() || ctx.accountRetiring)
          throw new DOMException("The active account changed.", "AbortError");
      };
      return async (request, signal) => {
        check(signal);
        const answer = await (request.method === "GET" ? active.read(request) : active.action(request));
        check(signal);
        return answer;
      };
    },
    isCloudProject: (id) => cloudSync.router.isCloudProject(id),
    ratings: () => snapshotCache.ratings(),
    image: {
      size: attachmentImageSize,
      thumbnail: (data, max) => {
        const image = nativeImage.createFromBuffer(data);
        if (image.isEmpty()) return undefined;
        const { width, height } = image.getSize();
        const scale = Math.min(1, max / Math.max(width, height));
        return (
          scale < 1
            ? image.resize({
                width: Math.round(width * scale),
                height: Math.round(height * scale),
                quality: "good",
              })
            : image
        ).toPNG();
      },
    },
    onEvent: onAppEvent,
    registerOfficialCodeArchiveHold,
    officialCodeManualKeepAwake: (id) => integration.manualCodeKeepAwake.has(id),
    setOfficialCodeManualKeepAwake,
    setOfficialCodeVisibility,
    readOfficialCodeArchivePullRequests: readDesktopArchivePullRequests,
    call: routedCall,
    localCall,
    respondToLocalCodeElicitation: (approval, response) => {
      const { store, activeAccount } = mainState;
      const engine = ctx.engines.running(approval.conversationId);
      const conversation = store.conversations.find((c) => c.id === approval.conversationId);
      if (
        !activeAccount || mainState.accountRetirement.accountRetiring ||
        !engine?.rpc?.connected || !engine.ownApprovals.includes(approval) ||
        !conversation || conversation.archived ||
        conversation.threadId !== approval.params?.threadId ||
        !conversation.turns.some((turn) =>
          turn.id === approval.params?.turnId && turn.status === "inProgress",
        )
      )
        throw Error("The elicitation request is no longer available.");
      engine.approve(approval.id, response);
    },
    withCallerWindow: (window, operation) =>
      callerWindows.run(window as BrowserWindow, operation),
    modelCatalog: async () =>
      (await routedCall("modelCatalog")) as ModelCatalog | null,
    appVersion: app.getVersion(),
    log: (...args) => console.log(...args),
  };
}

/** Internal receipt read stays on the invoking activation and owned conversation. */
function confirmedUploadReader(context: AdapterContext, runtime: ActivationRuntime): NonNullable<AdapterContext["readConfirmedUpload"]> {
  const owner=runtime.lease.identity.owner, store=runtime.lease.identity.store;
  const check=()=>{
    if(!runtime.lease.current() || context.account()?.id!==owner || context.sessionIdentity?.()!==store)
      throw Error("The upload account changed.");
  };
  return async(conversationId,rowId)=>{
    check();
    const conversation=await context.loadConversation(conversationId);
    check();
    if(!conversation || conversation.id!==conversationId)throw Error("The upload conversation is unavailable.");
    const receipt=cloudSync.confirmedUploadReceipt(conversation,rowId,()=>{
      try{check();return true;}catch{return false;}
    });
    check();
    return receipt;
  };
}

async function ensureServer(root: string, runtime: ActivationRuntime) {
  await runtime.storageReady;
  if (!runtime.lease.current()) throw new Error("This account window has retired.");
  if (runtime.server) return runtime.server;
  setStateDir(app.getPath("userData"));
  // Development and e2e tests: /__debug/eval runs JavaScript in the page
  // (CLAUDEX_OFFICIAL_UI_DEBUG=1 without the devtools window).
  const devtools =
    process.env.CLAUDEX_OFFICIAL_UI_DEVTOOLS === "1" ||
    process.env.CLAUDEX_OFFICIAL_UI_DEBUG === "1";
  const context = adapterContext(root, runtime);
  context.isCurrent = () => runtime.lease.current();
  context.openCheckout = (view) =>
    void openCheckoutWindow({ lease: runtime.lease, hidden: officialUiE2e(), view });
  const cloudCodeOwner = context.account()?.id;
  if (cloudCodeOwner)
    runtime.desktopCloudCode = createDesktopCloudCode(cloudSync.officialCode, cloudCodeOwner,
      () => runtime.lease.current());
  const remote = ctx.remote;
  if (remote) {
    let controller: AdapterContext["officialRemoteCode"];
    Object.defineProperty(context, "officialRemoteCode", {
      get() {
        if (!remote.ready || !runtime.lease.current()) return undefined;
        if (controller) return controller;
        const ownDevice = deviceLink.status().id;
        controller = createOfficialRemoteCodeController({
          list: async () => {
            const status = await context.dispatch?.status();
            if (!status || status.machinesFailed) throw Error("Could not load Remote Control computers.");
            const online = new Set(status.onlineDeviceIds);
            return status.devices.filter(({ id }) => id !== ownDevice)
              .map((device): DeviceInfo => ({ ...device, online: online.has(device.id) }));
          },
          call: (device, request) => {
            if (device === ownDevice) throw Error("Open this session on this computer.");
            if (!runtime.lease.current()) throw new DOMException("The active account changed.", "AbortError");
            return localCall("dispatchCall", device, "officialCode", [request]);
          },
          changed: (conversationId) => push({ type: "remote-code-changed", conversationId }),
        });
        runtime.lease.onRetire(controller.clear);
        return controller;
      },
    });
  }
  context.dispatchReceiver = {
    status: () => readDispatchReceiving(context),
    update: (changes) => setDispatchReceiving(context, changes),
    addDirectory: () => {
      const win = mainState.window;
      if (!win || win.isDestroyed() || windowRuntime.get(win.webContents) !== runtime)
        throw Error("Open the account’s Claudex window to choose a folder.");
      return callerWindows.run(win, () => addDispatchFolder(context));
    },
    removeDirectory: (folder) => removeDispatchFolder(context, folder),
    deviceAccess: (request) => changeDispatchTrust(context, request),
  };
  context.sideQuestionGateway = async (conversation, model, signal) => {
    const engine=mainState.engine,store=mainState.store;
    return ownedSideQuestionGateway({engine,store,conversation,model,signal,current:()=>runtime.lease.current() && mainState.engine===engine && mainState.store===store});
  };
  context.completeCodeTitle = (prompt, options) => {
    const engine = mainState.engine;
    const store = mainState.store;
    const current = () =>
      runtime.lease.current() &&
      mainState.engine === engine &&
      mainState.store === store;
    return gatewayCompleter(async () => {
      const { signal } = options;
      signal?.throwIfAborted();
      if (!current() || engine.policy().update?.state === "required")
        return undefined;
      const { providers, activeProviderId } = store.settings;
      const available = engine.gatewayEndpoint();
      const provider = providers.find(
        (candidate) =>
          candidate.id === (available ? engine.providerId : activeProviderId),
      );
      if (!provider?.model) return undefined;
      const model = options.model ?? provider.model;
      if (model !== provider.model && !provider.models.includes(model))
        return undefined;
      if (!available)
        await engine.ensure(provider, {
          interactive: false,
          current: () => current() && !signal?.aborted,
        });
      signal?.throwIfAborted();
      if (
        !current() ||
        engine.providerId !== provider.id ||
        engine.policy().update?.state === "required"
      )
        return undefined;
      const endpoint = engine.gatewayEndpoint();
      return endpoint ? { ...endpoint, model } : undefined;
    })(prompt, options);
  };
  const commandEngine = mainState.engine;
  const commandStore = mainState.store;
  const commandCurrent = () => runtime.lease.current() &&
    mainState.engine === commandEngine && mainState.store === commandStore;
  const chatCurrent = () => commandCurrent() &&
    !mainState.accountRetirement.accountRetiring && !!mainState.activeAccount;
  context.mcpAppToolbox = () => ({
    activation: runtime.lease,
    settings: () => commandStore.settings,
    policy: () => commandEngine.policy(),
    current: chatCurrent,
    onRetire: (close) => runtime.lease.onRetire(close),
    async codeScope({ sessionId, toolUseId }, { serverName, toolName }) {
      if (!sessionId.startsWith("local_") || !chatCurrent()) return false;
      const id = sessionId.slice(6);
      const history = await context.localLoadConversation?.(id);
      const conversation = commandStore.conversations.find((row) => row.id === id);
      const owner = mainState.activeAccount?.id;
      if (!chatCurrent() || !history || !conversation || history.createdAt !== conversation.createdAt ||
          (conversation.sessionAuthors &&
            (conversation.sessionAuthors.ownerAccountUuid !== owner ||
             conversation.sessionAuthors.viewerAccountUuid !== owner))) return false;
      return codeMcpAppAllowsTool({ ...history,
        connectorOverrides: conversation.connectorOverrides,
        connectorToolOverrides: conversation.connectorToolOverrides,
      }, toolUseId, serverName, toolName);
    },
    fetch,
    headers: (name) => commandEngine.connectorHeaders?.(name),
  });
  const localChat = (id: string) => {
    if (!chatCurrent() || cloudSync.router.isCloudConversation(id)) return;
    const owner = mainState.activeAccount?.id;
    const row = commandStore.conversations.find(candidate => candidate.id === id);
    if (row?.mode === "chat" && !row.archived && (!row.sessionAuthors ||
        (row.sessionAuthors.ownerAccountUuid === owner && row.sessionAuthors.viewerAccountUuid === owner)))
      return row;
  };
  context.chatElicitation = engineChatElicitation({
    current: chatCurrent,
    canRespond: chatCurrent,
    conversation: localChat,
    engine: id => ctx.engines.running(id),
  });
  context.chatComputerUse = chatComputerUseHost({
    async requests(id) {
      const row = localChat(id);
      if (row?.turns.at(-1)?.status !== "inProgress" || !ctx.services.computerUse?.enabledFor(id))
        return [];
      const state = await localCall("computerUseState") as ComputerUseState;
      return chatCurrent() ? (state.requests ?? []).filter(request => request.conversationId === id) : [];
    },
    async answer(id, decision) {
      if (!chatCurrent()) throw Error("The account has changed.");
      await localCall("answerComputerUseAccess", id, decision);
    },
    translator: () => nativeTranslator(preference(ctx.store.settings, "locale")),
  });
  Object.defineProperty(context, "chatPermissionModes", {
    get: () => chatCurrent() ? availableChatPermissionModes(commandEngine.policy()) : undefined,
  });
  context.commandDeclines = createCommandDeclineHost({
    current: commandCurrent,
    // Only this local engine's actual request objects, never a merged cloud snapshot.
    approvals: () => commandEngine.ownApprovals,
    conversation: id => commandStore.conversations.find(c => c.id === id),
    declineExact: approval => {
      if (!commandCurrent() || !commandEngine.rpc ||
          !commandEngine.ownApprovals.includes(approval) ||
          commandEngine.ownApprovals.filter(a => a.id === approval.id).length !== 1)
        throw Error("The command request is no longer current.");
      commandEngine.approve(approval.id, { decision: "decline" });
      if (!commandCurrent() || commandEngine.ownApprovals.includes(approval))
        throw Error("The command decline was not confirmed.");
      return { status: "declined" };
    },
  });
  context.readConfirmedUpload = confirmedUploadReader(context,runtime);
  context.codeCommandPermissions = createCodeCommandPermissionHost({
    current: commandCurrent,
    runtime: () => commandEngine.rpc,
    approvals: () => commandEngine.ownApprovals,
    conversation: (id) => commandStore.conversations.find((c) => c.id === id),
    canRespond: (approval) => !codeApprovalIsStopping(
      commandStore.conversations.find((c) => c.id === approval.conversationId),
      approval.params,
    ),
    allowPersistent: (approval) => {
      const conversation = commandStore.conversations.find(
        (row) => row.id === approval.conversationId,
      );
      return !!conversation && commandEngine.policy().approvalsAlwaysAllow === true &&
        !codeExecutionSettings(commandStore.settings, conversation).codePlanMode;
    },
    respondExact: (approval, result) => {
      if (
        !commandCurrent() || !commandEngine.rpc?.connected ||
        !commandEngine.ownApprovals.includes(approval) ||
        commandEngine.ownApprovals.filter(
          (a) => String(a.id) === String(approval.id),
        ).length !== 1
      )
        throw Error("The command request is no longer current.");
      commandEngine.approve(approval.id, result);
      if (!commandCurrent() || commandEngine.ownApprovals.includes(approval))
        throw Error("The command response was not confirmed.");
    },
  });
  context.openStaticArtifactPreview = createStaticArtifactPreviewHost(context, {
    current: () => runtime.lease.current(),
    committedWindow: () => {
      const win = mainState.window;
      return win && !win.isDestroyed() && runtime.windows.has(win) &&
        windowRuntime.get(win.webContents) === runtime ? win : undefined;
    },
    onRetire: (listener) => runtime.lease.onRetire(listener),
    preloadPath: path.join(dirname, "static-artifact-preview-preload.cjs"),
    open: openStaticArtifactPreview,
  });
  runtime.codeCommandPermissions = context.codeCommandPermissions;
  context.call = (method, ...args) => {
    if (!runtime.lease.current()) throw new Error("This account window has retired.");
    const complete = authorizeRetiredTerminalResponse(runtime.lease, method, args[0]);
    try {
      const result = routedCall(method, ...args);
      return Promise.resolve(result).then((value) => { complete?.(true, value); return value; },
        (error) => { complete?.(false, error); throw error; });
    } catch (error) { complete?.(false, error); throw error; }
  };
  if (!runtime.dictation) {
    runtime.dictation = createOfficialDictation(
      composerDictation ??= new DictationSessions(ctx),
      () => voiceAvailability(ctx),
      () => runtime.lease.current(),
    );
    runtime.lease.onRetire(runtime.dictation.close);
  }
  runtime.starting ??= startOfficialUiServer({
    root,
    rendererPacks: officialRendererPacks(root),
    rendererBusy: () => mainState.engine?.isBusy() ?? false,
    isCurrent: () => runtime.lease.current(),
    responseLease: runtime.lease,
    requireStablePort: true,
    desktopStartup: !officialUiE2e(),
    forbiddenPorts: new Set([...usedPorts].filter(port => portOwners.get(port) !== runtime.storage.key)),
    portFile: runtime.storage.portFile,
    api: createNativeAccountApi(context),
    upgrade: runtime.dictation.upgrade,
    log: (...args) => console.warn(...args),
    debugQuit: officialUiE2e() ? () => app.quit() : undefined,
    debugFileInput:officialUiE2e()?async(files,windowId)=>{
      if(!Array.isArray(files)||files.length>12||files.some(p=>typeof p!=='string'||!fs.realpathSync(p).startsWith(fs.realpathSync(app.getPath('userData'))+path.sep)))throw Error('Only test-profile fixture files can be selected.');
      const win=windowId?officialWindows.get(windowId):mainState.window;if(!win||win.isDestroyed())throw Error('No test window');
      const debug=win.webContents.debugger;const attached=debug.isAttached();if(!attached)debug.attach('1.3');
      try{const {root}=await debug.sendCommand('DOM.getDocument');const {nodeId}=await debug.sendCommand('DOM.querySelector',{nodeId:root.nodeId,selector:'input[type=file]'});if(!nodeId)throw Error('No file input');await debug.sendCommand('DOM.setFileInputFiles',{nodeId,files});}finally{if(!attached)debug.detach();}
    }:undefined,
    debugKey: officialUiE2e()
      ? (key, modifiers, preview, windowId) => {
          const win = windowId
            ? officialWindows.get(windowId)
            : mainState.window;
          if (!win || win.isDestroyed()) throw Error("No official test window");
          let contents = win.webContents;
          if (preview) {
            const browser = ctx.services.browser?.host;
            const session =
              browser &&
              [...browser.sessions.values()].find(
                (s) =>
                  s.shown?.window ===
                  (win as unknown as import("../browser/browser-host").HostWindow),
              );
            const view = session && browser?.activeTab(session).view;
            if (!view) throw Error("No visible test preview");
            contents = view.webContents as Electron.WebContents;
          }
          const nativeModifiers = modifiers as (
            "meta" | "control" | "shift" | "alt"
          )[];
          contents.sendInputEvent({
            type: "keyDown",
            keyCode: key,
            modifiers: nativeModifiers,
          });
          contents.sendInputEvent({
            type: "keyUp",
            keyCode: key,
            modifiers: nativeModifiers,
          });
        }
      : undefined,
    debugEval: devtools
      ? (script, windowId) => {
          // -1: the top-up window (checkout-window.ts).
          if (windowId === -1) return evalInCheckoutWindow(runtime.lease, script);
          const win = windowId
            ? officialWindows.get(windowId)
            : mainState.window;
          if (!win || win.isDestroyed()) throw new Error("No official window");
          return win.webContents.executeJavaScript(script, true);
        }
      : undefined,
    debugCall: devtools
      ? (name, args) => adapterContext(root).call(name, ...args)
      : undefined,
    debugFrames: devtools
      ? async (windowId) => {
          const win = windowId
            ? officialWindows.get(windowId)
            : mainState.window;
          if (!win || win.isDestroyed()) throw Error("No official window");
          const pageFrames=await Promise.all(
            win.webContents.mainFrame.framesInSubtree
              .filter((frame) => frame !== win.webContents.mainFrame)
              .map(async (frame) => ({
                url: frame.url,
                text: await frame
                  .executeJavaScript(
                    "document.body?.innerText.slice(0,12000) ?? ''",
                  )
                  .catch(() => null),
                canvases: await frame.executeJavaScript(
                  "Array.from(document.querySelectorAll('canvas')).map(c=>{try{const p=c.getContext('2d')?.getImageData(0,0,c.width,c.height).data;let dark=0;if(p)for(let i=0;i<p.length;i+=4)if(p[i+3]>0&&p[i]<180&&p[i+1]<180&&p[i+2]<180)dark++;return {width:c.width,height:c.height,darkPixels:dark};}catch{return {width:c.width,height:c.height,darkPixels:0}}})",
                ).catch(()=>[]),
              })),
          );
          return [...pageFrames,...await nativePdfPreviewState(win.id)];
        }
      : undefined,
    debugClick: devtools
      ? (x, y, windowId) => {
          const win = windowId
            ? officialWindows.get(windowId)
            : mainState.window;
          if (!win || win.isDestroyed()) throw new Error("No official window");
          const [width, height] = win.getContentSize();
          if (x >= width || y >= height)
            throw new Error("Click is outside the window");
          win.webContents.sendInputEvent({ type: "mouseMove", x, y });
          win.webContents.sendInputEvent({
            type: "mouseDown",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
          win.webContents.sendInputEvent({
            type: "mouseUp",
            x,
            y,
            button: "left",
            clickCount: 1,
          });
        }
      : undefined,
    debugFocus:
      officialUiE2e() && process.env.CLAUDEX_OFFICIAL_UI_E2E_FOCUS === "1"
        ? (windowId) => {
            const win = windowId
              ? officialWindows.get(windowId)
              : mainState.window;
            if (!win || win.isDestroyed())
              throw Error("No such official test window");
            app.focus({ steal: true });
            win.focus();
          }
        : undefined,
    debugCapture: devtools
      ? async (windowId,nativePdf) => {
          if(nativePdf)return captureNativePdfPreview(windowId?(officialWindows.get(windowId)?.id):mainState.window?.id);
          const contents =
            windowId === -1
              ? checkoutContents(runtime.lease)
              : (windowId ? officialWindows.get(windowId) : mainState.window)
                  ?.webContents;
          if (!contents) throw new Error("No such window");
          return (await contents.capturePage()).toPNG();
        }
      : undefined,
    debugOpenWindow: devtools
      ? async () => (await createOfficialWindow({ extra: true })).webContents.id
      : undefined,
    debugNavigate: devtools
      ? async (route, windowId) => {
          const win = windowId
            ? officialWindows.get(windowId)
            : mainState.window;
          if (!win || win.isDestroyed()) throw new Error("No official window");
          const target = new URL(
            route,
            win.webContents.getURL() || "http://localhost/",
          );
          const current = new URL(win.webContents.getURL());
          if (target.origin !== current.origin)
            throw new Error("Only page routes");
          // Hash-only settings navigation has no dom-ready event.
          if (
            target.pathname === current.pathname &&
            target.search === current.search &&
            target.hash !== current.hash
          ) {
            await win.loadURL(target.toString());
            return;
          }
          // A page that guards leaving (a draft, a reply in progress) would cancel
          // the load silently; the official main ignores the guard for its own
          // reloads the same way.
          const allow = (event: Electron.Event) => event.preventDefault();
          win.webContents.on("will-prevent-unload", allow);
          // Answered at dom-ready: a pending subresource (an image still loading)
          // must not hold the test back.
          const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("The page did not load in 30 s")),
              30000,
            );
            win.webContents.once("dom-ready", () => {
              clearTimeout(timer);
              resolve();
            });
          });
          try {
            win.loadURL(target.toString()).catch(() => undefined);
            await ready;
          } finally {
            win.webContents.off("will-prevent-unload", allow);
          }
        }
      : undefined,
  }).then(async (started) => {
    if (!runtime.lease.current()) {
      try { await started.close(); } catch { runtime.startupCloseFailed = true; throw new Error("Retired account server cleanup was not confirmed."); }
      throw new Error("The account changed while the interface server was starting.");
    }
    runtime.server = started;
    usedPorts.add(Number(new URL(started.origin).port));
    portOwners.set(Number(new URL(started.origin).port), runtime.storage.key);
    // Development origin only; never log the private activation capability.
    if (devtools)
      console.log(
        `[official-ui] debug origin ${started.origin}`,

      );
    return started;
  }).catch((error) => {
    runtime.starting = undefined;
    throw error;
  });
  return runtime.starting;
}

/** Every official window by its webContents id (the debug channel addresses extra ones). */
const officialWindows = new Map<number, BrowserWindow>();
export function officialAppWindows(): BrowserWindow[] {
  return [...officialWindows.values()].filter((win) => !win.isDestroyed());
}
let native: ReturnType<typeof createNativeHost> | undefined;

export function requestOfficialSupportBundle(window: BrowserWindow | null | undefined) {
  if (!window || window.isDestroyed() || !windowRuntime.has(window.webContents)) return false;
  void native?.supportBundle.open(window);
  return true;
}

export function notifyOfficialZoomChanged(window: BrowserWindow) {
  native?.host.emitTo(window, "WindowState", "zoomFactorChanged", window.webContents.getZoomFactor());
}

export function officialQuickEntryLocale(root: string) {
  const locale = officialLocale({ root, settings: () => mainState.store.settings });
  return { locale, messages: officialLocaleMessages(root, locale) };
}

export function submitOfficialQuickEntry(submission: OfficialQuickEntrySubmission | "new-chat") {
  const window = mainState.window;
  if (window && native?.host.currentWindows().includes(window))
    native.quickEntry.submit(window, submission);
}

export async function openOfficialDeepLink(
  window: BrowserWindow,
  link: DeepLink,
  take: () => boolean,
) {
  const runtime = windowRuntime.get(window.webContents);
  if (!runtime) return false;
  const host = native;
  if (!host || !runtime.lease.current()) return true;
  const snapshot = link.kind === "conversation" || link.kind === "code-continue" || link.kind === "needs-input"
    ? await readSnapshot(true)
    : undefined;
  if (runtime.lease.current() && !window.isDestroyed() && take())
    host.quickEntry.navigate(window, officialDeepLinkRoute(link, runtime.lease.identity.owner, snapshot));
  return true;
}

export function officialQuickEntryRecents() {
  const window = mainState.window;
  if (window && native?.host.currentWindows().includes(window))
    return native.quickEntry.recents(window);
}
interface ConnectorBrowserAttempt {
  id: string;
  source: string | null;
  window: BrowserWindow;
  href: string;
  expires: number;
}
const connectorBrowserAttempts = new WeakMap<ActivationRuntime, Map<string, ConnectorBrowserAttempt>>();

export function notifyOfficialConnectorAuthentication(
  name: string,
  state: string,
  error?: "access_denied" | "callback_failed",
) {
  const attempts = currentRuntime && connectorBrowserAttempts.get(currentRuntime);
  const attempt = attempts?.get(state);
  attempts?.delete(state);
  return notifyOfficialConnectorResult(connectorUuid(name), error, attempt);
}

function notifyOfficialConnectorResult(
  serverId: string,
  error?: "access_denied" | "callback_failed",
  attempt?: ConnectorBrowserAttempt,
) {
  if (!native?.host.window) return false;
  const url = new URL(`claudex://claude.ai/mcp-auth-callback/${serverId}`);
  url.searchParams.set("step", error ? "error" : "success");
  if (error) url.searchParams.set("oauth_error", error);
  if (attempt) {
    url.searchParams.set("client_attempt_id", `ca_${attempt.id}`);
    if (attempt.source) url.searchParams.set("mcp_auth_source", attempt.source);
    if (error && !attempt.window.isDestroyed() &&
        attempt.window.webContents.getURL() === attempt.href) {
      const result = new URL(attempt.href);
      for (const [key, value] of url.searchParams) result.searchParams.set(key, value);
      result.searchParams.set("step", "end_error");
      result.searchParams.set("server", serverId);
      void attempt.window.loadURL(result.href).catch(() => {});
    }
    native.host.emitTo(attempt.window, "DeepLink", "handleDeepLink", url.href);
  } else {
    native.host.emit("DeepLink", "handleDeepLink", url.href);
  }
  return true;
}

export function refreshOfficialConnector(name: string) {
  const runtime = currentRuntime;
  const owner = mainState.activeAccount?.id;
  const origin = runtime?.server?.origin;
  if (!runtime?.lease.current() || !origin || !owner) return;
  const org = organizationUuid(owner);
  const serverId = connectorUuid(name);
  for (const window of runtime.windows) {
    if (window.isDestroyed() || windowRuntime.get(window.webContents) !== runtime ||
        URL.parse(window.webContents.getURL())?.origin !== origin)
      continue;
    // The original auth observer can skip discovery once connection metadata
    // reports connected. Read its live tools after the app-server reload.
    void window.webContents.executeJavaScript(
      `import("/assets/v1/shared-m-1-Nm0kn4Ee.js").then(({ Aw }) =>
        Aw(${JSON.stringify(org)}, { serverUuid: ${JSON.stringify(serverId)} }))`,
    ).catch(() => {});
  }
}

let windowManager:
  | {
      setupForWindow(win: BrowserWindow, options: unknown): void;
      pendingWindows?: Map<string, { ownerWebContentsId: number }>;
      windows?: Map<string, { ownerWebContentsId: number; instance: { destroy(options: { emitClosed: boolean }): void } }>;
      destroy(): void;
    }
  | undefined;

function reapReplacedDocumentPopouts(ownerId: number) {
  for (const [key, record] of windowManager?.pendingWindows ?? []) {
    if (record.ownerWebContentsId === ownerId) windowManager!.pendingWindows!.delete(key);
  }
  for (const [key, record] of windowManager?.windows ?? []) {
    if (record.ownerWebContentsId !== ownerId) continue;
    try {
      record.instance.destroy({ emitClosed: false });
      if (windowManager!.windows!.get(key) === record) windowManager!.windows!.delete(key);
    } catch {
      console.error("Official pop-out cleanup after document replacement could not be confirmed.");
    }
  }
}

/**
 * Opens an official window. The first is the app's main window; `extra`
 * windows (e2e runs) share its session, server and native host.
 */
export async function createOfficialWindow(options: {
  extra?: boolean;
  startup?: { position: MainWindowState | undefined; visibility: StealthWindow | undefined };
} = {}) {
  const account = mainState.activeAccount;
  const store = mainState.store;
  const generation = mainState.accountRetirement.accountActivationIdentity;
  const runtime = runtimeForAccount();
  let finishPreparation!: () => void;
  const preparation = new Promise<void>(resolve => { finishPreparation = resolve; });
  runtime.preparations.add(preparation);
  const stage = stageOfficialWindow<BrowserWindow>({
    current: () =>
      !!account &&
      mainState.activeAccount?.id === account.id &&
      mainState.store === store &&
      !mainState.shuttingDown &&
      mainState.accountRetirement.accountActivationIdentity === generation &&
      mainState.accountRetirement.accountRetiring === false,
    subscribeRetirement: (retire) => deactivatingListeners.add(retire),
    main: () => mainState.window,
    setMain: (win) => {
      mainState.window = win;
      mainState.signInShape = false;
      mainState.boundsBeforeSignIn = undefined;
    },
    extra: options.extra === true,
    revoke: (win) => {
      if (officialWindows.get(win.webContents.id) === win) officialWindows.delete(win.webContents.id);
      native?.host.detach(win);
    },
  });
  try {
    stage.check();
    const root = officialUiRoot();
    const { origin, token } = await ensureServer(root, runtime);
    stage.check();
    const features = JSON.parse(
      fs.readFileSync(path.join(root, "data", "capabilities.json"), "utf8"),
    ).configurations[0];
    Object.assign(features, computerUseFeatures(ctx.services.computerUse?.settingsState?.()));
    const nativeQuickEntry = process.platform === "darwin";
    const voiceShortcut = quickEntryDictationSupported() && officialNativeQuickAccessAvailable(root);
    features.nativeQuickEntry = { status: nativeQuickEntry ? "supported" : "unavailable" };
    features.quickEntryDictation = { status: voiceShortcut ? "supported" : "unavailable" };
    features.customQuickEntryDictationShortcut = features.quickEntryDictation;
    features.sshBrowserPane = { status: "supported" };
    features.ccdPromptSuggestionsSetting = { status: "supported" };
    if (process.platform === "win32") {
      features.wslLocalFiles = { status: "supported" };
      features.wslPreview = { status: "supported" };
    }
    const display = JSON.parse(
      fs.readFileSync(path.join(root, "data", "display-settings.json"), "utf8"),
    );
    const ses = runtime.session;
    // Published modules are served as immutable (their names are content hashes
    // upstream), but assembly rewrites their text: a new bundle empties the
    // partition's HTTP cache once so the page never runs a stale copy.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
    );
    const managerPath = path.join(root, "host", "window-manager.cjs");
    const managerProof = manifest.hostWindowManager;
    if (managerProof?.revision !== "claudex-window-activation-v1" ||
        managerProof.outputSha256 !== "501c4e079e89e9133cbcdbda0f64d77dc8e10c2b3befd0724045c91310380435" ||
        createHash("sha256").update(fs.readFileSync(managerPath)).digest("hex") !== managerProof.outputSha256)
      throw new Error("The activation-bound window manager is unavailable. Rebuild the interface.");
    const marker = path.join(
      app.getPath("userData"),
      `official-ui-bundle-${runtime.storage.key}.json`,
    );
    let seen: { generatedAt?: string } = {};
    try {
      seen = JSON.parse(fs.readFileSync(marker, "utf8"));
    } catch {}
    if (seen.generatedAt !== manifest.generatedAt) {
      await ses.clearCache();
      stage.check();
      fs.writeFileSync(
        marker,
        JSON.stringify({
          generatedAt: manifest.generatedAt,
          buildId: manifest.buildId,
        }),
      );
    }
    stage.check();
    await ses.cookies.set({
      url: origin,
      name: cookieName,
      value: token,
      httpOnly: true,
      sameSite: "strict",
    });
    stage.check();
    // The page opens the organization it last used (its lastActiveOrg cookie):
    // after an account switch that is the signed-in account's own.
    if (account)
      await ses.cookies.set({
        url: origin,
        name: "lastActiveOrg",
        value: organizationUuid(account.id),
        sameSite: "lax",
        expirationDate: Date.now() / 1000 + 365 * 86400,
      });
    stage.check();
    // Import owned drafts before any original composer reads this partition.
    await (runtime.draftImport ??= restoreLegacyDrafts({
      userData: app.getPath("userData"),
      marker: path.join(path.dirname(runtime.storage.portFile), "legacy-drafts-imported"),
      targetSession: ses,
      targetOrigin: origin,
      owner: runtime.lease.identity.owner,
      preload: path.join(dirname, "legacy-draft-preload.cjs"),
      conversationDrafts: async (ids, refresh) => {
        if (refresh && runtime.lease.current())
          await readSnapshot(true).catch(() => undefined);
        return runtime.lease.current() ? reactConversationDrafts(runtime, ids) : new Map();
      },
      current: () => runtime.lease.current(),
    }).catch(() => console.warn("Older drafts could not be restored. The next launch will retry.")));
    stage.check();
    // Claudex's page shim runs beside the official preload (page-shim.cjs).
    const shim = path.join(root, "host", "claudex-shim.cjs");
    if (fs.existsSync(shim)) {
      const register = (
        ses as unknown as {
          registerPreloadScript?: (s: {
            type: "frame";
            filePath: string;
            id?: string;
          }) => string;
        }
      ).registerPreloadScript;
      const registered =
        (
          ses as unknown as { getPreloadScripts?: () => { filePath: string }[] }
        ).getPreloadScripts?.() ?? [];
      if (register && !registered.some((script) => script.filePath === shim))
        register.call(ses, {
          type: "frame",
          filePath: shim,
          id: "claudex-shim",
        });
    }
    installOfficialClipboardWritePermission(ses, (contents) => {
      const owner = windowRuntime.get(contents);
      const window = officialWindows.get(contents.id);
      return owner === runtime && owner.lease.current() &&
        contents.session === ses && window?.webContents === contents &&
        !window.isDestroyed() && window.isFocused()
        ? origin : undefined;
    }, undefined, (contents) => {
      const owner = windowRuntime.get(contents);
      return owner === runtime && owner.lease.current() &&
        officialWindows.get(contents.id)?.webContents === contents &&
        voiceAvailability(ctx).transcription ? origin : undefined;
    });
    const previewRoot = path.join(path.dirname(root), "official-usercontent");
    const localPreviewReady = fs.existsSync(
      path.join(previewRoot, "manifest.json"),
    );
    const isPublicDirectory = (url: URL) =>
      url.origin === "https://api.anthropic.com" &&
      (url.pathname === "/api/directory/plugins" ||
        url.pathname === "/api/directory/servers");
    if (!previewProtocols.has(ses)) {
      const assets = localPreviewReady
        ? createUserContentHandler(previewRoot, origin)
        : undefined;
      ses.protocol.handle("https", (request) => {
        const url = new URL(request.url);
        if (isPublicDirectory(url) && ["GET", "OPTIONS"].includes(request.method))
          return fetch(`${origin}/api/__public${url.pathname.slice(4)}${url.search}`, {
            method: request.method,
            headers: { Origin: origin },
          });
        if (!assets) return new Response(null, { status: 404 });
        return url.origin === userContentOrigin &&
          url.pathname === "/api/convert-pdf"
          ? documentPreview.handle(request)
          : assets(request);
      });
      previewProtocols.add(ses);
    }
    // Nothing leaves the computer from this window: the adapter answers every API.
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      if (isPublicDirectory(url)) return callback({ cancel: false });
      if (localPreviewReady && url.origin === userContentOrigin)
        return callback({ cancel: false });
      callback({
        cancel:
          ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
          !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      });
    });
    // An e2e window is shown (the page sees itself visible, so nothing pauses)
    // but fully transparent, click-through and unfocusable: it never covers or
    // takes input from the desktop.
    const hidden = officialUiE2e();
    const focusTest =
      hidden && process.env.CLAUDEX_OFFICIAL_UI_E2E_FOCUS === "1";
    const saved = !options.extra && !hidden
      ? options.startup?.position ?? readMainWindowState(mainWindowFile())
      : undefined;
    const win = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      ...(hidden
        ? {
            focusable: focusTest,
            skipTaskbar: true,
          }
        : {}),
      ...(hidden || options.extra
        ? { width: display.window?.width ?? 1440, height: display.window?.height ?? 900 }
        : officialWindowPlacement(saved, display.window)),
      minWidth: 600,
      minHeight: 400,
      title: "Claudex",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#151515" : "#fcfcfb",
      ...mainWindowChrome(process.platform, mainState.zoomLevel, nativeTheme.shouldUseDarkColors),
      webPreferences: {
        session: ses,
        preload: path.join(root, "host", "official-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        additionalArguments: [`--desktop-features=${JSON.stringify(features)}`],
        backgroundThrottling: false,
      },
    });
    stage.attach(win);
    watchOfficialRenderer(win.webContents, () => runtime.lease.current());
    officialWindows.set(win.webContents.id, win);
    applyZoom(win, mainState.zoomLevel);
    win.webContents.on("did-finish-load", () => applyZoom(win, mainState.zoomLevel));
    runtime.windows.add(win);
    runtime.ownerIds.add(win.webContents.id);
    managerOwnerBindings.set(win.webContents.id, runtime);
    windowRuntime.set(win.webContents, runtime);
    const contents = win.webContents;
    const id = contents.id;
    const previousLayoutOwner = runtime.layoutOwner;
    if (!options.extra) {
      runtime.layoutOwner = win;
      const replaceLayoutDocument = () => {
        if (activeLayoutOwner() !== win || mainState.quitting) return;
        runtime.layout.reoffer();
        reapReplacedDocumentPopouts(id);
      };
      contents.on("did-navigate", replaceLayoutDocument);
      contents.on("render-process-gone", replaceLayoutDocument);
    }
    if (!options.extra && !hidden) {
      trackMainWindow(win, mainWindowFile(), () => mainState.zoomLevel,
        () => mainState.window === win && runtime.lease.current());
      win.on("close", () => {
        if (mainState.window === win && runtime.lease.current()) writeOfficialBootSurface(store.root);
      });
    }
    win.on("closed", () => {
      if (officialWindows.get(id) === win) officialWindows.delete(id);
      runtime.windows.delete(win);
      windowRuntime.delete(contents);
      if (runtime.layoutOwner === win)
        runtime.layoutOwner = previousLayoutOwner?.isDestroyed() ? undefined : previousLayoutOwner;
      if (mainState.window === win) mainState.window = undefined;
    });
    // The page recognises the desktop app by the "Claude/<version>" token in the
    // user agent plus the preload's bindings (shared-l-p-m-w-0 tG/wq); without it
    // the web chrome renders. The version is the front-end's own desktop version.
    const build = JSON.parse(
      fs.readFileSync(path.join(root, "data", "build.json"), "utf8"),
    );
    win.webContents.setUserAgent(
      `${win.webContents.getUserAgent()} Claude/${build.installedDesktopVersion ?? "4.4212.0"}`,
    );
    native ??= createNativeHost(origin, bindNativeCommandContext(adapterContext(root), () => {
      const active = currentRuntime;
      return active?.lease.current() ? active.codeCommandPermissions : undefined;
    }), features, {
      availability: () => voiceAvailability(ctx),
      credential: (window) => {
        const active = windowRuntime.get(window.webContents);
        return active?.server && active.dictation?.credential(active.server.origin) || null;
      },
    }, ctx.integration, {
      mainWindow: activeLayoutOwner,
      sessions: (window) => {
        const owner = windowRuntime.get(window.webContents);
        if (!owner?.lease.current() || owner.layoutOwner !== window || mainState.quitting) return;
        return {
          report: (layout) => owner.layout.report(layout),
          take: () => {
            const layout = owner.layout.take();
            if (!layout) return null;
            return clampOfficialLayoutToDisplays(
              layout,
              screen.getAllDisplays().map(display => display.workArea),
              bounds => screen.getDisplayMatching(bounds).workArea,
            );
          },
        };
      },
      commands: (window) => windowRuntime.get(window.webContents)?.layoutCommands,
    });
    native.host.on("WindowState.resetZoom", async () => {
      const { setZoomLevel } = await import("../app/main-window");
      setZoomLevel(0);
    });
    native.host.attach(win, { origin, current: () => runtime.lease.current() });
    native.quickEntry.attach(win);
    if (!managerOrigins.includes(origin)) managerOrigins.push(origin);
    windowManager ??= require(
      path.join(root, "host", "window-manager.cjs"),
    ).setupWindowManager({
      allowedOrigins: managerOrigins,
      claudexActivationBound: true,
      allowWebContents: (contents: Electron.WebContents) => {
        const owner = windowRuntime.get(contents);
        return !mainState.quitting && !!owner && owner.lease.current() && contents.session === owner.session &&
          !!owner.server && contents.mainFrame.url.startsWith(owner.server.origin + "/");
      },
      defaultWindowOptions: (contents: Electron.WebContents) => {
        const owner = windowRuntime.get(contents);
        if (!owner?.lease.current() || contents.session !== owner.session)
          throw new Error("This account window has retired.");
        return { webPreferences: { nodeIntegration: false, contextIsolation: true,
          sandbox: true, session: owner.session } };
      },
    });
    let designNavigation: string | undefined;
    const designOwnerOrg = account && organizationUuid(account.id);
    const designLocation = (address: string) => {
      const target = new URL(address);
      const route = officialDesignArtifactRoute(target.pathname, target.search);
      return target.origin === origin && route?.organization === designOwnerOrg
        ? route?.id : undefined;
    };
    const openOwnedDesign = async (id: string, current: () => boolean) => {
      if (!account || !designOwnerOrg || !current()) return false;
      const design = (await readSnapshot(true)).conversations.find(conversation =>
        isOwnedDesign(conversation, account.id, designOwnerOrg) && conversation.blankArtifact.id === id);
      if (!design || !isOwnedDesign(design, account.id, designOwnerOrg) || !current()) return false;
      await openDesignWindow({
        lease: runtime.lease,
        conversation: design,
        title: design.title,
        readConversation: async () => (await readSnapshot(true)).conversations.find(conversation => conversation.id === design.id),
        hidden,
      });
      return current();
    };
    const showDesignNavigation = (address: string) => {
      const target = new URL(address);
      if (target.origin === origin) {
        const gallery = officialDesignWorkspacePath(target.pathname);
        if (gallery && runtime.lease.current()) {
          void win.loadURL(origin + gallery).catch(() => {});
          return;
        }
      }
      const id = designLocation(address);
      if (!id || designNavigation === id) return;
      designNavigation = id;
      const current = () => runtime.lease.current() && !win.isDestroyed() &&
        designLocation(win.webContents.getURL()) === id;
      void openOwnedDesign(id, current).then(opened => {
        if (opened && current()) return win.loadURL(origin + "/artifacts/design");
      }).catch(error => {
        if (current()) console.error("Design window failed to open:", error);
      }).finally(() => {
        if (designNavigation === id) designNavigation = undefined;
      });
    };
    win.webContents.on("did-navigate", (_event, address) => showDesignNavigation(address));
    win.webContents.on("did-navigate-in-page", (_event, address, mainFrame) => {
      if (mainFrame) showDesignNavigation(address);
    });
    windowManager!.setupForWindow(win, {
      // A connector's sign-in popup: a hidden window loads it, which hands the
      // sign-in to Claudex's browser flow (api/connectors.ts) and closes itself.
      fallbackWindowOpenHandler: (details: { url: string }) => {
        if (!runtime.lease.current()) return { action: "deny" };
        try {
          const target = new URL(details.url);
          if (target.origin === origin && /^\/downloads\/?$/.test(target.pathname)) {
            const service = ctx.remote?.ready ? ctx.remote.accounts.baseUrl : defaultClaudexServiceUrl;
            void localCall("openExternal", new URL("/downloads", service).href).catch((error) =>
              console.error("Could not open Claudex downloads:", error),
            );
            return { action: "deny" };
          }
          const designWorkspace = officialDesignWorkspaceDestination(target, origin);
          if (designWorkspace) {
            void win.loadURL(origin + designWorkspace).catch(() => {});
            return { action: "deny" };
          }
          const design = designLocation(target.href);
          if (design) {
            void openOwnedDesign(design, () => runtime.lease.current() && !win.isDestroyed()).catch(error => {
              if (runtime.lease.current()) console.error("Design window failed to open:", error);
            });
            return { action: "deny" };
          }
          const share = openOfficialShareLink({
            target, origin, token,
            current: () => runtime.lease.current() && !win.isDestroyed(),
            open: (address) => localCall("openExternal", address),
          });
          if (share) {
            void share.catch(() => {});
            return { action: "deny" };
          }
          if (
            target.origin === origin &&
            /\/mcp\/start-auth\//.test(target.pathname)
          )
            return {
              action: "allow",
              overrideBrowserWindowOptions: {
                show: false,
                width: 400,
                height: 300,
                webPreferences: {
                  session: ses,
                  sandbox: true,
                  contextIsolation: true,
                },
              },
            };
        } catch {}
        return { action: "deny" };
      },
    });
    win.webContents.on("will-navigate", (event, url) => {
      const target = new URL(url);
      const designWorkspace = officialDesignWorkspaceDestination(target, origin);
      if (designWorkspace) {
        event.preventDefault();
        if (runtime.lease.current()) void win.loadURL(origin + designWorkspace).catch(() => {});
        return;
      }
      if (target.origin !== origin) {
        event.preventDefault();
        return;
      }
      const connector = /^\/api\/organizations\/[^/]+\/mcp\/start-auth\/([0-9a-f-]{36})$/.exec(target.pathname);
      if (!connector || target.searchParams.get("browser_handoff") !== "1") return;
      event.preventDefault();
      if (!runtime.lease.current()) return;
      const id = target.searchParams.get("client_attempt_id");
      const attempt = id && /^[0-9a-f]{16}$/.test(id) ? {
        id,
        source: target.searchParams.get("mcp_auth_source"),
        window: win,
        href: win.webContents.getURL(),
        expires: Date.now() + 10 * 60_000,
      } : undefined;
      target.searchParams.set("response_format", "json");
      void fetch(target, {
        headers: { Cookie: `${cookieName}=${token}` },
        redirect: "error",
      }).then(async (response) => {
        if (!response.ok) throw Error("Connector sign-in did not start.");
        const result: unknown = await response.json();
        if (!runtime.lease.current()) return;
        if (result && typeof result === "object" && "connected" in result && result.connected === true) {
          notifyOfficialConnectorResult(connector[1], undefined, attempt);
          return;
        }
        if (!result || typeof result !== "object" || !("auth_url" in result) ||
            !("state" in result) || typeof result.state !== "string" ||
            typeof result.auth_url !== "string")
          throw Error("Connector sign-in is unavailable.");
        const state = result.state;
        const attempts = connectorBrowserAttempts.get(runtime) ?? new Map<string, ConnectorBrowserAttempt>();
        if (attempt) {
          for (const [key, pending] of attempts)
            if (pending.expires <= Date.now()) attempts.delete(key);
          attempts.set(state, attempt);
          connectorBrowserAttempts.set(runtime, attempts);
        }
        try {
          await shell.openExternal(connectorSignInUrl(result.auth_url));
        } catch (error) {
          attempts.delete(state);
          throw error;
        }
      }).catch(() => {
        if (runtime.lease.current())
          notifyOfficialConnectorResult(connector[1], "callback_failed", attempt);
      });
    });
    if (hidden) {
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
    }
    if (process.env.CLAUDEX_OFFICIAL_UI_DEVTOOLS === "1")
      win.webContents.openDevTools({ mode: "detach" });
    stage.check();
    const startupRoute = options.extra || mainState.pendingDeepLink
      ? "/new"
      : officialStartupRoute(runtime.apiScope);
    await win.loadURL(origin + startupRoute);
    stage.check();
    if (!hidden) {
      const result = await contents.executeJavaScript(`new Promise(resolve => {
        const root = document.documentElement;
        const ready = () => {
          const result = root.getAttribute("data-boot-ui-ready");
          if (result === "frame" || result === "error" || result === "timeout") return result;
          if (result !== "redirect") return null;
          const outlet = document.querySelector("[data-route-outlet]");
          const control = outlet?.querySelector('[contenteditable="true"],[role="alert"]');
          return control?.checkVisibility() && !outlet.querySelector("[data-page-loading],[data-route-skeleton]") ? "frame" : null;
        };
        const finish = result => {
          observer.disconnect();
          clearTimeout(timeout);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
        };
        const observer = new MutationObserver(() => {
          const result = ready();
          if (result) finish(result);
        });
        const timeout = setTimeout(() => { observer.disconnect(); resolve("timeout"); }, 11000);
        const existing = ready();
        if (existing) finish(existing);
        else observer.observe(root, { subtree: true, childList: true, attributes: true,
          attributeFilter: ["data-boot-ui-ready", "data-page-loading", "data-route-skeleton", "data-route-outlet", "contenteditable"] });
      })`);
      if (result === "timeout") throw Error("Claudex did not finish loading its first screen.");
      stage.check();
      await contents.capturePage(undefined, { stayHidden: true });
      stage.check();
    }
    stage.commit();
    for (const retired of retiredRuntimes) void retired.responsesDone?.then(() => {
      if (runtime.lease.current()) cleanupRetiredWindows(retired);
    });
    const visibility = options.startup?.visibility;
    if (hidden) win.showInactive();
    else if (visibility?.minimized) win.minimize();
    else if (!visibility || visibility.visible) {
      if (saved?.fullScreen) win.setFullScreen(true);
      else if (saved?.maximized) win.maximize();
      if (visibility) win.showInactive();
      else win.show();
    }
    if (!hidden) contents.setBackgroundThrottling(true);
    return win;
  } catch (error) {
    // Electron can reject a cancelled load with a raw ERR_ABORTED. Preserve
    // expected retirement classification for cold-start callers as well.
    stage.check();
    throw error;
  } finally {
    try { stage.dispose(); } finally { runtime.preparations.delete(preparation); finishPreparation(); }
  }
}


