import {
  codeAgentOwner,
  parseCodeAgentThread,
} from "../engine/code-agent-threads";
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
import {
  agentItems,
  agentThreadIds,
  ownsWorkflowAgent,
} from "../../shared/workflow-usage";
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
  current?(): boolean;
  readonly store: Store;
  readonly engine: Engine;
  engineFor?(conversationId: string): Engine;
  readonly activeAccount?: PublicAccount;
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
function ownsChildSession(context: Context, conversation: Conversation) {
  const authors = conversation.sessionAuthors;
  return !authors || (authors.ownerAccountUuid === context.activeAccount?.id &&
    authors.viewerAccountUuid === context.activeAccount?.id);
}
export async function stopWorkflowAgent(
  context: Context,
  conversationId: string,
  agentId: string,
): Promise<Conversation> {
  if (context.current?.() === false) throw Error("The account changed.");
  const store = context.store;
  const conversation = store.conversation(conversationId);
  if (!ownsChildSession(context, conversation)) throw Error("Agent session not found.");
  if (!agentItems(conversation.turns).some((item) => containsAgent(item, agentId)))
    throw Error("Agent is not part of this conversation.");
  const engineFor = () =>
    context.engineFor?.(conversationId) ?? context.engine.elsewhereFor?.(conversationId) ?? context.engine;
  const engine = engineFor();
  const rpc = engine.rpc;
  if (!rpc || engine.state.state !== "ready") throw Error("Codex is not connected.");
  const current = () => {
    if (context.current?.() === false || context.store !== store || engineFor() !== engine ||
        engine.rpc !== rpc || !store.conversations.includes(conversation) ||
        !ownsChildSession(context, conversation))
      throw Error("The account or agent connection changed.");
  };
  const response = await rpc.call("thread/read", { threadId: agentId, includeTurns: true });
  current();
  if (response?.thread?.id !== agentId) throw Error("Agent transcript is unavailable.");
  const last = response?.thread?.turns?.at(-1);
  if (last?.status === "inProgress") {
    await rpc.call("turn/interrupt", {
      threadId: agentId,
      turnId: last.id,
    });
    current();
    engine.gateway?.abortThread(agentId);
  }
  const status =
    last?.status === "completed"
      ? "completed"
      : last?.status === "failed"
        ? "errored"
        : "interrupted";
  for (const item of agentItems(conversation.turns))
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
  if (context.current?.() === false) throw Error("The account changed.");
  const store = context.store;
  const conversation = store.conversation(conversationId);
  if (!ownsChildSession(context, conversation)) throw Error("Agent session not found.");
  const ids = [
    ...new Set(
      conversation.turns.flatMap((turn) => turn.items.flatMap(agentThreadIds)),
    ),
  ].slice(0, 32);
  if (!ids.length) return structuredClone(conversation);
  const engineFor = () =>
    context.engineFor?.(conversationId) ?? context.engine.elsewhereFor?.(conversationId) ?? context.engine;
  const engine = engineFor();
  const rpc = engine.rpc;
  if (!rpc || engine.state.state !== "ready") throw Error("Codex is not connected.");
  const current = () => {
    if (context.current?.() === false || context.store !== store || engineFor() !== engine ||
        engine.rpc !== rpc || !store.conversations.includes(conversation) ||
        !ownsChildSession(context, conversation))
      throw Error("The account or agent connection changed.");
  };
  let changed = false;
  for (const agentId of ids) {
    const result = await rpc.call("thread/read", {
      threadId: agentId,
      includeTurns: true,
    });
    current();
    const thread = result?.thread;
    if (thread?.id !== agentId) continue;
    await describeChildThread({ store, engine }, thread);
    current();
    const last = thread.turns?.at(-1);
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
    store.flush();
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
  if (context.current?.() === false) throw Error("The account changed.");
  const conversation = context.store.conversation(conversationId);
  if (!ownsChildSession(context, conversation)) throw Error("Agent session not found.");
  const store = context.store;
  const engineFor = () =>
    context.engineFor?.(conversationId) ?? context.engine.elsewhereFor?.(conversationId) ?? context.engine;
  const engine = engineFor();
  const sameAccount = () => {
    if (context.current?.() === false || context.store !== store || engineFor() !== engine ||
        !store.conversations.includes(conversation) || !ownsChildSession(context, conversation))
      throw Error("The account or agent connection changed.");
  };
  const owner = conversation.turns.find((turn) =>
    turn.items.some((item) => containsAgent(item, agentId)),
  );
  if (!owner) throw Error("Agent is not part of this conversation.");
  if (!engine.rpc || engine.state.state !== "ready") {
    if (conversation.mode !== "code" || !conversation.cwd || conversation.incognito ||
        conversation.cloudHosted || conversation.linkedToComputer ||
        conversation.environment?.kind === "ssh" || !engine.owns(conversation))
      throw Error("Codex is not connected.");
    const provider = store.settings.providers.find(entry => entry.id === conversation.providerId);
    if (!provider) throw Error("The model service is unavailable.");
    await engine.ensure(provider, { interactive: false, current: () => { sameAccount(); return true; } });
    sameAccount();
  }
  const rpc = engine.rpc;
  if (!rpc || engine.state.state !== "ready") throw Error("Codex is not connected.");
  const current = () => { sameAccount(); if (engine.rpc !== rpc) throw Error("The agent connection changed."); };
  const result = await rpc.call("thread/read", {
    threadId: agentId,
    includeTurns: true,
  });
  current();
  if (result?.thread?.id !== agentId)
    throw Error("Agent transcript is unavailable.");
  // R7: the model's descriptions of the child's shell commands.
  await describeChildThread({ store, engine }, result.thread);
  current();
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
export async function readCodeAgent(
  context: Context,
  conversationId: string,
  agentId: string,
) {
  if (context.current?.() === false) throw Error("The account changed.");
  const conversation = context.store.conversation(conversationId);
  const owner = codeAgentOwner(conversation, agentId);
  if (!owner) throw Error("Agent is not part of this conversation.");
  const accountEngine = context.engine;
  const engine = accountEngine.elsewhereFor(conversationId) ?? accountEngine;
  const rpc = engine.rpc;
  if (!rpc || engine.state.state !== "ready") {
    const saved = owner.agentThreads?.[agentId];
    if (saved) return structuredClone(saved);
    throw Error("Codex is not connected.");
  }
  const result = await rpc.call("thread/read", {
    threadId: agentId,
    includeTurns: true,
  });
  if (
    context.current?.() === false ||
    context.engine !== accountEngine ||
    engine.rpc !== rpc ||
    context.store.conversation(conversationId) !== conversation
  )
    throw Error("The agent connection changed.");
  const thread = parseCodeAgentThread(result?.thread);
  if (thread.id !== agentId) throw Error("Agent transcript is unavailable.");
  const previous = new Map(
    agentItems(owner.agentThreads?.[agentId]?.turns ?? []).map((item) => [
      item.id,
      item,
    ]),
  );
  for (const item of agentItems(thread.turns)) {
    const children = previous.get(item.id)?.agentThreads;
    if (children) item.agentThreads = children;
  }
  owner.agentThreads = { ...owner.agentThreads, [agentId]: thread };
  context.store.flush();
  send(context, {
    type: "conversation",
    conversation: structuredClone(conversation),
  });
  return structuredClone(thread);
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
    const { engine, store } = context;
    if (engine.extensions.has(workflowExtensionId)) return;
    const extension = createWorkflowExtension({
      engine,
      root: () => store.root,
      settings: () => store.settings,
      policy: () => engine.policy(),
      modelEfforts: (providerId, model) => engine.modelEfforts(providerId, model),
    });
    runs = extension.runs;
    const release = engine.extensions.add(extension);
    engine.peerExtensions.push(extension);
    remove = () => {
      release();
      engine.peerExtensions = engine.peerExtensions.filter((entry) => entry !== extension);
    };
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
  handle("readCodeAgent", (rawConversation: unknown, rawAgent: unknown) =>
    readCodeAgent(context, id.parse(rawConversation), id.parse(rawAgent)),
  );
  handle("readWorkflowAgent", (rawConversation: unknown, rawAgent: unknown) =>
    readWorkflowAgent(context, id.parse(rawConversation), id.parse(rawAgent)),
  );
  handle("refreshWorkflowAgents", (rawConversation: unknown) =>
    refreshWorkflowAgents(context, id.parse(rawConversation)),
  );
}
