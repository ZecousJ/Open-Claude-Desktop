import {
  captureGeneratedFiles,
  captureOutputFiles,
  codeOutputTypes,
} from "../artifacts/generated-files";
import {
  finishTurn,
  itemIsRunning,
  recordItemLifecycle,
  recordMcpProgress,
  recordTurnUsage,
} from "../../shared/activity";
import path from "node:path";
import {
  safeguardFallbackModel,
  safeguardFlagged,
} from "../../shared/safeguard-fallback";
import { agentThreadIds, applyAgentUsage } from "../../shared/workflow-usage";
import { peerMessage } from "../../shared/agent-messages";
import {
  isContextLimitError,
  isLengthLimitError,
  isToolUseLimitError,
  reconnectAttempt,
  retryCause,
} from "../../shared/turn-errors";
import { preference } from "../../shared/settings-extras";
import type { Conversation, Item, Turn } from "../../shared/types";
import {
  threadTokenUsage,
  type SteeredMessageItem,
} from "../../shared/agent-api";
import { streamedItem, replaceOrAppend } from "./turn-items";
import { maxCommandOutputLength } from "./engine-support";
import type { Engine } from "./engine";

/** Applies a Codex app-server notification to the conversation that owns its thread. */
export function notification(this: Engine, msg: any) {
  // The first thing a timed send's turn produced ends its timing line.
  if (this.firstOutput.size && msg.params?.threadId) {
    const timing = this.firstOutput.get(msg.params.threadId);
    if (
      timing &&
      ((msg.method === "item/started" &&
        msg.params?.item?.type !== "userMessage") ||
        msg.method === "item/agentMessage/delta" ||
        msg.method === "turn/completed")
    ) {
      this.firstOutput.delete(msg.params.threadId);
      timing.done(
        msg.method === "turn/completed" ? "turn ended" : "first output",
      );
    }
  }
  const { method, params } = msg;
  if (method === "mcpServer/startupStatus/updated") {
    const error = this.safeMcpError(params?.error);
    this.mcpLogs.record(params?.name, params?.status, error);
    if (typeof params?.name === "string")
      this.mcpStartup.set(params.name, {
        status: params.status,
        error,
      });
    return;
  }
  if (method === "serverRequest/resolved") {
    const id = this.approvalId(params.requestId);
    this.ownApprovals = this.ownApprovals.filter((a) => a.id !== id);
    if (typeof id === "string") this.requestIds.delete(id);
    this.emit({ type: "approval-resolved", id });
    return;
  }
  // A side chat's ephemeral thread belongs to no conversation: its output
  // goes to the question waiting for it and nowhere else.
  const sideId = this.sides.chatOfThread(params?.threadId);
  if (sideId) {
    this.sides.notification(sideId, method, params);
    return;
  }
  // A workflow agent's thread reports to its run; its usage counts on the parent.
  const workflowListener = this.workflowThreads.get(params?.threadId);
  if (workflowListener) {
    if (method === "thread/tokenUsage/updated")
      this.applyChildUsage(
        params.threadId,
        params.tokenUsage?.total?.totalTokens,
      );
    try {
      workflowListener(method, params);
    } catch (error) {
      console.error(
        "A workflow agent listener failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }
  const id = this.routes.get(params?.threadId);
  if (!id) {
    // Child agent threads are not routed; only their token usage is tracked, on the parent.
    if (
      method === "thread/tokenUsage/updated" &&
      typeof params?.threadId === "string"
    )
      this.applyChildUsage(
        params.threadId,
        params.tokenUsage?.total?.totalTokens,
      );
    return;
  }
  // A conversation deleted while its agent was still talking: late
  // notifications for it are dropped (they used to throw here and take the
  // whole process down).
  const conversation = this.store.conversations.find((c) => c.id === id);
  if (!conversation) {
    this.routes.delete(params.threadId);
    return;
  }
  // Inactive native threads may still emit late usage/item notifications.
  if (conversation.threadId !== params.threadId) return;
  const turn =
    conversation.turns.find((t) => t.id === params.turnId) ??
    conversation.turns.at(-1);
  if (!turn) return;
  if (!this.applyTurnEvent(conversation, turn, method, params)) return;
  if (method === "turn/completed") {
    void this.capabilityTips.afterTurn(conversation, turn);
    void this.sessionAssistance.afterTurn(conversation, turn);
    if (
      turn.status === "failed" &&
      (safeguardFlagged(params.turn?.error) ||
        (this.lastRefusal &&
          this.lastRefusal.at >= turn.createdAt &&
          safeguardFlagged(this.lastRefusal)))
    )
      void this.retrySafeguard(conversation, turn);
    void this.titleOffers.afterTurn(conversation, turn);
    if (
      conversation.mode === "code" &&
      conversation.goal &&
      turn.status === "completed"
    ) {
      conversation.goal = {
        ...conversation.goal,
        iterations: conversation.goal.iterations + 1,
      };
    }
    this.signals.settleOrphanSearches(params.threadId, turn);
    this.signals.settleGeneratedImages(params.threadId, turn);
    this.signals.settleEarlyCalls(params.threadId, turn);
    this.extensions.turnCompleted(conversation, turn, () =>
      this.changed(conversation, true),
    );
  }
  conversation.updatedAt = Date.now();
  this.changed(conversation, method === "turn/completed");
}

export async function retrySafeguard(
  this: Engine,
  conversation: Conversation,
  turn: Turn,
) {
  // Code follows this host's persisted switch, including a web runner's
  // cloud sessions. Chat and Cowork follow Capabilities' separate switch.
  const allowed = () =>
    conversation.mode === "code"
      ? preference(this.store.settings, "switchModelsOnFlag") &&
        (this.codeSafeguardScope === "cloud" ||
          (this.environment.kind !== "space" &&
            conversation.environment?.kind !== "space"))
      : preference(this.store.settings, "modelAutoFallback");
  if (!allowed()) return;
  const provider = this.store.settings.providers.find(
    (item) => item.id === conversation.providerId,
  );
  if (!provider) return;
  const used = [
    ...(this.safeguardModels.get(conversation.id) ?? []),
    conversation.model,
  ];
  const model = safeguardFallbackModel(provider, used);
  if (!model) return;
  this.safeguardModels.set(conversation.id, used);
  while (this.pendingSend)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (
    this.safeguardModels.get(conversation.id) !== used ||
    conversation.turns.at(-1) !== turn ||
    turn.status !== "failed" ||
    conversation.archived ||
    !allowed()
  )
    return;
  try {
    await this.send(
      {
        conversationId: conversation.id,
        providerId: conversation.providerId,
        model,
        mode: conversation.mode,
        text: turn.prompt,
        attachments: turn.attachments,
        projectId: conversation.projectId,
        cwd: conversation.cwd,
      },
      turn.id,
      false,
      { safeguardRetry: true },
    );
    const retried = conversation.turns.at(-1);
    if (retried && retried !== turn) {
      retried.switchedTo = model;
      this.changed(conversation, true);
    }
  } catch {
    // A failed fallback remains paused in its transcript, like an ordinary failed send.
  }
}

export function applyChildUsage(
  this: Engine,
  agentId: string,
  totalTokens: number,
) {
  const parent = this.parentForAgent(agentId);
  if (parent && applyAgentUsage(parent, agentId, totalTokens))
    this.changed(parent);
}

/** Updates the turn for one notification; returns false when nothing changed. */
export function applyTurnEvent(
  this: Engine,
  conversation: Conversation,
  turn: Turn,
  method: string,
  params: any,
): boolean {
  // Any new output means a reconnect that was in progress has succeeded.
  if (method.startsWith("item/")) {
    delete turn.reconnecting;
    delete turn.reconnectCause;
  }
  switch (method) {
    case "turn/started":
      turn.id = params.turn.id;
      return true;
    case "turn/completed":
      turn.id = params.turn.id;
      if (typeof params.turn.postTurnSummary?.is_noteworthy === "boolean")
        turn.postTurnSummary = {
          is_noteworthy: params.turn.postTurnSummary.is_noteworthy,
        };
      finishTurn(turn, params.turn.status);
      const message = params.turn.error?.message;
      if (turn.research && params.turn.error?.code === "model_access") {
        turn.research.error = "model_access";
        turn.research.errorModel = params.turn.error.error_model;
      }
      const limit = [
        message,
        params.turn.error?.code,
        params.turn.stopReason,
        params.turn.stop_reason,
        params.turn.incomplete_details?.reason,
      ]
        .filter((value) => typeof value === "string")
        .join(" ");
      turn.error = this.refusalText(turn, message) ?? turn.error;
      if (
        params.turn.stopReason === "usage_limit" ||
        params.turn.stop_reason === "usage_limit"
      ) {
        turn.stopReason = "usage_limit";
        turn.usageHold ??= { resetsAt: null };
      }
      delete turn.reconnecting;
      delete turn.reconnectCause;
      if (isContextLimitError(limit)) {
        turn.status = "failed";
        turn.stopReason = "conversation_length_limit";
      } else if (isLengthLimitError(limit)) {
        turn.status = "failed";
        turn.stopReason = "length";
      } else if (isToolUseLimitError(limit)) {
        turn.status = "failed";
        turn.stopReason = "tool_use_limit";
      }
      this.clearApprovals(conversation.id);
      this.recordOutputFiles(conversation, turn);
      // Steered messages the model never read are not sent (E0).
      for (const [id, steer] of this.steers)
        if (steer.turnId === turn.id) this.steers.delete(id);
      return true;
    case "item/started":
    case "item/completed":
      return this.applyItemEvent(
        conversation,
        turn,
        params.threadId,
        params.item,
        method === "item/completed",
      );
    case "item/agentMessage/delta":
    case "item/plan/delta": {
      const item = streamedItem(turn, params.itemId, () => ({
        id: params.itemId,
        type: method === "item/plan/delta" ? "plan" : "agentMessage",
        text: "",
        lifecycleStatus: turn.status,
      }));
      item.text = (item.text ?? "") + params.delta;
      return true;
    }
    case "item/commandExecution/outputDelta": {
      const item = turn.items.find((value) => value.id === params.itemId);
      if (item)
        item.aggregatedOutput = (
          (item.aggregatedOutput ?? "") + params.delta
        ).slice(-maxCommandOutputLength);
      return true;
    }
    // A file the model is still writing (codex-model-catalog.ts): its row
    // shows from the first line and grows; item/started merges into it.
    case "item/fileChange/patchUpdated": {
      if (turn.status !== "inProgress" || !Array.isArray(params.changes))
        return false;
      const item = streamedItem(turn, params.itemId, () => ({
        id: params.itemId,
        type: "fileChange",
        status: "inProgress",
        changes: [],
        lifecycleStatus: "inProgress",
        startedAt: Date.now(),
      }));
      if (item.type !== "fileChange" || !itemIsRunning(item)) return false;
      item.changes = params.changes;
      return true;
    }
    case "item/reasoning/summaryTextDelta": {
      const item = streamedItem(turn, params.itemId, () => ({
        id: params.itemId,
        type: "reasoning",
        summary: [],
        lifecycleStatus: turn.status,
        startedAt: Date.now(),
      }));
      const index = params.summaryIndex ?? 0;
      item.summary ??= [];
      item.summary[index] = (item.summary[index] ?? "") + params.delta;
      return true;
    }
    case "item/mcpToolCall/progress":
      return (
        typeof params.itemId === "string" &&
        typeof params.message === "string" &&
        recordMcpProgress(turn, params.itemId, params.message)
      );
    case "turn/plan/updated":
      replaceOrAppend(turn, {
        id: `plan-${turn.id}`,
        type: "taskPlan",
        plan: params.plan,
      });
      return true;
    case "turn/diff/updated":
      replaceOrAppend(turn, {
        id: `diff-${turn.id}`,
        type: "diff",
        text: params.diff,
      });
      return true;
    case "thread/tokenUsage/updated": {
      conversation.usage = params.tokenUsage?.total;
      // E0: the full report (latest request, context window) for the window.
      const usage = threadTokenUsage(params.tokenUsage);
      if (usage) conversation.tokenUsage = usage;
      recordTurnUsage(turn, params.tokenUsage);
      return true;
    }
    case "error":
      // A retried stream drop shows as Reconnecting until output resumes.
      if (params.willRetry) {
        turn.reconnecting =
          reconnectAttempt(params.error?.message) ?? "retrying";
        const cause = retryCause(
          [
            params.error?.message,
            params.error?.codexErrorInfo
              ? JSON.stringify(params.error.codexErrorInfo)
              : undefined,
            params.error?.additionalDetails,
          ]
            .filter(Boolean)
            .join(" "),
        );
        if (cause) turn.reconnectCause = cause;
        else delete turn.reconnectCause;
      } else {
        delete turn.reconnecting;
        delete turn.reconnectCause;
        turn.error = this.refusalText(turn, params.error?.message);
        const reason = [params.error?.message, params.error?.code].join(" ");
        if (isContextLimitError(reason))
          turn.stopReason = "conversation_length_limit";
        else if (isToolUseLimitError(reason))
          turn.stopReason = "tool_use_limit";
        else if (isLengthLimitError(reason)) turn.stopReason = "length";
      }
      return true;
    default:
      return false;
  }
}

/** Records an item's start or completion; user messages are already the turn's prompt. */
export function applyItemEvent(
  this: Engine,
  conversation: Conversation,
  turn: Turn,
  threadId: string,
  item: Item,
  completed: boolean,
): boolean {
  const peer = peerMessage(item);
  if (peer) item = peer;
  if (item.type === "userMessage")
    return this.recordSteer(turn, item, completed);
  const previous = turn.items.find((value) => value.id === item.id);
  let incoming = { ...item };
  this.signals.reported(threadId, item.id);
  if (incoming.type === "subAgentActivity")
    this.attachPendingPrompt(threadId, incoming);
  // Gateway signals (descriptions, sources, citations) usually come first.
  this.pendingPatches.apply(threadId, incoming, completed);
  // Extensions trim what they keep elsewhere (computer-use screenshots).
  incoming = this.extensions.recordItem(conversation, incoming);
  // Snapshot written files once, when the change first completes.
  if (
    completed &&
    !this.launcher &&
    incoming.type === "fileChange" &&
    incoming.status === "completed" &&
    !previous?.generatedFiles
  )
    incoming.generatedFiles = captureGeneratedFiles(
      incoming,
      conversation.cwd ?? path.join(this.spaceRoot, "workspace"),
      conversation.incognito ? undefined : this.blobs,
    );
  recordItemLifecycle(turn, incoming, completed);
  for (const agentId of agentThreadIds(incoming))
    this.agentRoutes.set(agentId, conversation.id);
  return true;
}

/**
 * Chat and Cowork hand over what a turn saved, also files a command wrote
 * (a spreadsheet made by a script): they get cards with Download at the
 * end of the reply, like the original's output files. A Code turn hands
 * over only the documents it made (codeOutputTypes); its other files are
 * changes.
 */
export function recordOutputFiles(
  this: Engine,
  conversation: Conversation,
  turn: Turn,
) {
  if (this.launcher) return;
  if (turn.items.some((item) => item.type === "outputFiles")) return;
  const known = new Set(
    turn.items.flatMap((item) =>
      (item.generatedFiles ?? []).map((file) => path.resolve(file.path)),
    ),
  );
  const cwd = conversation.cwd ?? path.join(this.spaceRoot, "workspace");
  const files = captureOutputFiles(
    cwd,
    turn.createdAt - 1000,
    known,
    conversation.incognito ? undefined : this.blobs,
    `outputs-${turn.id}`,
    conversation.mode === "code" ? codeOutputTypes : undefined,
  );
  if (files.length)
    turn.items.push({
      id: `outputs-${turn.id}`,
      type: "outputFiles",
      status: "completed",
      generatedFiles: files,
    });
}

/**
 * A steered message reached the model (E0): it joins the turn at the point
 * where it was read. Other user messages are the turn's own prompt.
 */
export function recordSteer(
  this: Engine,
  turn: Turn,
  item: Item,
  completed: boolean,
) {
  const clientId = item.clientId;
  const steer =
    typeof clientId === "string" ? this.steers.get(clientId) : undefined;
  if (!steer) return false;
  const message: SteeredMessageItem = {
    id: item.id,
    type: "userMessage",
    steered: true,
    clientId,
    text: steer.text,
    attachments: steer.attachments,
  };
  recordItemLifecycle(turn, message, completed);
  if (completed) this.steers.delete(clientId);
  return true;
}
