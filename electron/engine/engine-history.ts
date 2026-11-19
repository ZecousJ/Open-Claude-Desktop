import { copyCodeForkScreenshots } from "./code-fork-files";
import { retireCodeRewind, rewindModel, type CodeRewindTarget } from "../../shared/code-rewind";
import fs from "node:fs";
import path from "node:path";
import { codeForkTurns, codeForkModel, codeForkSource, type CodeForkOptions } from "../../shared/code-fork";
import { codeForkPrefix } from "./code-fork-prefix";
import { prepareCodeForkWorktree } from "./code-fork-worktree";
import { assertCodeSessionSendAvailable, beginCodeSessionLifecycle } from "../conversations/code-lifecycle-guard";
import { finishTurn } from "../../shared/activity";
import { randomUUID } from "node:crypto";
import { updateRefusal } from "../../shared/client-policy-rules";
import { codeReadSnapshot, sameCodeReadActivity } from "../../shared/code-read-state";
import type { Conversation, Turn } from "../../shared/types";
import type { ReviewTarget } from "../../shared/composer-api";
import { isOutboxTurn } from "../ssh/outbox";
import { limitsKey, hasThreadMcp, reloadOptions } from "./thread-options";
import type { Engine } from "./engine";
import { CodeSendCancelled, CodeSendStart, trackCodeSendStart, type CodeRunAdmission } from "./code-send-start";
import { interrupt } from "./engine-handoff";

/**
 * /compact (`thread/compact/start`): Codex runs a turn of its own that
 * summarizes the thread. It is recorded as a turn with `compaction:
 * "manual"` so its notifications do not land on the previous turn.
 */
const compactingEngines = new WeakSet<Engine>();
export async function compactConversation(
  this: Engine,
  id: string,
  hostCurrent?: () => boolean,
  requestId?: string,
  start = new CodeSendStart(),
): Promise<Conversation> {
  const store = this.store;
  const current = () => {
    if ((hostCurrent && !hostCurrent()) || this.store !== store)
      throw Error("The account changed. Check the session before retrying compaction.");
  };
  current();
  if (requestId !== undefined &&
      (typeof requestId !== "string" || !requestId || requestId.length > 500))
    throw Error("Invalid compaction request identity.");
  const other = this.elsewhereFor(id);
  if (other) {
    if (requestId !== undefined)
      throw Error("This compaction request requires a local Code session.");
    return other.compactConversation(id, hostCurrent);
  }
  const c = store.conversation(id);
  const hosted = this.environment.kind === "space" && c.environment?.kind === "space" && this.owns(c);
  if (requestId !== undefined) {
    if (c.mode !== "code" || c.incognito || (!hosted && (c.cloudHosted || c.cloudEnvironmentId ||
        (c.environment && c.environment.kind !== "local"))))
      throw Error("This compaction request requires a local Code session.");
    // A recorded attempt is not permission to dispatch again after refresh or restart.
    if ([...c.turns, ...(c.savedBranches ?? []).flatMap(branch => branch.turns)]
        .some(turn => turn.compactionRequestId === requestId))
      return structuredClone(c);
  }
  if (this.pendingSend || compactingEngines.has(this))
    throw new Error("A task is being created. Try again in a moment.");
  assertCodeSessionSendAvailable(c);
  if (!c.threadId || !c.turns.length)
    throw new Error("There is nothing to compact yet.");
  this.assertIdle(id);
  const provider = store.settings.providers.find(p => p.id === c.providerId);
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, c.model);
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  const identity = { id: c.id, createdAt: c.createdAt, threadId: c.threadId,
    model: c.model, providerId: c.providerId, cwd: c.cwd, mode: c.mode,
    environment: JSON.stringify(c.environment), ownership: JSON.stringify([c.incognito,c.cloudHosted,c.cloudEnvironmentId,c.sessionAuthors]),
    turns: c.turns, count: c.turns.length };
  let preparedTurn: Turn | undefined;
  const check = () => {
    current();
    if (start.cancelledBeforeDispatch) throw new CodeSendCancelled();
    if (store.conversations.filter(row => row.id === id).length !== 1 ||
        store.conversation(id) !== c || c.id !== identity.id || c.createdAt !== identity.createdAt ||
        c.threadId !== identity.threadId || c.model !== identity.model ||
        c.providerId !== identity.providerId || c.cwd !== identity.cwd || c.mode !== identity.mode ||
        JSON.stringify(c.environment) !== identity.environment ||
        JSON.stringify([c.incognito,c.cloudHosted,c.cloudEnvironmentId,c.sessionAuthors]) !== identity.ownership || c.turns !== identity.turns ||
        c.turns.length !== identity.count + Number(!!preparedTurn) ||
        (preparedTurn && (c.turns.at(-1) !== preparedTurn || preparedTurn.status !== "inProgress" ||
          !preparedTurn.id.startsWith("pending-") || preparedTurn.items.length)) ||
        c.archived || c.worktree?.state === "deleted" ||
        (hosted && (c.linkedToComputer || c.chatDeviceBinding || c.codeNewTask)))
      throw Error("The session changed. Reopen it before compacting.");
    this.assertIdle(id, preparedTurn?.id);
  };
  check();
  const release = c.mode === "code" ? beginCodeSessionLifecycle(c) : () => {};
  compactingEngines.add(this);
  start.bind(() => this.store === store && (!hostCurrent || hostCurrent()) &&
    store.conversations.includes(c), () => {
      if (!preparedTurn || preparedTurn.status !== "inProgress") return;
      preparedTurn.userStopped = true;
      finishTurn(preparedTurn, "interrupted");
      this.changed(c, true);
      store.flush();
    });
  let ownsPending = false;
  let admission: CodeRunAdmission | undefined;
  let dispatched = false;
  try {
    await this.ensure(provider, { current: () => { current(); return true; } });
    check();
    const rpc = this.rpc;
    await this.windowsSandbox.ensureReady(rpc!, this.sandboxSetupFolder());
    check();
    if (this.rpc !== rpc || this.intentionalStop) throw Error("The agent connection changed.");
    if (this.pendingSend) throw Error("A task is being created. Try again in a moment.");
    this.pendingSend = true;
    ownsPending = true;
    const project = store.projects.find(p => p.id === c.projectId);
    await this.ensureThread(c, this.threadOptions(c, provider, c.model, c.mode, project),
      () => { check(); return true; });
    check();
    if (this.rpc !== rpc || this.intentionalStop) throw Error("The agent connection changed.");
    const turn: Turn = {
      id: "pending-" + randomUUID(), compaction: "manual", contextUsageModel: c.model,
      ...(requestId === undefined ? {} : { compactionRequestId: requestId }),
      prompt: "", attachments: [], items: [], status: "inProgress", createdAt: Date.now(),
    };
    preparedTurn = turn;
    trackCodeSendStart(c, turn, start);
    const previousUpdatedAt = c.updatedAt;
    c.turns.push(turn);
    c.updatedAt = Date.now();
    try {
      if (this.admitCodeRun && c.mode === "code") {
        admission = await this.admitCodeRun(c, start);
        check();
        admission?.track(turn);
      }
      if (requestId !== undefined) await store.persistCodeCompaction(c, turn,
        () => this.store === store && (!hostCurrent || hostCurrent()) && !start.cancelledBeforeDispatch);
    } catch (error) {
      if (!start.cancelledBeforeDispatch) {
        c.turns = c.turns.filter(t => t !== turn);
        c.updatedAt = previousUpdatedAt;
      }
      throw error;
    }
    try {
      check();
      this.routes.set(c.threadId!, c.id);
      this.changed(c, true);
      check();
      if (this.rpc !== rpc || this.intentionalStop) throw Error("The agent connection changed.");
      dispatched = true;
      const threadId = c.threadId!;
      const request = this.forward("thread/compact/start", { threadId });
      start.dispatched(async (stillCurrent) => {
        await request;
        const active = () => stillCurrent() && this.rpc === rpc &&
          c.threadId === threadId && c.turns.at(-1) === turn;
        if (!active() || turn.id.startsWith("pending-")) return { status: "mismatch" };
        if (turn.status !== "inProgress") return { status: "already_finished" };
        await interrupt.call(this, c.id, { conversation: c, turn, threadId, current: active });
        return { status: active() ? "accepted" : "mismatch" };
      });
      await request;
      current();
      if (hosted && requestId !== undefined && c.turns.includes(turn)) {
        turn.compactionAccepted = true;
        store.flush();
      }
    } catch (error) {
      // Transport rejection may follow acceptance. Keep the attempt and its ID,
      // including when turn/started has not arrived, rather than silently replaying it.
      if ((!hostCurrent || hostCurrent()) && this.store === store &&
          store.conversations.includes(c) && c.turns.includes(turn) &&
          !(hosted && dispatched && (turn.compactionAccepted || !turn.id.startsWith("pending-")))) {
        if (turn.status === "inProgress") {
          if (dispatched) turn.compactionUncertain = true;
          else finishTurn(turn, "failed");
          turn.error = dispatched
            ? "Compaction could not be confirmed and may still be running. Wait for its result or restart the agent before sending again."
            : "Compaction did not start. Check the session before trying again.";
        }
        if (requestId !== undefined) store.flush();
        this.changed(c, true);
      }
      throw error;
    }
    return structuredClone(c);
  } finally {
    if (!dispatched) admission?.abandon();
    release();
    compactingEngines.delete(this);
    if (ownsPending && this.store === store && (!hostCurrent || hostCurrent())) this.pendingSend = false;
  }
}

