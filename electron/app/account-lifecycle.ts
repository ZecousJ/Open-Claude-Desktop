import { routineSessionInput } from "../routines/routine-session";
import { desktopConnectorHeaders } from "../connectors/connector-auth";
import { preference } from "../../shared/settings-extras";
import { routineRunModel } from "../../shared/routines";
import { engineRoutineSummary } from "../routines/routine-summary";
import { routineRunMails } from "../routines/routine-mail";
import { app, safeStorage, nativeTheme } from "electron";
import fs from "node:fs";
import path from "node:path";
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
  accountDevices,
  deviceLink,
  selectedFolders,
  remoteFolders,
  integration,
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

export async function deactivateAccount() {
  mainState.quickEntry?.hide();
  // Packages' account services stop first, while the engine still runs.
  if (mainState.activeAccount) await deactivatingListeners.emitAsync();
  // A separate conversation window belongs to the account that opened it.
  appWindows.closeConversationWindows();
  // Sign-out calls no longer use the session from here on.
  if (mainState.remote) mainState.remote.ready = false;
  cloudSync.stop();
  deviceLink.disconnect();
  usageTurns.clear();
  mainState.scheduler?.stop();
  mainState.terminals?.reset();
  mainState.terminals = undefined;
  await mainState.engine?.stop();
  mainState.store?.flush();
  await mainState.artifactShares?.stop();
  artifactPopouts.closeAll();
  artifactPreviews.clear();
  selectedAttachments.clear();
  selectedFolders.clear();
  remoteFolders.clear();
  await mainState.remote?.release(mainState.credentials);
  mainState.remote = undefined;
  mainState.credentials?.clear();
  mainState.mcpConfig?.close();
  mainState.mcpConfig = undefined;
  clearTimeout(mainState.restartTimer);
  mainState.restartTimer = undefined;
  mainState.activeAccount = undefined;
  accountDevices.current(undefined);
  mainState.trayUsagePercent = undefined;
  mainState.trayUsageUnavailable = false;
  shapeMainWindow(false);
  mainState.rendererBase = undefined;
  integration.reset();
  integration.apply();
  mainState.activeSessionToken = undefined;
  mainState.scheduler = undefined;
  mainState.policyHost?.stop();
  mainState.policyHost = undefined;
  // Back to the state of a start with nobody signed in: nothing of the
  // account stays reachable through ctx, so the engine registry sees no local
  // engine and "Sign in to continue." guards fire instead of answering from
  // the stopped one.
  const none = undefined as never;
  mainState.engine = none;
  mainState.store = none;
  mainState.credentials = none;
  mainState.artifactShares = none;
  mainState.artifactLibrary = none;
  mainState.backgroundHistory = none;
  mainState.replyFeedback = none;
}

