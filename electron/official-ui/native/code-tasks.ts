import type { Conversation, Turn } from "../../../shared/types";
import { agentItems, agentThreadIds } from "../../../shared/workflow-usage";
import type { CodeAgentThread } from "../../engine/code-agent-threads";

export function codeAgentOutput(turns: Turn[]) {
  return {
    output: turns
      .flatMap((turn) => turn.items)
      .flatMap((item) =>
        item.type === "agentMessage" && item.text
          ? [item.text]
          : item.type === "commandExecution" && item.aggregatedOutput
            ? [item.aggregatedOutput]
            : [],
      )
      .join("\n"),
    truncated: false,
  };
}

export function createCodeTasks({
  get,
  call,
  writable,
}: {
  get(id: string): Promise<Conversation | undefined>;
  call(name: string, ...args: unknown[]): Promise<unknown>;
  writable(): boolean;
}) {
  async function task(sessionId: string, taskId: string) {
    const conversation = await get(sessionId);
    if (!conversation) throw Error("Code session not found.");
    if (
      !agentItems(conversation.turns).some((item) =>
        agentThreadIds(item).includes(taskId),
      )
    )
      throw Error("Agent is not part of this conversation.");
    return conversation;
  }
  return {
    async stop(sessionId: string, taskId: string) {
      const conversation = await task(sessionId, taskId);
      if (!writable() || conversation.archived)
        throw Error("Task controls are unavailable.");
      await call("stopWorkflowAgent", conversation.id, taskId);
    },
    async output(sessionId: string, taskId: string) {
      const conversation = await task(sessionId, taskId);
      const thread = (await call(
        "readCodeAgent",
        conversation.id,
        taskId,
      )) as CodeAgentThread;
      return codeAgentOutput(thread.turns);
    },
    async hydrate(conversation: Conversation) {
      const pending = [...conversation.turns.flatMap((turn) => turn.items)];
      for (const item of pending) {
        if (
          !(item.type === "subAgentActivity" && item.kind === "started") &&
          !(item.type === "collabAgentToolCall" && item.tool === "spawnAgent")
        )
          continue;
        for (const agentId of agentThreadIds(item)) {
          const saved = item.agentThreads?.[agentId];
          if (
            saved?.backfilled &&
            saved.turns.length &&
            saved.turns.every((turn) => turn.status !== "inProgress")
          ) {
            pending.push(...saved.turns.flatMap((turn) => turn.items));
            continue;
          }
          try {
            const thread = (await call(
              "readCodeAgent",
              conversation.id,
              agentId,
            )) as CodeAgentThread;
            item.agentThreads = { ...item.agentThreads, [agentId]: thread };
            pending.push(...thread.turns.flatMap((turn) => turn.items));
          } catch {
            // The persisted transcript remains readable while Codex is disconnected.
          }
        }
      }
    },
  };
}
