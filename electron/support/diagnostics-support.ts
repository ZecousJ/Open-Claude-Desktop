import os from "node:os";
import { type ClaudexBootstrap } from "../../shared/claudex-contract";
import type { Conversation } from "../../shared/types";
import { describeSub2ApiRefusal } from "../../server/sub2api-errors";
import type { ReportingFlags, QueueFile, ReporterClient } from "./diagnostics";

/** The service's collection switches; undefined before a bootstrap arrived. */
export function reportingFlags(
  bootstrap: ClaudexBootstrap | undefined,
): ReportingFlags | undefined {
  if (!bootstrap) return undefined;
  const feedback = bootstrap.features.feedback;
  return {
    diagnostics: bootstrap.features.diagnostics,
    feedback,
    allowConversationExcerpt:
      feedback && !!bootstrap.feedback?.feedback.allowConversationExcerpt,
  };
}

// ---------------------------------------------------------------------------
// Redaction

const maxMessage = 300;

/** Keys, bearer tokens and e-mail addresses become placeholders. */
export function redactSecrets(text: string) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{6,}/g, "[key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [token]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      "[token]",
    )
    .replace(
      /\b((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|secret|password)\s*[:=]\s*)["']?[^\s"',;]+/gi,
      "$1[secret]",
    )
    .replace(
      /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g,
      "[email]",
    );
}

/**
 * A diagnostic message: secrets, e-mail addresses and anything that looks
 * like a file path or URL removed, control characters dropped, at most 300
 * characters.
 */
