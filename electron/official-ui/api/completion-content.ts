/** Recorded engine content only. No tool invocation, permission or approval is created here. */
import { createHash } from "node:crypto";
import type { Conversation, Item, Turn } from "../../../shared/types";
import { projectWebCitationText } from "../../../shared/web-citation-text";
import { generatedOutputAttachments } from "./generated-output-files";
import { mcpAuthRequired, type McpAuthRequired } from "./connector-auth";
import { researchTaskId } from "./research-projection";
import type { ResearchReportArtifact } from "./research-report-artifact";
import { recordedToolFailed } from "../native/code-tool-transcript";
export interface CompletionBlock {
  key: string;
  start: Record<string, unknown>;
  text?: string;
  summaries?: string[];
  authRequired?: McpAuthRequired;
  complete: boolean;
}
const terminal = new Set(["completed", "failed", "declined", "interrupted"]);

export interface CompletionOutputContext {
  organization: string;
  conversationId: string;
  conversation?: Conversation;
  researchArtifact?: ResearchReportArtifact;
  researchEdit?: boolean;
}
function json(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded) > 128 * 1024)
    throw Error("Unsupported content size");
  return JSON.parse(encoded);
}
/** Preserve order, identities and observed results; never synthesize a successful tool result. */
export function completionBlocks(
  turn: Turn,
  deferTextForCitations = false,
  output?: CompletionOutputContext,
): CompletionBlock[] {
  const blocks: CompletionBlock[] = [];
  const ids = new Set<string>();
  const researchTask = output?.conversation && researchTaskId(output.organization, output.conversation, turn);
  const report = output?.researchArtifact;
  const research = "launch_extended_search_task";
  if (researchTask) {
    const id = `${researchTask}:research`;
    blocks.push(
      { key: id, start: { type: "tool_use", id, name: research, input: {}, partial_json: "" }, text: "{}", complete: true },
      { key: `${id}:result`, start: { type: "tool_result", tool_use_id: id, name: research, is_error: false,
        content: [{ type: "text", text: JSON.stringify({ task_id: researchTask }) }] }, complete: true },
    );
  }
  // Research has its own progress and source reader. Codex can revise its
  // intermediate tools and reasoning before it saves the final report.
  const researchOutput = !!researchTask || !!output?.researchEdit || !!report;
  const items = researchOutput
    ? turn.status === "inProgress" ? [] : turn.items.filter(item => item.type === "agentMessage")
    : turn.items;
  let searchObserved = deferTextForCitations;
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id || ids.has(item.id))
      throw Error("Invalid item identity");
    ids.add(item.id);
    // The turn-wide diff duplicates file activity. File snapshots are
    // presented once, after all writes and deletes in the turn are known.
    if (item.type === "diff" || item.type === "outputFiles" ||
        (item.type === "agentMessage" && item.id === report?.sourceItemId)) continue;
    const finished =
      turn.status !== "inProgress" ||
      terminal.has(item.lifecycleStatus ?? item.status ?? "");
    if (item.type === "agentMessage" || item.type === "reasoning") {
      if (
        (item.type === "agentMessage" || item.text !== undefined) &&
        typeof item.text !== "string"
      )
        throw Error("Invalid content text");
      if (
        item.content?.length ||
        item.resource_links?.length ||
        item.display_content
      )
        throw Error("Unsupported rich message");
      if (
        item.summary !== undefined &&
        (!Array.isArray(item.summary) ||
          item.summary.some((s) => typeof s !== "string"))
      )
        throw Error("Invalid reasoning summary");
      const thinking = item.type === "reasoning";
      const buffered =
        !thinking && (searchObserved || (item.citations?.length ?? 0) > 0);
      if (buffered && !finished) break;
      if (
        buffered &&
        Array.from(item.text ?? "").some(
          (c) =>
            c.length === 1 &&
            c.charCodeAt(0) >= 0xd800 &&
            c.charCodeAt(0) <= 0xdfff,
        )
      )
        throw Error("Invalid UTF-16");
      const text = item.text ?? "";
      const projected = thinking ? undefined : projectWebCitationText(text, !finished);
      blocks.push({
        key: item.id,
        start: projected
          ? { type: "text", text: "", citations: officialCitations(item, projected) }
          : { type: "thinking", thinking: "", summaries: [], signature: null },
        text: projected?.text ?? text,
        // Engine summaryTextDelta appends to the same summary string; the
        // official reducer only appends whole summary objects. Publish once stable.
        ...(thinking
          ? { summaries: finished ? (item.summary ?? []) : [] }
          : {}),
        complete: finished,
      });
      if (!finished) break; // Do not overtake an item whose final summaries/citations can still grow.
      continue;
    }
    if (
      ![
        "mcpToolCall",
        "dynamicToolCall",
        "commandExecution",
        "fileChange",
        "webSearch",
      ].includes(item.type)
    )
      throw Error("Unsupported recorded content");
    searchObserved = true; // Any recorded tool can supply citations for a later reply.
    const id = `${turn.id}:${item.id}`;
    const fileChange = item.type === "fileChange";
    const status = fileChange
      ? (item.status ?? item.lifecycleStatus)
      : (item.lifecycleStatus ?? item.status);
    // The engine can drop a provisional write when its tool event never arrives.
    if (fileChange && !terminal.has(status ?? "")) {
      if (turn.status === "inProgress") break;
      continue;
    }
    const tool = recordedTool(item);
    const name = fileChange
      ? "Edit"
      : item.type === "commandExecution"
        ? "Bash"
        : item.type === "webSearch"
          ? item.action?.type === "openPage" ||
            item.action?.type === "findInPage"
            ? "WebFetch"
            : "WebSearch"
          : item.tool;
    if (typeof name !== "string" || !name || name.length > 256)
      throw Error("Invalid recorded tool name");
    const done = terminal.has(status ?? "");
    if (
      !done &&
      (turn.status !== "inProgress" ||
        !["inProgress", "running"].includes(status ?? ""))
    )
      throw Error("Unfinished tool result");
    if (done && !tool) throw Error("Unsupported recorded tool data");
    blocks.push({
      key: `${item.id}:use`,
      start: { type: "tool_use", id, name, input: {}, partial_json: "" },
      text: done ? JSON.stringify(json(tool!.input)) : "",
      complete: done,
      authRequired: mcpAuthRequired(item, id, output?.conversationId),
    });
    if (!done) break;
    const failed =
      status !== "completed" ||
      recordedToolFailed(item) ||
      (typeof item.exitCode === "number" && item.exitCode !== 0);
    const result = json(tool!.output);
    blocks.push({
      key: `${item.id}:result`,
      start: {
        type: "tool_result",
        tool_use_id: id,
        name,
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
        is_error: failed,
      },
      complete: true,
    });
  }
  if (
    turn.status !== "inProgress" &&
    turn.items.some((item) => item.generatedFiles?.length)
  ) {
    if (!output) throw Error("Generated file organization is unavailable");
    const files = generatedOutputAttachments(
      output.organization,
      output.conversationId,
      turn,
      true,
    );
    if (files.length) {
      const id = `${turn.id}:files`;
      // The original file cards use an attachment ID for preview and download.
      // A stored-copy ID on a present_files result only enables download.
      blocks.push(
        {
          key: "files:use",
          start: {
            type: "tool_use",
            id,
            name: "SendUserFile",
            tool_display_name: "Shared files",
            input: {},
            partial_json: "",
          },
          text: "{}",
          complete: true,
        },
        {
          key: "files:result",
          start: {
            type: "tool_result",
            tool_use_id: id,
            name: "SendUserFile",
            is_error: false,
            content: [],
            display: "attach",
            attachments: files.map((file) => ({
              path: file.sessionPath,
              size: Number(file.fileSize),
              isImage: file.mediaType.startsWith("image/"),
              ...(file.unavailable
                ? { unavailable: true, unavailable_text: file.unavailableText }
                : { file_uuid: file.id }),
            })),
          },
          complete: true,
        },
      );
    }
  }
  if (report && turn.status !== "inProgress") {
    const id = `${report.versionUuid}:artifact`;
    const name = "artifacts";
    const input = { command: report.version === 1 ? "create" : "rewrite", id: report.artifactIdentifier,
      type: "text/markdown", title: report.title, content: report.markdown,
      version_uuid: report.versionUuid, version_number: report.version };
    // The report is already complete. Supplying the final input in one event
    // lets the original drawer index the finished artifact immediately.
    const encoded = JSON.stringify(input);
    const inline = Buffer.byteLength(encoded) < 128 * 1024;
    blocks.push(
      { key: id, start: { type: "tool_use", id, name, input: inline ? input : {}, partial_json: "" }, complete: true,
        ...(inline ? {} : { text: encoded }) },
      { key: `${id}:result`, start: { type: "tool_result", tool_use_id: id, name, is_error: false, content: [] }, complete: true },
    );
  }
  if (Buffer.byteLength(JSON.stringify(blocks)) > 2 * 1024 * 1024)
    throw Error("Content limit exceeded");
  return blocks;
}
function recordedTool(
  item: Item,
): { name: string; input: unknown; output: unknown } | undefined {
  if (
    (item.type === "mcpToolCall" || item.type === "dynamicToolCall") &&
    typeof item.tool === "string" &&
    item.tool.length > 0 &&
    item.tool.length <= 256
  ) {
    const input = item.input ?? item.arguments ?? item.params ?? {};
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const output = item.result ?? item.error;
    if (output === undefined) return;
    return { name: item.tool, input, output };
  }
  if (item.type === "fileChange" && Array.isArray(item.changes)) {
    const changes = item.changes.map(({ path, kind }) => ({ path, kind }));
    return {
      name: "Edit",
      input: { file_path: changes.map((change) => change.path) },
      output: {
        changes,
        ...(item.error !== undefined ? { error: item.error } : {}),
      },
    };
  }
  if (item.type === "commandExecution" && typeof item.command === "string")
    return {
      name: "Bash",
      input: { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}) },
      output: {
        output: item.aggregatedOutput ?? "",
        ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
      },
    };
  if (item.type === "webSearch") {
    const action = item.action;
    const input = action ?? { query: item.query ?? "" };
    return {
      name:
        action?.type === "openPage" || action?.type === "findInPage"
          ? "WebFetch"
          : "WebSearch",
      input,
      output: {
        ...(item.sources !== undefined ? { sources: item.sources } : {}),
        ...(item.result !== undefined ? { result: item.result } : {}),
        ...(item.error !== undefined ? { error: item.error } : {}),
        action: input,
      },
    };
  }
  return;
}

