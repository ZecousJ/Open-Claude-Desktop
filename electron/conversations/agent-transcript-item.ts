import type { Item } from "../../shared/types";
import { resourceLinks } from "../../shared/message-resources";
import { sanitizeDescription } from "../../shared/tool-description";
import { agentMessageOrigin, peerMessage } from "../../shared/agent-messages";
import { cleanCitations, uniqueSources } from "../../shared/gateway-signals";
import {
  computerUseServerName,
  screenshotIdOf,
  screenshotRef,
} from "../../shared/computer-use";

/**
 * A computer-use tool result keeps its screenshots on disk (R10): each image
 * the broker returns is followed by a `claudex-screenshot://<id>` text line.
 * The recorded item drops the image's base64 and names the saved screenshot
 * instead (`uri`), so conversations stay small; the window loads the picture
 * with `computerUseScreenshot`. An image without a reference stays as it is.
 */
export function withScreenshotRefs(item: Item): Item {
  if (item.type !== "mcpToolCall" || item.server !== computerUseServerName)
    return item;
  const result = item.result;
  if (!result || typeof result !== "object" || Array.isArray(result))
    return item;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return item;
  let replaced = false;
  const next = content.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== "object") return entry;
    const image = entry as Record<string, unknown>;
    if (image.type !== "image" || typeof image.data !== "string") return entry;
    const following = content[index + 1] as Record<string, unknown> | undefined;
    const id =
      following?.type === "text" && typeof following.text === "string"
        ? screenshotIdOf(following.text)
        : undefined;
    if (!id) return entry;
    replaced = true;
    const { data: _data, ...rest } = image;
    return { ...rest, uri: screenshotRef(id) };
  });
  return replaced ? { ...item, result: { ...result, content: next } } : item;
}

function jsonWithin(
  value: unknown,
  limit: number,
): { value: unknown; bytes: number } | undefined {
  if (value === undefined) return;
  try {
    const json = JSON.stringify(value);
    if (!json || Buffer.byteLength(json) > limit) return;
    return { value: JSON.parse(json), bytes: Buffer.byteLength(json) };
  } catch {
    return;
  }
}
/** Keep large tool payloads bounded across the child transcript IPC response. */
export function projectAgentItems(source: Item[]): Item[] {
  let richBudget = 4_200_000;
  const rich = <T>(value: T, limit: number): T | undefined => {
    const projected = jsonWithin(value, Math.min(limit, richBudget));
    if (projected) richBudget -= projected.bytes;
    return projected?.value as T | undefined;
  };
  return source.slice(-500).map((original) => {
    const item = withScreenshotRefs(peerMessage(original) ?? original);
    const links = resourceLinks(item);
    const imageCap = [
      "imageGeneration",
      "imageView",
      "mcpToolCall",
      "dynamicToolCall",
    ].includes(item.type)
      ? 2_100_000
      : 50_000;
    const result = rich(item.result, imageCap),
      contentItems = rich(item.contentItems, imageCap);
    const text =
      typeof item.text === "string" ? item.text.slice(0, 100_000) : undefined;
    // S1: model descriptions (R7) and search sources and citations (R45).
    const description =
      item.type === "commandExecution"
        ? sanitizeDescription(item.description)
        : undefined;
    const sources = Array.isArray(item.sources)
      ? uniqueSources(item.sources)
      : undefined;
    const citations =
      text && Array.isArray(item.citations)
        ? cleanCitations(item.citations, text.length)
        : undefined;
    return {
      id: String(item.id ?? ""),
      type: item.type,
      origin: agentMessageOrigin(item),
      notice: item.notice === "agents_killed" ? item.notice : undefined,
      error: rich(item.error, 5000),
      success: typeof item.success === "boolean" ? item.success : undefined,
      cancelled:
        typeof item.cancelled === "boolean" ? item.cancelled : undefined,
      agentNames: rich(item.agentNames, 5000),
      status: typeof item.status === "string" ? item.status : undefined,
      lifecycleStatus:
        typeof item.lifecycleStatus === "string"
          ? item.lifecycleStatus
          : undefined,
      text,
      description,
      sources: sources?.length ? sources : undefined,
      searchTool:
        item.searchTool === "web_search" || item.searchTool === "x_search"
          ? item.searchTool
          : undefined,
      citations: citations?.length ? citations : undefined,
      summary: Array.isArray(item.summary)
        ? item.summary
            .filter((part): part is string => typeof part === "string")
            .slice(0, 50)
            .map((part) => part.slice(0, 2000))
        : undefined,
      display_group: rich(item.display_group, 10_000),
      display_content: rich(
        item.display_content ?? item.result?.display_content,
        50_000,
      ),
      resource_links: links.length ? rich(links, 150_000) : undefined,
      command:
        typeof item.command === "string"
          ? item.command.slice(0, 5000)
          : undefined,
      aggregatedOutput:
        typeof item.aggregatedOutput === "string"
          ? item.aggregatedOutput.slice(-50_000)
          : undefined,
      exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
      server:
        typeof item.server === "string" ? item.server.slice(0, 200) : undefined,
      tool: typeof item.tool === "string" ? item.tool.slice(0, 200) : undefined,
      namespace:
        typeof item.namespace === "string"
          ? item.namespace.slice(0, 200)
          : undefined,
      progress:
        typeof item.progress === "string"
          ? item.progress.slice(0, 1000)
          : undefined,
      query:
        typeof item.query === "string" ? item.query.slice(0, 1000) : undefined,
      action: rich(item.action, 2000),
      arguments: rich(item.arguments, 50_000),
      result,
      contentItems,
      resultOmitted:
        (item.result != null && result === undefined) ||
        (item.contentItems != null && contentItems === undefined),
      changes: rich(item.changes, 50_000),
      plan: rich(item.plan, 50_000),
      durationMs:
        typeof item.durationMs === "number" ? item.durationMs : undefined,
      review:
        typeof item.review === "string" ? item.review.slice(0, 200) : undefined,
      revisedPrompt:
        typeof item.revisedPrompt === "string"
          ? item.revisedPrompt.slice(0, 20_000)
          : undefined,
      path:
        typeof item.path === "string" ? item.path.slice(0, 2000) : undefined,
      savedPath:
        typeof item.savedPath === "string"
          ? item.savedPath.slice(0, 2000)
          : undefined,
      kind: typeof item.kind === "string" ? item.kind : undefined,
      agentPath:
        typeof item.agentPath === "string"
          ? item.agentPath.slice(0, 500)
          : undefined,
      agentThreadId:
        typeof item.agentThreadId === "string" ? item.agentThreadId : undefined,
      receiverThreadIds: Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds
            .filter((id): id is string => typeof id === "string")
            .slice(0, 32)
        : undefined,
      agentsStates: rich(item.agentsStates, 10_000),
      prompt:
        typeof item.prompt === "string"
          ? item.prompt.slice(0, 20_000)
          : undefined,
    };
  });
}