/**
 * Bash mode (desktop bundle 2.31226.1): the Code composer's `!` line runs
 * as a shell command in the session instead of going to the model
 * (`thread/shellCommand`; Codex runs it with the thread's shell, without
 * the sandbox). It is recorded as a turn with `shell: true` whose prompt
 * is the command and whose `commandExecution` item (source "userShell")
 * arrives as notifications; the command is in the thread's history, so
 * the model reads it on its next turn.
 */
export async function runShellCommand(
  this: Engine,
  id: string,
  command: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.runShellCommand(id, command);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  if (c.mode !== "code")
    throw new Error("Shell commands run in Code sessions.");
  if (c.incognito) throw new Error("Shell commands aren't available here.");
  if (!command.trim()) throw new Error("Enter a shell command first.");
  this.assertIdle(id);
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  await this.ensure(provider);
  await this.windowsSandbox.ensureReady(this.rpc!, this.sandboxSetupFolder());
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  this.assertIdle(id);
  this.pendingSend = true;
  try {
    const project = this.store.projects.find((p) => p.id === c.projectId);
    await this.ensureThread(
      c,
      this.threadOptions(c, provider, c.model, c.mode, project),
    );
    this.routes.set(c.threadId!, c.id);
    // Codex assigns the turn's ID in turn/started.
    const turn: Turn = {
      id: "pending-" + randomUUID(),
      shell: true,
      prompt: command,
      attachments: [],
      items: [],
      status: "inProgress",
      createdAt: Date.now(),
    };
    c.turns.push(turn);
    c.updatedAt = Date.now();
    this.changed(c, true);
    try {
      await this.forward("thread/shellCommand", {
        threadId: c.threadId,
        command,
      });
    } catch (error) {
      // A command that never started leaves no turn behind.
      if (turn.id.startsWith("pending-"))
        c.turns = c.turns.filter((t) => t !== turn);
      else if (turn.status === "inProgress") {
        finishTurn(turn, "failed");
        turn.error = (error as Error).message;
      }
      this.changed(c, true);
      throw error;
    }
    return structuredClone(c);
  } finally {
    this.pendingSend = false;
  }
}

/**
 * `/review` (`review/start`, delivered inline): Codex reviews the target
 * in the session's own thread and ends the turn with its findings
 * (`exitedReviewMode`). It is recorded as a turn with `review` whose
 * prompt is what the person typed, so its notifications do not land on
 * the previous turn; the turn's items arrive as notifications.
 */