/** Opens an account's profile, runtime and policy; `host` for a Sub2API account. */
export async function activateAccount(
  account: PublicAccount,
  token: string,
  host?: RemoteHost,
) {
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
  mainState.store = new Store(profile);
  if (!hasSettings) {
    mainState.store.settings.name = account.name;
    mainState.store.flush();
  }
  if (!host && !mainState.operatorConfig && first) {
    const providers = mainState.store.settings.providers.filter((provider) =>
      provider.model.trim(),
    );
    if (
      providers.length &&
      providers.some(
        (provider) => provider.id === mainState.store.settings.activeProviderId,
      )
    ) {
      mainState.operatorConfig = {
        version: 1,
        providers: providers.map((provider) => ({
          ...provider,
          models: [...new Set([provider.model, ...provider.models])],
        })),
        activeProviderId: mainState.store.settings.activeProviderId,
      };
      saveOperatorConfig(root, mainState.operatorConfig);
    }
  }
  if (!host && mainState.operatorConfig) {
    mainState.store.settings.providers = structuredClone(
      mainState.operatorConfig.providers,
    );
    mainState.store.settings.activeProviderId =
      mainState.operatorConfig.activeProviderId;
    mainState.store.flush();
  }
  mainState.artifactLibrary = new ArtifactLibrary(mainState.store.root);
  mainState.backgroundHistory = new BackgroundHistory(mainState.store.root);
  mainState.artifactShares = new ArtifactShares(mainState.store.root);
  await mainState.artifactShares.start();
  mainState.replyFeedback = new ReplyFeedback(mainState.store.root);
  nativeTheme.themeSource = mainState.store.settings.theme;
  mainState.credentials = new ProviderCredentials(
    root,
    providerServiceScript(),
    safeStorage,
  );
  if (host) await host.prepare(mainState.credentials);
  else {
    await mainState.credentials.initialize(mainState.store.settings.providers);
    await mainState.credentials.importAccountVault(
      profile,
      mainState.store.settings.providers,
    );
  }
  mainState.engine = new Engine(
    mainState.store,
    resolveRuntime(app.isPackaged ? process.resourcesPath : undefined),
    // A Sub2API key that could not be stored encrypted is handed over at start.
    (id) => host?.sessionKey(id) ?? "",
    (event) => {
      if (event.type === "conversation") {
        mainState.scheduler?.observeConversation(event.conversation);
        usageTurns.observe(event.conversation);
        integration.observeConversation(event.conversation);
      }
      if (event.type === "approval")
        integration.observeApproval(event.approval, { reAlert: event.reAlert });
      if (event.type === "approval-resolved")
        integration.observeApprovalResolved(event.id);
      if (event.type === "engine" && event.engine.state !== "ready") {
        mainState.terminals?.reset();
        mainState.terminals = undefined;
      }
      push(event);
    },
    providerServiceScript(),
    mainState.credentials.vaultKey,
    root,
    limits,
    (refusal) => {
      handleRefusal(ctx, refusal);
      refusalListeners.emit(refusal);
    },
  );
  // A Chat's code reaches the network as Settings → Capabilities allows
  // (shared/local-egress.ts); the web runner has its own egress proxy.
  mainState.engine.localEgress = true;
  mainState.remote = host;
  if (host) {
    const { locationMetadataExtension } =
      await import("../account/location-metadata");
    const locationStore = mainState.store;
    const location = locationMetadataExtension(
      () => locationStore.settings,
      () =>
        host.backend.session.authorized((token) =>
          host.backend.client.location(token),
        ),
    );
    mainState.engine.extensions.add(location.extension);
    void location.prepare();
  }
  mainState.engine.connectorHeaders = (name) =>
    desktopConnectorHeaders(
      mainState.store.root,
      name,
      (
        mainState.store.settings.mcpServers[name] as
          { url?: string } | undefined
      )?.url,
    );
  // The policy source; stored settings are brought within it first.
  mainState.policyHost = createPolicyHost(ctx, account.id);
  mainState.engine.unavailableReason = host?.unavailableReason;
  // "Always allow" on a connector tool changes the connector's settings: the
  // MCP configuration file follows, and the open windows read them again.
  mainState.engine.onMcpServersRemembered = () => {
    try {
      if (mainState.mcpConfig)
        fs.writeFileSync(
          mainState.mcpConfig.path,
          mcpConfigText(mainState.store.settings.mcpServers),
          {
            mode: 0o600,
          },
        );
    } catch {
      // The settings hold it; the file catches up on the next edit.
    }
    sendSettings();
  };
  mainState.terminals = new TerminalController(
    mainState.store,
    mainState.engine,
    push,
  );
  mainState.scheduler = new Scheduler(mainState.store.root, {
    summarize: engineRoutineSummary(
      mainState.engine,
      () => mainState.store.settings,
    ),
    computerAccess: () => mainState.store.settings.computerAccess !== false,
    isBusy: () => mainState.engine.isBusy() || mainState.shuttingDown,
    policy,
    run: (saved) => {
      const task = routineRunModel(saved, mainState.store.settings, "local");
      return mainState.engine.send(
        routineSessionInput(task, mainState.store.settings),
      );
    },
    onChange: (schedules) => {
      push({ type: "schedules", schedules });
    },
    // The task's e-mail through the service (electron/routine-mail.ts).
    onRunEnded: (task, run) => {
      if (
        !routineRunMails(
          task,
          preference(mainState.store.settings, "notifySchedulesEmail"),
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
  const routines = mainState.scheduler;
  mainState.engine.routineApprovals = {
    isUnattended: (conversation) =>
      routines.isUnattendedConversation(conversation),
    holdForConnection: (id, hold) => routines.holdForConnection(id, hold),
    allowed: (id) => routines.allowedFor(id),
    allow: (id, entry) => routines.allow(id, entry),
  };
  mainState.activeAccount = host ? host.account(account) : account;
  mainState.activeSessionToken = token;
  mainState.policyHost.start();
  openMcpConfigFile();
  await nativeExtensions.activate();
  try {
    integration.apply();
  } catch (error) {
    console.error("Quick access shortcut:", (error as Error).message);
  }
  mainState.scheduler.start();
  void mainState.engine
    .ensure(
      mainState.store.settings.providers.find(
        (provider) => provider.id === mainState.store.settings.activeProviderId,
      )!,
    )
    .catch(() => {});
  activatedListeners.emit(mainState.activeAccount);
  shapeMainWindow(true);
  deviceLink.refresh();
}
