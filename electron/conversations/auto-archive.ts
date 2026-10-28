import type { Conversation, Settings } from "../../shared/types";
import { preference } from "../../shared/settings-extras";

const DAY = 86_400_000;
/** How often inactive sessions are looked for. */
export const autoArchiveCheckMs = 30 * 60_000;

/** Whether a session has work going on: a turn, a command or an agent still running. */
function busy(conversation: Conversation) {
  return conversation.turns.some(
    (turn) =>
      turn.status === "inProgress" ||
      turn.items.some(
        (item) =>
          (item as { status?: string }).status === "inProgress" ||
          (item as { status?: string }).status === "running",
      ),
  );
}

/**
 * Settings → Claude Code → Archive inactive sessions: local Code sessions with
 * no activity for that long, not running and with no background work. Their
 * worktree goes only when it has no changes (the archive path keeps it
 * otherwise).
 */
export function inactiveSessions(
  conversations: readonly Conversation[],
  settings: Settings,
  now: number,
): string[] {
  const days = preference(settings, "autoArchiveDays");
  if (!days) return [];
  return conversations
    .filter(
      (c) =>
        c.mode === "code" &&
        !c.archived &&
        !c.incognito &&
        !c.pinned &&
        (!c.environment || c.environment.kind === "local") &&
        now - (c.updatedAt ?? 0) >= days * DAY &&
        !busy(c),
    )
    .map((c) => c.id);
}

/** Looks now and every half hour; the returned function stops it. */
export function startAutoArchive(deps: {
  settings: () => Settings | undefined;
  conversations: () => readonly Conversation[] | undefined;
  archive: (id: string) => Promise<unknown>;
  now?: () => number;
}): () => void {
  const check = async () => {
    const settings = deps.settings();
    const conversations = deps.conversations();
    if (!settings || !conversations) return;
    for (const id of inactiveSessions(
      conversations,
      settings,
      deps.now?.() ?? Date.now(),
    ))
      await deps.archive(id).catch(() => {});
  };
  void check();
  const timer = setInterval(() => void check(), autoArchiveCheckMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