export function redactMessage(text: string) {
  return (
    redactSecrets(text.slice(0, 2000))
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      // A quoted path may contain spaces.
      .replace(/(["'`])[^"'`]*[\\/][^"'`]*\1/g, "$1[path]$1")
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
      .replace(/\b[A-Za-z]:\\[^\s"'<>|]*/g, "[path]")
      .replace(/\\\\[^\s"'<>|]+/g, "[path]")
      .replace(/(^|[\s"'(=:])~?\/[^\s"'<>)]+/g, "$1[path]")
      // Relative paths such as src/app/file.ts.
      .replace(/\b[\w.-]+(?:[\\/][\w.-]+)+\.[A-Za-z0-9]{1,8}\b/g, "[path]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxMessage)
  );
}

/** Texts this client writes itself: safe to report as they are. */
const clientTemplates = new Set<string>([
  "The Claudex service is unreachable.",
  "No model is assigned to this account yet.",
]);

/** The refusal texts `describeSub2ApiRefusal` writes: a failed turn with one is reported as its refusal. */
const refusalTemplates = new Set<string>(
  [
    [401, "INVALID_API_KEY"],
    [402, "INSUFFICIENT_BALANCE"],
    [429, "DAILY_LIMIT_EXCEEDED"],
    [429, "WEEKLY_LIMIT_EXCEEDED"],
    [429, "MONTHLY_LIMIT_EXCEEDED"],
    [429, "USAGE_LIMIT_EXCEEDED"],
    [429, "API_KEY_QUOTA_EXHAUSTED"],
    [429, "API_KEY_RATE_5H_EXCEEDED"],
    [429, "API_KEY_RATE_1D_EXCEEDED"],
    [429, "API_KEY_RATE_7D_EXCEEDED"],
    [403, "SUBSCRIPTION_EXPIRED"],
    [403, "SUBSCRIPTION_SUSPENDED"],
    [403, "SUBSCRIPTION_INVALID"],
    [403, "GROUP_DISABLED"],
    [403, "API_KEY_DISABLED"],
    [403, "API_KEY_EXPIRED"],
    [403, "USER_INACTIVE"],
    [403, "USER_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [403, "MODEL_NOT_ALLOWED"],
  ]
    .map(
      ([status, code]) =>
        describeSub2ApiRefusal(
          status as number,
          JSON.stringify({
            code,
            message: code === "MODEL_NOT_ALLOWED" ? "model" : "",
          }),
        )?.message,
    )
    .filter((text): text is string => !!text),
);

/** A failed turn's category, when its text is not one of this client's own. */
export function turnErrorCategory(error: string) {
  const text = error.toLowerCase();
  if (/context (length|window)|maximum context|too many tokens/.test(text))
    return "context_length";
  if (/timed? ?out|timeout/.test(text)) return "timeout";
  if (/\b429\b|rate.?limit|too many requests/.test(text)) return "rate_limited";
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key/.test(text))
    return "auth";
  if (
    /\bmodel\b/.test(text) &&
    /not (found|supported|available)|does not exist|unknown/.test(text)
  )
    return "model_unavailable";
  if (
    /\b5\d\d\b|server error|internal error|bad gateway|overloaded|service unavailable/.test(
      text,
    )
  )
    return "server_error";
  if (
    /unreachable|econn|enotfound|network|fetch failed|socket|disconnect|stream (closed|ended)|connection/.test(
      text,
    )
  )
    return "network";
  return "unknown";
}

/** The code and message a failed turn is reported with; undefined for a refusal (reported on its own). */
export function describeTurnError(error: string) {
  const text = error.trim();
  if (refusalTemplates.has(text)) return undefined;
  if (clientTemplates.has(text))
    return { code: "TURN_CLIENT", message: text.slice(0, maxMessage) };
  const category = turnErrorCategory(text);
  return { code: `TURN_${category.toUpperCase()}`, message: category };
}

/** Categories as the service accepts them: `[a-z0-9_-]{1,32}`, at most 10. */
export function feedbackCategories(categories: readonly string[] = []) {
  return [
    ...new Set(
      categories
        .map((item) =>
          item
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 32),
        )
        .filter(Boolean),
    ),
  ].slice(0, 10);
}

const maxExcerpt = 20_000;

/** The conversation up to the rated reply, newest text kept when it is long. */
export function conversationExcerpt(
  conversation: Conversation,
  turnId: string,
) {
  const index = conversation.turns.findIndex((turn) => turn.id === turnId);
  if (index < 0) return null;
  const parts: string[] = [];
  for (const turn of conversation.turns.slice(0, index + 1)) {
    if (turn.prompt) parts.push(`User: ${turn.prompt}`);
    const reply = turn.items
      .filter((item) => item.type === "agentMessage" && item.text)
      .map((item) => item.text)
      .join("\n\n");
    if (reply) parts.push(`Assistant: ${reply}`);
  }
  // Only the newest text is kept; redact a little more than that so a secret
  // cut at the edge is still recognised.
  const joined = parts.join("\n\n");
  const text = redactSecrets(joined.slice(-(maxExcerpt + 1000)));
  return text.length > maxExcerpt ? text.slice(text.length - maxExcerpt) : text;
}

// ---------------------------------------------------------------------------
// Queue

export const maxDiagnostics = 500;

export const maxFeedback = 200;

export const batchSize = 50;

/** A rating waits this long for the feedback dialog's categories and comment. */
export const ratingGraceMs = 2 * 60_000;

/** The service's switches are read again when older than this. */
export const statusMaxAgeMs = 10 * 60_000;

export const minBackoffMs = 60_000;

export const maxBackoffMs = 60 * 60_000;

export function validQueue(value: unknown): value is QueueFile {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    Array.isArray(data.diagnostics) &&
    Array.isArray(data.feedback) &&
    data.diagnostics.every(
      (item) =>
        !!item &&
        typeof item.id === "string" &&
        typeof item.kind === "string" &&
        typeof item.code === "string" &&
        typeof item.message === "string" &&
        typeof item.occurredAt === "number",
    ) &&
    data.feedback.every(
      (item) =>
        !!item &&
        typeof item.conversationId === "string" &&
        typeof item.turnId === "string" &&
        typeof item.dueAt === "number" &&
        !!item.report &&
        typeof item.report.id === "string",
    )
  );
}

export function reporterClient(appVersion: string): ReporterClient {
  const name =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : "Linux";
  return {
    appVersion,
    platform: process.platform,
    arch: process.arch,
    osVersion: `${name} ${os.release()}`.slice(0, 64),
  };
}
