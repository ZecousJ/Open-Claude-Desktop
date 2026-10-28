/**
 * Agent runtime calls: workflow sub-agents, and new calls such as the reply
 * feedback dialog. Handlers go in `electron/ipc/agent.ts`
 * (`electron/ipc/workflow.ts` holds the workflow agent ones).
 */
import type { AgentTranscript, Attachment, Conversation, Item } from "./types";
import { bridgeMethods } from "./bridge-methods";

export interface AgentAPI {
  stopWorkflowAgent(
    conversationId: string,
    agentThreadId: string,
  ): Promise<Conversation>;
  refreshWorkflowAgents(conversationId: string): Promise<Conversation>;
  readWorkflowAgent(
    conversationId: string,
    agentThreadId: string,
  ): Promise<AgentTranscript>;
  /** Stops a Workflow tool run (electron/workflows): no new agents, running ones interrupted. */
  stopWorkflowRun(conversationId: string, runId: string): Promise<boolean>;
}

export const agentMethods = bridgeMethods<AgentAPI>({
  stopWorkflowAgent: true,
  refreshWorkflowAgents: true,
  readWorkflowAgent: true,
  stopWorkflowRun: true,
});

// Engine seams (E0): token usage, compaction and steering, as the engine
// records them on conversations. The optional fields below extend the
// published types in shared/types.ts, which stays frozen.

/** One side of Codex's `ThreadTokenUsage` (app-server v2 `TokenUsageBreakdown`). */
export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/**
 * The latest `thread/tokenUsage/updated` of a conversation's native thread.
 * `total` adds up every request of the thread (the same numbers as
 * `Conversation.usage`). `last` is the latest request alone, so
 * `last.totalTokens` is how much of the context window the conversation fills
 * now; it drops after a compaction. `modelContextWindow` is the window Codex
 * works with for the model (95% of the configured window), null when Codex
 * reports none.
 */
export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/**
 * Context limits the engine gives Codex for one model, from the service's
 * model catalog (`ModelCatalogItem.contextWindow`/`autoCompactTokens`).
 * Codex compacts a conversation automatically before a turn when the context
 * holds more than `autoCompactTokens`, and never later than at 90% of the
 * window; it cannot use a window larger than the one it knows for the model
 * (272,000 tokens for models it does not know).
 */
export interface ModelContextLimits {
  contextWindow?: number;
  autoCompactTokens?: number;
}

/**
 * A message added to a running turn (`steerTurn`), recorded in that turn's
 * items once Codex hands it to the model. `clientId` is the `messageId`
 * `steerTurn` returned. A message still waiting when the turn is stopped is
 * never sent, and no item with its id appears.
 */
export interface SteeredMessageItem extends Item {
  type: "userMessage";
  steered: true;
  clientId: string;
  text: string;
  attachments: Attachment[];
}

declare module "./types" {
  interface Conversation {
    thinkingSummariesWanted?: boolean;
    thinkingMode?: "standard" | "extended";
    /** The thread's latest token usage (E0); absent before the first report. */
    tokenUsage?: ThreadTokenUsage;
  }
  interface ConversationBranch {
    tokenUsage?: ThreadTokenUsage;
  }
  interface Turn {
    /**
     * "manual": a /compact turn (`compactConversation`). It has no prompt and
     * holds the `contextCompaction` item; it cannot be retried or edited.
     */
    compaction?: "manual";
    /**
     * A Bash mode line (`runShellCommand`): the prompt is the command, run
     * in the session's shell; it holds the `commandExecution` item and
     * cannot be retried, edited or steered.
     */
    shell?: true;
  }
}

export function isSteeredMessage(item: Item): item is SteeredMessageItem {
  return item.type === "userMessage" && item.steered === true;
}

function breakdown(value: any): TokenUsageBreakdown | undefined {
  const count = (key: keyof TokenUsageBreakdown) => {
    const n = value?.[key];
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
  };
  const totalTokens = count("totalTokens");
  if (totalTokens === undefined) return undefined;
  return {
    totalTokens,
    inputTokens: count("inputTokens") ?? 0,
    cachedInputTokens: count("cachedInputTokens") ?? 0,
    outputTokens: count("outputTokens") ?? 0,
    reasoningOutputTokens: count("reasoningOutputTokens") ?? 0,
  };
}

/** Codex's `tokenUsage` payload, checked; undefined when it is not one. */
export function threadTokenUsage(value: any): ThreadTokenUsage | undefined {
  const total = breakdown(value?.total);
  const last = breakdown(value?.last);
  if (!total || !last) return undefined;
  const window = value?.modelContextWindow;
  return {
    total,
    last,
    modelContextWindow:
      Number.isInteger(window) && window > 0 ? (window as number) : null,
  };
}
