import type { Item, Turn } from "./types";

/** UI lifecycle metadata is independent of upstream tool-specific status values. */
export function itemIsRunning(item: Item): boolean {
  return item.lifecycleStatus
    ? item.lifecycleStatus === "inProgress"
    : item.status === "inProgress";
}

export function recordItemLifecycle(
  turn: Turn,
  incoming: Item,
  completed: boolean,
  now = Date.now(),
) {
  const index = turn.items.findIndex((item) => item.id === incoming.id);
  const previous = index < 0 ? undefined : turn.items[index];
  // Late notifications must never resurrect a terminal item or turn.
  const lifecycleStatus =
    turn.status !== "inProgress"
      ? turn.status
      : completed
        ? "completed"
        : (previous?.lifecycleStatus ?? "inProgress");
  const item: Item = { ...previous, ...incoming, lifecycleStatus };
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
  if (turn.status !== "inProgress") return false;
  let item = turn.items.find((value) => value.id === itemId);
  if (item && (item.type !== "mcpToolCall" || !itemIsRunning(item)))
    return false;
  if (!item) {
    item = {
      id: itemId,
      type: "mcpToolCall",
      status: "inProgress",
      lifecycleStatus: "inProgress",
    };
    turn.items.push(item);
  }
  item.progress = message.slice(0, 1000);
  return true;
}

export function finishTurn(
  turn: Turn,
  status: Exclude<Turn["status"], "inProgress">,
) {
  turn.status = status;
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
  // Text that is only whitespace has not started the reply: some upstreams open
  // with a blank message, which hid the working mark.
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
