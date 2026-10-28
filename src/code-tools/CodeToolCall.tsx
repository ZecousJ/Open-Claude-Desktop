import { ChevronRight } from "../ui/glyphs";
import type { Item } from "../../shared/types";
import { itemIsRunning } from "../../shared/activity";
import { isWebFetch } from "../../shared/web-fetch-item";
import { WebFetchError } from "../transcript/tools/WebFetchError";
import {
  isCodeExecution,
  codeExecutionLabel,
} from "../composer/code/code-execution-label";
import { computerUseServerName } from "../../shared/computer-use";
import { mcpOutput } from "../transcript/tools/McpToolView";
import { isMemoryTool } from "../transcript/tools/memory-tool-kind";
import { browserServerName } from "./browser-server";
import {
  syncBaseNamespace,
  syncBaseRow,
  syncBaseRunningVerb,
  syncBaseTool,
} from "../../shared/sync-base-branch";
import {
  useTranscriptViewContext,
  verboseOpen,
} from "../transcript-view/transcript-view-store";

/*
 * A connector or dynamic tool call in a Code turn: a grey row that opens
 * straight onto the result as plain 14px text, the way "Listed previews" opens
 * onto "[]"; a failed call is a red row with the error text in red, then each
 * argument as "name: value" ("expression: location.href", a monospace name over
 * a plain value). No "Input" / "Output" frames: those are the Chat and Cowork
 * rows. The capture words a row from the tool's own description ("Listed
 * previews", "Failed to run page script"); Codex reports only the server and
 * tool names, so the row reads "Used preview: preview_list" and "Failed to use
 * preview: preview_eval", the wording of R-0718 and of the failed Bash rows.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function argumentRows(value: unknown): { name?: string; text: string }[] {
  if (value === null || value === undefined) return [];
  if (!isObject(value)) return [{ text: JSON.stringify(value, null, 2) }];
  return Object.entries(value).map(([name, entry]) => ({
    name,
    text: typeof entry === "string" ? entry : JSON.stringify(entry, null, 2),
  }));
}

/** Claudex's own computer-use and Browser servers and the memory tool keep their rows. */
export function isCodeToolCall(item: Item) {
  if (item.type === "mcpToolCall")
    return (
      item.server !== computerUseServerName && item.server !== browserServerName
    );
  return item.type === "dynamicToolCall" && !isMemoryTool(item);
}

function imageSource(value: string) {
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/.test(
    value,
  ) && value.length < 2_000_100
    ? value
    : undefined;
}

/** The tool's own name as the row words it: "preview: preview list". */
export function codeToolName(item: Item) {
  const owner = String(
    (item.type === "dynamicToolCall" ? item.namespace : item.server) ?? "",
  );
  const tool =
    typeof item.tool === "string" ? item.tool.replace(/_+/g, " ") : item.tool;
  return [owner, tool].filter(Boolean).join(": ") || "a tool";
}

function firstText(item: Item) {
  const first = Array.isArray(item.contentItems)
    ? item.contentItems[0]
    : undefined;
  return first?.type === "inputText" && typeof first.text === "string"
    ? first.text
    : undefined;
}

/** The base branch a finished sync names after its verb. */
export function syncBaseMeta(item: Item) {
  if (item.namespace !== syncBaseNamespace || item.tool !== syncBaseTool)
    return undefined;
  if (itemIsRunning(item) || codeToolFailed(item)) return undefined;
  return syncBaseRow(firstText(item))?.base;
}

/** Whether the call failed (an error status, or a dynamic call that reports no success). */
export function codeToolFailed(item: Item) {
  return (
    item.status === "failed" ||
    item.lifecycleStatus === "failed" ||
    (item.type === "dynamicToolCall" && item.success === false)
  );
}

/**
 * A connector or dynamic tool call's row title in its state. `failedAsDone`
 * words a failed call as a finished one (the phones mark a failure with an
 * icon beside the words, not with "Failed to …").
 */
export function codeToolCallLabel(item: Item, failedAsDone = false) {
  const name = codeToolName(item);
  const app = isObject(item.appContext) ? item.appContext : undefined;
  const action =
    typeof app?.actionName === "string" && app.actionName.trim()
      ? app.actionName.trim()
      : undefined;
  // Sync with base branch words its row from its answer.
  if (item.namespace === syncBaseNamespace && item.tool === syncBaseTool) {
    if (itemIsRunning(item)) return syncBaseRunningVerb(item.arguments);
    const row = syncBaseRow(firstText(item));
    if (row && !codeToolFailed(item)) return row.verb;
  }
  if (itemIsRunning(item))
    return (
      action ?? (isCodeExecution(item) ? codeExecutionLabel() : `Using ${name}`)
    );
  if (codeToolFailed(item) && !failedAsDone) return `Failed to use ${name}`;
  if (item.lifecycleStatus === "interrupted") return `${name} stopped`;
  return action ?? `Used ${name}`;
}

export function CodeToolCall({ item }: { item: Item }) {
  const view = useTranscriptViewContext();
  const dynamic = item.type === "dynamicToolCall";
  const running = itemIsRunning(item);
  const failed = codeToolFailed(item);
  const label = codeToolCallLabel(item);
  const meta = syncBaseMeta(item);
  const error = isWebFetch(item)
    ? undefined
    : isObject(item.error)
      ? item.error.message
      : item.error;
  const output = dynamic
    ? (Array.isArray(item.contentItems) ? item.contentItems : []).map(
        (value: any) =>
          value?.type === "inputText" && typeof value.text === "string"
            ? ({ type: "text", text: value.text } as const)
            : value?.type === "inputImage" &&
                typeof value.imageUrl === "string" &&
                imageSource(value.imageUrl)
              ? ({ type: "image", url: imageSource(value.imageUrl)! } as const)
              : ({
                  type: "other",
                  label:
                    value?.type === "inputImage"
                      ? "Image result available in the tool response"
                      : "Unsupported output type",
                } as const),
      )
    : mcpOutput(item);
  const args = argumentRows(item.arguments);
  return (
    <details className="code-command code-tool-call" open={verboseOpen(view)}>
      <summary>
        <span
          className="code-command-label"
          data-running={running || undefined}
          data-failed={(failed && !running) || undefined}
        >
          {label}
          {meta && (
            <>
              {" "}
              <span className="code-file-name">{meta}</span>
            </>
          )}
        </span>
        <WebFetchError item={item} />
        <ChevronRight size={16} strokeWidth={1.75} />
      </summary>
      <div className="code-tool-call-body">
        {typeof error === "string" && error && (
          <p className="code-tool-call-error" role="status">
            {error}
          </p>
        )}
        {output.map((entry, index) =>
          entry.type === "text" ? (
            <p key={index} className="code-tool-call-text">
              {entry.text}
            </p>
          ) : entry.type === "image" ? (
            <img key={index} src={entry.url} alt="Tool result" />
          ) : entry.type === "resource" ? (
            <p key={index} className="code-tool-call-text">
              {entry.text ?? entry.uri}
            </p>
          ) : (
            <p key={index} className="code-tool-call-text">
              {entry.label}
            </p>
          ),
        )}
        {item.resultOmitted && (
          <p className="code-tool-call-text">
            Large result omitted from this transcript
          </p>
        )}
        {args.map((arg, index) => (
          <p key={index} className="code-tool-call-arg">
            {arg.name && <code>{arg.name}:</code>}
            {arg.text}
          </p>
        ))}
      </div>
    </details>
  );
}
