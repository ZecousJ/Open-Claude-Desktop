/** Read-only MCP/dynamic-tool projection. Never executes a tool or fetches media. */
import type { Item, Settings } from "../../../shared/types";
import { resourceLinks, validResourceBase64 } from "../../../shared/message-resources";
import { connectorUuid } from "../api/connector-auth";

export type CodeToolResultBlock =
  | { type: "text"; text: string }
  | ({ type: "resource_link" } & CodeToolResourceLink)
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

type CodeToolResourceLink = {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  mime_type?: string;
};

export type CodeToolMetadata = {
  _meta?: { anthropic_error_code: "mcp_auth_required" };
  structuredContent?: unknown;
  resourceLinks?: CodeToolResourceLink[];
};

const textBudget = 100_000;
const imageBudget = 4 * 1024 * 1024;
const blockBudget = 256;
const terminal = new Set([
  "completed",
  "failed",
  "declined",
  "interrupted",
  "cancelled",
  "canceled",
]);
const failure = new Set([
  "failed",
  "declined",
  "interrupted",
  "cancelled",
  "canceled",
]);
const record = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function recordedToolFailed(item: Item): boolean {
  return item.success === false ||
    item.error != null ||
    failure.has(item.status ?? "") ||
    failure.has(item.lifecycleStatus ?? "") ||
    item.result?.isError === true ||
    item.result?.is_error === true;
}

const collaborationTools = new Set([
  "spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent",
]);
const agentStates = new Set([
  "pendingInit", "running", "inProgress", "completed", "shutdown",
  "errored", "failed", "interrupted", "cancelled", "canceled", "stopped",
  "notFound",
]);
const agentIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const observedState = (value: unknown) =>
  typeof value === "string" && agentStates.has(value) ? value : "unknown";

/**
 * Bounded, read-only observations, not an Agent/Task tool or child transcript.
 * Item is open-ended; fields are verified against shared/workflow-model's
 * collab/V2 consumers. Never copy prompts, messages, errors or raw metadata.
 * A completed spawn call does not mean its child completed.
 */
export function codeAgentActivityText(item: Item): string | undefined {
  let ids: string[], label: string, omitted = false;
  if (item.type === "collabAgentToolCall") {
    if (!collaborationTools.has(item.tool ?? "") ||
        !Array.isArray(item.receiverThreadIds)) return;
    const sample = item.receiverThreadIds.slice(0, 32);
    ids = [...new Set(sample.filter(agentIdentifier))];
    omitted = item.receiverThreadIds.length > 32 ||
      sample.some((id: unknown) => !agentIdentifier(id));
    label = `Recorded collaboration call: ${item.tool}`;
  } else if (item.type === "subAgentActivity") {
    if (!agentIdentifier(item.agentThreadId) ||
        !["started", "interrupted"].includes(item.kind)) return;
    ids = [item.agentThreadId];
    label = `Recorded subagent event: ${item.kind}`;
  } else return;
  if (!ids.length) return;
  const lines = [label];
  if (item.type === "collabAgentToolCall") {
    lines.push(`Call status: ${observedState(item.status)}`);
    if (item.lifecycleStatus !== undefined)
      lines.push(`Call lifecycle: ${observedState(item.lifecycleStatus)}`);
  }
  const states = record(item.agentsStates) ? item.agentsStates : undefined;
  const usage = record(item.agentTokenUsage) ? item.agentTokenUsage : undefined;
  for (const id of ids) {
    const state = states && Object.hasOwn(states, id) && record(states[id])
      ? observedState(states[id].status) : "unknown";
    const tokens = usage && Object.hasOwn(usage, id) ? usage[id] : undefined;
    lines.push(`Child ${id}: ${state}${
      Number.isSafeInteger(tokens) && tokens >= 0 ? `; ${tokens} recorded tokens` : ""
    }`);
  }
  if (omitted) lines.push("Additional or malformed child records omitted.");
  lines.push("Recorded child activity.");
  return lines.join("\n");
}

