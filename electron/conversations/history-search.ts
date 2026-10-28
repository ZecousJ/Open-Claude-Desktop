import type { Conversation } from "../../shared/types";
import {
  historySearchInput,
  type HistorySearchHit,
} from "../../shared/history-search";

/** Characters kept on each side of a match in a snippet. */
const around = 40;

const snippetOf = (text: string, at: number, length: number) => {
  const start = Math.max(0, at - around);
  const end = Math.min(text.length, at + length + around);
  return (
    (start > 0 ? "…" : "") +
    text.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < text.length ? "…" : "")
  );
};

/**
 * The desktop's stored history search (the web runner's searchConversations
 * reads the service's store): titles, prompts and reply text of the
 * conversations on this computer, newest first, with the first matching
 * turn and a snippet.
 */
export function searchLocalConversations(
  conversations: Conversation[],
  query: unknown,
  options: unknown = {},
): { results: HistorySearchHit[] } {
  const input = historySearchInput.parse({
    ...(options && typeof options === "object" && !Array.isArray(options)
      ? options
      : {}),
    query,
  });
  const needle = input.query.toLocaleLowerCase();
  if (!needle) return { results: [] };
  const results: HistorySearchHit[] = [];
  const ordered = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const c of ordered) {
    if (results.length >= input.limit) break;
    if (c.archived && !input.includeArchived) continue;
    if (input.mode && c.mode !== input.mode) continue;
    if (input.projectId && (c.projectId !== input.projectId || c.incognito))
      continue;
    const hit: HistorySearchHit = {
      conversationId: c.id,
      title: c.title,
      mode: c.mode,
      ...(c.projectId ? { projectId: c.projectId } : {}),
      archived: Boolean(c.archived),
      updatedAt: c.updatedAt,
    };
    let found = false;
    for (const turn of c.turns) {
      const texts = [
        turn.prompt ?? "",
        ...turn.items.flatMap((item) =>
          item.type === "agentMessage" && typeof item.text === "string"
            ? [item.text]
            : [],
        ),
      ];
      for (const text of texts) {
        const at = text.toLocaleLowerCase().indexOf(needle);
        if (at < 0) continue;
        hit.turnId = turn.id;
        hit.snippet = snippetOf(text, at, needle.length);
        found = true;
        break;
      }
      if (found) break;
    }
    if (found || c.title.toLocaleLowerCase().includes(needle))
      results.push(hit);
  }
  return { results };
}
