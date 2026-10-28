/**
 * What this renderer window shows (R2): the main window, or one conversation
 * in its own window (`index.html?window=conversation&id=<id>`).
 *
 * Seam file (S0), handed to package R2-C, which may add exports; renaming or
 * removing one needs the main session's agreement.
 */
import { isToolPaneKind, type ToolPaneKind } from "../../shared/tool-pane";

export type WindowRole =
  | { kind: "project"; projectId: string }
  | { kind: "main" }
  | { kind: "conversation"; conversationId: string; pane?: ToolPaneKind };

/** Conversation ids the main process creates (UUIDs and fixture ids). */
const conversationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Reads the window's role from its search string. Anything unexpected falls
 * back to the main window rather than a half-locked one.
 */
export function windowRole(
  search = globalThis.location?.search ?? "",
): WindowRole {
  const params = new URLSearchParams(search);
  const id = params.get("id") ?? "";
  if (params.get("window") === "project" && conversationIdPattern.test(id))
    return { kind: "project", projectId: id };
  if (params.get("window") === "conversation" && conversationIdPattern.test(id))
    return {
      kind: "conversation",
      conversationId: id,
      ...(isToolPaneKind(params.get("pane"))
        ? { pane: params.get("pane") as ToolPaneKind }
        : {}),
    };
  return { kind: "main" };
}
