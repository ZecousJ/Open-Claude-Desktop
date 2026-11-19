import type { Item, Turn } from "./types";

/** UI lifecycle metadata is independent of upstream tool-specific status values. */
export function itemIsRunning(item: Item): boolean {
  const status = item.lifecycleStatus ?? item.status;
  return status === "inProgress" || status === "running";
}

export function recordItemLifecycle(
  turn: Turn,
  incoming: Item,
  completed: boolean,
  now = Date.now(),
) {
  const index = turn.items.findIndex((item) => item.id === incoming.id);
  const previous = index < 0 ? undefined : turn.items[index];
  const tool =
    incoming.type === "mcpToolCall" || incoming.type === "dynamicToolCall";
  // Late start snapshots must not overwrite a completed tool's name, input,
  // error or result, even though its lifecycle would otherwise remain terminal.
  if (tool && previous && !completed && !itemIsRunning(previous)) return;
  // Late notifications must never resurrect a terminal item or turn.
  const lifecycleStatus =
    turn.status !== "inProgress"
      ? turn.status
      : completed
        ? "completed"
        : (previous?.lifecycleStatus ?? "inProgress");
  const item: Item = { ...previous, ...incoming, lifecycleStatus };
  // Distinguish an explicit empty completion from finishTurn's inferred
  // settlement of a tool whose final notification was never recorded.
  if (tool && completed && incoming.status === undefined)
    item.status = [
      "completed",
      "failed",
      "declined",
      "interrupted",
      "cancelled",
      "canceled",
    ].includes(previous?.status ?? "")
      ? previous!.status
      : "completed";
  // Progress can precede item/started; empty start defaults are not a reset.
  if (tool && !completed && previous?.progress && !incoming.progress)
    item.progress = previous.progress;
  // A start snapshot may arrive after streamed reasoning already did.
  // Only completion snapshots (including []) may clear that text.
  if (
    !completed &&
    incoming.type === "reasoning" &&
    previous?.type === "reasoning" &&
    Array.isArray(previous.summary) &&
    previous.summary.some(
      (text) => typeof text === "string" && text.length > 0,
    ) &&
    Array.isArray(incoming.summary) &&
    incoming.summary.length === 0
  )
    item.summary = previous.summary;
  // Local observation times drive the Code status line ("Thought for Ns").
  item.startedAt =
    typeof previous?.startedAt === "number" ? previous.startedAt : now;
  if (lifecycleStatus !== "inProgress")
    item.completedAt =
      typeof previous?.completedAt === "number" ? previous.completedAt : now;
  if (index < 0) turn.items.push(item);
  else turn.items[index] = item;
}

/** Progress notifications can precede item/started but cannot revive a completed tool. */
export function recordMcpProgress(
  turn: Turn,
  itemId: string,
  message: string,
): boolean {
  if (
    turn.status !== "inProgress" ||
    typeof itemId !== "string" ||
    !itemId.trim() ||
    typeof message !== "string"
  )
    return false;
  let item = turn.items.find((value) => value.id === itemId);
  if (item && (item.type !== "mcpToolCall" || !itemIsRunning(item)))
    return false;
  if (!item) {
    item = {
      id: itemId,
      type: "mcpToolCall",
      status: "inProgress",
      lifecycleStatus: "inProgress",
      startedAt: Date.now(),
    };
    turn.items.push(item);
  }
  const progress = message.slice(0, 1000);
  if (item.progress === progress) return false;
  item.progress = progress;
  return true;
}

export function clearTurnRetry(turn: Turn) {
  delete turn.reconnecting;
  delete turn.reconnectCause;
  delete turn.streamRetry;
}

export function finishTurn(
  turn: Turn,
  status: Exclude<Turn["status"], "inProgress">,
) {
  turn.status = status;
  clearTurnRetry(turn);
  if (turn.compactionUncertain) {
    delete turn.compactionUncertain;
    turn.error = status === "interrupted"
      ? "Compaction was interrupted before its outcome could be confirmed."
      : "Compaction ended without a confirmed outcome.";
  }
  const now = Date.now();
  for (const item of turn.items) {
    if (itemIsRunning(item)) {
      item.lifecycleStatus = status;
      item.completedAt ??= now;
    }
  }
}

export type ActivityPhase =
  "idle" | "waiting" | "thinking" | "tools" | "streaming" | "approval";
export function turnActivity(
  turn: Turn,
  awaitingApproval = false,
): ActivityPhase {
  if (turn.status !== "inProgress") return "idle";
  if (awaitingApproval) return "approval";
  const active = turn.items.filter(itemIsRunning);
  // A tool can continue while the model emits commentary. Keep its progress visible.
  if (
    active.some(
      (item) => !["agentMessage", "plan", "reasoning"].includes(item.type),
    )
  )
    return "tools";
  // Text that is only whitespace has not started the reply: some upstreams
  // open with a blank message, which hid the working mark (owner, 2026-10-14).
  if (
    active.some(
      (item) =>
        ["agentMessage", "plan"].includes(item.type) && item.text?.trim(),
    )
  )
    return "streaming";
  if (active.some((item) => item.type === "reasoning") || turn.items.length)
    return "thinking";
  return "waiting";
}

/** Output tokens produced during this turn, from cumulative thread usage notifications. */
/** Thread totals minus their value when the turn began gives the turn's own usage. */
function turnDelta(
  turn: Turn,
  base: "outputTokenBase" | "inputTokenBase",
  total: unknown,
  last: unknown,
) {
  if (!Number.isSafeInteger(total) || (total as number) < 0) return undefined;
  const lastValue =
    Number.isSafeInteger(last) && (last as number) >= 0 ? (last as number) : 0;
  turn[base] ??= Math.max(0, (total as number) - lastValue);
  return Math.max(0, (total as number) - turn[base]!);
}
const uncached = (value: any) =>
  Number.isSafeInteger(value?.inputTokens)
    ? value.inputTokens -
      (Number.isSafeInteger(value?.cachedInputTokens)
        ? value.cachedInputTokens
        : 0)
    : undefined;

export function recordTurnUsage(turn: Turn, usage: any) {
  if (turn.status !== "inProgress") return false;
  const output = turnDelta(
    turn,
    "outputTokenBase",
    usage?.total?.outputTokens,
    usage?.last?.outputTokens,
  );
  if (output === undefined) return false;
  const input = turnDelta(
    turn,
    "inputTokenBase",
    uncached(usage?.total),
    uncached(usage?.last),
  );
  const changed =
    output !== turn.outputTokens ||
    (input !== undefined && input !== turn.inputTokens);
  turn.outputTokens = output;
  if (input !== undefined) turn.inputTokens = input;
  return changed;
}
