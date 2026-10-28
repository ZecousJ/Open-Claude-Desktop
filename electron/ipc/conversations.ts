import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ResumeSessions, resumeTurns } from "../engine/resume-sessions";
import { CliSessions } from "../conversations/cli-sessions";
import type { AppEvent, Attachment, Conversation } from "../../shared/types";
import type { Store } from "../store/store";
import type { Engine } from "../engine/engine";
import type { Scheduler } from "../routines/scheduler";
import type { ReplyFeedback } from "../conversations/reply-feedback";
import type { WorkspaceTrustGate } from "./workspace-trust";
import { registerConversationManageHandlers } from "./conversation-manage-handlers";
import { registerConversationTurnHandlers } from "./conversation-turn-handlers";

export type Handle = (name: string, fn: (...args: any[]) => any) => void;
export interface Context {
  readonly scheduler?: Scheduler;
  readonly store: Store;
  readonly engine: Engine;
  readonly replyFeedback: ReplyFeedback;
  selectedAttachments: Map<string, Attachment>;
  allowedFolder: (folder?: string) => void;
  noActive: () => void;
  closeTerminals?: (conversationId: string) => Promise<void>;
  /** Tells the account's windows (and, on the runner, its devices). */
  push?: (event: AppEvent) => void;
  /** Code's workspace trust (desktop only, electron/ipc/workspace-trust.ts). */
  readonly services?: { workspaceTrust?: WorkspaceTrustGate };
  cliConfigDir?(): string | undefined;
}
export const string = z.string().min(1).max(500);
/** Where a new conversation runs (R9); missing means this computer. */
export const environmentInput = z.union([
  z.object({ kind: z.literal("local") }).strict(),
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
export function registerConversationHandlers(handle: Handle, context: Context) {
  const resumable = new ResumeSessions({
    request: (method, params) =>
      context.engine.resumeSessionRequest(method, params),
    conversations: () => context.store.conversations,
    scope: () => context.store.root,
    allowFolder: (cwd) => {
      context.allowedFolder(cwd);
      context.services?.workspaceTrust?.assert({ mode: "code", cwd });
    },
  });
  const cli = new CliSessions({
    configDir: () =>
      context.cliConfigDir?.() ??
      (context.engine.environment?.kind === "space"
        ? `${context.store.root}/claude-config`
        : undefined),
    conversations: () => context.store.conversations,
    scope: () => context.store.root,
    allowFolder: (cwd) => {
      context.allowedFolder(cwd);
      context.services?.workspaceTrust?.assert({ mode: "code", cwd });
    },
  });
  handle("listResumableSessions", async () => {
    const [native, imported] = await Promise.all([
      resumable.list(),
      cli.list().catch(() => []),
    ]);
    return [...native, ...imported].sort(
      (first, second) => second.lastActivityAt - first.lastActivityAt,
    );
  });
  handle("previewResumeSession", async (raw: unknown) =>
    cli.owns(z.string().uuid().parse(raw))
      ? (await cli.read(raw as string)).turns
      : resumeTurns(await resumable.read(raw as string)),
  );
  const importCli = async (handle: string) => {
    const root = context.store.root;
    const transcript = await cli.read(handle, true);
    if (
      root !== context.store.root ||
      context.store.conversations.some(
        (entry) => entry.importedCliSessionId === transcript.sessionId,
      )
    )
      throw new Error("Couldn’t resume that session.");
    const settings = context.store.settings;
    const provider = settings.providers.find(
      (entry) => entry.id === settings.activeProviderId,
    );
    if (!provider) throw new Error("Couldn’t resume that session.");
    const conversation: Conversation = {
      id: randomUUID(),
      importedCliSessionId: transcript.sessionId,
      importedHistory: true,
      title: transcript.title || "Untitled session",
      mode: "code",
      cwd: transcript.cwd,
      providerId: provider.id,
      model: provider.model,
      environment: context.engine.environment,
      pinned: false,
      archived: false,
      createdAt: transcript.turns[0]?.createdAt ?? transcript.modifiedAt,
      updatedAt: transcript.modifiedAt,
      turns: transcript.turns,
    };
    context.store.conversations.unshift(conversation);
    context.store.flush();
    context.push?.({
      type: "conversation",
      conversation: structuredClone(conversation),
    });
    return conversation;
  };
  handle("probeImportableCliSessions", async () => ({
    count: (await cli.list()).filter((entry) => !entry.folderMissing).length,
  }));
  handle("importAllCliSessions", async () => {
    const root = context.store.root;
    let imported = 0,
      skipped = 0;
    for (const entry of await cli.list()) {
      if (root !== context.store.root) break;
      try {
        await importCli(entry.handle);
        imported++;
      } catch {
        skipped++;
      }
    }
    return { imported, skipped };
  });
  const { engineOf } = registerConversationTurnHandlers({
    cli,
    context,
    handle,
    importCli,
    resumable,
  });
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
