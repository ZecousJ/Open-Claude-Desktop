import { finishTurn } from "../../shared/activity";
import { randomUUID } from "node:crypto";
import { effortForMode } from "../../shared/code-effort";
import {
  handOffInstructions,
  handOffPrompt,
  handOffRequest,
  transcriptDigest,
} from "../../shared/hand-off";
import {
  attachmentRefusal,
  connectorAllowed,
  updateRefusal,
} from "../../shared/client-policy-rules";
import type { Attachment, Conversation, Turn } from "../../shared/types";
import type { SteerResult } from "../../shared/composer-api";
import { isOutboxTurn } from "../ssh/outbox";
import { WorkflowAgentRequest, WorkflowThreadListener } from "./engine-types";
import { sideChatInstructions, sideContextFull } from "./side-chat-model";
import { steerMissedTurn, turnInput } from "./engine-support";
import type { Engine } from "./engine";

/** Linked sessions and remembered choices. */
export async function resolveCodeNewTask(
  this: Engine,
  id: string,
  offerId: string,
  choice: "here" | "new_session",
  remember = false,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.resolveCodeNewTask(id, offerId, choice, remember);
  const conversation = this.store.conversation(id);
  const offer = conversation.codeNewTask;
  if (!offer || offer.id !== offerId)
    throw new Error("This suggestion is no longer available.");
  this.assertIdle(id);
  delete conversation.codeNewTask;
  if (remember) {
    this.store.settings.ccNewTaskPrompt = choice;
    this.store.flush();
    this.emit({ type: "resync" });
  }
  this.changed(conversation, true);
  try {
    return await this.send(
      {
        ...offer,
        conversationId: choice === "here" ? id : undefined,
        parentSessionId: choice === "new_session" ? id : undefined,
        mode: "code",
        cwd: conversation.cwd,
        projectId: conversation.projectId,
        environment: conversation.environment,
        additionalFolders:
          choice === "new_session" ? conversation.additionalFolders : undefined,
        cloudEnvironmentId: conversation.cloudEnvironmentId,
      },
      undefined,
      false,
      { newTaskResolved: true },
    );
  } catch (error) {
    conversation.codeNewTask = offer;
    this.changed(conversation, true);
    throw error;
  }
}

/**
 * Hand off to a new session (shared/hand-off.ts): the note is written on
 * an ephemeral read-only fork of the thread at its last finished turn, the
 * way a side chat is answered, so this conversation is not touched. A
 * session too long to answer from (the fork fails on the context window)
 * hands off an excerpt of its latest messages instead. The new session is
 * a fresh thread in the same folder, project, model and place whose first
 * message is the note; it links back, and this one records it under the
 * turn it was handed off after.
 */
export async function handOffConversation(
  this: Engine,
  id: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.handOffConversation(id);
  const { c, target, note, written } = await this.handOffNote(id);
  const startedAt = Date.now();
  const record = (created: Conversation) => {
    c.handOffs = [
      ...(c.handOffs ?? []),
      {
        conversationId: created.id,
        turnId: target.id,
        createdAt: created.createdAt,
      },
    ];
    this.changed(c, true);
    this.store.flush();
  };
  try {
    const created = await this.send({
      text: handOffPrompt({ title: c.title, note, written }),
      attachments: [],
      mode: c.mode,
      cwd: c.cwd,
      projectId: c.projectId,
      providerId: c.providerId,
      model: c.model,
      ...(c.environment ? { environment: c.environment } : {}),
      handedOffFrom: {
        conversationId: c.id,
        turnId: target.id,
        title: c.title,
      },
    });
    record(created);
    return created;
  } catch (error) {
    // A session that was created but could not start is still linked.
    const created = this.store.conversations.find(
      (x) => x.handedOffFrom?.conversationId === id && x.createdAt >= startedAt,
    );
    if (created) record(created);
    throw error;
  }
}

/**
 * Continue in cloud's "Writing the handoff note": the same note a hand-off
 * writes, returned instead of sent, so the window can start the cloud session
 * with it as its first message (`handOffPrompt`). This session is not touched.
 */
export async function writeHandOffNote(
  this: Engine,
  id: string,
): Promise<{ title: string; note: string; written: boolean }> {
  const other = this.elsewhereFor(id);
  if (other) return other.writeHandOffNote(id);
  const { c, note, written } = await this.handOffNote(id);
  return { title: c.title, note, written };
}

/**
 * The handoff note of a Code session at its last finished turn, written
 * on an ephemeral fork (a digest of the latest messages when the session
 * is too long to answer from). Refused while a reply runs or the session
 * changed meanwhile.
 */
