import { z } from "zod";
import type { Conversation, Item, Turn } from "../../shared/types";
import { agentItems, agentThreadIds } from "../../shared/workflow-usage";
import { recordItemLifecycle } from "../../shared/activity";

export type CodeAgentThread = NonNullable<Item["agentThreads"]>[string];
const itemSchema = z.object({ id: z.string(), type: z.string() }).passthrough();
const turnSchema = z.object({
  id: z.string(),
  status: z.enum(["inProgress", "completed", "failed", "interrupted"]),
  items: z.array(itemSchema),
  startedAt: z.number().nullable().optional(),
  error: z.object({ message: z.string() }).nullable().optional(),
});
const threadSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  turns: z.array(turnSchema),
});

export function codeAgentOwner(conversation: Conversation, agentId: string) {
  return agentItems(conversation.turns).find(
    (item) =>
      (item.type === "subAgentActivity" ||
        (item.type === "collabAgentToolCall" && item.tool === "spawnAgent")) &&
      agentThreadIds(item).includes(agentId),
  );
}

export function parseCodeAgentThread(value: unknown): CodeAgentThread {
  const thread = threadSchema.parse(value);
  return {
    id: thread.id,
    backfilled: true,
    turns: thread.turns.map((turn) => ({
      id: turn.id,
      status: turn.status,
      createdAt: (turn.startedAt ?? thread.createdAt) * 1000,
      ...(turn.error ? { error: turn.error.message } : {}),
      prompt: turn.items
        .filter((item) => item.type === "userMessage")
        .flatMap((item) =>
          Array.isArray(item.content)
            ? item.content.flatMap((part) =>
                part?.type === "text" && typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
            : [],
        )
        .join("\n"),
      attachments: [],
      items: turn.items.filter((item) => item.type !== "userMessage"),
    })),
  };
}

export function recordCodeAgentEvent(
  owner: Item,
  agentId: string,
  method: string,
  params: any,
): boolean {
  if (
    ![
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "item/commandExecution/outputDelta",
    ].includes(method)
  )
    return false;
  const turnId = params.turnId ?? params.turn?.id;
  if (typeof turnId !== "string") return false;
  const thread = owner.agentThreads?.[agentId] ?? { id: agentId, turns: [] };
  let turn = thread.turns.find((value) => value.id === turnId);
  if (!turn) {
    turn = {
      id: turnId,
      prompt: "",
      attachments: [],
      items: [],
      status: "inProgress",
      createdAt: Date.now(),
    };
    thread.turns.push(turn);
  }
  switch (method) {
    case "turn/started":
      break;
    case "turn/completed": {
      turn.status = turnSchema.shape.status.parse(params.turn.status);
      if (typeof params.turn.error?.message === "string")
        turn.error = params.turn.error.message;
      break;
    }
    case "item/started":
    case "item/completed": {
      const item = itemSchema.parse(params.item);
      if (item.type === "userMessage") {
        turn.prompt = Array.isArray(item.content)
          ? item.content
              .flatMap((part) =>
                part?.type === "text" && typeof part.text === "string"
                  ? [part.text]
                  : [],
              )
              .join("\n")
          : "";
      } else recordItemLifecycle(turn, item, method === "item/completed");
      break;
    }
    case "item/agentMessage/delta":
    case "item/commandExecution/outputDelta": {
      if (typeof params.itemId !== "string" || typeof params.delta !== "string")
        return false;
      let item = turn.items.find((value) => value.id === params.itemId);
      const message = method === "item/agentMessage/delta";
      if (!item) {
        item = {
          id: params.itemId,
          type: message ? "agentMessage" : "commandExecution",
          lifecycleStatus: "inProgress",
        };
        turn.items.push(item);
      }
      if (message) item.text = (item.text ?? "") + params.delta;
      else item.aggregatedOutput = (item.aggregatedOutput ?? "") + params.delta;
      break;
    }
    default:
      return false;
  }
  owner.agentThreads = { ...owner.agentThreads, [agentId]: thread };
  return true;
}
