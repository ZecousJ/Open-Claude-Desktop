import type { Conversation } from "./types";

/**
 * Credentials that look like the real thing, found before a session is shared.
 * Only well-known shapes, so ordinary text and code do not raise it; sharing
 * goes ahead either way.
 */
const shapes: [string, RegExp][] = [
  ["api_key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  [
    "github_token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/,
  ],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe_key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["private_key", /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY(?: BLOCK)?-----/],
];

/** The kinds of credential in the texts, each once. */
export function scanSecrets(texts: string[]): string[] {
  const found = new Set<string>();
  for (const text of texts)
    for (const [kind, shape] of shapes) if (shape.test(text)) found.add(kind);
  return [...found];
}

/** What a session said and ran, as plain texts to scan. */
export function conversationTexts(
  conversation: Partial<Pick<Conversation, "turns">>,
): string[] {
  const texts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value) texts.push(value);
  };
  for (const turn of conversation.turns ?? []) {
    push(turn.prompt);
    for (const item of turn.items ?? []) {
      push(item.text);
      push(item.command);
      push(item.aggregatedOutput);
      for (const part of Array.isArray(item.content) ? item.content : [])
        push(part?.text);
      for (const part of Array.isArray(item.contentItems)
        ? item.contentItems
        : [])
        push(part?.text);
      if (item.arguments && typeof item.arguments === "object")
        push(JSON.stringify(item.arguments));
    }
  }
  return texts;
}
