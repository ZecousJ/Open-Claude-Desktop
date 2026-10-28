/** Only the completed spawn_agent function call is eligible for child context capture. */
export interface AgentPromptEvent {
  parentThreadId: string;
  callId: string;
  message: string;
  model?: string;
}
export function agentPromptFromResponse(
  event: any,
  parentThreadId: unknown,
): AgentPromptEvent | undefined {
  if (
    typeof parentThreadId !== "string" ||
    !parentThreadId ||
    parentThreadId.length > 500
  )
    return;
  if (event?.type !== "response.output_item.done") return;
  const item = event.item;
  if (
    item?.type !== "function_call" ||
    item.name !== "spawn_agent" ||
    typeof item.call_id !== "string" ||
    !item.call_id ||
    item.call_id.length > 500 ||
    typeof item.arguments !== "string" ||
    item.arguments.length > 200_000
  )
    return;
  try {
    const args: unknown = JSON.parse(item.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    const message = (args as Record<string, unknown>).message;
    if (
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 100_000
    )
      return;
    const model = (args as Record<string, unknown>).model;
    return {
      parentThreadId,
      callId: item.call_id,
      message,
      ...(typeof model === "string" && model.length > 0 && model.length <= 200
        ? { model }
        : {}),
    };
  } catch {
    return;
  }
}
