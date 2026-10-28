/**
 * A file write the model has begun. Codex reports an apply_patch call only once
 * the model has written all of it; the gateway sees the call open in the
 * upstream stream and tells the main process, which shows the file change in
 * progress at once. Codex's own item has the call's id and replaces it.
 */
export interface ToolStartEvent {
  threadId: string;
  callId: string;
}

/** Longest thread and call id accepted. */
const maxIdLength = 500;

/** The tools whose calls are shown as soon as they open. */
export const earlyShownTools = new Set(["apply_patch"]);

/** The call a Responses stream event opens, when it is an early-shown tool. */
export function toolStartFromResponse(
  event: any,
  threadId: unknown,
): ToolStartEvent | undefined {
  if (
    typeof threadId !== "string" ||
    !threadId ||
    threadId.length > maxIdLength
  )
    return;
  if (event?.type !== "response.output_item.added") return;
  const item = event.item;
  if (item?.type !== "custom_tool_call" && item?.type !== "function_call")
    return;
  if (item.namespace || !earlyShownTools.has(item.name)) return;
  const callId = item.call_id;
  if (typeof callId !== "string" || !callId || callId.length > maxIdLength)
    return;
  return { threadId, callId };
}

/** A toolStart signal from the provider child, checked again. */
export function parseToolStartSignal(
  value: unknown,
): ToolStartEvent | undefined {
  const event = value as Partial<ToolStartEvent> | null;
  if (
    !event ||
    typeof event.threadId !== "string" ||
    !event.threadId ||
    event.threadId.length > maxIdLength ||
    typeof event.callId !== "string" ||
    !event.callId ||
    event.callId.length > maxIdLength
  )
    return;
  return { threadId: event.threadId, callId: event.callId };
}
