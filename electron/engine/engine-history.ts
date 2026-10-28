import { finishTurn } from "../../shared/activity";
import { randomUUID } from "node:crypto";
import { updateRefusal } from "../../shared/client-policy-rules";
import type { Conversation, Turn } from "../../shared/types";
import type { ReviewTarget } from "../../shared/composer-api";
import { isOutboxTurn } from "../ssh/outbox";
import { limitsKey, hasThreadMcp, reloadOptions } from "./thread-options";
import type { Engine } from "./engine";

/**
 * /compact (`thread/compact/start`): Codex runs a turn of its own that
 * summarizes the thread. It is recorded as a turn with `compaction:
 * "manual"` so its notifications do not land on the previous turn.
 */
export async function compactConversation(
  this: Engine,
  id: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.compactConversation(id);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  if (!c.threadId || !c.turns.length)
    throw new Error("There is nothing to compact yet.");
  this.assertIdle(id);
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, c.model);
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
      compaction: "manual",
      prompt: "",
      attachments: [],
      items: [],
      status: "inProgress",
      createdAt: Date.now(),
    };
    c.turns.push(turn);
    c.updatedAt = Date.now();
    this.changed(c, true);
    try {
      await this.forward("thread/compact/start", { threadId: c.threadId });
    } catch (error) {
      // A compaction that never started leaves no turn behind.
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
 * Bash mode: the Code composer's `!` line runs as a shell command in the
 * session instead of going to the model (`thread/shellCommand`; Codex runs it
 * with the thread's shell, without the sandbox). It is recorded as a turn with
 * `shell: true` whose prompt is the command and whose `commandExecution` item
 * (source "userShell") arrives as notifications; the command is in the thread's
 * history, so the model reads it on its next turn.
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
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.startReview(id, target, prompt);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  if (c.mode !== "code") throw new Error("Reviews run in Code sessions.");
  if (c.incognito) throw new Error("Reviews aren't available here.");
  if (!c.threadId || !c.turns.length)
    throw new Error("Send a message first, then review the session's changes.");
  this.assertIdle(id);
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, c.model);
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
      await this.forward("review/start", {
        threadId: c.threadId,
        target,
        delivery: "inline",
      });
    } catch (error) {
      // A review that never started leaves no turn behind.
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
 * Fork session / Fork from here: a new conversation that continues this one
 * after a finished turn (the last one when none is named), on a native fork of
 * its thread (`thread/fork` with `lastTurnId`). This conversation stays as it
 * is and records the fork at that turn; the new one records where it came from.
 * Saved reply and prompt versions stay with the source. A prompt is sent in the
 * new conversation once it exists (Send in a forked session).
 */
/**
 * Rewind to here / `/rewind`: removes a message and everything after it (the
 * last message when none is named). The conversation continues on a fork of its
 * thread that stops before that message, so the removed turns and their thread
 * are kept aside for Undo rewind until the next message is sent. Files stay as
 * they are.
 */
export async function rewindConversation(
  this: Engine,
  id: string,
  turnId?: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.rewindConversation(id, turnId);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  if (c.turns.some((t) => t.status === "inProgress"))
    throw new Error("Rewind is unavailable while Claudex is working");
  this.assertIdle(id);
  const index = turnId
    ? c.turns.findIndex((t) => t.id === turnId)
    : c.turns.length - 1;
  if (index < 0) throw new Error("Nothing to rewind to yet");
  if (index > 0 && !c.threadId)
    throw new Error("Rewind isn't available for this session.");
  if (index > 0) this.assertIncognitoLive(c);
  let threadId: string | undefined;
  if (index > 0) {
    const provider = this.store.settings.providers.find(
      (p) => p.id === c.providerId,
    );
    if (!provider) throw new Error("The model service is unavailable.");
    this.assertModel(provider, c.model);
    await this.ensure(provider);
    this.pendingSend = true;
    try {
      const project = this.store.projects.find((p) => p.id === c.projectId);
      const threadOptions = this.threadOptions(
        c,
        provider,
        c.model,
        c.mode,
        project,
      );
      await this.ensureThread(c, threadOptions);
      const fork = await this.rpc!.call("thread/fork", {
        threadId: c.threadId,
        lastTurnId: c.turns[index - 1].id,
        ...reloadOptions(threadOptions),
      });
      if (!fork.thread?.id) throw new Error("Couldn't rewind this session.");
      if (hasThreadMcp(threadOptions) && !c.incognito) {
        await this.rpc!.call("thread/unsubscribe", {
          threadId: fork.thread.id,
        });
        await this.rpc!.call("thread/resume", {
          threadId: fork.thread.id,
          ...reloadOptions(threadOptions),
        });
      }
      threadId = fork.thread.id;
      this.loaded.add(threadId!);
      this.threadLimits.set(threadId!, limitsKey(threadOptions));
      this.routes.set(threadId!, c.id);
    } finally {
      this.pendingSend = false;
    }
  }
  c.rewind = {
    variant: "pending",
    index,
    threadId: c.threadId,
    turns: c.turns.slice(index),
    at: Date.now(),
  };
  c.threadId = threadId;
  c.turns = c.turns.slice(0, index);
  c.updatedAt = Date.now();
  this.changed(c, true);
  this.store.flush();
  return structuredClone(c);
}

/**
 * Undo rewind / Redo rewind: swaps the turns after the rewind point, and
 * the thread holding them, with the ones set aside. Refused once a message
 * was sent after the rewind, or while one is running.
 */
export async function swapRewind(
  this: Engine,
  id: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.swapRewind(id);
  const c = this.store.conversation(id);
  const rewind = c.rewind;
  if (!rewind)
    throw new Error(
      "Couldn\u2019t undo this rewind because a message was sent after it.",
    );
  if (c.turns.some((t) => t.status === "inProgress"))
    throw new Error("Rewind is unavailable while Claudex is working");
  this.assertIdle(id);
  const kept = c.turns.slice(0, rewind.index);
  const tail = c.turns.slice(rewind.index);
  const thread = c.threadId;
  c.threadId = rewind.threadId;
  c.turns = [...kept, ...rewind.turns];
  c.rewind = {
    variant: rewind.variant === "pending" ? "forward" : "pending",
    index: rewind.index,
    threadId: thread,
    turns: tail,
    at: Date.now(),
  };
  if (c.threadId) this.routes.set(c.threadId, c.id);
  c.updatedAt = Date.now();
  this.changed(c, true);
  this.store.flush();
  return structuredClone(c);
}

export async function forkConversation(
  this: Engine,
  id: string,
  turnId?: string,
  prompt?: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.forkConversation(id, turnId, prompt);
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  if (c.incognito) throw new Error("An incognito chat can't be forked.");
  const settled = (t: Turn) =>
    t.status !== "inProgress" &&
    !t.id.startsWith("pending-") &&
    !isOutboxTurn(t);
  const target = turnId
    ? c.turns.find((t) => t.id === turnId)
    : [...c.turns].reverse().find(settled);
  if (!c.threadId || !target) throw new Error("There is nothing to fork yet.");
  if (!settled(target))
    throw new Error("Wait for this reply to finish before forking from it.");
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, c.model);
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  await this.ensure(provider);
  this.pendingSend = true;
  let forked: Conversation;
  try {
    const project = this.store.projects.find((p) => p.id === c.projectId);
    const threadOptions = this.threadOptions(
      c,
      provider,
      c.model,
      c.mode,
      project,
    );
    await this.ensureThread(c, threadOptions);
    const fork = await this.rpc!.call("thread/fork", {
      threadId: c.threadId,
      lastTurnId: target.id,
      ...reloadOptions(threadOptions),
    });
    if (!fork.thread?.id)
      throw new Error("The agent did not return a forked thread.");
    // As in branchFrom: a fork starts per-thread MCP servers without their
    // tools until it is loaded again (SP-1).
    if (hasThreadMcp(threadOptions)) {
      await this.rpc!.call("thread/unsubscribe", {
        threadId: fork.thread.id,
      });
      await this.rpc!.call("thread/resume", {
        threadId: fork.thread.id,
        ...reloadOptions(threadOptions),
      });
    }
    const now = Date.now();
    const kept = structuredClone(c.turns.slice(0, c.turns.indexOf(target) + 1));
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
      id: randomUUID(),
      threadId: fork.thread.id,
      turns: kept,
      pinned: false,
      archived: false,
      createdAt: now,
      updatedAt: now,
      forkedFrom: { conversationId: c.id, turnId: target.id, title: c.title },
      parentSessionId: c.id,
    };
    this.loaded.add(forked.threadId!);
    this.threadLimits.set(forked.threadId!, limitsKey(threadOptions));
    this.routes.set(forked.threadId!, forked.id);
    c.forks = [
      ...(c.forks ?? []),
      { conversationId: forked.id, turnId: target.id, createdAt: now },
    ];
    this.store.conversations.unshift(forked);
    this.changed(c, true);
    this.changed(forked, true);
    this.store.flush();
  } finally {
    this.pendingSend = false;
  }
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
