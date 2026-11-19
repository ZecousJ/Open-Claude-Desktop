import { stageSession } from "./session-stage";
import { organizationPluginSources } from "./organization-plugin-sources";
import { routineSessionInput } from "../../electron/routines/routine-session";
import { gitHubTools } from "./github-tools";
import { persistSessionPullRequest } from "./session-git";
import { autoFixFacts } from "../../electron/git/pr-autofix";
import fs from "node:fs";
import path from "node:path";
import type { AppEvent, Conversation, PublicAccount } from "../../shared/types";
import { webHost } from "../../shared/host";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { cloudCodeConnectorInventory } from "../../electron/official-ui/api/cloud-code-connectors";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import { webErrorCodes } from "../../shared/web-protocol";
import { Accounts } from "../../electron/account/accounts";
import { ArtifactLibrary } from "../../electron/artifacts/artifact-library";
import { ArtifactShares } from "../../electron/artifacts/artifact-shares";
import { BackgroundHistory } from "../../electron/conversations/background-history";
import {
  ConnectorClients,
  connectorRequestHeaders,
  savedConnectorHeaders,
} from "../../electron/connectors/connector-clients";
import { Engine } from "../../electron/engine/engine";
import { CodeRunAdmissionError } from "../../electron/engine/code-send-start";
import { webCallScope } from "./electron-shim";
import { callError } from "./dispatcher-support";
import { registerRemoteConnectorSkills } from "../../electron/connectors/remote-skills";
import { ProviderCredentials } from "../../electron/engine/provider-credentials";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import {
  createPolicyHost,
  handleRefusal,
} from "../../electron/remote/host-wiring";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { CloudStore } from "./cloud-store";
import { discardIncognitoUploads } from "../../electron/workspace/incognito-upload";
import { parseWebKey, WebRemoteHost, type WebKey } from "./web-remote-host";
import { attachmentsFolder, pruneAttachments } from "./attachments";
import { queuedCodeAttachmentIds } from "./official-code-queue";
import { Scheduler } from "../../electron/routines/scheduler";
import { engineRoutineSummary } from "../../electron/routines/routine-summary";
import { ConnectorOAuth } from "./connector-oauth";
import {
  ConnectorTokens,
  connectorFetch,
  connectorHosts,
  connectorUrlGuard,
} from "./connectors";
import type { UserNetwork } from "./net-policy-compile";
import { nextWakeAt, routineRunModel } from "../../shared/routines";
import { preference } from "../../shared/settings-extras";
import { noWorkingTree } from "./sandbox-git";
import { routineRunMails } from "../../electron/routines/routine-mail";
import { isOwnedCloudCodeSession } from "../../electron/official-ui/api/code-session-ownership";
import {
  prepareCodexCache,
  pruneIdleSpaceCaches,
} from "../../electron/engine/codex-cache";
import type { WebAppContext, WebContextOpenInput } from "./web-app-context";
import { browserNotificationSettings } from "../../shared/official-notification-preferences";

