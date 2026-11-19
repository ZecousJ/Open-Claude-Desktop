import { z } from "zod";

const identity = z.string().min(1).max(500);
const timestamp = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const creation = { turnCreatedAt: timestamp, conversationCreatedAt: timestamp };
export const interruptTargetSchema = z.union([
  z
    .object({
      ...creation,
      kind: z.literal("starting"),
      turnId: identity.startsWith("pending-"),
    })
    .strict(),
  z
    .object({
      ...creation,
      turnId: identity.refine(
        (value) => !value.startsWith("pending-"),
        "A stable turn identity is required.",
      ),
      threadId: identity.optional(),
    })
    .strict(),
]);

/** A starting turn can acquire its native thread and turn IDs while Stop is in flight. */
export type InterruptTarget = z.infer<typeof interruptTargetSchema>;

/** accepted acknowledges local cancellation or engine dispatch, not an upstream terminal notification. */
export type InterruptTargetResult = {
  status: "accepted" | "already_finished" | "mismatch";
};
