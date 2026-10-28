import { z } from "zod";
import type { BrowserWindow } from "electron";
import type { Engine } from "../engine/engine";
import type { Store } from "../store/store";
import type {
  AppEvent,
  Conversation,
  Item,
  PublicAccount,
} from "../../shared/types";
import { agentThreadIds, ownsWorkflowAgent } from "../../shared/workflow-usage";
import { recordAgentsStopped } from "../../shared/agent-messages";
import {
  createWorkflowExtension,
  workflowExtensionId,
  type WorkflowRuns,
} from "../workflows/extension";
import { projectAgentTranscript } from "../conversations/agent-transcript";
import {
  releaseToolDescriptions,
  toolDescriptionsFor,
} from "../engine/tool-description-store";
import { describeChildThread, describeActivity } from "./workflow-rollout";
type Handle = (name: string, fn: (...args: any[]) => any) => void;
export interface Context {
  readonly store: Store;
  readonly engine: Engine;
  readonly window?: BrowserWindow;
  /** Sends an event to every app window (the main and separate ones, R2). */
  push?(event: AppEvent): void;
  /** Account lifecycle (AppContext); child command descriptions follow it (R7-B). */
  onAccountActivated?(cb: (account: PublicAccount) => void): () => void;
  onAccountDeactivating?(cb: () => void | Promise<void>): () => void;
}
function send(context: Context, event: AppEvent) {
  if (context.push) context.push(event);
  else context.window?.webContents.send("app:event", event);
}
export const id = z.string().min(1).max(500);
function containsAgent(item: Item, agentId: string) {
  return ownsWorkflowAgent(item, agentId);
}
export async function stopWorkflowAgent(
  context: Context,
  conversationId: string,
  agentId: string,
): Promise<Conversation> {
  const conversation = context.store.conversation(conversationId);
  if (
    !conversation.turns.some((turn) =>
      turn.items.some((item) => containsAgent(item, agentId)),
    )
  )
    throw Error("Agent is not part of this conversation.");
  if (!context.engine.rpc || context.engine.state.state !== "ready")
    throw Error("Codex is not connected.");
  const response = await context.engine.rpc.call("thread/read", {
    threadId: agentId,
    includeTurns: true,
  });
  const last = response?.thread?.turns?.at(-1);
  if (last?.status === "inProgress") {
    await context.engine.rpc.call("turn/interrupt", {
      threadId: agentId,
      turnId: last.id,
    });
    context.engine.gateway?.abortThread(agentId);
  }
  const status =
    last?.status === "completed"
      ? "completed"
      : last?.status === "failed"
        ? "errored"
        : "interrupted";
  for (const turn of conversation.turns)
    for (const item of turn.items)
      if (containsAgent(item, agentId)) {
        item.agentsStates = {
          ...item.agentsStates,
          [agentId]: {
            status,
            message: status === "interrupted" ? "Stopped by user" : null,
          },
        };
        const began = Number(response?.thread?.createdAt);
        if (Number.isFinite(began) && began > 0) {
          item.agentStartedAt = {
            ...item.agentStartedAt,
            [agentId]: Math.round(began * 1000),
          };
          item.agentDurationMs = {
            ...item.agentDurationMs,
            [agentId]: Math.max(0, Date.now() - began * 1000),
          };
        }
      }
  if (status === "interrupted") recordAgentsStopped(conversation);
  context.store.flush();
  send(context, {
    type: "conversation",
    conversation: structuredClone(conversation),
  });
  return structuredClone(conversation);
}
export async function refreshWorkflowAgents(
  context: Context,
  conversationId: string,
): Promise<Conversation> {
  const conversation = context.store.conversation(conversationId);
  const ids = [
    ...new Set(
      conversation.turns.flatMap((turn) => turn.items.flatMap(agentThreadIds)),
    ),
  ].slice(0, 32);
  if (!ids.length) return structuredClone(conversation);
  if (!context.engine.rpc || context.engine.state.state !== "ready")
    throw Error("Codex is not connected.");
  let changed = false;
  for (const agentId of ids) {
    const result = await context.engine.rpc.call("thread/read", {
      threadId: agentId,
      includeTurns: true,
    });
    const thread = result?.thread,
      last = thread?.turns?.at(-1);
    if (thread?.id === agentId) await describeChildThread(context, thread);
    const status =
      thread?.status?.type === "active"
        ? "running"
        : thread?.status?.type === "systemError"
          ? "errored"
          : last?.status === "completed"
            ? "completed"
            : last?.status === "interrupted"
              ? "interrupted"
              : last?.status === "failed"
                ? "errored"
                : undefined;
    if (!status) continue;
    for (const turn of conversation.turns)
      for (const item of turn.items)
        if (containsAgent(item, agentId)) {
          const previous = item.agentsStates?.[agentId];
          const startedAt = Number(thread?.createdAt),
            updatedAt = Number(thread?.updatedAt);
          const durationMs =
            Number.isFinite(startedAt) &&
            Number.isFinite(updatedAt) &&
            updatedAt >= startedAt &&
            status !== "running"
              ? Math.round((updatedAt - startedAt) * 1000)
              : undefined;
          const activity = describeActivity(thread);
          if (
            previous?.status === status &&
            item.agentStartedAt?.[agentId] === Math.round(startedAt * 1000) &&
            (durationMs === undefined ||
              item.agentDurationMs?.[agentId] === durationMs) &&
            item.agentToolUses?.[agentId] === activity.toolUses &&
            item.agentCurrentAction?.[agentId] === activity.currentAction
          )
            continue;
          item.agentsStates = {
            ...item.agentsStates,
            [agentId]: { status, message: previous?.message ?? null },
          };
          if (Number.isFinite(startedAt) && startedAt > 0)
            item.agentStartedAt = {
              ...item.agentStartedAt,
              [agentId]: Math.round(startedAt * 1000),
            };
          if (durationMs !== undefined)
            item.agentDurationMs = {
              ...item.agentDurationMs,
              [agentId]: durationMs,
            };
          item.agentToolUses = {
            ...item.agentToolUses,
            [agentId]: activity.toolUses,
          };
          item.agentCurrentAction = {
            ...item.agentCurrentAction,
            [agentId]: activity.currentAction,
          };
          changed = true;
        }
  }
  if (changed) {
    context.store.flush();
    send(context, {
      type: "conversation",
      conversation: structuredClone(conversation),
    });
  }
  return structuredClone(conversation);
}
export async function readWorkflowAgent(
  context: Context,
  conversationId: string,
  agentId: string,
) {
  const conversation = context.store.conversation(conversationId);
  const owner = conversation.turns.find((turn) =>
    turn.items.some((item) => containsAgent(item, agentId)),
  );
  if (!owner) throw Error("Agent is not part of this conversation.");
  if (!context.engine.rpc || context.engine.state.state !== "ready")
    throw Error("Codex is not connected.");
  const result = await context.engine.rpc.call("thread/read", {
    threadId: agentId,
    includeTurns: true,
  });
  if (result?.thread?.id !== agentId)
    throw Error("Agent transcript is unavailable.");
  // R7: the model's descriptions of the child's shell commands.
  await describeChildThread(context, result.thread);
  const source =
    owner.items.find(
      (item) =>
        containsAgent(item, agentId) && typeof item.agentPrompt === "string",
    ) ?? owner.items.find((item) => containsAgent(item, agentId));
  const prompt =
    typeof source?.agentPrompt === "string"
      ? source.agentPrompt
      : typeof source?.prompt === "string"
        ? source.prompt
        : owner.prompt;
  return projectAgentTranscript(
    result.thread,
    typeof source?.agentModel === "string"
      ? source.agentModel
      : conversation.model,
    prompt,
  );
}
/**
 * Keeps the descriptions of child agents' commands for the signed-in
 * account (R7-B): the store hooks into the account's engine when the
 * account is activated, and is written and let go before it signs out.
 */
