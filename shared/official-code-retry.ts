import { z } from "zod";
import type { Turn } from "./types";

export const officialCodeApiRetryMessage = z.object({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  uuid: z.string(),
  session_id: z.string(),
  parent_tool_use_id: z.null(),
  claudex_transient: z.literal(true),
  attempt: z.number().int().positive(),
  max_retries: z.number().int().positive(),
  error: z.enum(["unknown", "authentication_failed", "rate_limit", "overloaded"]),
}).refine((event) => event.attempt <= event.max_retries);

export type CodeApiRetryMessage = z.infer<typeof officialCodeApiRetryMessage>;

export function codeApiRetryMessage(
  sessionId: string,
  turn: Turn | undefined,
): CodeApiRetryMessage | undefined {
  if (turn?.status !== "inProgress" || !turn.streamRetry) return;
  const { attempt, maxRetries, cause } = turn.streamRetry;
  return {
    type: "system",
    subtype: "api_retry",
    uuid: `${turn.id}:api-retry:${attempt}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    claudex_transient: true,
    attempt,
    max_retries: maxRetries,
    error: cause ?? "unknown",
  };
}

export function codeApiRetryClearedMessage(sessionId: string) {
  return {
    type: "system",
    subtype: "api_retry_cleared",
    session_id: sessionId,
    parent_tool_use_id: null,
    claudex_transient: true,
  } as const;
}