export function transcriptToolText(
  value: unknown,
  budget = textBudget,
): string {
  if (typeof value === "string")
    return value.startsWith("data:") ? "" : value.slice(0, budget);
  try {
    const text = JSON.stringify(
      value,
      (key, nested: unknown) => {
        if (
          key === "_meta" ||
          (typeof nested === "string" &&
            (nested.startsWith("data:") ||
              ((key === "data" || key === "blob") && nested.length > 1024)))
        )
          return undefined;
        return nested;
      },
      2,
    );
    return text?.slice(0, budget) ?? "";
  } catch {
    return "";
  }
}

function codeToolResourceLink(part: unknown): CodeToolResourceLink | undefined {
  if (!record(part) || typeof part.uri !== "string") return;
  const { uri, name, title, description, mimeType, mime_type } = part;
  return {
    uri,
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof mimeType === "string" ? { mimeType } : {}),
    ...(typeof mime_type === "string" ? { mime_type } : {}),
  };
}

export function registeredCodeAppToolName(
  item: Item,
  mcpServers?: Settings["mcpServers"],
) {
  if (
    item.type !== "mcpToolCall" ||
    typeof item.server !== "string" || !item.server ||
    typeof item.tool !== "string" || !item.tool
  ) return;
  const config = mcpServers?.[item.server];
  const uri: unknown = item.appContext?.resourceUri ?? item.mcpAppResourceUri;
  if (
    typeof uri === "string" && uri.startsWith("ui://") &&
    record(config) && typeof config.claudex_directory_id === "string" &&
    typeof config.url === "string" && !config.command
  ) {
    return `mcp__${connectorUuid(item.server)}__${item.tool}`;
  }
}

