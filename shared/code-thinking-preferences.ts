import { z } from "zod";
import type { Conversation } from "./types";

export const codeThinkingPreferenceSnapshotSchema = z
  .object({
    id: z.string().min(1).max(500),
    createdAt: z.number().finite().nonnegative(),
    thinkingSummariesWanted: z.boolean().nullable(),
  })
  .strict();

/** Identity and explicit preference only: no transcript or global default. */
export function codeThinkingPreferenceSnapshot(c: Conversation) {
  return codeThinkingPreferenceSnapshotSchema.parse({
    id: c.id,
    createdAt: c.createdAt,
    thinkingSummariesWanted: c.thinkingSummariesWanted ?? null,
  });
}