export async function startReview(
  this: Engine,
  id: string,
  target: ReviewTarget,
  prompt?: string,
  official?: { current: () => boolean; uuid: string; start: CodeSendStart },
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.startReview(id, target, prompt, official);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  official?.start.bind(official.current, () => {});
  const check = () => {
    assertCodeSessionSendAvailable(c);
    if (official && (!official.current() || this.store.conversation(id) !== c))
      throw Error("The account or session changed before the Code review.");
    if (official?.start.cancelledBeforeDispatch) throw new CodeSendCancelled();
  };
  check();
  if (c.mode !== "code") throw new Error("Reviews run in Code sessions.");
  if (c.incognito) throw new Error("Reviews aren't available here.");
  if (!c.threadId || !c.turns.length)
    throw new Error("Send a message first, then review the session's changes.");
  const previous = official && [...c.turns, ...(c.savedBranches ?? []).flatMap((branch) => branch.turns)]
    .find((turn) => turn.officialCodeEventId === official.uuid);
  if (previous) {
    if (!previous.review || previous.prompt !== prompt?.trim())
      throw Error("This message id already belongs to another input.");
    return structuredClone(c);
  }
  this.assertIdle(id);
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, c.model);
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  await this.ensure(provider, official ? { current: official.current } : undefined);
  check();
  await this.windowsSandbox.ensureReady(this.rpc!, this.sandboxSetupFolder());
  check();
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  this.assertIdle(id);
  this.pendingSend = true;
  try {
    const project = this.store.projects.find((p) => p.id === c.projectId);
    await this.ensureThread(
      c,
      this.threadOptions(c, provider, c.model, c.mode, project),
    );
    check();
    this.routes.set(c.threadId!, c.id);
    // Codex assigns the turn's ID in turn/started.
    const turn: Turn = {
      id: "pending-" + randomUUID(),
      ...(official ? { officialCodeEventId: official.uuid } : {}),
      review: target,
      prompt: prompt?.trim() || "/review",
      attachments: [],
      items: [],
      status: "inProgress",
      createdAt: Date.now(),
    };
    c.turns.push(turn);
    c.updatedAt = Date.now();
    this.changed(c, true);
    try {
      if (official) {
        trackCodeSendStart(c, turn, official.start);
        official.start.dispatched(async (current) => {
          if (!current() || c.turns.at(-1) !== turn || turn.status !== "inProgress" ||
              !c.threadId || turn.id.startsWith("pending-"))
            return { status: "mismatch" };
          await interrupt.call(this, id, { conversation: c, turn, threadId: c.threadId, current });
          return { status: "accepted" };
        });
      }
      await this.forward("review/start", {
        threadId: c.threadId,
        target,
        delivery: "inline",
      });
    } catch (error) {
      if (official) {
        throw Error("The Code review could not be confirmed. Check the session before retrying.", { cause: error });
      }
      if (turn.id.startsWith("pending-"))
        c.turns = c.turns.filter((t) => t !== turn);
      else if (turn.status === "inProgress") {
        finishTurn(turn, "failed");
        turn.error = (error as Error).message;
      }
      this.changed(c, true);
      throw error;
    }
    return structuredClone(c);
  } finally {
    this.pendingSend = false;
  }
}

/**
 * Fork session / Fork from here (desktop bundle 2.31226.1): a new
 * conversation that continues this one after a finished turn (the last
 * one when none is named). This conversation stays as it is and records
 * the fork at that turn; the new one records where it came from.
 * Saved reply and prompt versions stay with the source. A prompt is sent
 * in the new conversation once it exists (Send in a forked session).
 */
/**
 * Rewind to here / `/rewind` (desktop bundle 2.31226.1): removes a
 * message and everything after it (the last message when none is named).
 * The conversation continues on a fork of its thread that stops before
 * that message, so the removed turns and their thread are kept aside for
 * Undo rewind until the next message is sent. Files stay as they are.
 */
// Hold the same session lock used by lifecycle operations across all awaits.
async function codeHistory<T>(engine: Engine, id: string, run: () => Promise<T>): Promise<T> {
  const c = engine.store.conversation(id);
  if (c.mode !== "code") return run();
  engine.store.assertLocalCodeLifecycleAvailable();
  assertCodeSessionSendAvailable(c);
  const release = beginCodeSessionLifecycle(c);
  try { return await run(); } finally { release(); }
}
function freshThread(engine: Engine, value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    !engine.routes.has(value) && !engine.loaded.has(value) &&
    !engine.store.conversations.some(c => c.threadId === value || c.rewind?.threadId === value ||
      c.preClearHistory?.threadId === value || c.preClearHistory?.rewind?.threadId === value ||
      c.savedBranches?.some(branch => branch.threadId === value));
}

export function changeCodeClearHistory(
  engine: Engine,
  id: string,
  action: "clear" | "restore",
  current: () => boolean,
): Promise<Conversation | undefined> {
  const store = engine.store, c = store.conversation(id);
  const valid = () => current() && engine.store === store && engine.owns(c) &&
    c.mode === "code" && !!c.cwd && !c.incognito && !c.archived && !c.codeNewTask &&
    c.worktree?.state !== "deleted" && !c.cloudHosted && !c.cloudEnvironmentId &&
    c.environment?.kind !== "space";
  if (!valid()) throw Error("This Code session's conversation cannot be changed.");
  return codeHistory(engine, id, async () => {
    if (engine.pendingSend)
      throw Error("Wait for Code input to finish submitting before changing history.");
    engine.assertIdle(id);
    const settled = (turns: Turn[]) => turns.every(turn =>
      turn.status !== "inProgress" && !isOutboxTurn(turn));
    if (!settled(c.turns))
      throw Error("Wait for the Code conversation to settle before changing history.");
    const previous = c.preClearHistory;
    if (action === "restore" && !previous) return undefined;
    const active = {
      threadId: c.threadId, turns: c.turns, usage: c.usage,
      tokenUsage: c.tokenUsage, rewind: c.rewind,
    };
    const hasActive = !!active.threadId || !!active.turns.length || !!active.rewind;
    if (action === "clear" && !hasActive) return structuredClone(c);
    const keep = action === "clear" ? previous : hasActive ? active : undefined;
    const selected = action === "restore" ? previous : undefined;
    if (selected && !settled(selected.turns))
      throw Error("The previous Code conversation is not settled.");
    const savedBranches = keep && (keep.threadId || keep.turns.length)
      ? [...c.savedBranches ?? [], {
        id: randomUUID(), threadId: keep.threadId, turns: keep.turns,
        usage: keep.usage, tokenUsage: keep.tokenUsage,
        providerId: c.providerId, model: c.model, visited: Date.now(),
      }]
      : c.savedBranches;
    const patch: Partial<Conversation> = {
      threadId: selected?.threadId,
      turns: selected?.turns ?? [],
      usage: selected?.usage,
      tokenUsage: selected?.tokenUsage,
      rewind: selected?.rewind,
      preClearHistory: action === "clear" ? active : undefined,
      savedBranches,
      promptSuggestion: undefined,
      sessionState: undefined,
      updatedAt: Date.now(),
    };
    store.commitLocalCodeHistory(c, patch, undefined, valid);
    if (c.threadId) engine.routes.set(c.threadId, c.id);
    engine.changed(c, true);
    return structuredClone(c);
  });
}

