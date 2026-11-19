import "../../shared/code-rewind";
import { codeAgentOwner, recordCodeAgentEvent } from "./code-agent-threads";
import {
  captureGeneratedFiles,
  captureOutputFiles,
  codeOutputTypes,
} from "../artifacts/generated-files";
import {
  clearTurnRetry,
  finishTurn,
  itemIsRunning,
  recordItemLifecycle,
  recordMcpProgress,
  recordTurnUsage,
} from "../../shared/activity";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  safeguardFallbackModel,
  safeguardFlagged,
} from "../../shared/safeguard-fallback";
import { agentItems, agentThreadIds, applyAgentUsage, ownsWorkflowAgent } from "../../shared/workflow-usage";
import { peerMessage } from "../../shared/agent-messages";
import { recordCodeHelperReport } from "./code-helper-reports";
import { nativeCoworkSearchIntents } from "./official-cowork-send";
import {
  isContextLimitError,
  isLengthLimitError,
  isToolUseLimitError,
  reconnectAttempt,
  retryCause,
} from "../../shared/turn-errors";
import { preference } from "../../shared/settings-extras";
import { hasLocalBrowserExecution } from "../../shared/browser-execution-eligibility";
import type { Conversation, Item, Turn } from "../../shared/types";
import {
  threadTokenUsage,
  type SteeredMessageItem,
} from "../../shared/agent-api";
import { streamedItem, replaceOrAppend } from "./turn-items";
import { maxCommandOutputLength } from "./engine-support";
import type { Engine } from "./engine";
import { recordConnectorAuthRejection, rejectedConnectorTool } from "../connectors/connector-auth-rejection";
import { codeInterruptInFlight, codeSendStartFor } from "./code-send-start";

