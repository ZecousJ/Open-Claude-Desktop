/**
 * The past chats a `conversation_search` or `recent_chats` call returned,
 * read back from the text the tool gave the model
 * (electron/memory/tools.ts `chatListing`) so the transcript row can list
 * them. The text is data: only the id, title and time are read from the
 * `<chat …>` tags, and a chat whose id is not a plain identifier is left out.
 */
export interface PastChat {
  id: string;
  title: string;
  updatedAt: number;
}

const unescape = (text: string) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

export function parsePastChats(texts: string[]): PastChat[] {
  const chats: PastChat[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(
      /<chat id="([^"]*)" title="([^"]*)" updated_at="([^"]*)"/g,
    )) {
      const id = unescape(match[1]);
      const updatedAt = Date.parse(match[3]);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      chats.push({
        id,
        title: unescape(match[2]).trim() || "Untitled chat",
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
    }
  }
  return chats;
}
