import { assertBlankArtifactRevision } from "../artifacts/blank-artifact-files";
import {
  codeExecutionSettings,
  codeSessionSettings,
  codePermissionModeOf,
} from "../../shared/code-session-permissions";
import { StartTiming, timingWanted } from "../app/start-timing";
import {
  codexModelSlug,
  effectiveToolSearch,
} from "../../shared/tool-search-mode";
import fs from "node:fs";
import path from "node:path";
import { createSessionWorktree } from "../git/code-worktree";
import { selectReplyVersion as selectBranchReply } from "../../shared/branches";
import { finishTurn } from "../../shared/activity";
import { randomUUID } from "node:crypto";
import { effortForMode } from "../../shared/code-effort";
import { thinkingSummaryForTurn } from "../../shared/thinking-summaries";
import { isContextLimitError } from "../../shared/turn-errors";
import { preference } from "../../shared/settings-extras";
import { researchPolicyOf } from "../../shared/client-policy";
import type { Conversation } from "../../shared/types";
import { sessionRepositoryOf } from "../../shared/session-git";
import {
  failSetup,
  markSetupStep,
  newSessionSetup,
  setupFailureOf,
  type SessionSetupHook,
} from "../../shared/session-setup";
import { isOutboxTurn, newOutboxId } from "../ssh/outbox";
import { projectConnectorOverrides } from "../../shared/project-tools";
import { SendInput, newConversation } from "./new-conversation";
import { transient, turnInput } from "./engine-support";
import type { Engine } from "./engine";