export async function rewindConversation(this: Engine, id: string, turnId?: CodeRewindTarget, hostCurrent?: () => boolean): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.rewindConversation(id, turnId, hostCurrent);
  return codeHistory(this, id, () => rewindHistory.call(this, id, turnId, hostCurrent));
}

export type HostedCodeRewindPatch = Pick<Conversation, "turns" | "threadId" | "rewind" | "updatedAt">;

type HostedCodeRewindCommit = (
  conversation: Conversation,
  patch: HostedCodeRewindPatch,
  targetIndex: number,
  current: () => boolean,
) => Promise<void>;

export async function rewindHostedCodeHistory(
  engine: Engine,
  id: string,
  target: CodeRewindTarget,
  current: () => boolean,
  commit: HostedCodeRewindCommit,
): Promise<void> {
  const conversation = engine.store.conversation(id);
  if (!current() || conversation.mode !== "code" || !engine.owns(conversation))
    throw Error("The hosted Code session changed before rewind.");
  const release = beginCodeSessionLifecycle(conversation);
  try {
    await rewindHistory.call(engine, id, target, current, commit);
  } finally {
    release();
  }
}
export async function swapRewind(this: Engine, id: string, hostCurrent?: () => boolean): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.swapRewind(id, hostCurrent);
  return codeHistory(this, id, () => swapHistory.call(this, id, hostCurrent));
}
export async function switchCodeRewindMark(engine: Engine, id: string, markId: string, current: () => boolean) {
  return codeHistory(engine, id, async () => {
    if (!current()) throw Error("The account changed before switching rewind history.");
    const store = engine.store, c = store.conversation(id);
    engine.assertIdle(id);
    if (engine.pendingSend || c.turns.some(turn => turn.status === "inProgress"))
      throw Error("Wait for the Code session to finish before switching history.");
    if (c.rewind?.variant === "pending") throw Error("Send or undo the pending rewind before switching history.");
    const matches = c.savedBranches?.filter(branch => branch.id === markId && branch.rewindMark) ?? [];
    if (matches.length !== 1) throw Error("The rewind marker is no longer available.");
    const target = matches[0];
    if (target.turns.some(turn => turn.status === "inProgress" || turn.id.startsWith("pending-")))
      throw Error("The saved rewind history is not settled.");
    const history = structuredClone(c);
    retireCodeRewind(history);
    const savedBranches = (history.savedBranches ?? []).filter(branch => branch.id !== markId);
    savedBranches.push({
      id: randomUUID(), threadId: c.threadId, turns: structuredClone(c.turns),
      model: c.model, providerId: c.providerId, visited: Date.now(),
      rewindMark: { forkPoint: target.rewindMark!.forkPoint,
        direction: target.rewindMark!.direction === "forward" ? "back" : "forward", at: Date.now() },
    });
    store.commitLocalCodeHistory(c, {
      threadId: target.threadId, turns: structuredClone(target.turns),
      model: target.model, providerId: target.providerId, savedBranches,
      rewind: undefined, updatedAt: Date.now(),
    }, undefined, () => current() && engine.store === store && store.conversation(id) === c);
    if (c.threadId) engine.routes.set(c.threadId, c.id);
    engine.changed(c, true);
    return structuredClone(c);
  });
}
export async function forkConversation(this: Engine, id: string, turnId?: string, prompt?: string, branchId?: string, hostCurrent?: () => boolean, options?: CodeForkOptions): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.forkConversation(id, turnId, prompt, branchId, hostCurrent, options);
  const source = this.store.conversation(id);
  if (source.mode !== "code") return forkHistory.call(this, id, turnId, prompt, branchId, hostCurrent, options);
  this.store.assertLocalCodeLifecycleAvailable();
  const release = beginCodeSessionLifecycle(source);
  try { return await forkHistory.call(this, id, turnId, prompt, branchId, hostCurrent, options); }
  finally { release(); }
}
const rewindPending = new WeakMap<object, object>();
async function rewindHistory(
  this: Engine,
  id: string,
  turnId?: CodeRewindTarget,
  hostCurrent?: () => boolean,
  hostedCommit?: HostedCodeRewindCommit,
): Promise<Conversation> {
  if (hostCurrent && !hostCurrent()) throw Error("The account changed before rewind.");
  const other = this.elsewhereFor(id);
  if (other) return other.rewindConversation(id, turnId, hostCurrent);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const store = this.store, c = store.conversation(id);
  const facts = () => JSON.stringify({threadId:c.threadId, turns:c.turns, rewind:c.rewind,
    activeBranchId:c.activeBranchId, cwd:c.cwd, providerId:c.providerId, model:c.model,
    mode:c.mode, environment:c.environment, projectId:c.projectId, incognito:c.incognito,
    archived:c.archived, worktree:c.worktree, cloudHosted:c.cloudHosted,
    cloudEnvironmentId:c.cloudEnvironmentId, sessionAuthors:c.sessionAuthors, codeNewTask:c.codeNewTask,
    codePermissionMode:c.codePermissionMode, strictSandbox:c.strictSandbox, localSandboxOff:c.localSandboxOff,
    connectorOverrides:c.connectorOverrides, connectorToolOverrides:c.connectorToolOverrides, additionalFolders:c.additionalFolders});
  const original = facts();
  let prepared = false;
  const current = () => {
    if (this.store !== store || store.conversations.find(row => row.id === id) !== c || facts() !== original ||
        prepared && this.intentionalStop || hostCurrent && !hostCurrent())
      throw Error("The account or history changed during rewind. Check the session before retrying.");
  };
  current();
  if (c.turns.some((t) => t.status === "inProgress"))
    throw new Error("Rewind is unavailable while Claudex is working");
  this.assertIdle(id);
  const targetTurnId = typeof turnId === "object" ? turnId.turnId : turnId;
  const before = typeof turnId === "object" ? turnId : undefined;
  const index = targetTurnId
    ? c.turns.findIndex((t) => t.id === targetTurnId)
    : c.turns.length - 1;
  if (index < 0) throw new Error("Nothing to rewind to yet");
  if (c.mode === "code" && (new Set(c.turns.map(t => t.id)).size !== c.turns.length ||
      c.turns.some(t => t.id.startsWith("pending-") || isOutboxTurn(t))))
    throw Error("The Code history is not settled or has ambiguous turn identities.");
  const kept = codeForkTurns(c.turns, c.turns[index].id, { turnId: c.turns[index].id, ...(before ? { itemId: before.itemId } : {}) });
  if ((index > 0 || before) && !c.threadId)
    throw new Error("Rewind isn't available for this session.");
  if (index > 0 || before) this.assertIncognitoLive(c);
  let threadId: string | undefined;
  let threadLimit: string | undefined;
  if (index > 0 || before) {
    const provider = store.settings.providers.find(
      (p) => p.id === c.providerId,
    );
    if (!provider) throw new Error("The model service is unavailable.");
    this.assertModel(provider, c.model);
    await this.ensure(provider, {current: () => { current(); return true; }});
    prepared = true;
    current();
    if (this.pendingSend) throw Error("Another task started while rewind was preparing.");
    const rpc = this.rpc;
    if (!rpc) throw Error("The agent connection is unavailable.");
    const token = {};
    rewindPending.set(this, token);
    this.pendingSend = true;
    try {
      const project = store.projects.find((p) => p.id === c.projectId);
      const threadOptions = this.threadOptions(
        c,
        provider,
        c.model,
        c.mode,
        project,
      );
      await this.ensureThread(c, threadOptions, () => { current(); return true; });
      current();
      if (this.rpc !== rpc) throw Error("The agent connection changed.");
      const targetItem = before ? c.turns[index].items.find(item => item.id === before.itemId) : undefined;
      const prefix = targetItem ? await codeForkPrefix(rpc, this.codexHome, c.threadId!, c.turns[index].id, targetItem) : undefined;
      current();
      let fork;
      try {
        fork = await rpc.call("thread/fork", {
          threadId: c.threadId,
          ...(prefix ? { path: prefix.path } : { lastTurnId: c.turns[index - 1].id }),
          ...reloadOptions(threadOptions),
        });
      } finally { prefix?.dispose(); }
      current();
      if (this.rpc !== rpc) throw Error("The agent connection changed; check the session before retrying.");
      if (!freshThread(this, fork?.thread?.id))
        throw new Error("Couldn't confirm the rewound thread. Check the session before retrying.");
      if (hasThreadMcp(threadOptions) && !c.incognito) {
        await rpc.call("thread/unsubscribe", {
          threadId: fork.thread.id,
        });
        current();
        if (this.rpc !== rpc) throw Error("The agent connection changed.");
        await rpc.call("thread/resume", {
          threadId: fork.thread.id,
          ...reloadOptions(threadOptions),
          excludeTurns: true,
        });
      }
      current();
      if (this.rpc !== rpc) throw Error("The agent connection changed.");
      if (!freshThread(this, fork.thread.id)) throw Error("The rewound thread is already in use.");
      threadId = fork.thread.id;
      threadLimit = limitsKey(threadOptions);
      // Publish routing only after the history commit succeeds.
    } finally {
      if (rewindPending.get(this) === token) {
        rewindPending.delete(this);
        if (this.store === store && this.rpc === rpc && (!hostCurrent || hostCurrent())) this.pendingSend = false;
      }
    }
  }
  current();
  const history = { threadId, turns: kept, updatedAt: Date.now() };
  if (hostedCommit) {
    await hostedCommit(c, { ...history, rewind: undefined }, index, () => { current(); return true; });
  } else {
    const saved = structuredClone(c);
    retireCodeRewind(saved);
    const patch: Partial<Conversation> = {
      ...history, savedBranches: saved.savedBranches,
      rewind: { variant: "pending", index, threadId: c.threadId, model: c.model,
      filesRewoundTo: c.codeFilesRewoundTo,
      ...(before ? { partial: true } : {}),
        turns: c.turns.slice(index), at: Date.now() },
      model: rewindModel(c.turns.slice(index), c.model),
    codeFilesRewoundTo: JSON.stringify(c.codeFilesRewoundTo) === JSON.stringify(turnId) ? undefined : c.codeFilesRewoundTo,
    };
    if (c.mode === "code") store.commitLocalCodeHistory(c, patch, undefined, () => { current(); return true; });
    else { Object.assign(c, patch); store.flush(); }
  }
  if (threadId) { this.loaded.add(threadId); this.routes.set(threadId, c.id);
    if (threadLimit !== undefined) this.threadLimits.set(threadId, threadLimit); }
  this.changed(c, true);
  return structuredClone(c);
}

