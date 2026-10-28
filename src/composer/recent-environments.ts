import type { Conversation } from "../../shared/types";

/** When each environment was last used by a Code session. */
export function environmentUsage(conversations: Conversation[]) {
  const used = new Map<string, number>();
  for (const conversation of conversations) {
    if (conversation.mode !== "code" || conversation.incognito) continue;
    const id =
      conversation.environment?.kind === "space"
        ? `cloud:${conversation.cloudEnvironmentId ?? "default"}`
        : conversation.environment?.kind === "ssh"
          ? `ssh:${conversation.environment.hostId}`
          : conversation.cwd
            ? `folder:${conversation.cwd}`
            : "local";
    used.set(id, Math.max(used.get(id) ?? 0, conversation.updatedAt));
  }
  return used;
}

/** The picker follows environment usage. */
export function orderRecentEnvironments<Row extends { id: string }>(
  rows: Row[],
  conversations: Conversation[],
) {
  const used = environmentUsage(conversations);
  return [...rows].sort(
    (first, second) => (used.get(second.id) ?? 0) - (used.get(first.id) ?? 0),
  );
}
