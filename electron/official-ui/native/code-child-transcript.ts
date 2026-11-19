import { z } from "zod";
import type { Conversation } from "../../../shared/types";
import { convertCodeTranscript, type CodeTranscriptRow } from "./code-transcript";

const childTranscript = z.object({
  model: z.string(),
  context: z.string(),
  items: z.array(z.object({ id: z.string(), type: z.string() }).passthrough()).max(500),
  status: z.enum(["running", "completed", "failed", "stopped"]),
  truncated: z.boolean(),
  createdAt: z.number().finite().nonnegative().optional(),
});

/** Adapts the existing bounded child read; reading a log never runs a tool. */
export function projectCodeChildTranscript(
  projected: unknown,
  sessionId: string,
  toolId: string,
  childId: string,
): CodeTranscriptRow[] {
  const child = childTranscript.parse(projected);
  const conversation: Conversation = {
    id: sessionId, mode: "code", title: "", providerId: "", model: child.model,
    createdAt: child.createdAt ?? 0, updatedAt: child.createdAt ?? 0,
    pinned: false, archived: false,
    turns: [{
      id: `child:${childId}`, prompt: child.context, attachments: [], items: child.items,
      status: child.status === "running" ? "inProgress" : child.status === "stopped" ? "interrupted" : child.status,
      createdAt: child.createdAt ?? 0,
    }],
  };
  return convertCodeTranscript(conversation, undefined, { appendSettledNotices: true }).rows
    .filter(row => row.type === "user" || row.type === "assistant")
    .map(row => ({ ...row, isSidechain: true, parent_tool_use_id: toolId, agentId: childId }));
}

export function codeChildOutput(projected: unknown) {
  const child = childTranscript.parse(projected);
  const parts = child.items.flatMap(item => {
    if (item.type === "agentMessage" && typeof item.text === "string") return [item.text];
    if (item.type === "commandExecution" && typeof item.aggregatedOutput === "string") return [item.aggregatedOutput];
    return [];
  });
  const text = parts.join("\n\n");
  return { output: text.slice(-100_000), truncated: child.truncated || text.length > 100_000 };
}
