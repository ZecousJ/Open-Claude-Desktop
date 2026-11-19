import { z } from "zod";
import { codeEffortLevels } from "./code-effort";
import { cloudEnvironmentId } from "./cloud-environments-input";

const permissionModes = ["default", "acceptEdits", "plan", "auto", "bypassPermissions"] as const;
const picks = z.strictObject({
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(codeEffortLevels).optional(),
  permissionMode: z.enum(permissionModes).optional(),
  shownPermissionMode: z.enum(permissionModes).optional(),
  useWorktree: z.boolean().optional(),
});

export const officialCodeSideSessionTarget = z.discriminatedUnion("target", [
  z.strictObject({
    target: z.literal("local"),
    auto: z.boolean().optional(),
    environmentId: z.undefined().optional(),
    poolId: z.undefined().optional(),
    useWorktree: z.boolean().optional(),
    picks: picks.optional(),
  }),
  z.strictObject({
    target: z.literal("cloud"),
    environmentId: cloudEnvironmentId.optional(),
    poolId: z.string().min(1).max(150).optional(),
    useWorktree: z.undefined().optional(),
    auto: z.boolean().optional(),
    picks: picks.optional(),
  }),
]);

export const codeSideSessionPlacement = z.strictObject({
  worktree: z.boolean().optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.enum(codeEffortLevels).optional(),
  codePermissionMode: z.enum(["manual", "acceptEdits", "plan", "auto", "bypass"]).optional(),
});
export type CodeSideSessionPlacement = z.infer<typeof codeSideSessionPlacement>;

export const codeCloudSideSessionTarget = z.strictObject({
  environmentId: cloudEnvironmentId,
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(210),
  model: z.string().min(1).max(200),
  effort: z.enum(codeEffortLevels).optional(),
  permissionMode: z.enum(permissionModes).optional(),
});
export type CodeCloudSideSessionTarget = z.infer<typeof codeCloudSideSessionTarget>;

export const codeCloudSideSessionIdentity = z.strictObject({
  request_id: z.string().uuid(),
  parent_session_id: z.string().uuid(),
  task_id: z.string().regex(/^task_[a-f0-9]{8}$/),
});
export const codeCloudSideSessionId = z.string().regex(/^session_[a-f0-9]{32}$/);

export type CodeCloudHelperStart = {
  taskId: string;
  requestId: string;
  toolCallId: string;
  threadId: string;
  turnId: string;
  title: string;
  brief: string;
  requestedEnvironment?: string;
  requestedRepository?: string;
  target: CodeCloudSideSessionTarget;
  environmentUpdatedAt: number;
  environmentHash: string;
  createdAt: number;
} & ({ state: "pending" } | { state: "started"; sessionId: string });
