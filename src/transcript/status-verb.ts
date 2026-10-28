import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";

// The browser tools' running words on the status line.
const browserVerbs: Record<string, string> = {
  navigate: "Opening a page",
  screenshot: "Capturing page",
  read_page: "Reading page",
  get_text: "Reading page text",
  get_page_text: "Reading page text",
  find: "Finding on page",
  form_input: "Filling in a field",
  computer: "Interacting with page",
  javascript_tool: "Running page script",
  evaluate: "Running page script",
  read_console_messages: "Reading console",
  read_network_requests: "Reading network activity",
  resize_window: "Resizing browser",
  tabs_list: "Checking tabs",
  tabs_context: "Checking tabs",
  tab_new: "Opening tab",
  tab_select: "Switching tabs",
  tab_close: "Closing tab",
  preview_start: "Starting preview",
  preview_stop: "Stopping preview",
  preview_list: "Listing previews",
  preview_logs: "Reading server logs",
};

/**
 * A running file change's word, as its row says it ("Creating" for new
 * files only, "Deleting" for removals only, else "Editing";
 * CodeFileChange's fileChangeParts), without loading the row here.
 */
function fileChangeVerb(item: Item) {
  const kinds = new Set(
    (item.changes ?? []).map((change) =>
      typeof change.kind === "string" ? change.kind : change.kind?.type,
    ),
  );
  if (kinds.size === 1 && kinds.has("add")) return "Creating";
  if (kinds.size === 1 && kinds.has("delete")) return "Deleting";
  return "Editing";
}

/** The newest tool still running in a turn (not reasoning or reply text). */
export function runningTool(items: Item[]) {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (
      item.type !== "agentMessage" &&
      item.type !== "reasoning" &&
      itemIsRunning(item)
    )
      return item;
  }
  return undefined;
}

/**
 * The word that leads the status line while a tool runs ("Creating",
 * "Starting preview", "Running"): the running form of the tool's row, as
 * the live desktop's line reads it ("Starting preview 2s · 5.1k tokens").
 */
export function runningVerb(item: Item): string {
  switch (item.type) {
    case "fileChange":
      return fileChangeVerb(item);
    case "commandExecution":
      return "Running";
    case "webSearch":
      return "Searching";
    case "mcpToolCall":
    case "dynamicToolCall": {
      const tool = String((item as { tool?: string }).tool ?? "").replace(
        /^mcp__[^_]+__/,
        "",
      );
      return browserVerbs[tool] ?? "Running";
    }
    default:
      return "Running";
  }
}
