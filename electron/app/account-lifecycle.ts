import { desktopPreferences } from "../store/desktop-preferences";
import { savedAccountUiPort } from "../official-ui/account-browser-storage";
import { isRetiredOfficialWindow, officialUiEnabled } from "../official-ui/window";
import { readState } from "../official-ui/api/state";
import { inAdapterScope, newAdapterScope } from "../official-ui/api/scope";
import { officialScheduledTaskModes } from "../official-ui/scheduled-task-preferences";
import { isReservedLoopbackPort } from "../loopback-ports";
import { createIncognitoRetirement } from "./incognito-retirement";
import { discardIncognitoUploads } from "../workspace/incognito-upload";
import { isShortcutRegistrationFailure } from "./desktop-shortcut-error";
import { noteActivationPhase, activationLocalError } from "../account/activation-failure";
import { accountDeactivated } from "./account-transition-events";
import { routineSessionInput } from "../routines/routine-session";
import { desktopConnectorAuthRejected, desktopConnectorAuthStatus, desktopConnectorHeaders } from "../connectors/connector-auth";
import { savedConnectorHeaders } from "../connectors/connector-clients";
import { registerRemoteConnectorSkills } from "../connectors/remote-skills";
import { notificationLevels } from "../../shared/notification-levels";
import { preference } from "../../shared/settings-extras";
import { routineRunModel } from "../../shared/routines";
import { engineRoutineSummary } from "../routines/routine-summary";
import { routineRunMails } from "../routines/routine-mail";
import { app, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Store } from "../store/store";
import { Engine } from "../engine/engine";
import { Scheduler } from "../routines/scheduler";
import { TerminalController } from "../terminal/terminal-controller";
import { ArtifactShares } from "../artifacts/artifact-shares";
import { ArtifactLibrary } from "../artifacts/artifact-library";
import { BackgroundHistory } from "../conversations/background-history";
import { importLegacyProfile } from "../account/accounts";
import { ProviderCredentials } from "../engine/provider-credentials";
import { ReplyFeedback } from "../conversations/reply-feedback";
import { saveOperatorConfig } from "../../server/operator-config";
import { resolveRequestLimits } from "../../server/operator-limits";
import { resolveRuntime } from "../engine/runtime";
import { mcpConfigText } from "../connectors/mcp-config-file";
import type { PublicAccount } from "../../shared/types";
import { type RemoteHost } from "../remote/host";
import { createPolicyHost, handleRefusal } from "../remote/host-wiring";
import { mainState } from "./main-state";
import {
  artifactPreviews,
  artifactPopouts,
  routineMail,
  selectedAttachments,
  cloudSync,
  desktopCredentials,
  accountDevices,
  deviceLink,
  selectedFolders,
  remoteFolders,
  integration,
  getDeviceDesktopPreferences,
  saveDeviceDesktopPreferences,
  policy,
  refusalListeners,
  activatedListeners,
  deactivatingListeners,
  appWindows,
  providerServiceScript,
  push,
  sendSettings,
  ctx,
  nativeExtensions,
  usageTurns,
} from "../main";
import { openMcpConfigFile } from "./mcp-config-file";
import { shapeMainWindow } from "./main-window";

// Share only in-flight stops of the same captured resource. A future restart
// may need a fresh stop; no permanent success cache or global-account lookup.
const resourceStops = new WeakMap<object, Promise<void>>();
function stopResource(resource: object | undefined, stop: () => void | Promise<void>) {
  if (!resource) return Promise.resolve();
  const pending = resourceStops.get(resource);
  if (pending) return pending;
  const result = Promise.resolve().then(stop);
  resourceStops.set(resource, result);
  void result.then(() => { if (resourceStops.get(resource) === result) resourceStops.delete(resource); },
    () => { if (resourceStops.get(resource) === result) resourceStops.delete(resource); });
  return result;
}

