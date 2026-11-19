import type { Conversation, Turn } from "../../shared/types";

const stopping = new WeakMap<Turn, number>();

export function holdCodeTurnApprovals(turn: Turn): () => void {
  stopping.set(turn, (stopping.get(turn) ?? 0) + 1);
  return () => {
    const remaining = (stopping.get(turn) ?? 1) - 1;
    if (remaining) stopping.set(turn, remaining);
    else stopping.delete(turn);
  };
}

export function codeApprovalIsStopping(
  conversation: Conversation | undefined,
  params: { threadId?: unknown; turnId?: unknown } | undefined,
): boolean {
  const turn = conversation?.turns.at(-1);
  return Boolean(
    conversation?.mode === "code" &&
    conversation.threadId === params?.threadId &&
    turn?.status === "inProgress" &&
    turn.id === params?.turnId &&
    stopping.has(turn),
  );
}
