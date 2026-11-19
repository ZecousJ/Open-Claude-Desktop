import { z } from "zod";
import {
  cleanBaseIds,
  knowledgeBaseId,
  maxConversationBases,
} from "../../shared/knowledge-api";
import type { AppEvent, Attachment, Conversation } from "../../shared/types";
import type { Store } from "../store/store";
import type { Engine } from "../engine/engine";
import type { Scheduler } from "../routines/scheduler";
import type { ReplyFeedback } from "../conversations/reply-feedback";
import type { WorkspaceTrustGate } from "./workspace-trust";
import { registerConversationManageHandlers } from "./conversation-manage-handlers";
import { registerConversationTurnHandlers } from "./conversation-turn-handlers";
import { registerResumableSessions } from "./resumable-sessions";
import { wslEnvironmentInput } from "../workspace/workspace-fs";

export type Handle = (name: string, fn: (...args: any[]) => any) => void;
export interface Context {
  readonly accountActivationIdentity?: unknown;
  readonly accountRetiring?: boolean;
  readonly activeAccount?: { id: string };
  readonly scheduler?: Scheduler;
  knowledgeCatalog?(): Promise<import("../../shared/knowledge-api").KnowledgeBaseInfo[]>;
  readonly store: Store;
  readonly engine: Engine;
  readonly replyFeedback: ReplyFeedback;
  selectedAttachments: Map<string, Attachment>;
  policy?(): import("../../shared/client-policy").ClientPolicy;
  allowedFolder: (folder?: string) => void;
  noActive: () => void;
  closeTerminals?: (conversationId: string) => Promise<void>;
  /** Tells the account's windows (and, on the runner, its devices). */
  push?: (event: AppEvent) => void;
  /** Code's workspace trust (desktop only, electron/ipc/workspace-trust.ts). */
  readonly services?: {
    workspaceTrust?: WorkspaceTrustGate;
    ssh?: Pick<import("./ssh").SshServiceApi, "allowed" | "hosts">;
    folderBranchSwitch?: import("../git/folder-branch").FolderBranchSwitch;
  };
  accountGeneration?(): unknown;
}
export const string = z.string().min(1).max(500);
/** Where a new conversation runs (R9); missing means this computer. */
export const environmentInput = z.union([
  z.object({ kind: z.literal("local") }).strict(),
  wslEnvironmentInput,
  // Only the cloud runner sets a space (runner/src/dispatcher.ts); a window's
  // own environment never names one (runner/src/method-guard.ts).
  z
    .object({
      kind: z.literal("space"),
      spaceId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ssh"),
      hostId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
    })
    .strict(),
]);
/** A conversation's knowledge bases (shared/knowledge-api.ts). */
export const knowledgeBasesInput = z
  .array(z.string().regex(knowledgeBaseId))
  .max(maxConversationBases)
  .transform((ids) => cleanBaseIds(ids));

export function registerConversationHandlers(handle: Handle, context: Context) {
  registerResumableSessions(handle, context);
  const { engineOf } = registerConversationTurnHandlers({ context, handle });
  handle("restartEngine", async () => {
    context.noActive();
    await context.engine.stop();
    await context.engine.ensure(
      context.store.settings.providers.find(
        (p) => p.id === context.store.settings.activeProviderId,
      )!,
    );
  });
  registerConversationManageHandlers({ context, engineOf, handle });
}