const retryPartial = new WeakMap<Turn, Item[]>();

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
    const parent = typeof params?.threadId === "string" ? this.parentForAgent(params.threadId) : undefined;
    const owner = parent && codeAgentOwner(parent, params.threadId);
    if (parent && owner && recordCodeAgentEvent(owner, params.threadId, method, params))
      this.changed(parent);
    if (
      method === "thread/tokenUsage/updated" &&
      typeof params?.threadId === "string"
    )
      this.applyChildUsage(
        params.threadId,
        params.tokenUsage?.total?.totalTokens,
      );
    if (method === "turn/completed" && typeof params?.threadId === "string") {
      const parent = this.parentForAgent(params.threadId);
      const status = params.turn?.status === "completed" ? "completed" :
        params.turn?.status === "interrupted" ? "interrupted" :
        params.turn?.status === "failed" ? "errored" : undefined;
      if (parent && status) {
        for (const turn of parent.turns)
          for (const item of turn.items)
            if (ownsWorkflowAgent(item, params.threadId))
              item.agentsStates = {
                ...item.agentsStates,
                [params.threadId]: { status, message: item.agentsStates?.[params.threadId]?.message ?? null },
              };
        this.changed(parent, true);
      }
    }
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
  // Retry errors, summaries and MCP tools must identify their exact turn.
  const turn =
    method === "thread/tokenUsage/updated" ||
    (method === "error" && params.willRetry === true) ||
    method === "item/reasoning/summaryTextDelta" ||
    method === "item/mcpToolCall/progress" ||
    ((method === "item/started" || method === "item/completed") &&
      ["mcpToolCall", "dynamicToolCall"].includes(params?.item?.type))
      ? typeof params.turnId === "string" && params.turnId.trim()
        ? conversation.turns.find((t) => t.id === params.turnId)
        : undefined
      : (conversation.turns.find((t) => t.id === params.turnId) ??
        conversation.turns.at(-1));
  if (!turn) return;
  const wasRunning = turn.status === "inProgress";
  const completedExactTurn = method === "turn/completed" && params.turn?.id === turn.id;
  const wasRetrying = turn.streamRetry;
  if (!this.applyTurnEvent(conversation, turn, method, params)) return;
  if (method === "turn/completed") {
    void this.capabilityTips.afterTurn(conversation, turn);
    void this.sessionAssistance.afterTurn(conversation, turn);
    const flagged = this.lastRefusal;
    if (wasRunning && turn === conversation.turns.at(-1) && turn.status === "failed" &&
        (safeguardFlagged(params.turn?.error) ||
          (flagged?.threadId && flagged.threadId === conversation.threadId &&
            flagged.at >= turn.createdAt && safeguardFlagged(flagged)))) {
      turn.refusedPrompt ??= { model: conversation.model };
      if (flagged && safeguardFlagged(flagged) && flagged.threadId === conversation.threadId)
        this.lastRefusal = undefined;
      void this.retrySafeguard(conversation, turn);
    }
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
    this.signals.settleGeneratedImages(turn);
    this.signals.settleEarlyCalls(params.threadId, turn);
    this.extensions.turnCompleted(conversation, turn, () =>
      this.changed(conversation, true),
    );
  }
  conversation.updatedAt = Date.now();
  const settledCodeTurnId = method === "turn/completed" &&
    conversation.mode === "code" && wasRunning && turn.status !== "inProgress"
    ? turn.id
    : undefined;
  this.changed(
    conversation,
    method === "turn/completed" ||
      (conversation.mode === "code" && wasRetrying !== turn.streamRetry),
    settledCodeTurnId,
  );
  if (wasRunning && completedExactTurn && this.owns(conversation)) {
    const parent = recordCodeHelperReport(this.store.conversations, conversation, turn);
    if (parent) {
      const destination = this.owns(parent) ? this : this.elsewhereFor(parent.id);
      destination?.changed(parent, true);
      this.store.flush();
    }
  }
  // Publish generated Chat outputs through a full write even when a quick
  // follow-up completed between the runner's streaming saves.
  if (
    method === "turn/completed" &&
    conversation.mode === "chat" &&
    !conversation.incognito &&
    (turn.research?.report || turn.researchReportRevision || turn.items.some((item) =>
      item.type === "imageGeneration" || item.generatedFiles?.length))
  )
    this.store.flush();
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
    const nativeSearch = nativeCoworkSearchIntents.get(turn);
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
        ...(nativeSearch === false ? { webSearch: false } : {}),
      },
      turn.id,
      false,
      { safeguardRetry: true, ...(nativeSearch !== undefined ? { nativeCowork: true } : {}) },
    );
    const retried = conversation.turns.at(-1);
    if (retried && retried !== turn) {
      retried.switchedTo = model;
      if (turn.refusedPrompt) retried.refusedPrompt = { ...turn.refusedPrompt };
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
  // Reject malformed and late summary fragments before changing any turn state.
  if (method === "item/reasoning/summaryTextDelta") {
    const index = params?.summaryIndex;
    if (
      turn.status !== "inProgress" ||
      typeof params?.turnId !== "string" ||
      !params.turnId.trim() ||
      params.turnId !== turn.id ||
      typeof params.itemId !== "string" ||
      !params.itemId.trim() ||
      typeof params.delta !== "string" ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      // Bound sparse/out-of-order indices to avoid unbounded allocation.
      index >= 1024
    )
      return false;
    let item = turn.items.find((value) => value.id === params.itemId);
    if (item && (item.type !== "reasoning" || !itemIsRunning(item)))
      return false;
    if (!item) {
      item = {
        id: params.itemId,
        type: "reasoning",
        summary: [],
        lifecycleStatus: "inProgress",
        startedAt: Date.now(),
      };
      turn.items.push(item);
    }
    if (!Array.isArray(item.summary)) item.summary = [];
    // Keep the array dense, even when a later section arrives first.
    while (item.summary.length <= index) item.summary.push("");
    // Old out-of-order streams persisted sparse holes as null. Never stringify
    // malformed or absent sections into the visible public summary.
    item.summary[index] =
      (typeof item.summary[index] === "string" ? item.summary[index] : "") +
      params.delta;
    clearTurnRetry(turn);
    return true;
  }
  if (method === "item/mcpToolCall/progress") {
    if (
      typeof params?.turnId !== "string" ||
      params.turnId !== turn.id ||
      !recordMcpProgress(turn, params.itemId, params.message)
    )
      return false;
    clearTurnRetry(turn);
    return true;
  }
  // Invalid or stale tool snapshots cannot reset reconnect state either.
  if (
    (method === "item/started" || method === "item/completed") &&
    ["mcpToolCall", "dynamicToolCall"].includes(params?.item?.type)
  ) {
    const item = params.item;
    const previous = turn.items.find((value) => value.id === item.id);
    if (
      typeof params.turnId !== "string" ||
      params.turnId !== turn.id ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      (previous && previous.type !== item.type) ||
      (method === "item/started" &&
        (turn.status !== "inProgress" ||
          (previous && !itemIsRunning(previous))))
    )
      return false;
  }
  switch (method) {
    case "turn/started":
      if (turn.compactionUncertain) {
        delete turn.compactionUncertain;
        delete turn.error;
      }
      turn.id = params.turn.id;
      codeSendStartFor(conversation, turn)?.start.promoted(turn.id);
      return true;
    case "turn/completed":
      if (params.turn.status === "interrupted" && turn.id === params.turn.id) {
        const partial = retryPartial.get(turn);
        if (partial && !turn.items.some((item) => item.type === "agentMessage" && itemIsRunning(item) && item.text))
          turn.items.push(...partial);
      }
      if (turn.id === params.turn.id) retryPartial.delete(turn);
      if (turn.compactionUncertain) {
        delete turn.compactionUncertain;
        delete turn.error;
      }
      if (
        params.turn.status === "interrupted" &&
        turn.id === params.turn.id &&
        codeInterruptInFlight(turn)
      )
        turn.userStopped = true;
      const completedTurnMatches = turn.id === params.turn.id;
      turn.id = params.turn.id;
      if (typeof params.turn.postTurnSummary?.is_noteworthy === "boolean")
        turn.postTurnSummary = {
          is_noteworthy: params.turn.postTurnSummary.is_noteworthy,
        };
      if (completedTurnMatches && params.turn.status === "failed" && safeguardFlagged(params.turn.error))
        turn.refusedPrompt = { model: conversation.model };
      finishTurn(turn, params.turn.status);
      if (turn.status === "completed" && turn.usageHold?.window === "five_hour") {
        delete turn.usageHold;
        delete turn.stopReason;
      }
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
      turn.error = this.refusalText(turn, message, conversation.threadId) ?? turn.error;
      if (
        params.turn.stopReason === "usage_limit" ||
        params.turn.stop_reason === "usage_limit"
      ) {
        turn.stopReason = "usage_limit";
        turn.usageHold ??= { resetsAt: null };
      }
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
    case "item/completed": {
      const item: Item = params.item;
      const written = method === "item/completed" && item.type === "fileChange" &&
        item.status === "completed" && conversation.mode === "code" &&
        !this.launcher && !conversation.archived && !conversation.deviceChatOrigin &&
        hasLocalBrowserExecution(conversation) && params.turnId === turn.id &&
        turn.status === "inProgress" && turn === conversation.turns.at(-1) &&
        !turn.items.some((previous) => previous.id === item.id && previous.lifecycleStatus === "completed");
      const accepted = this.applyItemEvent(
        conversation,
        turn,
        params.threadId,
        params.item,
        method === "item/completed",
      );
      if (accepted && written) {
        const paths = (turn.items.find((recorded) => recorded.id === item.id)?.generatedFiles ?? [])
          .filter((file) => file.operation !== "delete")
          .map((file) => file.path);
        if (paths.length) this.emit({ type: "code-files-written", conversationId: conversation.id, paths });
      }
      if (accepted && params.item.type !== "userMessage" && params.turnId === turn.id)
        clearTurnRetry(turn);
      return accepted;
    }
    case "item/agentMessage/delta":
    case "item/plan/delta": {
      if (method === "item/agentMessage/delta" && params.delta) retryPartial.delete(turn);
      const item = streamedItem(turn, params.itemId, () => ({
        id: params.itemId,
        type: method === "item/plan/delta" ? "plan" : "agentMessage",
        text: "",
        lifecycleStatus: turn.status,
      }));
      item.text = (item.text ?? "") + params.delta;
      if (params.turnId === turn.id) clearTurnRetry(turn);
      return true;
    }
    case "item/commandExecution/outputDelta": {
      const item = turn.items.find((value) => value.id === params.itemId);
      if (!item) return false;
      item.aggregatedOutput = (
        (item.aggregatedOutput ?? "") + params.delta
      ).slice(-maxCommandOutputLength);
      if (params.turnId === turn.id) clearTurnRetry(turn);
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
      if (params.turnId === turn.id) clearTurnRetry(turn);
      return true;
    }
    case "turn/plan/updated": {
      if (conversation.mode === "code") {
        if (turn.status !== "inProgress" || params.turnId !== turn.id)
          return false;
        const { plan, explanation } = params;
        const previous = turn.items.filter((item) => item.type === "taskPlan").at(-1);
        if (
          previous &&
          previous.explanation === explanation &&
          isDeepStrictEqual(previous.plan, plan)
        )
          return false;
        turn.items.push({
          id: `plan-${randomUUID()}`,
          type: "taskPlan",
          plan,
          explanation,
          lifecycleStatus: "completed",
        });
        clearTurnRetry(turn);
        return true;
      }
      replaceOrAppend(turn, {
        id: `plan-${turn.id}`,
        type: "taskPlan",
        plan: params.plan,
      });
      if (params.turnId === turn.id) clearTurnRetry(turn);
      return true;
    }
    case "turn/diff/updated":
      replaceOrAppend(turn, {
        id: `diff-${turn.id}`,
        type: "diff",
        text: params.diff,
      });
      if (params.turnId === turn.id) clearTurnRetry(turn);
      return true;
    case "thread/tokenUsage/updated": {
      const usage = threadTokenUsage(params.tokenUsage);
      if (!usage) return false;
      turn.contextUsage = usage.last;
      const turnIndex = conversation.turns.indexOf(turn);
      if (!conversation.turns.some((entry, index) => index > turnIndex && entry.contextUsage)) {
        conversation.usage = usage.total;
        conversation.tokenUsage = {
          ...usage,
          model: turn.contextUsageModel ?? conversation.model,
        };
      }
      recordTurnUsage(turn, params.tokenUsage);
      return true;
    }
    case "error":
      // A retried stream drop shows as Reconnecting until output resumes.
      if (params.willRetry === true) {
        if (turn.status !== "inProgress" || params.turnId !== turn.id)
          return false;
        const partial = turn.items.filter(
          (item) => item.type === "agentMessage" && itemIsRunning(item) && item.text,
        );
        if (partial.length) retryPartial.set(turn, partial);
        turn.items = turn.items.filter(
          (item) => item.type !== "agentMessage" || !itemIsRunning(item),
        );
        const attempt = reconnectAttempt(params.error?.message);
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
        turn.reconnecting = attempt
          ? `${attempt.attempt}/${attempt.maxRetries}`
          : "retrying";
        if (cause) turn.reconnectCause = cause;
        else delete turn.reconnectCause;
        if (attempt) turn.streamRetry = { ...attempt, ...(cause && { cause }) };
        else delete turn.streamRetry;
      } else {
        clearTurnRetry(turn);
        turn.error = this.refusalText(turn, params.error?.message, conversation.threadId);
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
  let incoming = { ...item, ...(previous?.agentThreads ? { agentThreads: previous.agentThreads } : {}) };
  if (incoming.type === "contextCompaction") {
    const before = previous?.compactionTokens?.before ?? conversation.tokenUsage?.last.totalTokens;
    const after = completed ? turn.contextUsage?.totalTokens : undefined;
    incoming.compactionTokens = { before, after };
  }
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
  const rejected = completed ? rejectedConnectorTool(incoming) : undefined;
  if (rejected) {
    const config = this.store.settings.mcpServers[rejected] as { url?: unknown } | undefined;
    if (typeof config?.url === "string") {
      incoming.mcpAuthRejectionUrl = config.url;
      recordConnectorAuthRejection(this.store, rejected, config.url);
      if (this.connectorAuthorizationRejected && this.startedMcpServers) {
        const started = JSON.parse(this.startedMcpServers)[rejected];
        const authorization = started?.http_headers?.Authorization;
        const token = typeof authorization === "string" && /^Bearer (.+)$/i.exec(authorization)?.[1];
        if (started?.url === config.url && token)
          this.connectorAuthorizationRejected(rejected, config.url, token);
      }
    }
  }
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
    ...(steer.officialCoworkEventId ? { officialCoworkEventId: steer.officialCoworkEventId } : {}),
    ...(steer.officialCode ? {
      officialCodeEventId: steer.officialCode.eventId,
      officialCodeInputHash: steer.officialCode.inputHash,
    } : {}),
  };
  recordItemLifecycle(turn, message, completed);
  if (completed) this.steers.delete(clientId);
  return true;
}
