import type { Conversation, ConversationBranch, Turn } from "./types";

export const responseGroup = (turn: Turn) => turn.responseGroupId ?? turn.id;

/** Find a completed reply even when its version is on a saved branch. */
export function completedReply(c: Conversation, turnId: string): Turn | undefined {
  return [c.turns, ...(c.savedBranches ?? []).map((branch) => branch.turns)]
    .flat()
    .find((turn) => turn.id === turnId && turn.status === "completed");
}

export interface ChatLeafTarget {
  conversationCreatedAt: number;
  turnId: string;
  turnCreatedAt: number;
  branchId: string | null;
}

function activePath(c: Conversation): ConversationBranch {
  return {
    id: c.activeBranchId ?? "original",
    threadId: c.threadId,
    turns: c.turns,
    providerId: c.providerId,
    model: c.model,
    usage: c.usage,
    tokenUsage: c.tokenUsage,
    visited: c.branchVisit ?? 0,
  };
}

/** Each version restores the most recently selected continuation of that reply. */
export function replyVersions(c: Conversation, turn: Turn) {
  const group = responseGroup(turn);
  const versions = new Map<
    string,
    { turnId: string; branchId: string; createdAt: number; visited: number }
  >();
  for (const branch of [...(c.savedBranches ?? []), activePath(c)]) {
    const candidate = branch.turns.find((t) => responseGroup(t) === group);
    if (!candidate) continue;
    const prior = versions.get(candidate.id);
    if (!prior || branch.visited >= prior.visited)
      versions.set(candidate.id, {
        turnId: candidate.id,
        branchId: branch.id,
        createdAt: candidate.createdAt,
        visited: branch.visited,
      });
  }
  return [...versions.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.turnId.localeCompare(b.turnId),
  );
}

export function promptVersions(c: Conversation, turn: Turn) {
  const group = turn.promptGroupId ?? responseGroup(turn);
  const versions = new Map<
    string,
    { turnId: string; branchId: string; createdAt: number; visited: number }
  >();
  for (const branch of [...(c.savedBranches ?? []), activePath(c)]) {
    const candidate = branch.turns.find(
      (t) => (t.promptGroupId ?? responseGroup(t)) === group,
    );
    if (!candidate) continue;
    const key = candidate.promptVersionId ?? responseGroup(candidate);
    const prior = versions.get(key);
    if (!prior || branch.visited >= prior.visited)
      versions.set(key, {
        turnId: candidate.id,
        branchId: branch.id,
        createdAt: Math.min(
          prior?.createdAt ?? candidate.createdAt,
          candidate.createdAt,
        ),
        visited: branch.visited,
      });
  }
  return [...versions.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.turnId.localeCompare(b.turnId),
  );
}

/** Commit only after the new native thread was successfully prepared. */
export function beginReplyBranch(
  c: Conversation,
  turnId: string,
  threadId: string,
  branchId: string,
) {
  const index = c.turns.findIndex((t) => t.id === turnId);
  if (index < 0)
    throw new Error("The response is no longer in this conversation.");
  if (c.turns.some((t) => t.status === "inProgress"))
    throw new Error("Wait for the current response to finish.");
  const target = c.turns[index];
  const groupId = responseGroup(target);
  target.responseGroupId = groupId;
  c.savedBranches ??= [];
  c.savedBranches.push(structuredClone(activePath(c)));
  c.activeBranchId = branchId;
  c.branchVisit = (c.branchVisit ?? 0) + 1;
  c.threadId = threadId;
  c.turns = structuredClone(c.turns.slice(0, index));
  c.usage = undefined;
  c.tokenUsage = undefined;
  return groupId;
}

export function selectReplyVersion(
  c: Conversation,
  turnId: string,
  versionTurnId: string,
  kind: "reply" | "prompt" = "reply",
) {
  if (c.turns.some((t) => t.status === "inProgress"))
    throw new Error("Wait for the current response to finish.");
  const turn = c.turns.find((t) => t.id === turnId);
  if (!turn) throw new Error("The response is no longer in this conversation.");
  const version = (
    kind === "prompt" ? promptVersions(c, turn) : replyVersions(c, turn)
  ).find((v) => v.turnId === versionTurnId);
  if (!version)
    throw new Error(
      "This reply version does not belong to the selected response.",
    );
  if (version.turnId === turn.id) return;
  const next = c.savedBranches?.find((b) => b.id === version.branchId);
  if (!next) throw new Error("The saved reply branch is unavailable.");
  activateBranch(c, next);
}

export function selectChatLeaf(c: Conversation, target: ChatLeafTarget): boolean {
  if (c.mode !== "chat" || c.createdAt !== target.conversationCreatedAt)
    throw new Error("The Chat conversation changed. Reopen it before selecting a version.");
  if (c.turns.some((turn) => turn.status === "inProgress"))
    throw new Error("Wait for the current response to finish.");
  const isTarget = (turn: Turn | undefined) =>
    turn?.id === target.turnId && turn.createdAt === target.turnCreatedAt;
  const activeBranchId = c.activeBranchId ?? "original";
  if (
    (target.branchId === null || target.branchId === activeBranchId) &&
    isTarget(c.turns.at(-1))
  )
    return false;
  const branches = (c.savedBranches ?? []).filter(
    (branch) => branch.id === target.branchId,
  );
  const next = branches.length === 1 ? branches[0] : undefined;
  if (
    !next ||
    next.id === activeBranchId ||
    !isTarget(next.turns.at(-1)) ||
    next.turns.some((turn) => turn.status === "inProgress")
  )
    throw new Error("The saved Chat version changed. Reopen the conversation.");
  activateBranch(c, next);
  return true;
}

function activateBranch(c: Conversation, next: ConversationBranch) {
  const previous = structuredClone(activePath(c));
  c.savedBranches = c.savedBranches!.filter((b) => b.id !== next.id);
  c.savedBranches.push(previous);
  c.activeBranchId = next.id;
  c.branchVisit =
    Math.max(
      c.branchVisit ?? 0,
      ...c.savedBranches.map((b) => b.visited),
      next.visited,
    ) + 1;
  c.threadId = next.threadId;
  c.turns = structuredClone(next.turns);
  c.providerId = next.providerId;
  c.model = next.model;
  c.usage = next.usage;
  c.tokenUsage = next.tokenUsage;
  c.updatedAt = Date.now();
}