export async function handOffNote(this: Engine, id: string) {
  if (this.pendingSend)
    throw new Error("A task is being created. Try again in a moment.");
  const c = this.store.conversation(id);
  if (c.mode !== "code")
    throw new Error("Only Code sessions can be handed off.");
  if (c.incognito) throw new Error("An incognito chat can't be handed off.");
  this.assertIdle(id);
  const settled = (t: Turn) =>
    t.status !== "inProgress" &&
    !t.id.startsWith("pending-") &&
    !isOutboxTurn(t);
  const target = [...c.turns].reverse().find(settled);
  if (!c.threadId || !target)
    throw new Error("There is nothing to hand off yet.");
  if (c.turns.at(-1) !== target)
    throw new Error("Wait for this reply to finish before handing off.");
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  this.assertModel(provider, c.model);
  if (this.policy().update?.state === "required")
    throw new Error(updateRefusal(this.policy().update!));
  let note: string;
  let written = true;
  const noteId = `hand-off-${randomUUID()}`;
  try {
    note = await this.sides.ask(
      id,
      noteId,
      handOffRequest,
      handOffInstructions,
    );
  } catch (error) {
    const message = (error as Error).message;
    if (message !== sideContextFull) {
      // The side chat's own words do not fit here.
      throw /^(The side chat|Couldn’t get an answer|The answer reached)/.test(
        message,
      )
        ? new Error("Couldn’t write the handoff note. Try again.")
        : error;
    }
    note = transcriptDigest(c.turns);
    written = false;
  } finally {
    this.sides.close(noteId, new Error("The side chat was closed."));
  }
  if (!note.trim()) throw new Error("There is nothing to hand off yet.");
  // The person may have written to this session while the note was made.
  if (this.pendingSend || c.turns.at(-1) !== target)
    throw new Error("This session changed while the note was written.");
  this.assertIdle(id);
  return { c, target, note, written };
}

/**
 * Side chat: a question about a conversation asked beside it. It runs on an
 * ephemeral fork of the conversation's thread, made at its last finished turn
 * the first time, so the model sees the whole conversation so far and the
 * conversation itself is not touched: no turn, item or thread of it changes,
 * even while it is running. The side chat's later questions go to the same
 * fork. Resolves with the answer. While it is written, the answer so far goes
 * to the window as "side-chat-text" events; Stop (`interruptSideChat`) ends it
 * early with what was written.
 */
/**
 * Starts one agent of a workflow (electron/workflows): a fresh Codex thread
 * with the conversation's provider, folder, sandbox and instructions. It
 * asks for no approvals (nobody is there to answer mid-run; what the
 * sandbox does not allow fails) and gets no app tools. `listener` receives
 * every notification of the thread until it is released.
 */
export async function startWorkflowAgent(
  this: Engine,
  conversationId: string,
  request: WorkflowAgentRequest,
  listener: WorkflowThreadListener,
): Promise<{ threadId: string; turnId?: string; model: string }> {
  const other = this.elsewhereFor(conversationId);
  if (other) return other.startWorkflowAgent(conversationId, request, listener);
  const c = this.store.conversation(conversationId);
  const provider = this.store.settings.providers.find(
    (p) => p.id === c.providerId,
  );
  if (!provider) throw new Error("The model service is unavailable.");
  // A model the session cannot use (an alias such as "sonnet") falls back to its own.
  const model =
    request.model &&
    [provider.model, ...provider.models].includes(request.model)
      ? request.model
      : c.model;
  this.assertModel(provider, model);
  if (this.policy().update?.state === "required")
    throw new Error(updateRefusal(this.policy().update!));
  await this.ensure(provider);
  const project = this.store.projects.find((p) => p.id === c.projectId);
  const { dynamicTools: _tools, ...options } = this.threadOptions(
    c,
    provider,
    model,
    c.mode,
    project,
  );
  const started = await this.rpc!.call("thread/start", {
    ...options,
    ...(request.cwd ? { cwd: request.cwd } : {}),
    approvalPolicy: "never",
    developerInstructions: [options.developerInstructions, request.instructions]
      .filter(Boolean)
      .join("\n\n"),
  });
  const threadId: unknown = started?.thread?.id;
  if (typeof threadId !== "string" || !threadId)
    throw new Error(
      "The agent did not return a thread for the workflow agent.",
    );
  this.workflowThreads.set(threadId, listener);
  try {
    const turn = await this.rpc!.call("turn/start", {
      threadId,
      input: [{ type: "text", text: request.prompt, text_elements: [] }],
      model,
      // Agents of an Ultracode turn think at the highest regular effort.
      effort:
        request.effort ??
        ((effort) => (effort === "ultra" ? "xhigh" : effort))(
          c.effort ??
            project?.defaultEffort ??
            effortForMode(this.store.settings, c.mode),
        ),
      ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
    });
    return { threadId, turnId: turn?.turn?.id, model };
  } catch (error) {
    this.releaseWorkflowAgent(threadId);
    throw error;
  }
}

