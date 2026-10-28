/**
 * What computer use offers other packages through `ctx.services.computerUse`
 * (R10-E's engine extension adds the MCP server per thread; storage usage
 * counts screenshots). Set while an account is signed in; the implementation
 * is in `electron/ipc/computer-use.ts`.
 */
/** A built-in MCP server the engine adds to a thread's config (S1's builtinMcpServers, command form). */
export interface ComputerUseMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  startupTimeoutSec: number;
  /** request_access waits up to 10 minutes for the person. */
  toolTimeoutSec: number;
}

/** What other packages (R10-E's engine extension, storage usage) use. */
export interface ComputerUseService {
  /** Computer use is on for this conversation (policy, setting, mode, platform, permissions). */
  enabledFor(conversationId: string): boolean;
  /** The adapter for the conversation's thread, or undefined while computer use is off for it. */
  mcpServer(conversationId: string): ComputerUseMcpServer | undefined;
  /** Routines run unattended and never get computer use. */
  markUnattended(conversationId: string, unattended: boolean): void;
  /** Guidance for the model's instructions while the tools are offered. */
  readonly instructions: string;
  /** Bytes the saved screenshots take (Settings → Storage). */
  screenshotBytes(): number;
  /** A conversation was deleted: forget its grants and screenshots. */
  deleteConversation(conversationId: string): Promise<void>;
}

declare module "../app/app-context" {
  interface ComputerUseSlot extends ComputerUseService {}
}
