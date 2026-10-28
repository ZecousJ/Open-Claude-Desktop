/**
 * R7-A: the gateway asks the model to describe each shell command. It adds a
 * required `description` parameter to Codex's shell tools (Codex 0.144.1
 * sends them with `strict: false` and runs calls that carry the extra field;
 * the raw arguments stay in the history, so the model sees what it wrote)
 * and reads the description back from the finished function call.
 *
 * Only top-level function tools named in `describedShellTools` change:
 * namespace tools, MCP tools (their arguments reach third-party servers),
 * custom tools (apply_patch) and built-in tools are left alone.
 */
import {
  descriptionParameter,
  describedShellTools,
  maxDescriptionLength,
  sanitizeDescription,
  type ToolDescriptionEvent,
} from "../shared/tool-description";
import { maxSignalIdLength } from "../shared/gateway-signals";

type Json = Record<string, any>;

/** Largest function-call arguments string read for a description. */
const maxArgumentsLength = 200_000;

function describedSchema(parameters: unknown): Json | undefined {
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  )
    return;
  const schema = parameters as Json;
  const properties = schema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties) ||
    Object.hasOwn(properties, "description")
  )
    return;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return {
    ...schema,
    properties: { ...properties, description: { ...descriptionParameter } },
    required: required.includes("description")
      ? required
      : [...required, "description"],
  };
}

/**
 * The request with a `description` parameter on each shell tool; the input
 * object is not changed. Returns the same object when nothing applies.
 */
export function augmentToolSchemas<T extends Json>(request: T): T {
  if (!Array.isArray(request?.tools)) return request;
  let changed = false;
  const tools = request.tools.map((tool: unknown) => {
    if (!tool || typeof tool !== "object") return tool;
    const value = tool as Json;
    if (value.type !== "function" || !describedShellTools.has(value.name))
      return tool;
    const parameters = describedSchema(value.parameters);
    if (!parameters) return tool;
    changed = true;
    return { ...value, parameters };
  });
  return changed ? { ...request, tools } : request;
}

/** The description in a finished shell function call, if it has one. */
export function toolDescriptionFromResponse(
  event: any,
  threadId: unknown,
): ToolDescriptionEvent | undefined {
  if (
    typeof threadId !== "string" ||
    !threadId ||
    threadId.length > maxSignalIdLength
  )
    return;
  if (event?.type !== "response.output_item.done") return;
  const item = event.item;
  if (
    item?.type !== "function_call" ||
    item.namespace ||
    !describedShellTools.has(item.name) ||
    typeof item.call_id !== "string" ||
    !item.call_id ||
    item.call_id.length > maxSignalIdLength ||
    typeof item.arguments !== "string" ||
    item.arguments.length > maxArgumentsLength
  )
    return;
  try {
    const args: unknown = JSON.parse(item.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    const raw = (args as Json).description;
    if (typeof raw !== "string" || raw.length > 25 * maxDescriptionLength)
      return;
    const description = sanitizeDescription(raw);
    if (!description) return;
    return { threadId, callId: item.call_id, description };
  } catch {
    return;
  }
}
