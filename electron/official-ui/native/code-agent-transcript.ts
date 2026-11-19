import type { Conversation, Item, Settings, Turn } from "../../../shared/types";
import { agentThreadIds } from "../../../shared/workflow-usage";
import { codeAgentActivityText } from "./code-tool-transcript";
import {
  convertCodeTranscript,
  type CodeTranscriptRow,
} from "./code-transcript";

export type CodeAgentEvent = {
  task_id: string;
  tool_use_id: string;
} & (
  | {
      subtype: "task_started";
      task_type: "local_agent";
      description: string;
      prompt?: string;
    }
  | { subtype: "task_progress"; usage: { total_tokens: number } }
  | {
      subtype: "task_notification";
      status: "completed" | "failed" | "stopped";
      summary: string;
    }
);

export function codeAgentTranscript(
  conversation: Conversation,
  turn: Turn,
  item: Item,
  parentUuid: string | null,
  mcpServers?: Settings["mcpServers"],
): CodeTranscriptRow[] {
  if (
    !(item.type === "subAgentActivity" && item.kind === "started") &&
    !(item.type === "collabAgentToolCall" && item.tool === "spawnAgent")
  )
    return [];
  if (codeAgentActivityText(item) === undefined) return [];
  const rows: CodeTranscriptRow[] = [];
  for (const agentId of agentThreadIds(item)
    .slice(0, 32)
    .filter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id))) {
    const toolId = `${turn.id}:agent:${item.id}:${agentId}`;
    const prompt =
      typeof item.agentPrompt === "string"
        ? item.agentPrompt
        : typeof item.prompt === "string"
          ? item.prompt
          : (item.agentThreads?.[agentId]?.turns[0]?.prompt ?? "");
    const description =
      typeof item.description === "string" ? item.description : "Subagent";
    const base = {
      sessionId: conversation.id,
      timestamp: new Date(turn.createdAt).toISOString(),
      isSidechain: false,
      parentUuid,
    };
    rows.push({
      ...base,
      type: "assistant",
      uuid: `${toolId}:use`,
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: toolId,
            name: "Agent",
            input: { description, prompt, subagent_type: "general-purpose" },
          },
        ],
      },
    });
    const result = { agentId, isAsync: true };
    rows.push({
      ...base,
      type: "user",
      uuid: `${toolId}:result`,
      parentUuid: `${toolId}:use`,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolId,
            content: JSON.stringify(result),
            is_error: false,
          },
        ],
      },
      toolUseResult: result,
    });
    rows.push({
      ...base,
      type: "system",
      uuid: `${toolId}:start`,
      subtype: "task_started",
      task_id: agentId,
      tool_use_id: toolId,
      task_type: "local_agent",
      description,
      ...(prompt ? { prompt } : {}),
      message: { role: "assistant", content: [] },
    });
    const child = item.agentThreads?.[agentId];
    if (child) {
      const converted = convertCodeTranscript({
        ...conversation,
        id: conversation.id,
        turns: child.turns,
      }, undefined, { mcpServers });
      rows.push(
        ...converted.rows
          .filter((row) => row.type === "user" || row.type === "assistant")
          .map((row) => ({
            ...row,
            uuid: `${agentId}:${row.uuid}`,
            parentUuid: row.parentUuid ? `${agentId}:${row.parentUuid}` : null,
            parent_tool_use_id: row.parent_tool_use_id ?? toolId,
            agentId: row.agentId ?? agentId,
            isSidechain: true,
          })),
      );
    }
    const tokens = item.agentTokenUsage?.[agentId];
    if (
      typeof tokens === "number" &&
      Number.isSafeInteger(tokens) &&
      tokens >= 0
    )
      rows.push({
        ...base,
        type: "system",
        uuid: `${toolId}:usage`,
        subtype: "task_progress",
        task_id: agentId,
        tool_use_id: toolId,
        usage: { total_tokens: tokens },
        message: { role: "assistant", content: [] },
      });
    const status =
      child?.turns.at(-1)?.status ?? item.agentsStates?.[agentId]?.status;
    const terminal =
      status === "completed"
        ? "completed"
        : ["failed", "errored"].includes(status)
          ? "failed"
          : ["interrupted", "shutdown", "stopped"].includes(status)
            ? "stopped"
            : undefined;
    if (terminal)
      rows.push({
        ...base,
        type: "system",
        uuid: `${toolId}:done`,
        subtype: "task_notification",
        task_id: agentId,
        tool_use_id: toolId,
        status: terminal,
        summary:
          child?.turns
            .flatMap((turn) => turn.items)
            .filter((item) => item.type === "agentMessage")
            .at(-1)?.text ?? "",
        message: { role: "assistant", content: [] },
      });
  }
  return rows;
}
