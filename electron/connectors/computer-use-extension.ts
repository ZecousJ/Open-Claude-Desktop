/**
 * Computer use in the engine (R10-E). The broker (electron/ipc/computer-use.ts,
 * R10-M) decides whether a conversation may use the computer; this engine
 * extension (S1's registry) offers the `computer-use` MCP adapter to the
 * threads that may, and to no others:
 * - per thread, through `builtinMcpServers`: the server is in the thread's
 *   config only while the broker says computer use is on for the
 *   conversation (policy, the person's setting, Code or Cowork, this
 *   computer, macOS permissions). A change reloads the thread at its next
 *   send, so turning computer use off takes the tools away.
 * - never for a routine's run: nobody is at the computer to answer the
 *   access card. The scheduler says which conversations are unattended,
 *   including the one it is creating right now, and the broker is told too
 *   so a call that still arrives is refused.
 * - with the guidance for the model as turn context, once per thread (the
 *   developer instructions are fixed when a thread starts, and computer use
 *   can be turned on later).
 * - the screenshots in tool results are kept on disk by the broker; the
 *   recorded items name them instead of carrying their base64.
 * - a deleted conversation's grants and screenshots are removed.
 */
import {
  onThisMachine,
  type Conversation,
  type Item,
} from "../../shared/types";
import {
  computerUseInstructions,
  computerUseServerName,
} from "../../shared/computer-use";
import type { AppContext } from "../app/app-context";
import type {
  BuiltinMcpServer,
  EngineExtension,
  EngineTurnContext,
} from "../engine/engine-extensions";
import type { ComputerUseService } from "../computer-use/service";
import { withScreenshotRefs } from "../conversations/agent-transcript-item";

export const computerUseExtensionId = "computer-use";

export interface ComputerUseExtensionDeps {
  /** The signed-in account's computer use, when it is running. */
  service(): ComputerUseService | undefined;
  /** A routine's run works in this conversation (or is creating it). */
  unattended(conversation: Readonly<Conversation>): boolean;
  /** A conversation used computer use in this session (for clean-up on delete). */
  used?(conversationId: string): void;
}

/** The adapter entry for a conversation's thread, or undefined when it isn't offered. */
export function computerUseServerFor(
  ctx: Pick<EngineTurnContext, "conversation" | "mode">,
  deps: ComputerUseExtensionDeps,
): BuiltinMcpServer | undefined {
  const service = deps.service();
  if (!service) return undefined;
  const conversation = ctx.conversation;
  // The broker refuses Chat too; the turn's mode is checked here as well
  // because a send may switch the conversation's mode.
  if (ctx.mode === "chat" || conversation.mode === "chat") return undefined;
  if (!onThisMachine(conversation.environment)) return undefined;
  // The broker follows the scheduler's answer here too, so a run that
  // failed before the scheduler saw it doesn't stay unattended.
  const unattended = deps.unattended(conversation);
  service.markUnattended(conversation.id, unattended);
  if (unattended) return undefined;
  const server = service.mcpServer(conversation.id);
  if (!server || server.name !== computerUseServerName) return undefined;
  deps.used?.(conversation.id);
  return {
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
    startupTimeoutSec: server.startupTimeoutSec,
    // request_access waits for the person (up to 10 minutes).
    toolTimeoutSec: server.toolTimeoutSec,
    // Access is asked for on the broker's card, not by Codex a second time.
    defaultToolsApprovalMode: "approve",
  };
}

/** The engine extension; keeps which thread already got the guidance. */
export function computerUseExtension(
  deps: ComputerUseExtensionDeps,
): EngineExtension & { forget(conversationId: string): void } {
  /** Conversation → the thread that was given the guidance. */
  const guided = new Map<string, string>();
  return {
    id: computerUseExtensionId,
    // Incognito chats may use it too; their screenshots stay in memory.
    incognito: true,
    reservedMcpServerNames: [computerUseServerName],
    builtinMcpServers(ctx) {
      const server = computerUseServerFor(ctx, deps);
      return server ? [server] : undefined;
    },
    turnContext(ctx) {
      const threadId = ctx.conversation.threadId;
      if (!threadId || !computerUseServerFor(ctx, deps)) return undefined;
      if (guided.get(ctx.conversation.id) === threadId) return undefined;
      guided.set(ctx.conversation.id, threadId);
      return { guidance: computerUseInstructions };
    },
    recordItem(item: Item) {
      const trimmed = withScreenshotRefs(item);
      return trimmed === item ? undefined : trimmed;
    },
    forget(conversationId) {
      guided.delete(conversationId);
    },
  };
}

/** How often conversations that used computer use are checked for deletion. */
const deletionCheckMs = 30_000;

/**
 * Adds the extension to each signed-in account's local engine (SSH
 * conversations never get computer use), follows the scheduler's
 * unattended runs and cleans up after deleted conversations.
 */
export function registerComputerUseExtension(
  ctx: Pick<
    AppContext,
    | "engine"
    | "scheduler"
    | "services"
    | "store"
    | "onAccountActivated"
    | "onAccountDeactivating"
  >,
  options: { deletionCheckMs?: number } = {},
) {
  let cleanup: (() => void) | undefined;
  ctx.onAccountActivated(() => {
    cleanup?.();
    const engine = ctx.engine;
    const scheduler = ctx.scheduler;
    const service = () => ctx.services.computerUse;
    /** Conversations that used computer use this session. */
    const used = new Set<string>();
    const extension = computerUseExtension({
      service,
      unattended: (conversation) =>
        Boolean(scheduler?.isUnattendedConversation(conversation)),
      used: (id) => used.add(id),
    });
    const remove = engine.extensions.has(computerUseExtensionId)
      ? undefined
      : engine.extensions.add(extension);
    const stopFollowing = scheduler?.onUnattendedChange((id, unattended) =>
      service()?.markUnattended(id, unattended),
    );
    const checkDeleted = () => {
      if (!used.size) return;
      const existing = new Set(ctx.store.conversations.map((c) => c.id));
      for (const id of used) {
        if (existing.has(id)) continue;
        used.delete(id);
        extension.forget(id);
        const current = service();
        current?.markUnattended(id, false);
        void current
          ?.deleteConversation(id)
          .catch((error) =>
            console.error(
              "Computer use clean-up:",
              error instanceof Error ? error.message : String(error),
            ),
          );
      }
    };
    const timer = setInterval(
      checkDeleted,
      options.deletionCheckMs ?? deletionCheckMs,
    );
    timer.unref?.();
    cleanup = () => {
      clearInterval(timer);
      stopFollowing?.();
      remove?.();
      cleanup = undefined;
    };
  });
  ctx.onAccountDeactivating(() => cleanup?.());
}