/**
 * Undo rewind / Redo rewind: swaps the turns after the rewind point, and
 * the thread holding them, with the ones set aside. Refused once a message
 * was sent after the rewind, or while one is running.
 */
async function swapHistory(
  this: Engine,
  id: string,
  hostCurrent?: () => boolean,
): Promise<Conversation> {
  if (hostCurrent && !hostCurrent()) throw Error("The account changed before undo rewind.");
  const other = this.elsewhereFor(id);
  if (other) return other.swapRewind(id, hostCurrent);
  if (this.pendingSend) throw Error("A task is being prepared. Wait before undoing rewind.");
  const store = this.store, c = store.conversation(id);
  const rewind = c.rewind;
  if (!rewind)
    throw new Error(
      "Couldn\u2019t undo this rewind because a message was sent after it.",
    );
  if (c.turns.some((t) => t.status === "inProgress"))
    throw new Error("Rewind is unavailable while Claudex is working");
  this.assertIdle(id);
  if (this.store !== store || store.conversation(id) !== c || hostCurrent && !hostCurrent()) throw Error("The account changed before undo rewind.");
  if (c.mode === "code" && (!Number.isInteger(rewind.index) || rewind.index < 0 ||
      rewind.index > c.turns.length || !Array.isArray(rewind.turns) ||
      rewind.turns.some(t => t.status === "inProgress" || t.id.startsWith("pending-") || isOutboxTurn(t))))
    throw Error("The saved rewind history is invalid or not settled.");
  const kept = c.turns.slice(0, rewind.index);
  const tail = c.turns.slice(rewind.index);
  const thread = c.threadId;
  const patch: Partial<Conversation> = {
    threadId: rewind.threadId, turns: [...kept, ...rewind.turns],
    model: rewind.model ?? c.model,
    codeFilesRewoundTo: rewind.filesRewoundTo ?? c.codeFilesRewoundTo,
    rewind: { variant: rewind.variant === "pending" ? "forward" : "pending",
      index: rewind.index, threadId: thread, model: c.model, partial: rewind.partial, filesRewoundTo: c.codeFilesRewoundTo, turns: tail, at: Date.now() },
    updatedAt: Date.now(),
  };
  if (c.mode === "code") store.commitLocalCodeHistory(c, patch, undefined,
    () => this.store === store && (!hostCurrent || hostCurrent()));
  else { Object.assign(c, patch); store.flush(); }
  if (c.threadId) this.routes.set(c.threadId, c.id);
  this.changed(c, true);
  return structuredClone(c);
}