export async function deactivateAccount() {
  let diagnosticPhase = "cleanup.begin";
  try {
  const retiredStore = mainState.store;
  const retirementGeneration = mainState.accountRetirement.accountActivationIdentity;
  mainState.accountRetirement.beginDeactivation();
  const phase = mainState.accountRetirement.accountActivationIdentity;
  const captured = { remote: mainState.remote, credentials: mainState.credentials,
    engine: mainState.engine, shares: mainState.artifactShares, feedback: mainState.replyFeedback };
  const check = () => {
    if (mainState.accountRetirement.accountActivationIdentity !== phase || mainState.store !== retiredStore)
      throw activationLocalError("account_transition_superseded", "The account transition was superseded.");
  };
  diagnosticPhase = "cleanup.quick_entry";
  mainState.quickEntry?.hide();
  diagnosticPhase = "cleanup.terminals";
  const terminals = mainState.terminals;
  mainState.terminals = undefined;
  await terminals?.reset();
  check();
  // Packages' account services stop while the engine still runs.
  diagnosticPhase = "cleanup.listeners";
  if (mainState.activeAccount) await deactivatingListeners.emitAsync();
  check();
  // A separate conversation window belongs to the account that opened it.
  diagnosticPhase = "cleanup.conversation_windows";
  appWindows.closeConversationWindows();
  // Sign-out calls no longer use the session from here on.
  if (mainState.remote) mainState.remote.ready = false;
  diagnosticPhase = "cleanup.cloud_sync";
  cloudSync.stop();
  diagnosticPhase = "cleanup.device_link";
  deviceLink.disconnect();
  diagnosticPhase = "cleanup.usage";
  usageTurns.clear();
  diagnosticPhase = "cleanup.scheduler";
  mainState.scheduler?.stop();
  diagnosticPhase = "cleanup.engine";
  const incognitoRetirement = createIncognitoRetirement({
    store: retiredStore, engine: captured.engine, selected: selectedAttachments, feedback: captured.feedback,
    current: (ownedStore, ownedEngine) => mainState.accountRetirement.accountActivationIdentity === phase &&
      mainState.store === ownedStore && mainState.engine === ownedEngine,
    stop: async () => {
      await stopResource(captured.engine, () => captured.engine?.stop());
      check();
      diagnosticPhase = "cleanup.incognito";
    },
  });
  await incognitoRetirement.run();
  check();
  diagnosticPhase = "cleanup.store_flush";
  mainState.store?.flush();
  diagnosticPhase = "cleanup.shares";
  await stopResource(captured.shares, () => captured.shares?.stop());
  check();
  diagnosticPhase = "cleanup.popouts";
  artifactPopouts.closeAll();
  diagnosticPhase = "cleanup.selection";
  artifactPreviews.clear();
  selectedAttachments.clear();
  selectedFolders.clear();
  remoteFolders.clear();
  diagnosticPhase = "cleanup.remote_release";
  await captured.remote?.release(captured.credentials);
  check();
  mainState.remote = undefined;
  diagnosticPhase = "cleanup.credentials";
  mainState.credentials?.clear();
  diagnosticPhase = "cleanup.mcp";
  mainState.mcpConfig?.close();
  mainState.mcpConfig = undefined;
  clearTimeout(mainState.restartTimer);
  mainState.restartTimer = undefined;
  mainState.activeAccount = undefined;
  diagnosticPhase = "cleanup.account_devices";
  accountDevices.current(undefined);
  mainState.trayUsagePercent = undefined;
  mainState.trayUsageUnavailable = false;
  diagnosticPhase = "cleanup.window_shape";
  if (!isRetiredOfficialWindow(mainState.window)) shapeMainWindow(false);
  mainState.rendererBase = undefined;
  diagnosticPhase = "cleanup.integration_reset";
  integration.reset();
  diagnosticPhase = "cleanup.integration_apply";
  try { integration.apply(); }
  catch (error) {
    // Account resources were already retired/reset. An unavailable optional
    // signed-out shortcut must not retain account state; other failures propagate.
    if (!isShortcutRegistrationFailure(error)) throw error;
    check();
    try { console.error("The signed-out Quick access shortcut could not be registered."); } catch {}
  }
  mainState.activeSessionToken = undefined;
  mainState.scheduler = undefined;
  diagnosticPhase = "cleanup.policy";
  mainState.policyHost?.stop();
  mainState.policyHost = undefined;
  // Back to the state of a start with nobody signed in: nothing of the
  // account stays reachable through ctx, so the engine registry sees no local
  // engine and "Sign in to continue." guards fire instead of answering from
  // the stopped one.
  diagnosticPhase = "cleanup.clear_state";
  const none = undefined as never;
  mainState.engine = none;
  mainState.store = none;
  mainState.credentials = none;
  mainState.artifactShares = none;
  mainState.artifactLibrary = none;
  mainState.backgroundHistory = none;
  mainState.replyFeedback = none;
  diagnosticPhase = "cleanup.notify";
  accountDeactivated(retiredStore, retirementGeneration);
  } catch (error) { noteActivationPhase(error, diagnosticPhase); throw error; }
}

