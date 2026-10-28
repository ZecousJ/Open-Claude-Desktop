import type { BackgroundTerminalInfo, Conversation } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
export interface RunningCommandTask {
  conversationId: string;
  turnId: string;
  itemId: string;
  command: string;
  cwd: string;
}
/** A foreground Codex command remains a task even when the native background list is empty. */
export function runningCommandTasks(
  conversations: Conversation[],
  native: BackgroundTerminalInfo[],
): RunningCommandTask[] {
  const listed = new Set(
    native.map((item) => `${item.conversationId}:${item.itemId}`),
  );
  return conversations
    .filter((conversation) => !conversation.archived)
    .flatMap((conversation) => {
      const turn = conversation.turns.at(-1);
      if (!turn || turn.status !== "inProgress") return [];
      return turn.items
        .filter(
          (item) =>
            item.type === "commandExecution" &&
            itemIsRunning(item) &&
            !listed.has(`${conversation.id}:${item.id}`),
        )
        .map((item) => ({
          conversationId: conversation.id,
          turnId: turn.id,
          itemId: item.id,
          command:
            typeof item.command === "string" && item.command.trim()
              ? item.command
              : "Running a command",
          cwd: typeof item.cwd === "string" ? item.cwd : "",
        }));
    });
}
