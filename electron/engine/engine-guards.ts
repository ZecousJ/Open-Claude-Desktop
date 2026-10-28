import { codeSessionSettings } from "../../shared/code-session-permissions";
import { modelProtocol } from "../../shared/provider-routes";
import { effectiveTurnSandbox } from "../../shared/sandbox-policy";
import path from "node:path";
import {
  modeAllowed,
  modeRefusal,
  runningMode,
  type PolicyMode,
} from "../../shared/client-policy";
import {
  attachmentRefusal,
  connectorAllowed,
  updateRefusal,
} from "../../shared/client-policy-rules";
import type { Project, Provider } from "../../shared/types";
import { isOutboxTurn } from "../ssh/outbox";
import { sameEnvironment } from "./engine-types";
import { chosenSandbox } from "./instructions";
import { SendInput, newConversation } from "./new-conversation";
import type { Engine } from "./engine";

/**
 * Replaces the device key in the running provider child after the service
 * issued it again, with the keys of the account's other service groups
 * (MG; every group key the account still has, by vault entry).
 */
export async function updateProviderKey(
  this: Engine,
  providerId: string,
  key: string,
  inVault: boolean,
  groupKeys: Record<string, string> = {},
) {
  if (inVault)
    await this.gateway?.setKeys({ [providerId]: key, ...groupKeys }, [
      providerId,
      ...Object.keys(groupKeys),
    ]);
  else await this.gateway?.setSessionKey(key, groupKeys);
  // Each SSH engine has its own gateway on this computer (R9).
  for (const peer of this.peers?.all() ?? [])
    if (peer !== this)
      await peer
        .updateProviderKey(providerId, key, inVault, groupKeys)
        .catch(() => {});
}

/** Rejects a message the account, model service or composer state cannot send. */
export function assertSendable(
  this: Engine,
  provider: Provider,
  input: SendInput,
) {
  if (!input.model.trim())
    throw new Error(
      this.unavailableReason ?? "No model is assigned to this account yet.",
    );
  this.assertModel(provider, input.model);
  if (input.mode === "code" && input.webSearch)
    throw Error("This Web search control belongs to Chat and Cowork.");
  // With web search turned off by the administrator, a conversation that had
  // it on simply continues without it (its switch is hidden, see sendTurn).
  const webSearch =
    this.policy().webSearch &&
    (input.conversationId
      ? this.store.conversation(input.conversationId).webSearch
      : input.webSearch);
  if (webSearch && modelProtocol(provider, input.model) !== "responses")
    throw new Error(
      "Web search requires a Responses-compatible model service.",
    );
  if (!input.text.trim() && !input.attachments.length)
    throw new Error("Enter a message.");
  this.assertPolicy(input);
}

/**
 * Extensions may refuse a message (policy, model support) before anything
 * starts; a new conversation is described by what it would be.
 */
export function assertExtensions(
  this: Engine,
  provider: Provider,
  input: SendInput,
) {
  if (!this.extensions.list().some((entry) => entry.beforeSend)) return;
  const project = this.store.projects.find((p) => p.id === input.projectId);
  const c = input.conversationId
    ? this.store.conversation(input.conversationId)
    : newConversation(
        input,
        provider,
        this.sendCwd(input, project),
        this.store.settings,
      );
  this.extensions.beforeSend(
    this.turnContext(c, provider, input.model, input.mode, project),
  );
}

export function assertModel(this: Engine, provider: Provider, model: string) {
  if (
    provider.models.length &&
    !new Set([provider.model, ...provider.models]).has(model)
  )
    throw new Error("This account can't use this model.");
}

/** The administrator's policy, enforced here as well as in the interface. */
export function assertPolicy(this: Engine, input: SendInput) {
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  const existing = input.conversationId
    ? this.store.conversation(input.conversationId)
    : undefined;
  if ((existing ? existing.incognito : input.incognito) && !policy.incognito)
    throw new Error("Your administrator has turned off incognito chats.");
  for (const file of input.attachments) {
    if (file.github && connectorAllowed(policy, "github")) continue;
    const refusal = attachmentRefusal(
      file.name,
      file.size,
      policy,
      input.mode === "code" ? "session" : "chat",
    );
    if (refusal) throw new Error(refusal);
  }
  if (input.mode !== "code") return;
  const cwd =
    existing?.cwd ??
    input.cwd ??
    this.store.projects.find((p) => p.id === input.projectId)?.cwd ??
    path.join(this.spaceRoot, "workspace");
  const sessionSettings = codeSessionSettings(
    this.store.settings,
    existing?.codePermissionMode ?? input.codePermissionMode,
  );
  const mode = runningMode(
    sessionSettings,
    effectiveTurnSandbox(
      this.platform,
      "code",
      chosenSandbox(
        sessionSettings,
        "code",
        cwd,
        existing?.scheduledRun ?? input.scheduledRun,
        false,
        existing?.scheduledPermission ?? input.scheduledPermission,
      ),
    ),
  );
  if (!modeAllowed(policy, mode))
    throw new Error(modeRefusal(mode as PolicyMode));
}

export function assertIdle(
  this: Engine,
  conversationId: string | undefined,
  waitingId?: string,
) {
  if (!conversationId) return;
  if (this.newTaskChecks.has(conversationId))
    throw new Error("This conversation is still running.");
  const running = this.store
    .conversation(conversationId)
    .turns.filter((t) => t.status === "inProgress" && t.id !== waitingId);
  if (running.some(isOutboxTurn))
    throw new Error(
      "A message is already waiting to be sent in this conversation. Send the next one after it.",
    );
  if (running.length) throw new Error("This conversation is still running.");
}

/**
 * The folder of an SSH conversation (R9): the conversation's, the one
 * chosen for a new one, or its project's when the project is on the same
 * host; send() fills in the host's default (launcher.defaultCwd) before.
 */
export function remoteCwdOf(this: Engine, input: SendInput, project?: Project) {
  const existing = input.conversationId
    ? this.store.conversation(input.conversationId)
    : undefined;
  return (
    existing?.cwd ??
    input.cwd ??
    (project && sameEnvironment(project.environment, this.environment)
      ? project.cwd
      : undefined)
  );
}

export function remoteCwd(this: Engine, input: SendInput, project?: Project) {
  const cwd = this.remoteCwdOf(input, project);
  if (!cwd)
    throw new Error(
      `Choose a folder on ${this.launcher?.label || "the SSH host"}`,
    );
  return cwd;
}

/** The folder a turn runs in: an SSH conversation's, or this computer's. */
export function sendCwd(this: Engine, input: SendInput, project?: Project) {
  const existing = input.conversationId
    ? this.store.conversation(input.conversationId)
    : undefined;
  const projectOnly =
    (existing?.mode ?? input.mode) !== "code" &&
    (existing?.incognito ?? input.incognito);
  return this.launcher
    ? this.remoteCwd(input, project)
    : (input.cwd ??
        (projectOnly ? undefined : project?.cwd) ??
        path.join(this.spaceRoot, "workspace"));
}
