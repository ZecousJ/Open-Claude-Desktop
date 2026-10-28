import type { Item } from "../../shared/types";
import { projectAgentItems } from "./agent-transcript-item";

const toolTypes = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "fileChange",
  "collabAgentToolCall",
  "subAgentActivity",
]);
function actionFor(item: Item | undefined) {
  if (!item) return undefined;
  if (item.type === "commandExecution") return "Running a command";
  if (item.type === "webSearch") return "Fetching";
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall")
    return "Using a tool";
  if (item.type === "fileChange") return "Editing files";
  return undefined;
}
export function summarizeAgentThread(thread: any) {
  const turns: Array<{ items: Item[] }> = Array.isArray(thread?.turns)
    ? thread.turns
    : [];
  const items = turns
    .flatMap((turn) => (Array.isArray(turn.items) ? turn.items : []))
    .filter(
      (item): item is Item =>
        !!item && typeof item === "object" && typeof item.type === "string",
    );
  const toolUses = items.filter((item) => toolTypes.has(item.type)).length;
  const running = [...items]
    .reverse()
    .find(
      (item) =>
        toolTypes.has(item.type) &&
        ["inProgress", "running"].includes(
          item.status ?? item.lifecycleStatus ?? "",
        ),
    );
  return { toolUses, currentAction: actionFor(running) };
}
export function projectAgentTranscript(
  thread: any,
  model: string,
  parentPrompt: string,
) {
  const turns: Array<{ id: string; items: Item[]; status: string }> =
    Array.isArray(thread?.turns) ? thread.turns : [];
  const items = turns
    .flatMap((turn) => (Array.isArray(turn.items) ? turn.items : []))
    .filter(
      (item): item is Item =>
        !!item && typeof item === "object" && typeof item.type === "string",
    );
  const safe = projectAgentItems(items);
  const last = turns.at(-1) as { status?: string } | undefined;
  const status =
    thread?.status?.type === "systemError" || last?.status === "failed"
      ? "failed"
      : last?.status === "interrupted"
        ? "stopped"
        : thread?.status?.type === "active" || last?.status === "inProgress"
          ? "running"
          : "completed";
  return {
    model,
    context: parentPrompt.slice(0, 100_000),
    items: safe,
    truncated: items.length > 500,
    status,
    ...summarizeAgentThread(thread),
  };
}