/** Pinned Chat citation readers require UUID, span and webpage metadata. Source
 * offsets are UTF-16; pinned shared-l-p-m-w-2::uf counts Unicode code points.
 * Convert only valid scalar boundaries. No network read. */
function officialCitations(item: Item, projected: ReturnType<typeof projectWebCitationText>) {
  if (item.citations === undefined) return [];
  if (!Array.isArray(item.citations) || item.citations.length > 200)
    throw Error("Invalid citations");
  return item.citations.map((c) => {
    if (
      !c ||
      typeof c.url !== "string" ||
      c.url.length > 2048 ||
      !Number.isSafeInteger(c.start) ||
      !Number.isSafeInteger(c.end) ||
      c.start < 0 ||
      c.end < c.start ||
      c.end > (item.text?.length ?? 0) ||
      (c.title !== undefined && typeof c.title !== "string")
    )
      throw Error("Invalid citation");
    const text = item.text ?? "";
    const split = (n: number) =>
      n > 0 &&
      n < text.length &&
      /[\uD800-\uDBFF]/.test(text[n - 1]) &&
      /[\uDC00-\uDFFF]/.test(text[n]);
    if (split(c.start) || split(c.end))
      throw Error("Invalid citation boundary");
    const url = new URL(c.url);
    if (!["http:", "https:"].includes(url.protocol))
      throw Error("Unsupported citation URL");
    const hash = createHash("sha256")
      .update(JSON.stringify([item.id, c.url, c.start, c.end]))
      .digest("hex");
    return {
      uuid: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
      url: c.url,
      title: c.title ?? url.hostname,
      start_index: Array.from(projected.text.slice(0, projected.displayOffset(c.start))).length,
      end_index: Array.from(projected.text.slice(0, projected.displayOffset(c.end))).length,
      metadata: {
        type: "webpage_metadata",
        site_domain: url.hostname,
        site_name: url.hostname,
      },
    };
  });
}