export async function activate(
  this: WebAppContext,
  { accessToken, register, accountSettingsReady, shellReady }: WebContextOpenInput,
) {
  const runtime = this.runtime;
  const profile = path.join(this.dataRoot, "profile");
  // Who the token belongs to (Go checked it; the runner never trusts an id alone).
  const me = await this.me(accessToken);
  if (me.id !== this.userId)
    throw Object.assign(
      new Error("The session does not belong to this user."),
      { code: webErrorCodes.badRequest },
    );
  await runtime.prepareUserData?.(this.userId, profile);
  discardIncognitoUploads(profile, this.selectedAttachments);
  pruneIdleSpaceCaches(profile, new Set());
  const codexCache = prepareCodexCache(profile, profile);
  const account: PublicAccount = {
    id: remoteAccountId(runtime.serviceUrl, me.id),
    email: me.email,
    name: me.username || me.email.split("@")[0] || me.email,
    remote: true,
  };
  this.store = await CloudStore.openAccount({
    root: profile,
    userId: this.userId,
    transport: runtime.transport,
    log: this.log,
  }, (settings) => accountSettingsReady?.({
    accountId: account.id,
    settings: browserNotificationSettings(settings),
  }));
  const history = this.store.loadHistory();
  void history.catch(() => {});
  const attachments = attachmentsFolder(profile);
  // The first time, the name is the account's (as a desktop profile starts).
  if (this.store.fresh || !this.store.settings.name)
    this.store.settings.name = account.name;
  this.accounts = new Accounts(path.join(this.dataRoot, "local-accounts"));
  this.artifactLibrary = new ArtifactLibrary(profile);
  this.backgroundHistory = new BackgroundHistory(profile);
  // Local share links would point at the runner's loopback: not started.
  this.artifactShares = new ArtifactShares(profile);
  this.replyFeedback = new ReplyFeedback(profile);
  this.credentials = new ProviderCredentials(
    this.dataRoot,
    this.providerServiceScript,
    {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error(notAvailableOnWeb);
      },
      decryptString: () => {
        throw new Error(notAvailableOnWeb);
      },
    },
  );
  const key = async (): Promise<WebKey> =>
    parseWebKey(await runtime.transport.request("key.get", this.userId, {}));
  const parts = WebRemoteHost.create(this, {
    baseUrl: runtime.serviceUrl,
    dataRoot: this.dataRoot,
    userId: this.userId,
    email: me.email,
    key,
    fetch: runtime.fetch,
  });
  this.session = parts.session;
  this.session.setAccessToken(accessToken);
  const host = parts.host;
  host.watch();
  this.remote = host;
  // The plan, key and models; a plan problem is shown, not fatal.
  let prepareError: string | undefined;
  try {
    await host.prepare(this.credentials);
  } catch (error) {
    prepareError =
      error instanceof Error ? error.message : "Your plan is unavailable.";
    this.log(
      `claudex-runner: user ${this.userId}'s plan could not be read: ${prepareError}`,
    );
  }
  // Settings → Connectors: remote servers with their tokens on the runner.
  this.connectorTokens = new ConnectorTokens(profile);
  const integrations = path.join(profile, "integrations");
  fs.mkdirSync(integrations, { recursive: true, mode: 0o700 });
  this.integrationTokens = new ConnectorTokens(integrations);
  const connectorNetwork = this.runtime.connectorNetwork ?? { level: "full" as const };
  const guard = connectorUrlGuard(connectorNetwork);
  const connectorStore = this.store;
  const connectorActivation = this.officialSessionIdentity();
  const connectorTokens = this.connectorTokens;
  const fetchConnector = connectorFetch(connectorNetwork);
  const connectorAccountCurrent = () =>
    !this.accountRetiring && this.activeAccount?.id === account.id &&
    this.store === connectorStore && this.connectors === connectors &&
    this.officialSessionIdentity() === connectorActivation;
  const oauth = new ConnectorOAuth(
    profile,
    runtime.publicUrl ?? runtime.serviceUrl,
    fetchConnector,
    connectorTokens,
    () => { if (connectorAccountCurrent()) this.mcpConfig.authorizationChanged(); },
    (name, resource) => {
      const server = connectorStore.settings.mcpServers[name] as
        { url?: string; enabled?: boolean } | undefined;
      return (
        connectorAccountCurrent() && server?.url === resource && server.enabled !== false &&
        connectorAllowed(this.policy(), name, server)
      );
    },
  );
  const getConnectorToken = (name: string) => {
    const resource = (connectorStore.settings.mcpServers[name] as { url?: string } | undefined)?.url;
    const status = resource && oauth.status(name, resource);
    if (status !== "reconnect" && status !== "disconnected") return connectorTokens.get(name);
  };
  const connectors: WebAppContext["connectors"] = {
    assertUrl: guard,
    fetch: fetchConnector,
    getToken: getConnectorToken,
    setToken: (name, token) => {
      const resource = (connectorStore.settings.mcpServers[name] as { url?: string } | undefined)?.url;
      if (token && resource) oauth.forget(name, resource);
      connectorTokens.set(name, token);
    },
  };
  this.connectors = connectors;
  connectors.beginLogin = async (name, resource, returnUrl) => {
    const address = await oauth.begin(
      name,
      resource,
      returnUrl,
      new ConnectorClients(connectorStore.root).get(name, resource),
    );
    await connectors.assertUrl(address);
    return address;
  };
  connectors.completeLogin = (state, code, issuer, expectedName) => oauth.complete(state, code, issuer, expectedName);
  this.connectorOAuth = oauth;
  // The sandbox's network follows the user's Capabilities settings.
  const reportNetwork = () =>
    this.runtime.network?.(this.userId, this.userNetwork());
  reportNetwork();
  this.settingsListeners.add(reportNetwork);
  // Project chats are told where their knowledge files are (engine.ts);
  // the sandbox sees the folder at the same path, read-only.
  const projects = path.join(profile, "projects");
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const binary = runtime.codexBinary({
    userId: this.userId,
    storeRoot: profile,
    codexCache,
    attachments,
    projects,
    organizationPluginSources: organizationPluginSources(profile),
  });
  const markCodeUnread = (event: Extract<AppEvent, { type: "conversation" }>) => {
    const { conversation, settledCodeTurnId } = event;
    const turn = conversation.turns.at(-1);
    if (this.accountRetiring || !settledCodeTurnId || turn?.id !== settledCodeTurnId ||
        conversation.archived || turn.compaction || !isOwnedCloudCodeSession(conversation, account.id) ||
        (turn.status !== "completed" && turn.status !== "failed")) return;
    const stored = this.store.conversations.find((row) =>
      row.id === conversation.id && row.createdAt === conversation.createdAt,
    );
    if (!stored) return;
    const patch = { unread: true, readStateRevision: (stored.readStateRevision ?? 0) + 1 };
    Object.assign(stored, patch);
    Object.assign(conversation, patch);
    this.store.flush();
    return { type: "code-read-state", conversationId: conversation.id, ...patch } satisfies AppEvent;
  };
  this.engine = new Engine(
    this.store,
    binary,
    (id) => host.sessionKey(id),
    (event) => {
      const readState = event.type === "conversation" ? markCodeUnread(event) : undefined;
      if (event.type === "conversation") {
        this.usageTurns.observe(event.conversation);
        this.scheduler?.observeConversation(event.conversation);
      }
      this.push(event);
      if (readState) this.push(readState);
    },
    this.providerServiceScript,
    this.credentials.vaultKey,
    this.dataRoot,
    this.requestLimitsFor(account.id),
    (refusal) => {
      handleRefusal(this, refusal);
      this.refusalListeners.emit(refusal);
    },
  );
  if (runtime.codeRunCapacity) {
    const capacity = runtime.codeRunCapacity;
    this.engine.admitCodeRun = async (conversation, start) => {
      if (webCallScope.getStore()?.consumeGoRunSlot?.()) return;
      try {
        return await capacity.acquire({
          userId: this.userId,
          conversation,
          start,
          subscribe: (listener) => this.onEvent(listener),
        });
      } catch (error) {
        if (start.cancelledBeforeDispatch) throw error;
        const result = callError(error);
        throw new CodeRunAdmissionError(result.message, result.code);
      }
    };
  }
  // A cloud Code session's GitHub tools (push, pull requests, issues),
  // also in the repository spaces' engines.
  const githubStore = this.store;
  const githubActivation = this.officialSessionIdentity();
  const githubSessionCurrent = (conversation: Conversation) =>
    !this.accountRetiring &&
    this.activeAccount?.id === account.id &&
    this.officialSessionIdentity() === githubActivation &&
    this.store === githubStore &&
    githubStore.conversations.includes(conversation) &&
    isOwnedCloudCodeSession(conversation, account.id);
  const github = gitHubTools({
    userId: this.userId,
    transport: runtime.transport,
    // The branch and git state each session records after a turn.
    workingTree: () => this.services.workingTree,
    automaticPullRequests: {
      settings(conversation) {
        return githubSessionCurrent(conversation)
          ? githubStore.settings
          : { prAutoCreate: false };
      },
      async save(conversation, pr) {
        await persistSessionPullRequest(
          githubStore,
          conversation,
          pr,
          () => githubSessionCurrent(conversation),
        );
      },
    },
  });
  this.engine.extensions.add(github);
  const { locationMetadataExtension } =
    await import("../../electron/account/location-metadata");
  const locationStore = this.store;
  const location = locationMetadataExtension(
    () => locationStore.settings,
    () => runtime.transport.request("location.get", this.userId, {}),
  );
  this.engine.extensions.add(location.extension);
  this.engine.peerExtensions.push(location.extension);
  void location.prepare();
  this.engine.peerExtensions.push(github);
  this.engine.connectorHeaders = (name) => {
    const resource = (connectorStore.settings.mcpServers[name] as
      { url?: string } | undefined)?.url;
    if (!resource) return undefined;
    const token = getConnectorToken(name);
    return connectorRequestHeaders(savedConnectorHeaders(profile, name, resource), token);
  };
  this.engine.connectorAuthorizationRejected = (name, url, token) => {
    if (connectorAccountCurrent()) oauth.rejectAccess(name, url, token);
  };
  this.engine.connectorAuthStatus = (name, url) => {
    if (connectorAccountCurrent()) return oauth.status(name, url);
  };
  const skillStore = this.store;
  const skillEngine = this.engine;
  const skillHost = this.connectors;
  skillEngine.remoteConnectorSkill = registerRemoteConnectorSkills({
    store: skillStore,
    current: () => !this.accountRetiring && this.store === skillStore &&
      this.engine === skillEngine && this.connectors === skillHost,
    activation: () => this.officialSessionIdentity(),
    policy: () => this.policy(),
    headers: (name) => skillEngine.connectorHeaders?.(name),
    fetch: skillHost.fetch,
  }).resolve;
  this.engine.unavailableReason = host.unavailableReason ?? prepareError;
  this.engine.sandboxNetwork = runtime.sandboxNetwork === true;
  this.engine.capabilityTipHost = (runtime.host ?? webHost).capabilities;
  this.engine.codeSafeguardScope = "cloud";
  // Cloud sessions ask nothing: the sandbox's folders are trusted in Codex
  // (shared/workspace-trust-api.ts), the space engines' too.
  this.engine.trustEveryWorkspace = true;
  this.policyHost = createPolicyHost(this, account.id);
  this.activeAccount = host.account(account);
  host.ready = true;
  this.policyHost.start();
  this.services.workingTree =
    runtime.workingTree?.({ userId: this.userId, storeRoot: profile }) ??
    noWorkingTree;
  this.services.routineApiToken = async (triggerId, action) => {
    const answer = (await runtime.transport.request(
      "routine.api-token",
      this.userId,
      { triggerId, action },
    )) as { token?: unknown; hint?: unknown } | undefined;
    return {
      ...(typeof answer?.token === "string" ? { token: answer.token } : {}),
      ...(typeof answer?.hint === "string" ? { hint: answer.hint } : {}),
    };
  };
  this.services.routineGitHubHook = (triggerId, action, hook) =>
    runtime.transport.request("github.hook", this.userId, {
      triggerId,
      action,
      ...(hook ?? {}),
    });
  this.services.readChatGitHub = (input) =>
    runtime.transport.request("github.api", this.userId, {
      url: `https://github.com/${input.repository}`,
      action: input.path ? "repository.file" : "repository.tree",
      branch: input.branch,
      path: input.path,
    });
  this.services.githubReview = (input) =>
    runtime.transport.request("github.api", this.userId, {
      ...input,
      url: `https://github.com/${input.repository}`,
      action: `pr.${input.action}`,
    }) as Promise<import("../../shared/github-review").GitHubReviewResult>;
  this.services.readPullRequestAutoFix = async (repository, number) => {
    const response = (await runtime.transport.request(
      "github.api",
      this.userId,
      {
        url: `https://github.com/${repository}`,
        action: "pr.autoFixFacts",
        number,
      },
    )) as { pullRequest?: unknown };
    return autoFixFacts(response.pullRequest);
  };
  register(this);
  this.preparedListeners.emit();
  await (shellReady ? Promise.race([history, shellReady(this)]) : history);
  if (this.accountRetiring) throw new Error("The session has ended.");
  try {
    pruneAttachments(profile, this.store.conversations, queuedCodeAttachmentIds(profile, account.id, this.store.conversations));
  } catch {
    // Old drafts stay until next time.
  }
  oauth.resume();
  this.startScheduler(profile);
  this.codeAutoArchive.start();
  if (this.store.conversations.some((conversation) => {
    const binding = conversation.chatDeviceBinding;
    const turn = conversation.turns.at(-1);
    return conversation.mode === "cowork" && !conversation.archived && !conversation.incognito &&
      binding?.version === 1 && binding.accountScope === String(this.userId) &&
      binding.organizationId === null &&
      (turn?.status === "inProgress" || (turn?.status === "interrupted" && turn.stopReason === "restart"));
  })) this.chatDeviceController.schedule();
  this.finishAccountActivation(this.activeAccount);
}