async function forkHistory(
  this: Engine,
  id: string,
  turnId?: string,
  prompt?: string,
  branchId?: string,
  hostCurrent?: () => boolean,
  options?: CodeForkOptions,
): Promise<Conversation> {
  if (hostCurrent && !hostCurrent()) throw new Error("The account changed before the fork started.");
  const other = this.elsewhereFor(id);
  if (other) return other.forkConversation(id, turnId, prompt, branchId, hostCurrent, options);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const store = this.store, source = store.conversation(id);
  const isCode = source.mode === "code";
  const childId = options?.conversationId ?? randomUUID();
  if (store.conversations.some(conversation => conversation.id.toLowerCase() === childId.toLowerCase()))
    throw Error("The requested fork session already exists.");
  let targetCwd = source.cwd;
  if (options?.cwd !== undefined) {
    if (!isCode || !path.isAbsolute(options.cwd) || !fs.statSync(options.cwd).isDirectory())
      throw Error("Cannot fork: target folder must be a local absolute directory.");
    targetCwd = path.resolve(options.cwd);
  }
  const branches = branchId === undefined ? [] : (source.savedBranches ?? []).filter(branch => branch.id === branchId);
  if (branchId !== undefined && (typeof branchId !== "string" || !branchId || branches.length !== 1 || !turnId))
    throw new Error("The saved branch or explicit fork reply is unavailable.");
  const branch = branches[0];
  if (branch && (!branch.threadId || !branch.providerId || !branch.model ||
      branch.turns.filter(turn => turn.id === turnId).length !== 1))
    throw new Error("The saved branch mapping is incomplete or ambiguous.");
  const fingerprint = branch ? JSON.stringify(branch) : undefined;
  const c: Conversation = branch ? {...structuredClone(source), threadId: branch.threadId,
    providerId: branch.providerId, model: branch.model, turns: structuredClone(branch.turns)} : source;
  const activeFacts = () => JSON.stringify({threadId: source.threadId, providerId: source.providerId,
    model: source.model, activeBranchId: source.activeBranchId,
    ...(source.mode === "code" ? { cwd:source.cwd, mode:source.mode, environment:source.environment,
      projectId:source.projectId, archived:source.archived, worktree:source.worktree,
      codeNewTask:source.codeNewTask, rewind:source.rewind, sessionAuthors:source.sessionAuthors } : {}),
    turns: options?.before && turnId ? codeForkTurns(source.turns, turnId, options.before) :
      turnId ? source.turns.slice(0, source.turns.findIndex(turn => turn.id === turnId) + 1) : source.turns});
  const activeFingerprint = branch ? undefined : activeFacts();
  const ownership = () => JSON.stringify({ id: source.id, createdAt: source.createdAt,
    cwd: source.cwd, mode: source.mode, environment: source.environment, projectId: source.projectId,
    archived: source.archived, worktree: source.worktree, incognito: source.incognito,
    cloudHosted: source.cloudHosted, cloudEnvironmentId: source.cloudEnvironmentId,
    sessionAuthors: source.sessionAuthors, rewind: source.rewind, codeNewTask: source.codeNewTask,
    importedHistory: source.importedHistory, importedSessionResumePending: source.importedSessionResumePending,
    codePermissionMode:source.codePermissionMode, strictSandbox:source.strictSandbox, localSandboxOff:source.localSandboxOff,
    connectorOverrides:source.connectorOverrides, connectorToolOverrides:source.connectorToolOverrides,
    additionalFolders:source.additionalFolders, sessionInstructions:source.sessionInstructions });
  const originalOwnership = ownership();
  let prepared = false;
  const current = () => {
    if (this.store !== store || prepared && this.intentionalStop || hostCurrent && !hostCurrent())
      throw new Error("The account or engine changed. A requested fork may already exist; check before retrying.");
    if (store.conversation(id) !== source || ownership() !== originalOwnership ||
        store.conversations.filter(row => row.id === id).length !== 1)
      throw new Error("The source conversation changed.");
    if (!branch && activeFacts() !== activeFingerprint)
      throw new Error("The active branch changed. A requested fork may already exist; check before retrying.");
    if (branch) {
      const matches = (source.savedBranches ?? []).filter(item => item.id === branchId);
      if (matches.length !== 1 || JSON.stringify(matches[0]) !== fingerprint)
        throw new Error("The saved branch changed. A requested fork may already exist; check before retrying.");
    }
  };
  current();
  if (c.incognito) throw new Error("An incognito chat can't be forked.");
  if (c.importedSessionResumePending) throw Error("Confirm resuming the imported Code session before forking it.");
  const settled = (t: Turn) =>
    t.status !== "inProgress" &&
    !t.id.startsWith("pending-") &&
    !isOutboxTurn(t);
  const target = turnId
    ? c.turns.find((t) => t.id === turnId)
    : [...c.turns].reverse().find(settled);
  if (!target) throw new Error("There is nothing to fork yet.");
  if (c.mode === "code" && c.turns.filter(t => t.id === target.id).length !== 1)
    throw Error("The Code fork reply is ambiguous.");
  if (!settled(target) && !options?.before)
    throw new Error("Wait for this reply to finish before forking from it.");
  const kept = codeForkTurns(c.turns, target.id, options?.before);
  const forkSource = codeForkSource(c, target, kept);
  if (!forkSource) throw new Error("There is nothing to fork yet.");
  if (forkSource.kind === "native" && options?.before?.importedRowId !== undefined)
    throw Error("The selected message is not available in the native Code history.");
  const model = codeForkModel(c.turns, c.model, options?.before);
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, model);
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  let forked: Conversation;
  let native: { threadId: string; limits: string } | undefined;
  let rpc: Engine["rpc"];
  let forkWorktree: Awaited<ReturnType<typeof prepareCodeForkWorktree>> | undefined;
  let commitAttempted = false;
  try {
    if (options?.separateWorktree) {
      if (!isCode || !source.worktree || options.cwd !== undefined || forkSource.kind !== "native")
        throw Error("This Code session cannot fork into a separate worktree.");
      forkWorktree = await prepareCodeForkWorktree(source, store.settings.codeWorktreeLocation ?? "",
        store.settings.codeBranchPrefix || "claude", current);
      targetCwd = forkWorktree.cwd;
      current();
    }
    if (forkSource.kind === "native") {
      await this.ensure(provider, {current: () => { current(); return true; }});
      prepared = true;
      current();
      if (this.pendingSend) throw new Error("Another task started while the fork was preparing.");
      rpc = this.rpc;
      if (!rpc) throw new Error("The agent connection is unavailable.");
      this.pendingSend = true;
      const project = this.store.projects.find((p) => p.id === c.projectId);
      const threadOptions = this.threadOptions(
        { ...c, cwd: targetCwd, ...(targetCwd !== c.cwd ? { projectId: undefined, worktree: undefined, codeSessionFolderGrants: undefined } : {}) },
        provider,
        model,
        c.mode,
        targetCwd === c.cwd ? project : undefined,
      );
      if (!isCode) await this.ensureThread(c, this.threadOptions(c, provider, c.model, c.mode, project), () => { current(); return true; });
      current();
      if (this.rpc !== rpc) throw new Error("The agent connection changed.");
      const beforeItem = options?.before?.itemId;
      const prefix = beforeItem || c.archived && kept.length ? await codeForkPrefix(rpc, store.root, forkSource.threadId, target.id,
        target.items.find(item => item.id === beforeItem)) : undefined;
      let fork;
      try {
        current();
        fork = await rpc.call(kept.length ? "thread/fork" : "thread/start", {
          ...(kept.length ? { threadId: forkSource.threadId,
            ...(prefix ? { path: prefix.path } : {}),
            ...(beforeItem ? {} : { lastTurnId: kept.at(-1)!.id }) } : {}),
          ...(kept.length ? reloadOptions(threadOptions) : threadOptions),
        });
      } finally { prefix?.dispose(); }
      current();
      if (this.rpc !== rpc) throw new Error("The agent connection changed; check your chats before retrying.");
      if (!freshThread(this, fork?.thread?.id))
        throw new Error("The agent did not return a forked thread.");
      // As in branchFrom: a fork starts per-thread MCP servers without their
      // tools until it is loaded again (SP-1).
      if (hasThreadMcp(threadOptions)) {
        await rpc.call("thread/unsubscribe", {
          threadId: fork.thread.id,
        });
        current();
        if (this.rpc !== rpc) throw new Error("The agent connection changed.");
        await rpc.call("thread/resume", {
          threadId: fork.thread.id,
          ...reloadOptions(threadOptions),
          excludeTurns: true,
        });
      }
      current();
      if (this.rpc !== rpc) throw new Error("The agent connection changed.");
      if (!freshThread(this, fork.thread.id)) throw Error("The forked thread is already in use.");
      native = { threadId: fork.thread.id, limits: limitsKey(threadOptions) };
    }
    const now = Date.now();
    const {
      activeBranchId: _branch,
      branchVisit: _visit,
      savedBranches: _saved,
      forks: _forks,
      handOffs: _handOffs,
      usage: _usage,
      unread: _unread,
      sidebarRank: _rank,
      slim: _slim,
      ...rest
    } = c;
    forked = {
      ...structuredClone(rest),
      id: childId,
      cwd: targetCwd,
      model,
      threadId: native?.threadId,
      turns: kept,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      forkedFrom: { conversationId: c.id, turnId: target.id, title: c.title },
      parentSessionId: c.id,
    };
    if (c.mode === "code") {
      // Carry execution preferences, never another session's ownership or pending work.
      const keep = new Set(["id", "threadId", "title", "mode", "providerId", "model", "turns",
        "pinned", "archived", "createdAt", "updatedAt", "forkedFrom", "parentSessionId",
        "cwd", "projectId", "environment", "envScopeId", "startedFromEnvironmentId", "additionalFolders", "codeSessionFolderGrants", "effort", "sessionInstructions",
        "outputStyle", "customOutputStyles", "codePermissionMode", "localSandboxOff", "strictSandbox",
        "webSearch", "connectorOverrides", "connectorToolOverrides", "toolSearchMode",
        "sessionAuthors", "asksFirst", "remoteControlOff", "memoryDisabled", "worktree"]);
      for (const key of Object.keys(forked)) if (!keep.has(key)) delete (forked as any)[key];
      if (forkWorktree) forked.worktree = forkWorktree.worktree;
      else delete forked.worktree;
      if (forkSource.kind === "imported" || kept.some((turn) => turn.importedCodeTranscript?.length))
        forked.importedHistory = true;
    }
    if (targetCwd !== c.cwd) {
      delete forked.projectId;
      delete forked.codeSessionFolderGrants;
    }
    const patch = { forks: [...(source.forks ?? []),
      { conversationId: forked.id, turnId: target.id, createdAt: now }] };
    if (source.mode === "code") {
      const removeCopies = copyCodeForkScreenshots(store.root, source.id, forked.id, kept);
      try { commitAttempted = true; store.commitLocalCodeHistory(source, patch, forked, () => { current(); return true; }); }
      catch (error) { removeCopies(); throw error; }
    } else {
      if (store.conversations.some(conversation => conversation.id.toLowerCase() === childId.toLowerCase()))
        throw Error("The requested fork session already exists.");
      Object.assign(source, patch);
      store.conversations.unshift(forked);
      store.flush();
      if (source.mode === "chat" && options?.conversationId)
        await store.confirmChatFork(source, forked, () => { current(); return true; });
    }
    if (native) {
      this.loaded.add(native.threadId);
      this.threadLimits.set(native.threadId, native.limits);
      this.routes.set(native.threadId, forked.id);
    }
    this.changed(source, true);
    this.changed(forked, true);
  } finally {
    if (forkWorktree && !commitAttempted) await forkWorktree.cleanup();
    if (rpc && this.store === store && this.rpc === rpc) this.pendingSend = false;
  }
  current();
  if (!prompt?.trim()) return structuredClone(forked);
  return this.send({
    conversationId: forked.id,
    text: prompt,
    attachments: [],
    mode: forked.mode,
    cwd: forked.cwd,
    projectId: forked.projectId,
    providerId: forked.providerId,
    model: forked.model,
  });
}

