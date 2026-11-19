const uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const path = new RegExp(`^/api/organizations/(${uuid})/chat_conversations/(${uuid})/chat_messages/([^/]{1,1536})/chat_feedback$`);

export function officialReplyFeedbackTarget(method: string, pathname: string) {
  const match = (method === "POST" || method === "PUT") && path.exec(pathname);
  if (!match) return undefined;
  try {
    const messageId = decodeURIComponent(match[3]);
    return /^[A-Za-z0-9_.:-]{1,512}$/.test(messageId)
      ? { organizationId: match[1], conversationId: match[2], messageId } : undefined;
  } catch { return undefined; }
}

export const legacyReplyFeedbackTypes = new Map<string, number>([
  ["chat_ended", 10], ["flag/web-url", 10], ["flag/shallow", 10], ["flag/citations", 10],
  ["flag/verbose", 10], ["flag/context", 10], ["flag/content", 10],
  ["upvote", 1], ["flag", 2], ["flag/bug", 3], ["flag/harmful", 4],
  ["flag/refusal", 5], ["flag/file", 6], ["flag/instructions", 7], ["flag/facts", 8],
  ["flag/incomplete", 9], ["flag/other", 10], ["flag/thoughts", 12],
  ["flag/web-over", 13], ["flag/web-under", 14], ["flag/web-sources", 15],
  ["flag/think-under", 16], ["flag/memory", 17], ["flag/constitution", 18],
  ["sc/false_positive", 19], ["flag/art-file", 20], ["flag/art-broken", 21],
  ["flag/art-generic", 22], ["flag/art-brand", 23], ["flag/art-unwanted", 24],
  ["flag/art-overedit", 25], ["flag/art-no-load", 26], ["flag/art-slow", 27], ["flag/art-cutoff", 28],
]);