/** Interrupts a workflow agent's running turn and cuts its request. */
export async function interruptWorkflowAgent(
  this: Engine,
  threadId: string,
  turnId?: string,
) {
  if (!this.workflowThreads.has(threadId)) {
    for (const peer of this.peers?.all() ?? [])
      if (peer !== this) await peer.interruptWorkflowAgent(threadId, turnId);
    return;
  }
  if (turnId)
    await this.rpc
      ?.call("turn/interrupt", { threadId, turnId })
      .catch(() => {});
  this.gateway?.abortThread(threadId);
}

/** Stops listening to a finished workflow agent; its rollout stays for its transcript. */
export function releaseWorkflowAgent(this: Engine, threadId: string) {
  if (!this.workflowThreads.delete(threadId)) {
    for (const peer of this.peers?.all() ?? [])
      if (peer !== this) peer.releaseWorkflowAgent(threadId);
    return;
  }
  void this.rpc?.call("thread/unsubscribe", { threadId }).catch(() => {});
}

export async function askSideChat(
  this: Engine,
  id: string,
  sideChatId: string,
  question: string,
): Promise<string> {
  const other = this.elsewhereFor(id);
  if (other) return other.askSideChat(id, sideChatId, question);
  return this.sides.ask(id, sideChatId, question, sideChatInstructions, true);
}

/** Stop on a side chat's question (the answer so far is kept). */
export async function interruptSideChat(
  this: Engine,
  id: string,
  sideChatId: string,
): Promise<void> {
  const other = this.elsewhereFor(id);
  if (other) return other.interruptSideChat(id, sideChatId);
  return this.sides.interrupt(id, sideChatId);
}

/** Lets a side chat go (Clear, or the conversation was left). */
export async function endSideChat(
  this: Engine,
  id: string,
  sideChatId: string,
): Promise<void> {
  const other = this.elsewhereFor(id);
  if (other) return other.endSideChat(id, sideChatId);
  this.sides.end(id, sideChatId);
}

/**
 * Adds a message to the running turn (`turn/steer`). null when no turn can
 * take it: the renderer sends it as a new message instead. It is recorded
 * in the turn when Codex hands it to the model (recordSteer).
 */
export async function steerTurn(
  this: Engine,
  id: string,
  text: string,
  attachments: Attachment[],
): Promise<SteerResult | null> {
  const other = this.elsewhereFor(id);
  if (other) return other.steerTurn(id, text, attachments);
  const c = this.store.conversation(id);
  if (!text.trim() && !attachments.length) throw new Error("Enter a message.");
  const policy = this.policy();
  if (policy.update?.state === "required")
    throw new Error(updateRefusal(policy.update));
  for (const file of attachments) {
    if (file.github && connectorAllowed(policy, "github")) continue;
    const refusal = attachmentRefusal(file.name, file.size, policy);
    if (refusal) throw new Error(refusal);
  }
  const turn = c.turns.at(-1);
  if (
    !this.rpc ||
    !c.threadId ||
    !this.loaded.has(c.threadId) ||
    turn?.status !== "inProgress" ||
    turn.id.startsWith("pending-") ||
    turn.compaction ||
    turn.shell ||
    turn.review
  )
    return null;
  const messageId = "steer-" + randomUUID();
  const input = await turnInput(text, attachments, {
    inlineImages: !!this.launcher,
  });
  // Registered first: Codex can hand the message over before it answers.
  this.steers.set(messageId, { turnId: turn.id, text, attachments });
  try {
    await this.forward("turn/steer", {
      threadId: c.threadId,
      expectedTurnId: turn.id,
      clientUserMessageId: messageId,
      input,
    });
  } catch (error) {
    this.steers.delete(messageId);
    if (steerMissedTurn.test((error as Error).message)) return null;
    throw error;
  }
  return { messageId, conversation: structuredClone(c) };
}

export async function interrupt(this: Engine, id: string): Promise<void> {
  const other = this.elsewhereFor(id);
  if (other) return other.interrupt(id);
  const c = this.store.conversation(id);
  const t = c.turns.at(-1);
  // Stop while a cloud session fetches its repository: the fetch ends.
  if (this.setupAbort?.conversationId === id) {
    this.setupAbort.abort.abort();
    return;
  }
  // Stop on a message waiting for its SSH host: it is never sent.
  if (t?.status === "inProgress" && isOutboxTurn(t)) {
    this.options.outbox?.remove(t.id);
    finishTurn(t, "interrupted");
    delete t.reconnecting;
    this.changed(c, true);
    this.store.flush();
    return;
  }
  if (t?.status === "inProgress" && c.threadId) {
    await this.rpc?.call("turn/interrupt", {
      threadId: c.threadId,
      turnId: t.id,
    });
    this.gateway?.abortThread(c.threadId);
  }
}

export async function releaseRunner(
  this: Engine,
  id: string,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.releaseRunner(id);
  const c = this.store.conversation(id);
  if (c.mode !== "code") throw new Error("Only Code sessions have a runner.");
  await this.interrupt(id);
  c.runnerReleasedAt = Date.now();
  this.changed(c, true);
  this.store.flush();
  await this.options.releaseEnvironment?.();
  return structuredClone(c);
}