export async function warmCodeSession(
  this: Engine,
  conversation: Conversation,
  expected: Conversation,
  active: () => boolean,
) {
  const store = this.store;
  const { threadId, providerId, model, cwd } = expected;
  const activity = codeReadSnapshot(expected);
  const current = () => active() && this.store === store &&
    store.conversations.includes(conversation) &&
    sameCodeReadActivity(conversation, activity) && conversation.providerId === providerId &&
    conversation.model === model && conversation.cwd === cwd &&
    !conversation.archived && !conversation.codeNewTask &&
    conversation.worktree?.state !== "deleted" &&
    conversation.turns.at(-1)?.status === "completed";
  if (!threadId || conversation.mode !== "code" || conversation.incognito ||
      !this.owns(conversation) || !current() || this.ownBusy())
    throw Error("The Code session cannot be warmed now. The model applies on the next start.");
  const provider = store.settings.providers.find(({ id }) => id === providerId);
  if (!provider) throw Error("The model service is unavailable.");
  this.assertModel(provider, model);
  const policy = this.policy();
  if (policy.update?.state === "required") throw Error(updateRefusal(policy.update));
  const release = beginCodeSessionLifecycle(conversation);
  try {
    if (this.launcher && cwd) await this.assertRemoteTrust(cwd, false);
    if (!current() || this.ownBusy())
      throw Error("The Code session changed while warming.");
    await this.ensure(provider, { interactive: false, current: active });
    if (!current() || this.ownBusy())
      throw Error("The Code session changed while warming.");
    this.pendingSend = true;
    try {
      const project = store.projects.find(({ id }) => id === conversation.projectId);
      await this.ensureThread(conversation, this.threadOptions(conversation, provider, model, "code", project), current);
    } finally {
      this.pendingSend = false;
    }
  } finally {
    release();
  }
}

