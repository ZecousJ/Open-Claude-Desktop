import { holdCodeTurnApprovals } from "./code-interrupt-scope";
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
import type { OfficialCodeSteer } from "../../shared/official-code-followup";
import type { Engine } from "./engine";
import { beginCodeInterrupt, codeSendStartFor } from "./code-send-start";
import type { CodeSideSessionPlacement } from "../../shared/official-code-side-session";

/** Linked sessions and remembered choices (live claude.ai bundle, 2026-10-14, c1c1ec7b9-DdxFmCQ2.js). */
export async function resolveCodeNewTask(
  this: Engine,
  id: string,
  offerId: string,
  choice: "here" | "new_session",
  remember = false,
  current?: () => boolean,
  placement?: CodeSideSessionPlacement,
): Promise<Conversation> {
  const other = this.elsewhereFor(id);
  if (other) return other.resolveCodeNewTask(id, offerId, choice, remember, current, placement);
  const conversation = this.store.conversation(id);
  const offer = conversation.codeNewTask;
  if (!offer || offer.id !== offerId)
    throw new Error("This suggestion is no longer available.");
  if (offer.cloudTarget) throw Error("This suggestion is already starting in the cloud.");
  if (offer.nativeInput && !current) throw new Error("Open the original Code offer to respond.");
  this.assertIdle(id);
  if (current && !current()) throw new Error("Code session is no longer available.");
  delete conversation.codeNewTask;
  if (remember) {
    this.store.settings.ccNewTaskPrompt = choice;
    this.store.flush();
    this.emit({ type: "resync" });
  }
  this.changed(conversation, true);
  if (offer.nativeInput) this.store.flush();
  try {
    const result = await this.send(
      {
        ...offer,
        ...(choice === "new_session" ? placement : undefined),
        ...(offer.nativeInput ? { officialCodeEventId: offer.nativeInput.uuid } : {}),
        conversationId: choice === "here" ? id : undefined,
        parentSessionId: choice === "new_session" ? id : undefined,
        mode: "code",
        cwd: conversation.cwd,
        projectId: conversation.projectId,
        environment: conversation.environment,
        additionalFolders:
          choice === "new_session"
            ? conversation.additionalFolders?.filter(
                folder => !conversation.codeSessionFolderGrants?.includes(folder),
              )
            : undefined,
        cloudEnvironmentId: conversation.cloudEnvironmentId,
      },
      undefined,
      false,
      { newTaskResolved: true, current },
    );
    if (offer.nativeInput && choice === "new_session") {
      const child = this.store.conversation(result.id);
      child.nativeSideSession = { taskId: offer.id };
      this.changed(child, true);
      this.store.flush();
      return structuredClone(child);
    }
    return result;
  } catch (error) {
    if (!offer.nativeInput) {
      conversation.codeNewTask = offer;
      this.changed(conversation, true);
    }
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
      ...(c.knowledgeBases?.length ? { knowledgeBases: c.knowledgeBases } : {}),
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
 * Continue in cloud's "Writing the handoff note" (live claude.ai bundle,
 * 2026-10-12): the same note a hand-off writes, returned instead of sent,
 * so the window can start the cloud session with it as its first message
 * (`handOffPrompt`). This session is not touched.
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
 * Side chat (desktop bundle 2.31226.1: "Start a side chat"): a question
 * about a conversation asked beside it. It runs on an ephemeral fork of
 * the conversation's thread, made at its last finished turn the first
 * time, so the model sees the whole conversation so far and the
 * conversation itself is not touched: no turn, item or thread of it
 * changes, even while it is running. The side chat's later questions go
 * to the same fork. Resolves with the answer. While it is written, the
 * answer so far goes to the window as "side-chat-text" events (the desktop
 * bundle's side chat shows the reply as it arrives); Stop
 * (`interruptSideChat`) ends it early with what was written.
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
  officialCode?: OfficialCodeSteer & { current: () => boolean },
  officialCowork?: { eventId?: string; current: () => boolean },
): Promise<SteerResult | null> {
  const other = this.elsewhereFor(id);
  if (other) return other.steerTurn(id, text, attachments, officialCode, officialCowork);
  const c = this.store.conversation(id);
  if (c.projectOrganizationId)
    throw Error("Send a new message from the shared project after this response ends.");
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
  const threadId = c.threadId;
  const input = await turnInput(text, attachments, {
    inlineImages: !!this.launcher,
  });
  if (officialCode && !officialCode.current()) return null;
  if (officialCowork && !officialCowork.current())
    throw Error("The Cowork session changed before sending.");
  if (officialCowork && (c.threadId !== threadId || c.turns.at(-1) !== turn ||
      turn.status !== "inProgress"))
    return null;
  // Registered first: Codex can hand the message over before it answers.
  this.steers.set(messageId, {
    turnId: turn.id,
    text,
    attachments,
    officialCode: officialCode && { eventId: officialCode.eventId, inputHash: officialCode.inputHash },
    officialCoworkEventId: officialCowork?.eventId,
  });
  try {
    await this.forward("turn/steer", {
      threadId: c.threadId,
      expectedTurnId: turn.id,
      clientUserMessageId: messageId,
      input,
    });
  } catch (error) {
    if (steerMissedTurn.test((error as Error).message)) {
      this.steers.delete(messageId);
      return null;
    }
    if (!officialCode) this.steers.delete(messageId);
    throw error;
  }
  return { messageId, conversation: structuredClone(c) };
}

export async function interrupt(
  this: Engine,
  id: string,
  exact?: {
    conversation: Conversation;
    turn: Turn;
    threadId: string;
    current: () => boolean;
  },
): Promise<void> {
  const other = exact ? undefined : this.elsewhereFor(id);
  if (other) return other.interrupt(id);
  const store = this.store;
  const c = store.conversation(id);
  const t = c.turns.at(-1);
  if (exact) {
    if (
      !exact.current() ||
      c !== exact.conversation ||
      t !== exact.turn ||
      c.threadId !== exact.threadId
    )
      throw Error("The Code turn changed before it could be stopped.");
  } else {
    const start = codeSendStartFor(c, t)?.start;
    if (
      start &&
      t?.status === "inProgress" &&
      (t.id.startsWith("pending-") || start.stopping)
    ) {
      if ((await start.stop()).status === "mismatch")
        throw Error("The Code turn changed before it could be stopped.");
      return;
    }
    // Stop while a cloud session fetches its repository: the fetch ends.
    if (this.setupAbort?.conversationId === id) {
      this.setupAbort.abort.abort();
      return;
    }
    // Stop on a message waiting for its SSH host: it is never sent.
    if (t?.status === "inProgress" && isOutboxTurn(t)) {
      this.options.outbox?.remove(t.id);
      t.userStopped = true;
      finishTurn(t, "interrupted");
      delete t.reconnecting;
      this.changed(c, true);
      this.store.flush();
      return;
    }
  }
  if (t?.status === "inProgress" && c.threadId) {
    const threadId = c.threadId;
    const rpc = this.rpc;
    const turnId = t.id;
    // Keep the actual source objects, not just reused IDs. A delayed stop must
    // never reconcile/clean up a replacement conversation or another account.
    const current = () => {
      try {
        return (!exact || exact.current()) && this.store === store && store.conversation(id) === c && this.rpc === rpc &&
          c.threadId === threadId && c.turns.at(-1) === t && t.id === turnId;
      } catch { return false; } // Deleted session / signed-out store.
    };
    const releaseApprovals = c.mode === "code" ? holdCodeTurnApprovals(t) : undefined;
    let accepted = false;
    let endInterrupt: (() => void) | undefined;
    try {
      if (!rpc)
        throw new Error("The Codex engine is not connected.");
      if (c.mode === "code" || c.mode === "cowork") endInterrupt = beginCodeInterrupt(t, current);
      await rpc.call("turn/interrupt", { threadId, turnId });
      accepted = true;
      if (current() && !t.userStopped && (t.status === "inProgress" || (t.status as Turn["status"]) === "interrupted")) {
        t.userStopped = true;
        if ((t.status as Turn["status"]) === "interrupted") {
          this.changed(c, true);
          this.store.flush();
        }
      }
    } catch (error) {
      if (process.env.CLAUDEX_STOP_DIAGNOSTICS === "1")
        console.warn(
          "[Claudex stop error]",
          JSON.stringify({
            turnId: t.id,
            status: t.status,
            message: (error as Error).message,
          }),
        );
      // A reply may finish between the click and Codex handling the stop.
      // Only accept that race when a terminal notification or an explicit
      // history read proves this exact turn finished; other errors still fail.
      if (!/^no active turn to interrupt$/i.test((error as Error).message))
        throw error;
      if (!current()) throw error;
      if (t.status !== "inProgress") {
        accepted = true;
        return;
      }
      const result = await rpc?.call("thread/read", {
        threadId,
        includeTurns: true,
      });
      const finished =
        result?.thread?.id === threadId &&
        result.thread.turns?.find((turn: any) => turn.id === t.id);
      if (process.env.CLAUDEX_STOP_DIAGNOSTICS === "1")
        console.warn(
          "[Claudex stop reconciliation]",
          JSON.stringify({
            turnId: t.id,
            localStatus: t.status,
            threadMatches: result?.thread?.id === threadId,
            sameEngine: this.rpc === rpc,
            sameLatestTurn: c.turns.at(-1) === t,
            nativeTurns: result?.thread?.turns?.map((turn: any) => ({
              id: turn.id,
              status: turn.status,
            })),
          }),
        );
      if (
        !current() ||
        !finished ||
        !["completed", "failed", "interrupted"].includes(finished.status)
      )
        throw error;
      accepted = true;
      if (t.status === "inProgress") {
        for (const item of finished.items ?? []) {
          if (item.type !== "userMessage")
            this.notification({
              method: "item/completed",
              params: { threadId, turnId: t.id, item },
            });
        }
        this.notification({
          method: "turn/completed",
          params: { threadId, turn: finished },
        });
        this.store.flush();
      }
    } finally {
      endInterrupt?.();
      try {
        if (accepted && rpc && current())
          await stopTurnBackgroundTerminals(rpc, threadId, t, current);
      } finally {
        // A failed RPC must not leave this turn's upstream stream hanging.
        // Never abort a newer turn or a replacement engine's request.
        releaseApprovals?.();
        if (current()) this.gateway?.abortThread(threadId);
      }
    }
  }
}

/** Stop only background terminals whose item IDs belong to the interrupted turn. */
async function stopTurnBackgroundTerminals(
  rpc: NonNullable<Engine["rpc"]>,
  threadId: string,
  turn: Turn,
  current: () => boolean,
) {
  const itemIds = new Set(
    turn.items
      .filter(
        (item) =>
          item.type === "commandExecution" &&
          typeof item.id === "string" &&
          !!item.id,
      )
      .map((item) => item.id),
  );
  if (!itemIds.size) return;
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  const terminated = new Set<string>();
  let pages = 0;
  do {
    // A malformed or continuously growing listing must fail rather than leave
    // Stop pending forever. Report incomplete cleanup to the caller.
    if (++pages > 100)
      throw new Error("Background terminal cleanup exceeded its page limit.");
    if (!current()) return;
    const page = await rpc.call("thread/backgroundTerminals/list", {
      threadId,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    });
    if (!current()) return;
    const matches = Array.isArray(page?.data)
      ? page.data.filter(
          (terminal: any) =>
            typeof terminal?.processId === "string" &&
            !!terminal.processId &&
            itemIds.has(terminal.itemId),
        )
      : [];
    await Promise.all(
      matches.map((terminal: any) => {
        if (!current() || terminated.has(terminal.processId)) return;
        terminated.add(terminal.processId);
        return rpc.call("thread/backgroundTerminals/terminate", {
          threadId,
          processId: terminal.processId,
        });
      }),
    );
    if (!current()) return;
    cursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
    if (cursor) {
      if (seenCursors.has(cursor))
        throw new Error("Background terminal cleanup returned a repeated cursor.");
      seenCursors.add(cursor);
    }
  } while (cursor);
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
