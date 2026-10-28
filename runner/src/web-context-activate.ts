import { stageSession } from "./session-stage";
import { routineSessionInput } from "../../electron/routines/routine-session";
import { gitHubTools } from "./github-tools";
import { autoFixFacts } from "../../electron/git/pr-autofix";
import fs from "node:fs";
import path from "node:path";
import type { PublicAccount } from "../../shared/types";
import { webHost } from "../../shared/host";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import { webErrorCodes } from "../../shared/web-protocol";
import { Accounts } from "../../electron/account/accounts";
import { ArtifactLibrary } from "../../electron/artifacts/artifact-library";
import { ArtifactShares } from "../../electron/artifacts/artifact-shares";
import { BackgroundHistory } from "../../electron/conversations/background-history";
import { Engine } from "../../electron/engine/engine";
import { ProviderCredentials } from "../../electron/engine/provider-credentials";
import { ReplyFeedback } from "../../electron/conversations/reply-feedback";
import {
  createPolicyHost,
  handleRefusal,
} from "../../electron/remote/host-wiring";
import { remoteAccountId } from "../../electron/sub2api/identity-support";
import { CloudStore } from "./cloud-store";
import { parseWebKey, WebRemoteHost, type WebKey } from "./web-remote-host";
import { attachmentsFolder, pruneAttachments } from "./attachments";
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
import {
  prepareCodexCache,
  pruneIdleSpaceCaches,
} from "../../electron/engine/codex-cache";
import type { WebAppContext } from "./web-app-context";
import type { RegisterHandlers } from "./web-app-context";

export async function activate(
  this: WebAppContext,
  accessToken: string,
  register: RegisterHandlers,
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
  pruneIdleSpaceCaches(profile, new Set());
  const codexCache = prepareCodexCache(profile, profile);
  this.store = await CloudStore.open({
    root: profile,
    userId: this.userId,
    transport: runtime.transport,
    log: this.log,
  });
  const attachments = attachmentsFolder(profile);
  try {
    pruneAttachments(profile, this.store.conversations, []);
  } catch {
    // Old drafts stay until next time.
  }
  const account: PublicAccount = {
    id: remoteAccountId(runtime.serviceUrl, me.id),
    email: me.email,
    name: me.username || me.email.split("@")[0] || me.email,
    remote: true,
  };
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
  const guard =
    this.runtime.connectorGuard ?? connectorUrlGuard({ level: "full" });
  this.connectors = {
    assertUrl: guard,
    fetch: connectorFetch({ level: "full" }, guard),
    getToken: (name) => this.connectorTokens.get(name),
    setToken: (name, token) => this.connectorTokens.set(name, token),
  };
  const oauth = new ConnectorOAuth(
    profile,
    runtime.serviceUrl,
    this.connectors.fetch!,
    this.connectorTokens,
    () => this.mcpConfig.update(this.store.settings.mcpServers),
    (name, resource) => {
      const server = this.store.settings.mcpServers[name] as
        { url?: string } | undefined;
      return (
        server?.url === resource &&
        connectorAllowed(this.policy(), name, server)
      );
    },
  );
  this.connectors.beginLogin = async (name, resource, returnUrl) => {
    const { ConnectorClients } =
      await import("../../electron/connectors/connector-clients");
    const address = await oauth.begin(
      name,
      resource,
      returnUrl,
      new ConnectorClients(this.store.root).get(name, resource),
    );
    await this.connectors.assertUrl(address);
    return address;
  };
  this.connectors.completeLogin = (state, code) => oauth.complete(state, code);
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
  });
  this.engine = new Engine(
    this.store,
    binary,
    (id) => host.sessionKey(id),
    (event) => {
      if (event.type === "conversation") {
        this.usageTurns.observe(event.conversation);
        this.scheduler?.observeConversation(event.conversation);
      }
      this.push(event);
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
  // A cloud Code session's GitHub tools (push, pull requests, issues),
  // also in the repository spaces' engines.
  const github = gitHubTools({
    userId: this.userId,
    transport: runtime.transport,
    // The branch and git state each session records after a turn.
    workingTree: () => this.services.workingTree,
  });
  this.engine.extensions.add(github);
  const { locationMetadataExtension } =
    await import("../../electron/account/location-metadata");
  const location = locationMetadataExtension(
    () => this.store.settings,
    () => runtime.transport.request("location.get", this.userId, {}),
  );
  this.engine.extensions.add(location.extension);
  void location.prepare();
  this.engine.peerExtensions.push(github);
  this.engine.connectorHeaders = (name) => {
    const token = this.connectorTokens.get(name);
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  };
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
  this.startScheduler(profile);
  this.activatedListeners.emit(this.activeAccount);
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
    summarize: engineRoutineSummary(this.engine, () => this.store.settings),
    isBusy: () => this.busy(),
    policy: () => this.policy(),
    run: async (saved) => {
      const task = routineRunModel(saved, this.store.settings, "remote");
      const can = (this.runtime.host ?? webHost).capabilities;
      if (task.mode === "cowork" ? !can.cloudCowork : !can.cloudCode)
        throw new Error(
          `${task.mode === "cowork" ? "Cowork" : "Code"} tasks aren't available on this service yet.`,
        );
      const input = routineSessionInput(task, this.store.settings);
      if (task.mode !== "code") return this.engine.send(input);
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
        { repository: task.repository },
      );
      type SendInput = Parameters<Engine["send"]>[0];
      const [staged, extra] = args as [
        SendInput,
        { setup?: SendInput["setup"] }?,
      ];
      return this.engine.send({
        ...staged,
        ...(extra?.setup ? { setup: extra.setup } : {}),
      });
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
