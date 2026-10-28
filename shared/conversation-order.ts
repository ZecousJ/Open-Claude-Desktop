import type { Conversation } from "./types";

export type SidebarSection = "pinned" | "recent";
export type DropPosition = "before" | "after";

/**
 * When a conversation was last active, for ordering lists: the start of its
 * latest turn (the person's last message), else its last change. A reply that
 * streams changes `updatedAt` many times a second, so two running conversations
 * ordered by it swapped places over and over.
 */
export function lastActivityAt(
  c: Pick<Conversation, "turns" | "updatedAt">,
): number {
  const started = c.turns?.at(-1)?.createdAt;
  return typeof started === "number" && started > 0 ? started : c.updatedAt;
}

export function sortedSidebarConversations(items: Conversation[]) {
  return [...items].sort((a, b) => {
    const ar =
      Number.isSafeInteger(a.sidebarRank) && a.sidebarRank! >= 0
        ? a.sidebarRank
        : undefined;
    const br =
      Number.isSafeInteger(b.sidebarRank) && b.sidebarRank! >= 0
        ? b.sidebarRank
        : undefined;
    if (ar === undefined && br !== undefined) return -1;
    if (br === undefined && ar !== undefined) return 1;
    if (ar !== undefined && br !== undefined && ar !== br) return ar - br;
    return lastActivityAt(b) - lastActivityAt(a) || a.id.localeCompare(b.id);
  });
}

/** Reorders one account's visible sidebar lists without changing conversation recency or content. */
export function reorderSidebarConversations(
  all: Conversation[],
  sourceId: string,
  targetId: string | undefined,
  section: SidebarSection,
  position: DropPosition,
) {
  const source = all.find((c) => c.id === sourceId && !c.archived);
  if (!source) throw Error("Conversation to move was not found.");
  if (targetId === sourceId) return all;
  const pinned = sortedSidebarConversations(
    all.filter((c) => !c.archived && c.pinned && c.id !== sourceId),
  );
  const recent = sortedSidebarConversations(
    all.filter((c) => !c.archived && !c.pinned && c.id !== sourceId),
  );
  const destination = section === "pinned" ? pinned : recent;
  let index = 0;
  if (targetId) {
    const target = destination.findIndex((c) => c.id === targetId);
    if (target < 0)
      throw Error("Conversation drop target is not in this section.");
    index = target + (position === "after" ? 1 : 0);
  }
  destination.splice(index, 0, source);
  const ranks = new Map<string, { pinned: boolean; sidebarRank: number }>();
  pinned.forEach((c, i) => ranks.set(c.id, { pinned: true, sidebarRank: i }));
  recent.forEach((c, i) => ranks.set(c.id, { pinned: false, sidebarRank: i }));
  return all.map((c) => (ranks.has(c.id) ? { ...c, ...ranks.get(c.id)! } : c));
}