/** Settings → Capabilities: what the user chose for their sandbox's network. */
export function userNetwork(this: WebAppContext): UserNetwork {
  const settings = this.store.settings;
  return {
    enabled: preference(settings, "networkEgress"),
    allowlist: preference(settings, "egressAllowlist"),
    domains: preference(settings, "egressDomains"),
    connectors: connectorHosts(settings.mcpServers),
  };
}

/**
 * The user's scheduled tasks: the desktop's scheduler on this profile. A
 * task runs as a new Cowork (or Code) task in the runner's own folder for
 * the user; when the next one is due the runner wakes the user again even
 * if no page is open (routine-wakes.ts).
 */
export function startScheduler(this: WebAppContext, profile: string) {
  const scheduler = new Scheduler(profile, {
    startupGraceMs: 60_000,
    summarize: engineRoutineSummary(this.engine, () => this.store.settings),
    isBusy: () => this.busy(),
    policy: () => this.policy(),
    run: async (saved) => {
      const { store, engine } = this;
      const activation = this.officialSessionIdentity();
      const current = () => !this.closedFlag && !this.signedOut &&
        this.store === store && this.engine === engine && this.officialSessionIdentity() === activation;
      const task = routineRunModel(saved, store.settings, "remote");
      const can = (this.runtime.host ?? webHost).capabilities;
      if (task.mode === "cowork" ? !can.cloudCowork : !can.cloudCode)
        throw new Error(
          `${task.mode === "cowork" ? "Cowork" : "Code"} tasks aren't available on this service yet.`,
        );
      const input = routineSessionInput(task, store.settings);
      if (task.mode !== "code") return engine.send(input, undefined, false, { current, interactive: false });
      if (task.codeConnectorSelections) {
        const configured = store.settings.mcpServers;
        const inventory = cloudCodeConnectorInventory(configured);
        const selected = new Map(task.codeConnectorSelections.map(({ key, url }) => [key, url]));
        if (task.codeConnectorSelections.some(({ key, url }) => !inventory.some((row) =>
          row.key === key && row.url === url && connectorAllowed(this.policy(), key, configured[key]))))
          throw Error("A connector selected for this task is unavailable. Edit the task and try again.");
        input.connectorOverrides = Object.fromEntries(Object.keys(configured)
          .filter((key) => !selected.has(key))
          .map((key) => [key, false]));
      }
      // A Code task runs as a cloud session: its own space, its repository
      // cloned in the first turn, its cloud environment (as a session the
      // browser starts, session-stage.ts).
      const [args] = await stageSession(
        this,
        {
          ...input,
          ...(task.cloudEnvironmentId
            ? { cloudEnvironmentId: task.cloudEnvironmentId }
            : {}),
        },
        { repository: task.repository, repositories: task.repositories },
      );
      type SendInput = Parameters<Engine["send"]>[0];
      const [staged, extra] = args as [
        SendInput,
        { setup?: SendInput["setup"] }?,
      ];
      return engine.send({
        ...staged,
        ...(extra?.setup ? { setup: extra.setup } : {}),
      }, undefined, false, { current, interactive: false });
    },
    onChange: (schedules) => {
      this.push({ type: "schedules", schedules });
      this.runtime.wake?.(this.userId, nextWakeAt(schedules));
    },
    onRunEnded: (task, run) => {
      if (
        !routineRunMails(
          task,
          preference(this.store.settings, "notifySchedulesEmail"),
        )
      )
        return;
      void this.routineMail
        .send({
          task: task.name,
          outcome: run.outcome,
          summary: run.summary ?? run.error,
        })
        .catch(() => {});
    },
    onError: (error) =>
      this.log(
        `claudex-runner: user ${this.userId}'s scheduled task: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  this.scheduler = scheduler;
  this.engine.routineApprovals = {
    isUnattended: (conversation) =>
      scheduler.isUnattendedConversation(conversation),
    holdForConnection: (id, hold) => scheduler.holdForConnection(id, hold),
    allowed: (id) => scheduler.allowedFor(id),
    allow: (id, entry) => scheduler.allow(id, entry),
  };
  this.runtime.wake?.(this.userId, nextWakeAt(scheduler.list()));
  scheduler.start();
}