export async function send(
  this: Engine,
  input: SendInput,
  retryTurnId?: string,
  editingPrompt = false,
  options: {
    interactive?: boolean;
    safeguardRetry?: boolean;
    newTaskResolved?: boolean;
  } = {},
): Promise<Conversation> {
  this.assertMcpAvailable();
  // A conversation that runs on another engine goes there (R9).
  const other = input.conversationId
    ? this.elsewhereFor(input.conversationId)
    : this.elsewhere(input.environment);
  if (other) return other.send(input, retryTurnId, editingPrompt, options);
  if (input.blankArtifactRevision) {
    if (!input.conversationId)
      throw new Error("An artifact revision belongs to its paired Chat.");
    assertBlankArtifactRevision(
      this.defaultWorkspace,
      this.store.conversation(input.conversationId),
      input.blankArtifactRevision,
    );
  }
  if (input.conversationId && !options.safeguardRetry)
    this.safeguardModels.delete(input.conversationId);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const timing = new StartTiming(
    (input.conversationId ?? "new").slice(0, 8),
    timingWanted(this.environment.kind === "space"),
  );
  const provider = this.store.settings.providers.find(
    (p) => p.id === input.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  if (!input.conversationId) {
    const project = this.store.projects.find(
      (item) => item.id === input.projectId,
    );
    input = {
      ...input,
      webSearch: input.webSearch ?? project?.tools?.webSearch,
      research: input.research ?? project?.tools?.research,
      connectorOverrides:
        input.connectorOverrides ?? projectConnectorOverrides(project),
    };
  }
  // Web search belongs to Chat and Cowork: a Code send that carries it (a
  // draft switch on by default, an older client) goes without it.
  const mode = input.conversationId
    ? this.store.conversation(input.conversationId).mode
    : input.mode;
  if (
    mode === "cowork" &&
    this.environment.kind !== "space" &&
    this.store.settings.computerAccess === false
  )
    throw new Error(
      "Computer access is off, so tasks that require a computer won’t run.",
    );
  if (
    input.conversationId &&
    this.environment.kind === "space" &&
    this.store.conversation(input.conversationId).linkedToComputer
  )
    throw new Error("Waiting for your computer");
  if (mode === "code" && (input.webSearch || input.research))
    input = { ...input, webSearch: false, research: false };
  if (!this.policy().webSearch)
    input = { ...input, webSearch: false, research: false };
  // Research turned off by the administrator: the Chat starts as asked,
  // without Research and without the web search it would have brought.
  else if (input.research && !researchPolicyOf(this.policy()).enabled)
    input = { ...input, research: false };
  this.assertSendable(provider, input);
  this.assertIdle(input.conversationId, input.clientMessageId);
  if (
    input.conversationId &&
    mode === "code" &&
    !retryTurnId &&
    !editingPrompt &&
    !options.safeguardRetry &&
    !options.newTaskResolved
  ) {
    const conversation = this.store.conversation(input.conversationId);
    if (conversation.codeNewTask)
      throw new Error(
        "A message is already waiting to be sent in this conversation. Send the next one after it.",
      );
    let unrelated = false;
    this.newTaskChecks.add(conversation.id);
    try {
      if (
        preference(this.store.settings, "ccNewTaskPrompt") !== "here" &&
        conversation.turns.at(-1)?.status === "completed" &&
        !this.gatewayEndpoint()
      )
        await this.ensure(provider, options);
      unrelated = await this.sessionAssistance.unrelatedTask(
        conversation,
        input.text,
      );
    } finally {
      this.newTaskChecks.delete(conversation.id);
    }
    if (unrelated) {
      this.assertIdle(input.conversationId, input.clientMessageId);
      conversation.codeNewTask = {
        id: randomUUID(),
        text: input.text,
        attachments: input.attachments,
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
      };
      this.changed(conversation, true);
      if (preference(this.store.settings, "ccNewTaskPrompt") === "new_session")
        return this.resolveCodeNewTask(
          conversation.id,
          conversation.codeNewTask.id,
          "new_session",
        );
      return structuredClone(conversation);
    }
    this.assertIdle(input.conversationId, input.clientMessageId);
  }
  const project = this.store.projects.find((p) => p.id === input.projectId);
  // An SSH conversation sent without a folder runs in the host's Default folder
  // or the user's home there.
  if (this.launcher?.defaultCwd && !this.remoteCwdOf(input, project)) {
    const cwd = await this.launcher.defaultCwd();
    if (cwd) input = { ...input, cwd };
  }
  // A new Code session on this computer without a folder works in an empty
  // folder of its own under the default workspace, made once here, rather than
  // the one folder every such session shared.
  if (
    !this.launcher &&
    this.environment.kind === "local" &&
    !input.conversationId &&
    input.mode === "code" &&
    !input.cwd &&
    !project?.cwd
  ) {
    const cwd = path.join(this.defaultWorkspace, "sessions", randomUUID());
    fs.mkdirSync(cwd, { recursive: true });
    input = { ...input, cwd };
  }
  // An SSH conversation needs a folder on its host before connecting.
  let plannedCwd = this.sendCwd(input, project);
  this.assertExtensions(provider, input);
  await this.dropWebSearch(input.conversationId);
  const queueable = this.canQueue(input, retryTurnId);
  // Every message to a host carries an id, so a resend after a dropped
  // connection can tell whether the host already has it (outbox).
  if (queueable && !input.clientMessageId)
    input = { ...input, clientMessageId: newOutboxId() };
  // The host is reconnecting by itself: the message waits for it.
  if (queueable && this.launcher!.waiting())
    return this.queue(input, provider, plannedCwd);
  // Code on an SSH host runs only in a workspace trusted there, checked
  // before the message shows (the window asks, then sends again).
  if (this.launcher && input.mode === "code")
    try {
      await this.assertRemoteTrust(plannedCwd, options.interactive ?? true);
    } catch (error) {
      if (queueable && transient(error))
        return this.queue(input, provider, plannedCwd);
      throw error;
    }
  // The message shows at once, running: the conversation and its pending turn
  // go out before the engine is made ready. A retry or an edit branches first,
  // as before.
  let early: Conversation | undefined;
  if (!queueable && !retryTurnId && !editingPrompt) {
    this.pendingSend = true;
    if (input.conversationId)
      early = this.store.conversation(input.conversationId);
    else {
      early = newConversation(input, provider, plannedCwd, this.store.settings);
      if (this.environment.kind === "space")
        early.cloudEnvironmentId = input.cloudEnvironmentId;
      if (this.environment.kind === "space")
        early.environment = this.environment;
      this.store.conversations.unshift(early);
    }
    early.updatedAt = Date.now();
    if (input.parentSessionId) {
      const parent = this.store.conversation(input.parentSessionId);
      early.parentSessionId = parent.id;
      early.repository = parent.repository;
      early.sessionRepositories = parent.sessionRepositories;
    }
    // A cloud Code session follows the sender's pull request settings.
    if (this.environment.kind === "space" && early.mode === "code") {
      if (input.autoPullRequest) early.autoPullRequest = input.autoPullRequest;
      else delete early.autoPullRequest;
    }
    this.earlyTurn = {
      id: "pending-" + randomUUID(),
      prompt: input.text,
      ...(input.notificationTrigger
        ? { notificationTrigger: input.notificationTrigger }
        : {}),
      ...(input.notificationKey
        ? { notificationKey: input.notificationKey }
        : {}),
      attachments: input.attachments,
      items: [],
      status: "inProgress",
      createdAt: Date.now(),
      ...(input.setup
        ? {
            setup: newSessionSetup(
              input.setup.repositories.length,
              Boolean(input.setup.setupScript),
            ),
          }
        : {}),
    };
    early.turns.push(this.earlyTurn);
    // Until the repository is in the folder, a later message fetches it.
    if (input.setup) early.pendingSetup = input.setup.repositories;
    if (input.setup?.setupScript)
      early.pendingSetupScript = input.setup.setupScript;
    if (input.setup && input.setup.repositories.length > 1)
      early.sessionRepositories = input.setup.repositories;
    // The lists show and search the repository (shared/session-git.ts).
    if (input.setup) {
      const repository = sessionRepositoryOf(input.setup.repositories[0]);
      if (repository) early.repository = repository;
    }
    this.changed(early, true);
    if (input.setup && !(await this.fetchForSetup(early, input.setup))) {
      this.earlyTurn = undefined;
      this.pendingSend = false;
      return structuredClone(early);
    }
  }
  // Worktree on: the new session gets its own worktree first ("Creating
  // worktree…" under the message), and runs there.
  if (
    early &&
    input.worktree &&
    !input.conversationId &&
    early.mode === "code" &&
    !this.launcher &&
    this.environment.kind !== "space"
  ) {
    const turn = early.turns.at(-1)!;
    turn.worktreeStep = "creating";
    this.changed(early, true);
    try {
      const made = await createSessionWorktree(plannedCwd, {
        location: this.store.settings.codeWorktreeLocation ?? "",
        prefix: this.store.settings.codeBranchPrefix ?? "claude",
        startBranch: input.worktreeBranch,
      });
      early.cwd = plannedCwd = made.cwd;
      early.worktree = made.worktree;
    } catch (error) {
      finishTurn(turn, "failed");
      turn.error = (error as Error).message;
      this.earlyTurn = undefined;
      this.pendingSend = false;
      this.changed(early, true);
      return structuredClone(early);
    } finally {
      delete turn.worktreeStep;
    }
    this.changed(early, true);
  }
  // The session's start goes on: its container, then Codex's turn.
  const setupTurn = early?.turns.at(-1)?.setup ? early.turns.at(-1) : undefined;
  timing.mark("setup");
  try {
    try {
      const before = this.startSteps;
      await this.ensure(provider, options);
      timing.mark(
        "engine",
        this.startSteps !== before ? this.startSteps?.join(", ") : "running",
      );
    } catch (error) {
      if (queueable && transient(error))
        return this.queue(input, provider, plannedCwd);
      throw error;
    }
    await this.syncRequestOptions(provider);
    await this.windowsSandbox.ensureReady(this.rpc!, this.sandboxSetupFolder());
  } catch (error) {
    if (early) {
      const t = early.turns.at(-1);
      if (t?.status === "inProgress") {
        finishTurn(t, "failed");
        t.error = (error as Error).message;
        if (!setupTurn) t.sendFailed = true;
      }
      failSetup(setupTurn?.setup, "failed");
      this.pendingSend = false;
      this.changed(early, true);
      // A cloud session's start fails in its transcript, which is open.
      if (setupTurn) return structuredClone(early);
    }
    throw error;
  } finally {
    // From here the turn is the engine's own work.
    this.earlyTurn = undefined;
  }
  if (setupTurn) {
    markSetupStep(setupTurn.setup, "provision", "completed");
    markSetupStep(
      setupTurn.setup,
      input.setup?.setupScript ? "setup_script" : "start",
      "running",
    );
    this.changed(early!, true);
  }
  if (!early) {
    // Another submission may have acquired the lock while ensure() was awaited.
    if (this.pendingSend)
      throw new Error("A task is being created. Try again in a moment.");
    this.assertIdle(input.conversationId, input.clientMessageId);
    this.pendingSend = true;
  }
  let c: Conversation | undefined = early;
  const rpc = this.rpc!;
  let turnStarted = false;
  try {
    const cwd = plannedCwd;
    if (!this.launcher) fs.mkdirSync(cwd, { recursive: true });
    if (input.setup?.setupScript) {
      // A cloud environment's setup script runs with full access only
      // because the whole engine sits in the runner's per-session sandbox;
      // an engine on this computer never runs one.
      if (this.environment.kind !== "space")
        throw new Error("Setup scripts run only in cloud environments.");
      const result = await rpc.call(
        "command/exec",
        {
          command: ["/bin/bash", "-c", input.setup.setupScript],
          cwd,
          timeoutMs: 600_000,
          outputBytesCap: 100_000,
          sandboxPolicy: { type: "dangerFullAccess" },
        },
        605_000,
      );
      if (result?.exitCode !== 0)
        throw new Error(result?.stderr || "Setup script failed");
      if (early) delete early.pendingSetupScript;
      markSetupStep(setupTurn?.setup, "setup_script", "completed");
      markSetupStep(setupTurn?.setup, "start", "running");
      if (early) this.changed(early, true);
    }
    if (early) c = early;
    else if (input.conversationId)
      c = this.store.conversation(input.conversationId);
    else {
      c = newConversation(input, provider, cwd, this.store.settings);
      // An SSH host's or an isolated space's conversation remembers where
      // it runs, so its next calls reach this engine and its thread.
      if (this.launcher || this.environment.kind === "space")
        c.environment = this.environment;
      this.store.conversations.unshift(c);
    }
    // A cloud Chat runs with the permission the sender chose on its
    // computer; a prompt from the web leaves the account's setting.
    if (this.environment.kind === "space" && input.mode !== "code") {
      if (input.taskPermission) c.senderPermission = input.taskPermission;
      else delete c.senderPermission;
    }
    const threadOptions = this.threadOptions(
      c,
      provider,
      input.model,
      input.mode,
      project,
    );
    const instructions = threadOptions.developerInstructions;
    const userInput = await turnInput(input.text, input.attachments, {
      inlineImages: !!this.launcher,
    });
    const versions = retryTurnId
      ? await this.branchFrom(c, retryTurnId, editingPrompt, threadOptions)
      : undefined;
    await this.ensureThread(c, threadOptions);
    timing.mark("thread");
    this.routes.set(c.threadId!, c.id);
    c.providerId = provider.id;
    c.model = input.model;
    if (input.thinkingSummariesWanted !== undefined)
      c.thinkingSummariesWanted = input.thinkingSummariesWanted;
    if (c.mode === "cowork")
      c.thinkingMode =
        input.thinkingMode ??
        c.thinkingMode ??
        preference(this.store.settings, "coworkThinkingMode");
    c.effort =
      input.effort ??
      c.effort ??
      this.store.projects.find((project) => project.id === c?.projectId)
        ?.defaultEffort;
    c.updatedAt = Date.now();
    delete c.promptSuggestion;
    delete c.sessionState;
    // A new message ends what a rewind set aside (Undo works until then).
    delete c.rewind;
    // A message from the outbox replaces its waiting turn.
    if (input.clientMessageId)
      c.turns = c.turns.filter((t) => t.id !== input.clientMessageId);
    // Codex assigns the real turn ID when turn/start returns (the early
    // pending turn is already there).
    if (!early)
      c.turns.push({
        id: "pending-" + randomUUID(),
        ...(versions?.responseGroupId ? versions : {}),
        prompt: input.text,
        ...(input.notificationTrigger
          ? { notificationTrigger: input.notificationTrigger }
          : {}),
        ...(input.notificationKey
          ? { notificationKey: input.notificationKey }
          : {}),
        attachments: input.attachments,
        items: [],
        status: "inProgress",
        createdAt: Date.now(),
      });
    if (input.mode === "cowork")
      c.turns.at(-1)!.coworkInstructions = {
        global:
          [
            this.store.settings.instructions,
            this.store.settings.coworkInstructions,
          ]
            .filter(Boolean)
            .join("\n\n") || undefined,
        folder: project?.instructions || undefined,
      };
    if (c.mode === "code") {
      c.turns.at(-1)!.codePermissionMode ??= codePermissionModeOf(
        codeSessionSettings(this.store.settings, c.codePermissionMode),
      );
    }
    this.changed(c, true);
    if (versions?.responseGroupId) this.store.flush();
    const effort =
      c.mode === "cowork" && c.thinkingMode === "standard"
        ? "low"
        : (c.effort ?? effortForMode(this.store.settings, input.mode));
    if (input.clientMessageId)
      this.options.outbox?.markAttempted(input.clientMessageId);
    // "View sent prompt" only where what the model got differs from the prompt
    // as shown.
    const sent = userInput
      .filter((part) => part.type === "text")
      .map((part) => part.text);
    c.turns.at(-1)!.rawOriginals =
      sent.length === 1 && sent[0] === c.turns.at(-1)!.prompt
        ? undefined
        : sent;
    turnStarted = true;
    // The service's usage by product counts this thread under its surface.
    if (c.threadId) this.gateway?.threadProduct(c.threadId, c.mode);
    await this.extensions.prepareTurn(
      this.turnContext(c, provider, input.model, input.mode, project),
    );
    assertBlankArtifactRevision(
      this.defaultWorkspace,
      c,
      input.blankArtifactRevision,
    );
    // Tool access (this conversation's, else Capabilities'): the model's
    // twin preloads connector tools (shared/tool-search-mode.ts).
    const codexModel = codexModelSlug(
      input.model,
      effectiveToolSearch(c, this.store.settings),
    );
    const result = await this.rpc!.call("turn/start", {
      threadId: c.threadId,
      input: userInput,
      model: codexModel,
      effort,
      ...thinkingSummaryForTurn(c, this.store.settings),
      ...(input.clientMessageId
        ? { clientUserMessageId: input.clientMessageId }
        : {}),
      ...this.turnExtras(
        this.turnContext(c, provider, input.model, input.mode, project),
      ),
      ...(input.mode === "code"
        ? {
            collaborationMode: {
              mode: codeExecutionSettings(this.store.settings, c).codePlanMode
                ? "plan"
                : "default",
              settings: {
                model: codexModel,
                reasoning_effort: effort,
                developer_instructions: codeExecutionSettings(
                  this.store.settings,
                  c,
                ).codePlanMode
                  ? null
                  : instructions,
              },
            },
          }
        : {}),
    });
    timing.mark("turn");
    if (timing.enabled) this.firstOutput.set(c.threadId!, timing);
    const turn = c.turns.at(-1)!;
    if (turn.id.startsWith("pending-")) turn.id = result.turn.id;
    if (input.clientMessageId)
      this.options.outbox?.remove(input.clientMessageId);
    markSetupStep(setupTurn?.setup, "start", "completed");
    this.changed(c, true);
    return structuredClone(c);
  } catch (error) {
    // R9: the connection dropped while the message was on its way. It
    // waits for the host; if turn/start may have arrived, the thread is
    // checked before it is sent again.
    if (c && queueable && !rpc.connected) {
      const pending = c.turns.at(-1);
      if (pending?.id.startsWith("pending-"))
        c.turns = c.turns.filter((t) => t !== pending);
      this.pendingSend = false;
      return this.queue(
        { ...input, conversationId: c.id },
        provider,
        c.cwd ?? plannedCwd,
        turnStarted,
      );
    }
    if (c) {
      const t = c.turns.at(-1);
      if (t?.status === "inProgress") {
        finishTurn(t, "failed");
        t.error = (error as Error).message;
        if (!setupTurn && !t.items.length && !isContextLimitError(t.error))
          t.sendFailed = true;
      }
      failSetup(setupTurn?.setup, "failed");
      this.changed(c, true);
      // A cloud session's start fails in its transcript, which is open.
      if (setupTurn) return structuredClone(c);
    }
    throw error;
  } finally {
    this.pendingSend = false;
  }
}

/**
 * A cloud session's first step (shared/session-setup.ts): its repository
 * is fetched into its folder while the session already shows. False when
 * it failed or was stopped; the turn then says so and has ended, and the
 * conversation keeps `pendingSetup` so its next message fetches again.
 */
export async function fetchForSetup(
  this: Engine,
  c: Conversation,
  hook: SessionSetupHook,
): Promise<boolean> {
  const turn = c.turns.at(-1)!;
  const setup = turn.setup;
  const abort = new AbortController();
  this.setupAbort = { conversationId: c.id, abort };
  markSetupStep(setup, "clone", "running");
  this.changed(c, true);
  try {
    await hook.fetch(abort.signal);
    if (abort.signal.aborted) throw new Error("Stopped");
    delete c.pendingSetup;
    markSetupStep(setup, "clone", "completed");
    markSetupStep(setup, "provision", "running");
    this.changed(c, true);
    return true;
  } catch (error) {
    const message = (error as Error)?.message || String(error);
    if (abort.signal.aborted) {
      // Stop: nothing failed; what was left is skipped.
      for (const step of setup?.steps ?? [])
        if (step.status === "running" || step.status === "pending")
          step.status = "skipped";
      finishTurn(turn, "interrupted");
    } else {
      failSetup(setup, setupFailureOf(error), message);
      finishTurn(turn, "failed");
      turn.error = message;
    }
    this.changed(c, true);
    this.store.flush();
    return false;
  } finally {
    this.setupAbort = undefined;
  }
}

export async function retryResponse(
  this: Engine,
  id: string,
  turnId: string,
  providerId: string,
  model: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.retryResponse(id, turnId, providerId, model);
  const c = this.store.conversation(id);
  const turn = c.turns.find((t) => t.id === turnId);
  if (!turn) throw new Error("The response is no longer available.");
  if (turn.compaction) throw new Error("A compaction can't be retried.");
  if (turn.shell) throw new Error("A shell command can't be retried.");
  if (turn.review) throw new Error("A review can't be retried.");
  return this.send(
    {
      conversationId: id,
      text: turn.prompt,
      attachments: turn.attachments,
      mode: c.mode,
      cwd: c.cwd,
      projectId: c.projectId,
      providerId,
      model,
    },
    turnId,
  );
}

export async function discardTurn(
  this: Engine,
  id: string,
  turnId: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.discardTurn(id, turnId);
  const c = this.store.conversation(id);
  const turn = c.turns.find((candidate) => candidate.id === turnId);
  if (!turn?.sendFailed || turn.status !== "failed") return structuredClone(c);
  if (isOutboxTurn(turn)) this.options.outbox?.remove(turn.id);
  c.turns = c.turns.filter((candidate) => candidate.id !== turnId);
  c.updatedAt = Date.now();
  this.changed(c, true);
  this.store.flush();
  return structuredClone(c);
}

export async function editPrompt(
  this: Engine,
  id: string,
  turnId: string,
  text: string,
  providerId: string,
  model: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.editPrompt(id, turnId, text, providerId, model);
  const c = this.store.conversation(id);
  const turn = c.turns.find((t) => t.id === turnId);
  if (!turn) throw new Error("The message is no longer available.");
  if (turn.compaction) throw new Error("A compaction has no message to edit.");
  if (turn.shell) throw new Error("A shell command can't be edited.");
  if (turn.review) throw new Error("A review can't be edited.");
  if (!text.trim() || text === turn.prompt)
    throw new Error("Change the message before saving.");
  return this.send(
    {
      conversationId: id,
      text,
      attachments: turn.attachments,
      mode: c.mode,
      cwd: c.cwd,
      projectId: c.projectId,
      providerId,
      model,
    },
    turnId,
    true,
  );
}

export function selectPromptVersion(
  this: Engine,
  id: string,
  turnId: string,
  versionTurnId: string,
) {
  return this.selectReplyVersion(id, turnId, versionTurnId, "prompt");
}

export function selectReplyVersion(
  this: Engine,
  id: string,
  turnId: string,
  versionTurnId: string,
  kind: "reply" | "prompt" = "reply",
): Conversation {
  const other = this.elsewhereFor(id);
  if (other) return other.selectReplyVersion(id, turnId, versionTurnId, kind);
  if (this.pendingSend)
    throw new Error("Wait for the current submission to finish.");
  const c = this.store.conversation(id);
  selectBranchReply(c, turnId, versionTurnId, kind);
  if (c.threadId) this.routes.set(c.threadId, c.id);
  this.changed(c, true);
  this.store.flush();
  return structuredClone(c);
}
