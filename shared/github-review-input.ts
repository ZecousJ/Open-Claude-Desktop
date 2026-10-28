import { z } from "zod";
import { validRepositoryName } from "./github-parse";

const body = z.string().trim().min(1).max(65536);
const id = z.number().int().positive().safe();
export const githubReviewInput = z.intersection(
  z.object({
    repository: z.string().max(140).refine(validRepositoryName),
    number: id,
  }),
  z.discriminatedUnion("action", [
    z.object({
      action: z.enum(["files", "timeline", "comments", "checks", "threads"]),
    }),
    z
      .object({
        action: z.enum(["resolve", "threadReply"]),
        threadId: z.string().regex(/^[A-Za-z0-9_=-]{4,200}$/),
        body: body.optional(),
      })
      .refine((input) => input.action !== "threadReply" || Boolean(input.body)),
    z.object({ action: z.enum(["annotations", "rerun"]), checkRunId: id }),
    z
      .object({
        action: z.literal("comment"),
        commitSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
        path: z.string().min(1).max(4096),
        line: id,
        startLine: id.optional(),
        side: z.enum(["LEFT", "RIGHT"]).optional(),
        body,
      })
      .refine(
        (input) =>
          input.startLine === undefined || input.startLine <= input.line,
      ),
    z.object({ action: z.literal("reply"), commentId: id, body }),
    z
      .object({
        action: z.literal("review"),
        event: z.enum(["COMMENT", "APPROVE", "REQUEST_CHANGES"]),
        body: body.optional(),
      })
      .refine((input) => input.event === "APPROVE" || Boolean(input.body)),
  ]),
);