/** Opens an account's profile, runtime and policy; `host` for a Sub2API account. */
export async function activateAccount(
  account: PublicAccount,
  token: string,
  host?: RemoteHost,
  intentCurrent: () => boolean = () => true,
) {
  if (!intentCurrent()) throw activationLocalError("account_transition_superseded", "The account activation was superseded.");
  const activationGeneration = mainState.accountRetirement.beginActivation();
  const root = app.getPath("userData");
  const limits = host
    ? host.requestLimits(account.id)
    : resolveRequestLimits(root, account.id);
  const profile = host
    ? host.profileRoot(account.id)
    : mainState.accounts.profileRoot(account.id);
  const first = !host && mainState.accounts.ownsLegacyData(account.id);
  if (first) importLegacyProfile(root, profile);
  const hasSettings = fs.existsSync(path.join(profile, "settings.json"));
  const activationStore = new Store(profile, desktopCredentials.cipher);
  mainState.store = activationStore;
  const current = () => intentCurrent() && mainState.accountRetirement.accountActivationIdentity === activationGeneration && mainState.store === activationStore;
  const check = () => { if (!current()) throw activationLocalError("account_transition_superseded", "The account activation was superseded."); };
  let activationScheduler: Scheduler | undefined;
  let activationTerminals: TerminalController | undefined;
  let activationShares: ArtifactShares | undefined;
  let activationCredentials: ProviderCredentials | undefined;
  let activationEngine: Engine | undefined;
  let activationPhase = "profile_setup";
  try {
  discardIncognitoUploads(profile, selectedAttachments);
  if (activationStore.settings.codeBrowserTools === undefined ||
      activationStore.settings.browserKeepCookies === undefined ||
      activationStore.settings.remoteControlStayReachable === undefined ||
      activationStore.settings.remoteControlSpawnMode === undefined ||
      activationStore.settings.legacyQuickEntryEnabled === undefined) {
    const legacy = inAdapterScope(newAdapterScope(account.id, profile), () =>
      readState<{
        launchEnabled?: unknown;
        launchPreviewStorage?: unknown;
        remoteControlStayReachable?: unknown;
        remoteControlSpawnMode?: unknown;
        legacyQuickEntryEnabled?: unknown;
      }>("preferences", {}),
    );
    const storage = legacy.launchPreviewStorage;
    const cookieMode = storage === "none" ? "until-quit" : storage === "shared" ? "always" : storage === "session" ? "per-session" : undefined;
    const codeBrowserTools = activationStore.settings.codeBrowserTools ??
      (typeof legacy.launchEnabled === "boolean" ? legacy.launchEnabled : undefined);
    const browserKeepCookies = activationStore.settings.browserKeepCookies ?? cookieMode;
    const stayReachable = activationStore.settings.remoteControlStayReachable ??
      (typeof legacy.remoteControlStayReachable === "boolean" ? legacy.remoteControlStayReachable : undefined);
    const remoteControlSpawnMode = activationStore.settings.remoteControlSpawnMode ??
      (legacy.remoteControlSpawnMode === "same-dir" || legacy.remoteControlSpawnMode === "worktree"
        ? legacy.remoteControlSpawnMode
        : undefined);
    const legacyQuickEntryEnabled = activationStore.settings.legacyQuickEntryEnabled ??
      (typeof legacy.legacyQuickEntryEnabled === "boolean" ? legacy.legacyQuickEntryEnabled : undefined);
    if (codeBrowserTools !== activationStore.settings.codeBrowserTools ||
        browserKeepCookies !== activationStore.settings.browserKeepCookies ||
        stayReachable !== activationStore.settings.remoteControlStayReachable ||
        remoteControlSpawnMode !== activationStore.settings.remoteControlSpawnMode ||
        legacyQuickEntryEnabled !== activationStore.settings.legacyQuickEntryEnabled) {
      activationStore.settings.codeBrowserTools = codeBrowserTools;
      activationStore.settings.browserKeepCookies = browserKeepCookies;
      activationStore.settings.remoteControlStayReachable = stayReachable;
      activationStore.settings.remoteControlSpawnMode = remoteControlSpawnMode;
      activationStore.settings.legacyQuickEntryEnabled = legacyQuickEntryEnabled;
      activationStore.flush();
    }
  }
  if (!hasSettings) {
    activationStore.settings.name = account.name;
    if (officialUiEnabled()) activationStore.settings.theme = "system";
    activationStore.flush();
  }
  if (!host && !mainState.operatorConfig && first) {
    const providers = activationStore.settings.providers.filter((provider) =>
      provider.model.trim(),
    );
    if (
      providers.length &&
      providers.some(
        (provider) => provider.id === activationStore.settings.activeProviderId,
      )
    ) {
      mainState.operatorConfig = {
        version: 1,
        providers: providers.map((provider) => ({
          ...provider,
          models: [...new Set([provider.model, ...provider.models])],
        })),
        activeProviderId: activationStore.settings.activeProviderId,
      };
      saveOperatorConfig(root, mainState.operatorConfig);
    }
  }
  if (!host && mainState.operatorConfig) {
    activationStore.settings.providers = structuredClone(
      mainState.operatorConfig.providers,
    );
    activationStore.settings.activeProviderId =
      mainState.operatorConfig.activeProviderId;
    activationStore.flush();
  }
  mainState.artifactLibrary = new ArtifactLibrary(activationStore.root);
  mainState.backgroundHistory = new BackgroundHistory(activationStore.root);
  mainState.artifactShares = new ArtifactShares(activationStore.root);
  activationShares = mainState.artifactShares;
  activationPhase = "artifact_shares";
  const uiPort = savedAccountUiPort(account.id, activationStore.root, root);
  await activationShares.start(uiPort && isReservedLoopbackPort(uiPort) ? uiPort : undefined);
  check();
  mainState.replyFeedback = new ReplyFeedback(activationStore.root);
  nativeTheme.themeSource = activationStore.settings.theme;
  mainState.credentials = new ProviderCredentials(
    desktopCredentials.root,
    providerServiceScript(),
    desktopCredentials.cipher,
  );
  activationCredentials = mainState.credentials;
  activationPhase = "credentials_and_host_prepare";
  if (host) { await host.prepare(activationCredentials, current); check(); }
  else {
    await activationCredentials.initialize(activationStore.settings.providers, current);
    check();
    if (!desktopCredentials.usesLocalFiles) {
      await activationCredentials.importAccountVault(
        profile,
        activationStore.settings.providers,
        current,
      );
      check();
    }
  }
  activationPhase = "engine_setup";
  activationEngine = new Engine(
    activationStore,
    resolveRuntime(app.isPackaged ? process.resourcesPath : undefined),
    // A Sub2API key that could not be stored encrypted is handed over at start.
    (id) => host?.sessionKey(id) ?? "",
    (event) => {
      if (!current()) return;
      if (event.type === "conversation") {
        activationScheduler?.observeConversation(event.conversation);
        usageTurns.observe(event.conversation);
        integration.observeConversation(event.conversation);
      }
      if (event.type === "approval")
        integration.observeApproval(event.approval, { reAlert: event.reAlert });
      if (event.type === "approval-resolved")
        integration.observeApprovalResolved(event.id);
      push(event);
    },
    providerServiceScript(),
    activationCredentials.vaultKey,
    desktopCredentials.root,
    limits,
    (refusal) => {
      if (!current()) return;
      handleRefusal(ctx, refusal);
      refusalListeners.emit(refusal);
    },
  );
  const ownedEngine = activationEngine;
  mainState.engine = ownedEngine;
  // A Chat's code reaches the network as Settings → Capabilities allows
  // (shared/local-egress.ts); the web runner has its own egress proxy.
  ownedEngine.localEgress = true;
  mainState.remote = host;
  if (host) {
    const { locationMetadataExtension } =
      await import("../account/location-metadata");
    check();
    const locationStore = activationStore;
    const location = locationMetadataExtension(
      () => locationStore.settings,
      () =>
        host.backend.session.authorized((token) =>
          host.backend.client.location(token),
        ),
    );
    ownedEngine.extensions.add(location.extension);
    void location.prepare();
  }
  ownedEngine.connectorHeaders = (name) => {
    check();
    const resource = (activationStore.settings.mcpServers[name] as { url?: string } | undefined)?.url;
    if (!resource) return undefined;
    const headers = savedConnectorHeaders(activationStore.root, name, resource);
    const status = desktopConnectorAuthStatus(ctx, name, resource);
    if (status === "reconnect" || status === "disconnected") return headers;
    const bearer = desktopConnectorHeaders(activationStore.root, name, resource);
    return bearer ? { ...headers, ...bearer } : headers;
  };
  ownedEngine.connectorAuthorizationRejected = (name, resource, bearer) => {
    if (current()) desktopConnectorAuthRejected(ctx, name, resource, bearer);
  };
  ownedEngine.connectorAuthStatus = (name, resource) => {
    check();
    return desktopConnectorAuthStatus(ctx, name, resource);
  };
  ownedEngine.remoteConnectorSkill = registerRemoteConnectorSkills({
    store: activationStore,
    current: () => current() && !mainState.accountRetirement.accountRetiring,
    policy: () => ctx.policy(),
    headers: (name) => ownedEngine.connectorHeaders?.(name),
  }).resolve;
  // The policy source; stored settings are brought within it first.
  mainState.policyHost = createPolicyHost(ctx, account.id);
  ownedEngine.unavailableReason = host?.unavailableReason;
  // "Always allow" on a connector tool changes the connector's settings: the
  // MCP configuration file follows, and the open windows read them again.
  ownedEngine.onMcpServersRemembered = () => {
    if (!current()) return;
    try {
      if (mainState.mcpConfig)
        fs.writeFileSync(
          mainState.mcpConfig.path,
          mcpConfigText(activationStore.settings.mcpServers),
          {
            mode: 0o600,
          },
        );
    } catch {
      // The settings hold it; the file catches up on the next edit.
    }
    sendSettings();
  };
  activationTerminals = new TerminalController(
    activationStore,
    ownedEngine,
    (event) => { if (current()) push(event); },
  );
  mainState.terminals = activationTerminals;
  const summarize = engineRoutineSummary(ownedEngine, () => activationStore.settings);
  const scheduledTaskScope = newAdapterScope(account.id, profile);
  activationScheduler = new Scheduler(activationStore.root, {
    summarize: (...args) => { check(); return summarize(...args); },
    computerAccess: () => current() && activationStore.settings.computerAccess !== false,
    enabledModes: () =>
      current() && officialUiEnabled()
        ? officialScheduledTaskModes(scheduledTaskScope)
        : undefined,
    isBusy: () => !current() || ownedEngine.isBusy() || mainState.shuttingDown,
    policy,
    run: (saved) => {
      check();
      const task = routineRunModel(saved, activationStore.settings, "local");
      if (task.mode === "code")
        ctx.services.workspaceTrust?.assert({ mode: "code", cwd: task.cwd });
      return ownedEngine.send(
        routineSessionInput(task, activationStore.settings),
        undefined,
        false,
        { current, interactive: false },
      );
    },
    onChange: (schedules) => {
      if (!current()) return;
      push({ type: "schedules", schedules });
    },
    // The task's e-mail through the service (electron/routine-mail.ts).
    onRunEnded: (task, run) => {
      if (!current()) return;
      if (
        !routineRunMails(
          task,
          preference(activationStore.settings, "notifySchedulesEmail"),
        )
      )
        return;
      void routineMail
        .send({
          task: task.name,
          outcome: run.outcome,
          summary: run.summary ?? run.error,
        })
        .catch(() => {});
    },
    onError: (error) =>
      console.error(
        "Scheduled task:",
        error instanceof Error ? error.message : String(error),
      ),
  });
  mainState.scheduler = activationScheduler;
  const routines = activationScheduler;
  ownedEngine.routineApprovals = {
    isUnattended: (conversation) =>
      routines.isUnattendedConversation(conversation),
    holdForConnection: (id, hold) => routines.holdForConnection(id, hold),
    allowed: (id) => routines.allowedFor(id),
    allow: (id, entry) => routines.allow(id, entry),
  };
  const savedDesktop = getDeviceDesktopPreferences();
  const desktop = desktopPreferences({
    ...(savedDesktop ?? activationStore.settings),
    legacyQuickEntryEnabled: savedDesktop?.legacyQuickEntryEnabled ??
      activationStore.settings.legacyQuickEntryEnabled,
    menuBar: savedDesktop?.menuBar ??
      preference(activationStore.settings, "menuBar"),
    keepAwake: savedDesktop?.keepAwake ??
      preference(activationStore.settings, "keepAwake"),
    keepAwakeWhileCoding: savedDesktop?.keepAwakeWhileCoding ??
      preference(activationStore.settings, "keepAwakeWhileCoding"),
    keepAwakeOnBattery: savedDesktop?.keepAwakeOnBattery ??
      preference(activationStore.settings, "keepAwakeOnBattery"),
    notificationLevels: savedDesktop?.notificationLevels ??
      notificationLevels(activationStore.settings),
    notificationSound: savedDesktop?.notificationSound ??
      preference(activationStore.settings, "notificationSound"),
    drawAttention: savedDesktop?.drawAttention ??
      preference(activationStore.settings, "drawAttention"),
  });
  Object.assign(activationStore.settings, desktop);
  if (!savedDesktop || !isDeepStrictEqual(desktopPreferences(savedDesktop), desktop)) {
    try {
      saveDeviceDesktopPreferences(desktop);
    } catch (error) {
      console.error("Desktop preferences could not be saved:", error instanceof Error ? error.message : error);
    }
  }
  mainState.activeAccount = host ? host.account(account) : account;
  mainState.activeSessionToken = token;
  activationPhase = "policy_start";
  mainState.policyHost.start();
  await openMcpConfigFile();
  check();
  activationPhase = "native_extensions";
  await nativeExtensions.activate();
  check();
  try {
    integration.apply();
  } catch (error) {
    console.error("Quick access shortcut:", (error as Error).message);
  }
  activationScheduler.start();
  void ownedEngine
    .ensure(
      activationStore.settings.providers.find(
        (provider) => provider.id === activationStore.settings.activeProviderId,
      )!,
      { current },
    )
    .catch(() => {});
  if (
    mainState.store === activationStore &&
    mainState.activeAccount?.id === account.id
  )
    mainState.accountRetirement.finishActivation(activationGeneration);
  activationPhase = "activation_listeners";
  activatedListeners.emit(mainState.activeAccount);
  check();
  if (!officialUiEnabled()) shapeMainWindow(true);
  check();
  deviceLink.refresh();
  } catch (error) {
    noteActivationPhase(error, activationPhase);
    // Never call deactivateAccount here: it may now belong to a newer winner.
    // Captured resources alone are safe to stop; shared nativeExtensions/policy
    // callbacks require their own lifecycle and are not globally reset here.
    const cleanup = [
      () => activationScheduler?.stop(),
      () => activationTerminals?.reset(),
      () => activationCredentials?.clear(),
      () => stopResource(activationEngine, () => activationEngine?.stop()),
      () => stopResource(activationShares, () => activationShares?.stop()),
    ];
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const outcomes = await Promise.race([
      Promise.allSettled(cleanup.map(fn => Promise.resolve().then(fn))),
      new Promise<undefined>(resolve => { cleanupTimer = setTimeout(() => resolve(undefined), 5000); }),
    ]);
    clearTimeout(cleanupTimer);
    if (!outcomes || outcomes.some(result => result.status === "rejected"))
      console.error("Superseded account resource cleanup was not confirmed.");
    // Timeout is not successful destruction: captured cleanup can finish late,
    // but may not retain the caller's original transition error indefinitely.
    throw error;
  }

}