export async function resumeSshCodeCut(
  this: Engine,
  conversation: Conversation,
  active: () => boolean,
  canContinue: () => boolean = () => true,
) {
  const store = this.store;
  const { threadId, providerId, model, cwd } = conversation;
  const turn = conversation.turns.at(-1);
  const cut = turn?.sshCut;
  const launcher = this.launcher;
  if (conversation.environment?.kind !== "ssh" || !launcher?.remoteExecutionEnded ||
      !cwd || !threadId || !turn || !cut || Date.now() - cut.at > 86_400_000) return false;
  let sourceIndex = conversation.turns.length - 1;
  while (sourceIndex > 0 && conversation.turns[sourceIndex].autoContinuation) sourceIndex--;
  const firstCut = conversation.turns[sourceIndex].sshCut;
  if (conversation.turns.length - sourceIndex > 3 ||
      firstCut && Date.now() - firstCut.at > 86_400_000) return false;
  const hostId = conversation.environment.hostId;
  const current = () => active() && canContinue() && this.store === store && this.owns(conversation) &&
    store.conversations.includes(conversation) && conversation.mode === "code" &&
    !conversation.archived && !conversation.incognito && !conversation.codeNewTask &&
    conversation.threadId === threadId && conversation.providerId === providerId && conversation.cwd === cwd &&
    conversation.model === model && conversation.turns.at(-1) === turn &&
    turn.status === "interrupted" && !turn.userStopped && !cut.continuationId &&
    !this.options.outbox?.list(hostId).some((entry) => entry.conversationId === conversation.id);
  if (!current() || this.ownBusy()) return false;
  const provider = store.settings.providers.find(({ id }) => id === providerId);
  if (!provider || this.policy().update?.state === "required") return false;
  this.assertModel(provider, model);
  const release = beginCodeSessionLifecycle(conversation);
  let continuationId: string, prompt: string;
  try {
    await this.assertRemoteTrust(cwd, false);
    if (!current() || this.ownBusy()) return false;
    if (!cut.executionEnded) {
      if (!await launcher.remoteExecutionEnded(cut.executionId) || !current() || this.ownBusy())
        return false;
      cut.executionEnded = true;
      store.flush();
    }
    await this.ensure(provider, { interactive: false, current: active });
    if (!current() || this.ownBusy() || !this.rpc) return false;
    const rpc = this.rpc;
    const reply = await rpc.call("thread/turns/list", { threadId, limit: 1, sortDirection: "desc" });
    const nativeTurn = Array.isArray(reply?.data) ? reply.data[0] : undefined;
    if (!current() || this.ownBusy() || this.rpc !== rpc ||
        nativeTurn?.id !== turn.id ||
        nativeTurn?.status !== "interrupted") return false;
    continuationId = randomUUID();
    const interruptedTool = [...(nativeTurn.items ?? []), ...turn.items].some(
      (item: { type: string; status?: string; lifecycleStatus?: string }) =>
        ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(item.type) &&
        ["interrupted", "inProgress", "running"].includes(item.lifecycleStatus ?? item.status ?? ""),
    );
    prompt = interruptedTool
      ? "Code was restarted on the remote host while you were working. If your last tool call reads as refused or interrupted by the user, that was written by the restart: nobody refused it, and it may have run in part before it was cut off. Check what it did before you run it again, then continue from where you left off."
      : "Code was restarted on the remote host while you were working. Please continue from where you left off.";
    cut.continuationId = continuationId;
    store.flush();
  } finally {
    release();
  }
  const updated = await this.send({
    conversationId: conversation.id, mode: "code", text: prompt, attachments: [],
    providerId, model, officialCodeEventId: continuationId,
  }, undefined, false, { interactive: false, autoContinuation: true, current: active });
  return updated.turns.some((entry) => entry.officialCodeEventId === continuationId);
}
