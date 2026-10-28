import type { ElicitResult } from "./mcp-server";
import type { JsonRpcId } from "./mcp-server";
/** Versions this server speaks, newest first. */
export const mcpProtocolVersions = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const jsonRpcErrors = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  busy: -32000,
} as const;

export function idKey(id: JsonRpcId) {
  return `${typeof id}:${id}`;
}

export function validId(id: unknown): id is JsonRpcId {
  return (
    (typeof id === "string" && id.length <= 200) ||
    (typeof id === "number" && Number.isFinite(id))
  );
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The elicitation answer as the tools use it; anything unexpected is a cancel. */
export function elicitResultOf(value: unknown): ElicitResult {
  if (!isObject(value)) return { action: "cancel" };
  const action = value.action;
  if (action === "accept")
    return {
      action,
      ...(isObject(value.content) ? { content: value.content } : {}),
    };
  if (action === "decline") return { action };
  return { action: "cancel" };
}