export function codeToolTranscript(
  item: Item,
  mcpServers?: Settings["mcpServers"],
) {
  const status = item.lifecycleStatus ?? item.status;
  const running = status === "inProgress" || status === "running";
  const payload = item.result;
  const explicitLinks = payload?.resource_links ?? item.resource_links;
  const hasPayload =
    payload != null ||
    item.error != null ||
    Array.isArray(item.contentItems) ||
    Array.isArray(explicitLinks) ||
    typeof item.success === "boolean";
  // A turn can finish before the tool completion arrives.
  const missingResult =
    status === "completed" && !terminal.has(item.status ?? "") && !hasPayload;
  const complete =
    !missingResult && (terminal.has(status ?? "") || (!status && hasPayload));
  const failed = recordedToolFailed(item);
  const tool =
    typeof item.tool === "string" && item.tool
      ? item.tool
      : item.type === "mcpToolCall"
        ? "MCP tool"
        : "Dynamic tool";
  const name = registeredCodeAppToolName(item, mcpServers) ?? (
    item.type === "mcpToolCall" &&
    typeof item.server === "string" &&
    item.server &&
    !tool.startsWith("mcp__")
      ? `mcp__${item.server}__${tool}`
      : tool
  );
  let input = item.input ?? item.arguments ?? item.params ?? {};
  // Some saved transports persisted JSON arguments as a string.
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (record(parsed)) input = parsed;
    } catch {
      /* Preserve literal input. */
    }
  }
  const content: CodeToolResultBlock[] = [];
  const warnings: string[] = [];
  let remainingText = textBudget,
    remainingImages = imageBudget;
  const warn = (text: string) => {
    if (!warnings.includes(text)) warnings.push(text);
  };
  const addText = (text: string) => {
    if (text.length > remainingText) warn("Tool text truncated");
    const kept = text.slice(0, remainingText);
    remainingText -= kept.length;
    if (kept) content.push({ type: "text", text: kept });
  };
  const addSerialized = (value: unknown) =>
    addText(transcriptToolText(value, remainingText + 1));
  const addImage = (mimeType: unknown, data: unknown) => {
    const mime = mimeType ?? "image/png";
    if (typeof data === "string" && data.length > remainingImages) {
      warn("Tool image limit exceeded; image omitted");
      return;
    }
    if (
      typeof mime !== "string" ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime) ||
      typeof data !== "string" ||
      !data ||
      !validResourceBase64(data)
    ) {
      warn("Unsupported or malformed image omitted");
      return;
    }
    remainingImages -= data.length;
    content.push({
      type: "image",
      source: { type: "base64", media_type: mime, data },
    });
  };
  const block = (part: unknown) => {
    if (!record(part)) {
      warn("Malformed tool content omitted");
      return;
    }
    if (
      (part.type === "text" || part.type === "inputText") &&
      typeof part.text === "string"
    ) {
      addText(part.text);
      return;
    }
    if (part.type === "image") {
      if (record(part.source)) {
        if (part.source.type === "base64")
          addImage(part.source.media_type, part.source.data);
        else
          warn("Remote image omitted; transcript replay does not fetch media");
      } else addImage(part.mimeType, part.data);
      return;
    }
    if (part.type === "inputImage") {
      const match =
        typeof part.imageUrl === "string" &&
        /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.imageUrl);
      if (match) addImage(match[1], match[2]);
      else
        warn(
          "Remote or malformed image omitted; transcript replay does not fetch media",
        );
      return;
    }
    if (part.type === "resource_link") {
      const link = codeToolResourceLink(part);
      if (link) content.push({ type: "resource_link", ...link });
      else warn("Malformed resource link omitted");
      return;
    }
    if (part.type === "resource" && record(part.resource)) {
      const resource = part.resource;
      if (typeof resource.text === "string") addText(resource.text);
      else if (
        typeof resource.mimeType === "string" &&
        resource.mimeType.startsWith("image/")
      )
        addImage(resource.mimeType, resource.blob);
      else warn("Unsupported binary resource omitted");
      return;
    }
    warn(
      `Unsupported tool content type: ${typeof part.type === "string" ? part.type.slice(0, 80) : "unknown"}`,
    );
  };
  const parts = Array.isArray(payload?.content)
    ? payload.content
    : Array.isArray(item.contentItems)
      ? item.contentItems
      : undefined;
  if (parts) {
    for (const part of parts.slice(0, blockBudget)) block(part);
    if (parts.length > blockBudget) warn("Tool content block limit exceeded");
  } else if (typeof payload?.content === "string") {
    addSerialized(payload.content);
  } else if (item.type === "mcpToolCall" && record(payload)) {
    const {
      content,
      structuredContent,
      resource_links,
      _meta,
      isError,
      is_error,
      ...data
    } = payload;
    if (Object.keys(data).length) addSerialized(data);
  } else if (payload != null) addSerialized(payload);
  if (missingResult)
    warn(
      "The turn ended without a recorded tool result; tool success is unknown",
    );
  if (item.error != null) addSerialized(item.error?.message ?? item.error);

  const mcpMeta: CodeToolMetadata = {};
  if (record(payload) && payload.structuredContent !== undefined) {
    try {
      const json = JSON.stringify(payload.structuredContent);
      if (json !== undefined && json.length <= textBudget)
        mcpMeta.structuredContent = JSON.parse(json);
      else warn("Structured tool content limit exceeded");
    } catch {
      warn("Non-serializable structured tool content omitted");
    }
  }
  if (item.type === "mcpToolCall" && complete && !failed) {
    const boundedExplicit = Array.isArray(explicitLinks)
      ? explicitLinks.slice(0, blockBudget)
      : [];
    const boundedParts = parts?.slice(0, blockBudget) ?? [];
    const sources = [
      ...boundedExplicit,
      ...boundedParts.filter(
        (part: unknown) => record(part) && part.type === "resource_link",
      ),
    ];
    const links = resourceLinks({
      ...item,
      result: { content: boundedParts, resource_links: boundedExplicit },
    }).map((link) => {
      const source = sources.find(
        (part) => record(part) && part.uri === link.uri,
      );
      const description =
        record(source) &&
        typeof source.description === "string" &&
        source.description.trim() &&
        !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(source.description)
          ? source.description.trim().slice(0, 512)
          : undefined;
      return {
        ...link,
        name: link.name.slice(0, 512),
        ...(description ? { description } : {}),
      };
    });
    if (links.length) mcpMeta.resourceLinks = links;
  }
  if (record(payload) && payload._meta !== undefined)
    warn("Tool widget metadata retained in source history");
  return {
    name,
    input: record(input) ? input : { value: input },
    running,
    complete,
    failed,
    content,
    mcpMeta: Object.keys(mcpMeta).length ? mcpMeta : undefined,
    warnings,
    progress:
      typeof item.progress === "string"
        ? item.progress.slice(0, 1000)
        : undefined,
  };
}
