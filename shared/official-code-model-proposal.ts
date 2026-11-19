import { z } from "zod";
import {
  officialCodeSideSessionTarget,
  type CodeSideSessionPlacement,
} from "./official-code-side-session";

export const codeModelProposalId = z.string().regex(/^task_[a-f0-9]{8}$/);

export const codeModelProposalAction = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("start"),
    requestedId: z.string().uuid().optional(),
    useWorktree: z.boolean().optional(),
    wakeWhenDone: z.boolean().optional(),
    picks: officialCodeSideSessionTarget.options[0].shape.picks,
  }),
  z.strictObject({
    kind: z.literal("acceptOffer"),
    selection: officialCodeSideSessionTarget,
  }),
  z.strictObject({ kind: z.literal("pop"), launched: z.boolean() }),
]);

type ProposalPlacement = CodeSideSessionPlacement & {
  cwd: string;
  model: string;
};

export type CodeModelProposal = {
  id: string;
  title: string;
  brief: string;
  context: "fresh" | "fork";
  kind: "suggestion" | "offer";
  createdAt: number;
  expiresAt: number;
  sourceTurnId: string;
  sourceToolCallId?: string;
  sourceCwd: string;
  providerId: string;
} & CodeSideSessionPlacement & {
    state:
      | { kind: "pending" }
      | {
          kind: "claimed" | "started";
          childId: string;
          placement: ProposalPlacement;
        }
      | {
          kind: "cloudAccepted";
          requestId: string;
          target: import("./official-code-side-session").CodeCloudSideSessionTarget;
          environmentUpdatedAt: number;
          environmentHash: string;
          briefFilled: boolean;
        }
      | { kind: "dismissed" };
  };

export function codeModelProposalBrief(
  context: "fresh" | "fork",
  prompt: string,
  background = "",
) {
  if (context === "fresh")
    return `Background (from the session that started this one):\n${background}\n\nTask:\n${prompt}`;
  return [background, prompt].filter(Boolean).join("\n\n");
}