function trackToolDescriptions(context: Context) {
  context.onAccountActivated?.(() => {
    try {
      toolDescriptionsFor(
        context.engine,
        context.store.root,
        () => context.store.conversations,
      );
    } catch (error) {
      console.error(
        "Command descriptions are unavailable:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
  context.onAccountDeactivating?.(() => {
    try {
      releaseToolDescriptions(context.engine);
    } catch {
      /* The account's engine may already be gone. */
    }
  });
}
/**
 * The Workflow tool (electron/workflows) on the account's engine: added when
 * an account opens, so the desktop and the web runner both offer it.
 */
function registerWorkflowRuns(
  context: Context,
): () => WorkflowRuns | undefined {
  let runs: WorkflowRuns | undefined;
  let remove: (() => void) | undefined;
  const add = () => {
    remove?.();
    const engine = context.engine;
    if (engine.extensions.has(workflowExtensionId)) return;
    const extension = createWorkflowExtension({
      engine,
      root: () => context.store.root,
      settings: () => context.store.settings,
      policy: () => engine.policy(),
    });
    runs = extension.runs;
    remove = engine.extensions.add(extension);
  };
  if (context.onAccountActivated) context.onAccountActivated(add);
  else add();
  context.onAccountDeactivating?.(() => {
    remove?.();
    remove = undefined;
    runs = undefined;
  });
  return () => runs;
}
export function registerWorkflowHandlers(handle: Handle, context: Context) {
  trackToolDescriptions(context);
  const runs = registerWorkflowRuns(context);
  handle(
    "stopWorkflowRun",
    async (rawConversation: unknown, rawRun: unknown) => {
      const conversationId = id.parse(rawConversation);
      const runId = id.parse(rawRun);
      const conversation = context.store.conversation(conversationId);
      if (
        !conversation.turns.some((turn) =>
          turn.items.some((item) => item.workflowRunId === runId),
        )
      )
        throw Error("This workflow is not part of the conversation.");
      return (await runs()?.stop(runId)) ?? false;
    },
  );
  handle("stopWorkflowAgent", (rawConversation: unknown, rawAgent: unknown) =>
    stopWorkflowAgent(context, id.parse(rawConversation), id.parse(rawAgent)),
  );
  handle("readWorkflowAgent", (rawConversation: unknown, rawAgent: unknown) =>
    readWorkflowAgent(context, id.parse(rawConversation), id.parse(rawAgent)),
  );
  handle("refreshWorkflowAgents", (rawConversation: unknown) =>
    refreshWorkflowAgents(context, id.parse(rawConversation)),
  );
}
