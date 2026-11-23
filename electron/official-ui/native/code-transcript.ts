import "../../../shared/code-rewind";
import { codeAgentTranscript } from "./code-agent-transcript";
/**
 * Converts Claudex Code turns into the official LocalSessions transcript
 * envelope. The envelope is derived from the installed desktop client's Code
 * transcript reader. The adapter is experimental until every emitted item
 * type has a faithful representation.
 */
import { posix as path } from "node:path";
import type { Attachment, Conversation, GeneratedFile, Item, Settings, Turn } from "../../../shared/types";
import { sanitizeDescription } from "../../../shared/tool-description";
import { itemIsRunning } from "../../../shared/activity";
import { isSteeredMessage } from "../../../shared/agent-api";
import {
  agentMessageOrigin,
  type AgentMessageOrigin,
} from "../../../shared/agent-messages";
import { parseUnifiedDiff, type DiffLine } from "../../../shared/diff-model";
import { codeTurnStoppedByUser } from "../../../shared/official-code-followup";
import { visibleThinkingSummary } from "../../../shared/thinking-summaries";
import { codeWorkflowTranscript, type CodeWorkflowEvent } from "./code-workflow-transcript";
import type { CodeOutputAttachment } from "../api/generated-output-files";
import { mcpAuthRequired } from "../api/connector-auth";
import {
  codeAgentActivityText,
  codeToolTranscript,
  transcriptToolText,
  type CodeToolMetadata,
  type CodeToolResultBlock,
} from "./code-tool-transcript";

interface StructuredHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}
type FileResult = {
  filePath: string;
  originalFile: null;
  structuredPatch: StructuredHunk[];
} & (
  | { content: string; type: "create" }
  | {
      oldString: string;
      newString: string;
      replaceAll: false;
      claudexReconstructedFromPatch: true;
      claudexOriginalDiff: string;
    }
  | {
      edits: { old_string: string; new_string: string; replace_all: false }[];
      claudexReconstructedFromPatch: true;
      claudexOriginalDiff: string;
    }
);

type CodeLimitVerdict = {
  status: "rejected";
  rateLimitType: "five_hour";
  resetsAt: number;
  utilization: 1;
};

interface CodeTranscriptEnvelope {
  type: "user" | "assistant" | "system" | "rate_limit_event";
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  isSidechain: boolean;
  parent_tool_use_id?: string;
  agentId?: string;
  message: {
    id?: string;
    role: "user" | "assistant";
    stop_reason?: "end_turn" | "refusal" | "pause_turn";
    content: string | CodeContentBlock[];
    usage?: { input_tokens: number; cache_read_input_tokens: number; output_tokens: number };
  };
  toolUseResult?: Record<string, any>;
  mcpMeta?: CodeToolMetadata;
  /** Observed progress only, not a completed result or native progress event. */
  claudexToolProgress?: string;
  claudexToolResultWarnings?: string[];
  /** Diagnostics for records without a complete official representation. */
  claudexUnsupported?: string[];
  /** Original Codex summary sections; no Claude signature is fabricated. */
  claudexReasoning?: string[];
  isApiErrorMessage?: true;
  rate_limit_info?: CodeLimitVerdict;
  api_error?: "rate_limit";
  api_error_status?: 429;
  error?: "rate_limit";
  api_error_params?: { rate_limit_info: CodeLimitVerdict };
  /** Source records stay available for fields without an official equivalent. */
  claudexSourceItem?: Item;
  claudexSentPrompts?: string[];
  origin?: (AgentMessageOrigin & { from?: string; senderTaskId?: string }) | { kind: "auto-continuation" };
  codeOutput?: { turnId: string; itemId: string; fileId?: string };
  file_attachments?: {file_uuid:string;file_name:string;is_image:boolean}[];
}

type CodeCompactionState =
  | { subtype: "compact_boundary"; compact_metadata?: { pre_tokens?: number; post_tokens: number } }
  | { subtype: "status"; status: "compacting"; compact_result?: never }
  | { subtype: "status"; status: null; compact_result?: "failed" };

export const codeCompactionProgressUuid = (turnId: string, itemId: string) =>
  `${turnId}:item:${itemId}:compacting`;

export type CodeTranscriptRow = CodeTranscriptEnvelope & (
  | { subtype?: never }
  | ({ type: "system" } & (CodeCompactionState | { subtype: "agents_killed" } |
    { subtype: "local_command_output"; content: string } |
    { subtype: "model_refusal_fallback"; direction: "retry"; original_model: string; fallback_model: string; content: string } | import("./code-agent-transcript").CodeAgentEvent | CodeWorkflowEvent))
);

export type CodeContentBlock =
  | { type: 'image'; source: {type:'base64';media_type:string;data:string} }
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: "Bash";
      input: { command: string; description?: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: "Write";
      input: { file_path: string; content: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: "Edit";
      input: {
        file_path: string;
        old_string: string;
        new_string: string;
        replace_all: false;
      };
    }
  | {
      type: "tool_use";
      id: string;
      name: "MultiEdit";
      input: {
        file_path: string;
        edits: { old_string: string; new_string: string; replace_all: false }[];
      };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | CodeToolResultBlock[];
      is_error: boolean;
    };

export interface CodeTranscriptConversion {
  rows: CodeTranscriptRow[];
  /** Item kinds or turn features that cannot yet be represented safely. */
  unsupported: string[];
}

interface RecordedActivity {
  name: string;
  input: Record<string, unknown>;
  output: string;
  result?: Record<string, unknown>;
  running: boolean;
  failed: boolean;
  outputAttachment?: { fileId?: string };
}

function outputResult(attachment: CodeOutputAttachment) {
  const result = { attachments: [attachment] };
  return { result, output: JSON.stringify(result) };
}

function recordedOutput(
  activity: Pick<RecordedActivity, "running" | "failed">,
  attachment: CodeOutputAttachment,
  outputAttachment?: RecordedActivity["outputAttachment"],
): RecordedActivity {
  return {
    ...activity,
    name: "SendUserFile",
    input: { path: attachment.path },
    ...outputResult(attachment),
    ...(outputAttachment ? { outputAttachment } : {}),
  };
}

export function hydrateCodeOutput(
  row: CodeTranscriptRow,
  attachment?: CodeOutputAttachment,
): CodeTranscriptRow {
  if (!row.codeOutput) return row;
  const { codeOutput, ...display } = row;
  const content = display.message.content;
  if (!attachment || typeof content === "string") return display;
  const { result, output } = outputResult(attachment);
  return {
    ...display,
    message: {
      ...display.message,
      content: content.map((block) =>
        block.type === "tool_result" ? { ...block, content: output } : block,
      ),
    },
    toolUseResult: result,
  };
}

function recordedActivity(
  item: Item,
  mode: "code" | "cowork",
): RecordedActivity[] | undefined {
  const status = item.lifecycleStatus ?? item.status;
  const running = status === "inProgress" || status === "running";
  const failed = ["failed", "declined", "interrupted"].includes(status ?? "");
  const base = { running, failed };
  if (item.type === "sleep")
    return [
      {
        ...base,
        name: "Sleep",
        input: {},
        output:
          typeof item.durationMs === "number"
            ? JSON.stringify({ durationMs: item.durationMs })
            : "",
      },
    ];
  if (item.type === "imageView" && typeof item.path === "string") {
    return [
      {
        ...base,
        name: "Read",
        input: { file_path: item.path },
        output: transcriptToolText({
          path: item.path,
          viewedImage: true,
          ...(item.error ? { error: item.error } : {}),
        }),
      },
    ];
  }
  if (item.type === "collabAgentToolCall" && item.tool === "workflow") {
    return [
      {
        ...base,
        name: "Workflow",
        input: {
          name: item.workflowName ?? "workflow",
          description: item.workflowDescription ?? "",
          prompt: item.prompt ?? "",
          phases: item.workflowPhases ?? [],
        },
        output: transcriptToolText(item),
      },
    ];
  }
  if (
    item.type === "taskPlan" &&
    Array.isArray(item.plan) &&
    item.plan.every(
      (step: any) =>
        step != null &&
        typeof step.step === "string" &&
        ["pending", "inProgress", "in_progress", "completed"].includes(
          step.status,
        ),
    )
  ) {
    const todos = item.plan.map((step: any, index: number) => ({
      id: `${item.id}:${index}`,
      content: step.step,
      status: step.status === "inProgress" ? "in_progress" : step.status,
    }));
    return [
      {
        ...base,
        name: "TodoWrite",
        input: { todos },
        output: JSON.stringify({ todos, explanation: item.explanation ?? "" }),
        result: { newTodos: todos },
      },
    ];
  }
  if (item.type === "webSearch") {
    const action = item.action;
    if (action?.type === "openPage" || action?.type === "findInPage") {
      if (typeof action.url !== "string") return;
      // Codex's page-open record has no fetched body. Keep that distinction
      // instead of inventing page contents or an HTTP success response.
      return [
        {
          ...base,
          name: "WebFetch",
          input: {
            url: action.url,
            ...(action.type === "findInPage"
              ? { prompt: action.pattern ?? "" }
              : {}),
          },
          output: transcriptToolText({
            action,
            ...(item.result ? { result: item.result } : {}),
            ...(item.error ? { error: item.error } : {}),
          }),
        },
      ];
    }
    const queries = Array.isArray(action?.queries) ? action.queries : [];
    const query =
      typeof item.query === "string"
        ? item.query
        : typeof action?.query === "string"
          ? action.query
          : queries.join("\n");
    const content = Array.isArray(item.sources) ? item.sources : [];
    const result = { query, results: [{ content }], queries };
    return [
      {
        ...base,
        name: "WebSearch",
        input: { query },
        output: item.error
          ? transcriptToolText(item.error)
          : JSON.stringify(result),
        result,
      },
    ];
  }
  if (item.type === "outputFiles" && Array.isArray(item.generatedFiles)) {
    return item.generatedFiles.map((file) => {
      const metadata = {
        size: file.bytes ?? 0,
        isImage: file.mime?.startsWith("image/") ?? file.language === "image",
      };
      if (mode === "cowork") {
        return recordedOutput(base, {
          ...metadata,
          path: file.path,
          ...(file.state !== "ready"
            ? {
                unavailable: true,
                unavailable_text:
                  file.error ||
                  (file.state === "deleted" ? "File deleted" : "File unavailable"),
              }
            : {}),
        });
      }
      return recordedOutput(
        base,
        {
          ...metadata,
          path: path.basename(file.name.replaceAll("\\", "/")),
          unavailable: true,
        },
        { fileId: file.id },
      );
    });
  }
  if (
    mode === "code" &&
    item.type === "imageGeneration" &&
    typeof item.savedPath === "string" &&
    item.savedPath
  ) {
    return [
      recordedOutput(
        base,
        {
          path: path.basename(item.savedPath.replaceAll("\\", "/")),
          size: 0,
          isImage: true,
          unavailable: true,
        },
        {},
      ),
    ];
  }
  return undefined;
}

export function attachmentTranscript(text:string,attachments:Attachment[],imageData?:(a:Attachment)=>{mime:string;base64:string}|null){
  const blocks:CodeContentBlock[]=[],files:{file_uuid:string;file_name:string;is_image:false}[]=[];
  for(const a of attachments){
    if(!a.id||!a.name)continue;
    const image=a.kind==='image'?imageData?.(a):null;
    if(image)blocks.push({type:'image',source:{type:'base64',media_type:image.mime,data:image.base64}});
    else files.push({file_uuid:a.id,file_name:a.name,is_image:false});
  }
  if(blocks.length&&text)blocks.push({type:'text',text});
  return {content:blocks.length?blocks:text,files};
}

export function codeSteerTranscriptInput(
  turn: Pick<Turn, "id">,
  item: Item,
): { uuid: string; text: string; attachments: Attachment[] } | undefined {
  if (!isSteeredMessage(item) || typeof item.text !== "string") return;
  return {
    uuid:
      item.officialCodeEventId ?? item.officialCoworkEventId ?? (item.clientId || `${turn.id}:item:${item.id}`),
    text: item.text,
    attachments: item.attachments ?? [],
  };
}

const noNewline = "\\ No newline at end of file";
const hunkText = (lines: DiffLine[]) =>
  lines.map((line) => line.text + (line.ending ?? "\n")).join("");
type FileChange = NonNullable<Item["changes"]>[number];
const fileChangeKind = (change: FileChange) =>
  typeof change.kind === "string" ? change.kind : change.kind?.type;
const fileToolId = (turnId: string, itemId: string, index: number) =>
  `${turnId}:file:${itemId}:${index}`;

function writeInput(change: FileChange, generated: GeneratedFile[]) {
  if (fileChangeKind(change) !== "add" || change.kind?.move_path ||
      typeof change.path !== "string" || typeof change.diff !== "string" ||
      generated.some((file) => file.path === change.path &&
        (file.operation !== "create" || file.previousPath))) return;
  return { file_path: change.path, content: change.diff };
}

export function codeFileWrites(turnId: string, item: Item) {
  return codeFileChangeProjections(turnId, item)
    .map(({ tool }) => tool)
    .filter((tool) => tool.name === "Write");
}

export function codeFileChangeProjections(turnId: string, item: Item) {
  if (item.type !== "fileChange") return [];
  return (item.changes ?? []).flatMap((change, index) => {
    const projection = fileChangeTranscript(
      fileToolId(turnId, item.id, index), change, item.generatedFiles ?? [],
    );
    return projection ? [projection] : [];
  });
}

function fileChangeTranscript(
  id: string,
  change: FileChange,
  generated: GeneratedFile[],
): { tool: Extract<CodeContentBlock, { type: "tool_use" }>; result: FileResult } | undefined {
  const kind = fileChangeKind(change);
  const { path: filePath, diff } = change;
  if (change.kind?.move_path || typeof filePath !== "string" ||
      typeof diff !== "string") return;
  const files = generated.filter((file) => file.path === filePath);
  const base = { filePath, originalFile: null };
  if (kind === "add") {
    const input = writeInput(change, files);
    if (!input) return;
    const lines = diff === "" ? [] : diff.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    const patch = lines.map((line) => "+" + line);
    if (diff && !diff.endsWith("\n")) patch.push(noNewline);
    return {
      tool: { type: "tool_use", id, name: "Write", input },
      result: {
        ...base,
        type: "create",
        content: diff,
        structuredPatch: lines.length
          ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: patch }]
          : [],
      },
    };
  }
  if (kind !== "update" ||
      files.some((file) => file.operation !== "update" || file.previousPath)) return;
  const parsed = parseUnifiedDiff(diff, filePath);
  const file = parsed[0];
  if (parsed.length !== 1 || file.binary || file.oldPath || !file.hunks.length ||
      (file.path !== filePath &&
        !filePath.replaceAll("\\", "/").endsWith("/" + file.path.replaceAll("\\", "/"))))
    return;
  const edits: { old_string: string; new_string: string; replace_all: false }[] = [];
  const structuredPatch: StructuredHunk[] = [];
  for (const hunk of file.hunks) {
    const oldLines = hunk.lines.filter((line) => line.kind !== "add");
    const newLines = hunk.lines.filter((line) => line.kind !== "del");
    if (oldLines.length !== hunk.oldLines || newLines.length !== hunk.newLines ||
        hunk.lines.every((line) => line.kind === "context")) return;
    edits.push({
      old_string: hunkText(oldLines),
      new_string: hunkText(newLines),
      replace_all: false,
    });
    structuredPatch.push({
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      lines: hunk.lines.flatMap((line) => {
        const text = (line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ") + line.text;
        return line.ending === "" ? [text, noNewline] : [text];
      }),
    });
  }
  const result = {
    ...base, structuredPatch, claudexReconstructedFromPatch: true as const, claudexOriginalDiff: diff,
  };
  if (edits.length === 1) {
    const { old_string, new_string } = edits[0];
    return {
      tool: { type: "tool_use", id, name: "Edit", input: { file_path: filePath, ...edits[0] } },
      result: { ...result, oldString: old_string, newString: new_string, replaceAll: false },
    };
  }
  return {
    tool: { type: "tool_use", id, name: "MultiEdit", input: { file_path: filePath, edits } },
    result: { ...result, edits },
  };
}

function shellTranscriptText(turn: Turn, command: Item | undefined) {
  const input = `<bash-input>${turn.prompt}</bash-input>`;
  if (turn.status === "inProgress" && !command?.aggregatedOutput) return input;
  const output = (command?.aggregatedOutput ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  const exitCode = command?.exitCode;
  const exit = Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 999
    ? `<bash-exit-code>${exitCode}</bash-exit-code>`
    : "";
  return `${input}<bash-stdout>${output}</bash-stdout><bash-stderr></bash-stderr>${exit}`;
}

export function convertCodeTranscript(
  conversation: Conversation,
  imageData?: (attachment:Attachment)=>{mime:string;base64:string}|null,
  options: {
    mcpServers?: Settings["mcpServers"];
    onTurnEnd?: (turn: Turn, rowCount: number) => void;
    appendSettledNotices?: boolean;
    onPartialCoworkReply?: (reply: { id: string; text: string }) => void;
  } = {},
): CodeTranscriptConversion {
  const mode = conversation.mode;
  if (mode !== "code" && mode !== "cowork")
    throw new Error("History requires a Code conversation or a Cowork session.");
  const mcpServers = mode === "code" ? options.mcpServers : undefined;
  const rows: CodeTranscriptRow[] = [];
  const unsupported = new Set<string>();
  let parentUuid: string | null = null;
  for (const turn of conversation.turns) {
    if (turn.importedCodeTranscript?.length) {
      for (const source of turn.importedCodeTranscript) {
        rows.push({ ...source, sessionId: conversation.id } as CodeTranscriptRow);
        if (!source.isSidechain && !source.parent_tool_use_id)
          parentUuid = source.uuid;
      }
      options.onTurnEnd?.(turn, rows.length);
      continue;
    }
    const firstRow = rows.length;
    const timestamp = new Date(turn.createdAt).toISOString();
    const pendingNotices: { uuid: string; timestamp: string; kinds: string[] }[] = [];
    const writeNotice = ({ uuid, timestamp, kinds }: { uuid: string; timestamp: string; kinds: string[] }) => {
      const labels = kinds.map((kind) =>
        /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(kind) ? kind : "unknown-record",
      );
      rows.push({
        type: "system",
        uuid,
        parentUuid,
        sessionId: conversation.id,
        timestamp,
        isSidechain: false,
        message: { role: "assistant", content: [] },
        claudexUnsupported: labels,
      });
      parentUuid = uuid;
    };
    const diagnostic = (uuid: string, timestamp: string, kinds: string[], settled = false) => {
      if (turn.status === "inProgress" && !settled) return;
      const entry = { uuid, timestamp, kinds };
      if (options.appendSettledNotices) pendingNotices.push(entry);
      else writeNotice(entry);
    };
    const turnWarnings: string[] = [];
    if (turn.status === "inProgress") unsupported.add("running-turn");
    const userShell = turn.shell
      ? turn.items.find((item) => item.type === "commandExecution" && item.source === "userShell")
      : undefined;
    const prompt = turn.shell ? shellTranscriptText(turn, userShell) : turn.officialCodeDisplayText ?? turn.prompt;
    const uploaded=attachmentTranscript(prompt,turn.attachments,imageData);
    if (turn.attachments.some((a) => !a.name || !a.id)) {
      unsupported.add("attachments");
      turnWarnings.push("attachments");
    }
    if (turn.error && turn.status !== "failed" && turn.status !== "interrupted") {
      unsupported.add("turn-status");
      turnWarnings.push("turn-status");
    }
    const quotaHold = turn.usageHold;
    const quota: CodeLimitVerdict | undefined = conversation.mode === "code" &&
      turn.status === "failed" && turn.stopReason === "usage_limit" &&
      quotaHold?.window === "five_hour" && quotaHold.resetsAt !== null
      ? { status: "rejected", rateLimitType: "five_hour",
          resetsAt: Math.floor(quotaHold.resetsAt / 1000), utilization: 1 }
      : undefined;
    if (
      turn.stopReason &&
      !quota &&
      !(turn.status === "interrupted" && turn.stopReason === "restart")
    ) {
      unsupported.add("turn-stop-reason");
      turnWarnings.push("turn-stop-reason");
    }
    const userUuid = turn.officialCodeEventId ?? `${turn.id}:user`;
    if(!turn.compaction)rows.push({
      type: "user",
      uuid: userUuid,
      parentUuid,
      sessionId: conversation.id,
      timestamp,
      isSidechain: false,
      message: { role: "user", content: uploaded.content },
      ...(turn.autoContinuation && { origin: { kind: "auto-continuation" } }),
      ...(uploaded.files.length?{file_attachments:uploaded.files}:{}),
      ...(turn.rawOriginals?.length
        ? { claudexSentPrompts: [...turn.rawOriginals] }
        : {}),
    });
    if(!turn.compaction)parentUuid = userUuid;
    if (turn.refusedPrompt && turn.switchedTo) {
      const uuid = `${turn.id}:refusal-fallback`;
      rows.push({ type: "system", subtype: "model_refusal_fallback", direction: "retry",
        original_model: turn.refusedPrompt.model, fallback_model: turn.switchedTo, content: "",
        uuid, parentUuid, sessionId: conversation.id, timestamp, isSidechain: false,
        message: { role: "assistant", content: [] } });
      parentUuid = uuid;
    }
    const workflowRuns = new Map<string, Item>();
    const workflowCalls = new Set<string>();
    if (mode === "code") {
      for (const item of turn.items) {
        if (item.type === "collabAgentToolCall" && item.tool === "workflow" && item.id.startsWith("workflow-"))
          workflowRuns.set(item.id.slice("workflow-".length), item);
        if (item.type === "dynamicToolCall" && item.tool === "Workflow")
          workflowCalls.add(item.id);
      }
    }
    for (const sourceItem of turn.items) {
      const callId = sourceItem.type === "dynamicToolCall" && sourceItem.tool === "Workflow"
        ? sourceItem.id
        : undefined;
      const run = callId ? workflowRuns.get(callId) : undefined;
      const item = run ?? sourceItem;
      if (sourceItem.type === "collabAgentToolCall" && sourceItem.tool === "workflow" &&
          sourceItem.id.startsWith("workflow-") && workflowCalls.has(sourceItem.id.slice("workflow-".length)))
        continue;
      if (item === userShell) continue;
      if (item.type === "worktreeNotice" && item.text) {
        const uuid = `${turn.id}:item:${item.id}`;
        rows.push({
          type: "system",
          subtype: "local_command_output",
          content: `<local-command-stdout>${item.text}</local-command-stdout>`,
          uuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: { role: "assistant", content: [] },
        });
        parentUuid = uuid;
        continue;
      }
      if (item.type === "agentNotice" && item.notice === "agents_killed") {
        const uuid = `${turn.id}:item:${item.id}`;
        rows.push({
          type: "system",
          subtype: "agents_killed",
          uuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: { role: "assistant", content: [] },
        });
        parentUuid = uuid;
        continue;
      }
      if (item.type === "contextCompaction") {
        const postTokens = item.compactionTokens?.after ?? (turn.compaction ? turn.contextUsage?.totalTokens : undefined);
        const state: CodeCompactionState =
          item.lifecycleStatus === "completed" && turn.status === "completed"
            ? {
                subtype: "compact_boundary",
                ...(postTokens !== undefined && { compact_metadata: { pre_tokens: item.compactionTokens?.before, post_tokens: postTokens } }),
              }
            : turn.status === "inProgress"
              ? { subtype: "status", status: "compacting" }
              : {
                  subtype: "status",
                  status: null,
                  ...(turn.status === "failed"
                    ? { compact_result: "failed" }
                    : {}),
                };
        const itemUuid = `${turn.id}:item:${item.id}`;
        const uuid = state.subtype === "compact_boundary"
          ? (turn.compactionRequestId ? `${turn.compactionRequestId}:boundary` : itemUuid)
          : state.status === "compacting"
            ? codeCompactionProgressUuid(turn.id, item.id)
            : `${itemUuid}:compact-end`;
        rows.push({
          type: "system",
          ...state,
          uuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: { role: "assistant", content: [] },
          claudexSourceItem: item,
        });
        parentUuid = uuid;
        continue;
      }
      const agentRows = codeAgentTranscript(conversation, turn, item, parentUuid, mcpServers);
      if (agentRows.length) {
        rows.push(...agentRows);
        parentUuid = agentRows.filter(row => !row.parent_tool_use_id).at(-1)!.uuid;
        continue;
      }
      const agentActivity = codeAgentActivityText(item);
      if (agentActivity !== undefined) {
        const uuid = `${turn.id}:item:${item.id}`;
        rows.push({
          type: "assistant", uuid, parentUuid,
          sessionId: conversation.id, timestamp, isSidechain: false,
          message: { role: "assistant", content: [{ type: "text", text: agentActivity }] },
        });
        parentUuid = uuid;
        continue;
      }
      // These are recorded activities, not commands to execute on replay.
      // Official readers consume TodoWrite.input.todos, WebSearch's structured
      // result and SendUserFile.attachments (c7b82dfaf, c06cf64bb, shared-11).
      const activity = recordedActivity(item, mode);
      if (activity) {
        for (const [index, tool] of activity.entries()) {
          const toolId = run
            ? `${turn.id}:tool:${callId}`
            : `${turn.id}:activity:${item.id}:${index}`;
          const useUuid = `${toolId}:use`;
          rows.push({
            type: "assistant",
            uuid: useUuid,
            parentUuid,
            sessionId: conversation.id,
            timestamp,
            isSidechain: false,
            ...(tool.outputAttachment ? {} : { claudexSourceItem: item }),
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: toolId,
                  name: tool.name,
                  input: tool.input,
                },
              ],
            },
          });
          parentUuid = useUuid;
          const workflowEvents = mode === "code" && tool.name === "Workflow"
            ? codeWorkflowTranscript({ conversation, turn, item, toolId })
            : [];
          const appendWorkflowEvent = (event: CodeWorkflowEvent) => {
            rows.push({
              ...event,
              type: "system",
              parentUuid,
              sessionId: conversation.id,
              timestamp: event.timestamp ?? timestamp,
              isSidechain: false,
              message: { role: "assistant", content: [] },
            });
            parentUuid = event.uuid;
          };
          for (const event of workflowEvents)
            if (event.subtype !== "task_notification") appendWorkflowEvent(event);
          if (tool.running) {
            unsupported.add("running-tool-call");
            continue;
          }
          const resultUuid = `${toolId}:result`;
          rows.push({
            type: "user",
            uuid: resultUuid,
            parentUuid,
            sessionId: conversation.id,
            timestamp,
            isSidechain: false,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolId,
                  content: tool.output,
                  is_error: tool.failed,
                },
              ],
            },
            ...(tool.result ? { toolUseResult: tool.result } : {}),
            ...(tool.outputAttachment
              ? {
                  codeOutput: {
                    turnId: turn.id,
                    itemId: item.id,
                    ...tool.outputAttachment,
                  },
                }
              : {}),
          });
          parentUuid = resultUuid;
          for (const event of workflowEvents)
            if (event.subtype === "task_notification") appendWorkflowEvent(event);
        }
        continue;
      }
      const steer = codeSteerTranscriptInput(turn, item);
      if (steer) {
        const { uuid, text, attachments } = steer;
        const uploaded = attachmentTranscript(text, attachments, imageData);
        if (attachments.some(({ name, id }) => !name || !id)) {
          unsupported.add("attachments");
          turnWarnings.push("attachments");
        }
        rows.push({
          type: "user",
          uuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: { role: "user", content: uploaded.content },
          ...(uploaded.files.length ? { file_attachments: uploaded.files } : {}),
        });
        parentUuid = uuid;
        continue;
      }
      const peer = item.type === "peerMessage" && agentMessageOrigin(item);
      if (peer && typeof item.text === "string") {
        const uuid = `${turn.id}:item:${item.id}`;
        const from =
          typeof item.agentThreadId === "string" ? item.agentThreadId : undefined;
        rows.push({
          type: "user",
          uuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: { role: "user", content: item.text },
          origin: {
            ...peer,
            ...(from ? { from } : {}),
            ...(from && peer.subagent ? { senderTaskId: from } : {}),
          },
        });
        parentUuid = uuid;
        continue;
      }
      if (item.type === "reasoning") {
        // Some providers return both public summary and raw reasoning fields.
        // Project only summary; do not leak the source record into this envelope.
        const summary = visibleThinkingSummary(item);
        if (
          item.summary !== undefined &&
          (!Array.isArray(item.summary) ||
            Array.from(item.summary).some((part) => part != null && typeof part !== "string"))
        ) {
          unsupported.add("reasoning-summary");
          turnWarnings.push("reasoning-summary");
        }
        if (!summary.length) continue;
        const uuid = `${turn.id}:item:${item.id}`;
        rows.push({
          type: "assistant",
          uuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: summary.join("\n\n") },
            ],
          },
          claudexReasoning: summary,
        });
        parentUuid = uuid;
        continue;
      }
      // Claudex uses turn/diff/updated as aggregate state for the Changes
      // panel, and its own transcript deliberately excludes this duplicate.
      // The original aggregate stays in the conversation store.
      if (item.type === "diff") continue;
      if (item.type === "fileChange" && item.changes?.length) {
        const succeeded = item.status === "completed" &&
          item.lifecycleStatus !== "failed" && item.lifecycleStatus !== "interrupted";
        const pending = turn.status === "inProgress" && itemIsRunning(item);
        const projections = codeFileChangeProjections(turn.id, item);
        for (const projection of projections) {
          const toolId = projection.tool.id;
          const toolUuid = `${toolId}:use`;
          rows.push({
            type: "assistant",
            uuid: toolUuid,
            parentUuid,
            sessionId: conversation.id,
            timestamp,
            isSidechain: false,
            message: { role: "assistant", content: [projection.tool] },
          });
          parentUuid = toolUuid;
          if (pending && !succeeded) continue;
          const resultUuid = `${toolId}:result`;
          rows.push({
            type: "user",
            uuid: resultUuid,
            parentUuid: toolUuid,
            sessionId: conversation.id,
            timestamp,
            isSidechain: false,
            message: {
              role: "user",
              content: [{
                type: "tool_result", tool_use_id: toolId,
                content: !succeeded && typeof item.error === "string" ? item.error : "",
                is_error: !succeeded,
              }],
            },
            ...(succeeded && { toolUseResult: projection.result }),
          });
          parentUuid = resultUuid;
        }
        if (projections.length === item.changes.length) continue;
      }
      if (
        item.type === "commandExecution" &&
        typeof item.command === "string"
      ) {
        const toolId = `${turn.id}:tool:${item.id}`;
        const toolUuid = `${toolId}:use`;
        const description = sanitizeDescription(item.description);
        rows.push({
          type: "assistant",
          uuid: toolUuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolId,
                name: "Bash",
                input: {
                  command: item.command,
                  ...(description ? { description } : {}),
                },
              },
            ],
          },
        });
        parentUuid = toolUuid;
        const commandStatus = item.lifecycleStatus ?? item.status;
        if (
          !["completed", "failed", "declined", "interrupted"].includes(
            commandStatus ?? "",
          )
        ) {
          unsupported.add(
            (commandStatus === "inProgress" || commandStatus === "running")
              ? "running-command"
              : "unknown-command-status",
          );
          if (commandStatus !== "inProgress" && commandStatus !== "running")
            diagnostic(`${toolId}:notice`, timestamp, ["unknown-command-status"]);
          continue;
        }
        const resultUuid = `${toolId}:result`;
        rows.push({
          type: "user",
          uuid: resultUuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: turn.userStopped && item.lifecycleStatus === "interrupted" && !item.aggregatedOutput
                  ? "Tool execution stopped by user"
                  : item.aggregatedOutput ?? "",
                is_error:
                  ["failed", "declined", "interrupted"].includes(
                    item.status ?? "",
                  ) ||
                  ["failed", "interrupted"].includes(
                    item.lifecycleStatus ?? "",
                  ) ||
                  (typeof item.exitCode === "number" && item.exitCode !== 0),
              },
            ],
          },
        });
        parentUuid = resultUuid;
        continue;
      }
      if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        const tool = codeToolTranscript(item, mcpServers);
        if (
          item.type === "mcpToolCall" &&
          tool.progress !== undefined &&
          !item.tool
        ) {
          unsupported.add(tool.running ? "running-tool-call" : "unknown-tool-status");
          continue;
        }
        const toolId = `${turn.id}:tool:${item.id}`;
        const toolUuid = `${toolId}:use`;
        const authRequired = mcpAuthRequired(item, toolId, conversation.id);
        const mcpMeta = authRequired
          ? { ...tool.mcpMeta, _meta: { anthropic_error_code: authRequired.error_code } }
          : tool.mcpMeta;
        rows.push({
          type: "assistant",
          ...(tool.running && tool.progress !== undefined ? { claudexToolProgress: tool.progress } : {}),
          ...(!tool.complete && tool.warnings.length
            ? { claudexToolResultWarnings: tool.warnings }
            : {}),
          uuid: toolUuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: toolId,
                name: authRequired && item.tool
                  ? `mcp__${authRequired.server_id}__${item.tool}`
                  : tool.name,
                input: tool.input,
              },
            ],
          },
        });
        parentUuid = toolUuid;
        if (!tool.complete) {
          unsupported.add(tool.running ? "running-tool-call" : "unknown-tool-status");
          if (!tool.running && options.appendSettledNotices)
            diagnostic(`${toolId}:notice`, timestamp, ["unknown-tool-status"]);
          continue;
        }
        const resultUuid = `${toolId}:result`;
        rows.push({
          type: "user",
          ...(mcpMeta ? { mcpMeta } : {}),
          ...(mode === "code" && mcpMeta?.structuredContent !== undefined
            ? { toolUseResult: { structuredContent: mcpMeta.structuredContent } }
            : {}),
          ...(tool.warnings.length ? { claudexToolResultWarnings: tool.warnings } : {}),
          uuid: resultUuid,
          parentUuid,
          sessionId: conversation.id,
          timestamp,
          isSidechain: false,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                content: tool.content,
                is_error: tool.failed,
              },
            ],
          },
        });
        parentUuid = resultUuid;
        continue;
      }
      const text = item.type === "exitedReviewMode" ? item.review : item.text;
      if (
        !["agentMessage", "plan", "exitedReviewMode"].includes(item.type) ||
        typeof text !== "string"
      ) {
        unsupported.add(item.type || "unknown-item");
        diagnostic(
          `${turn.id}:item:${item.id}`,
          timestamp,
          [item.type || "unknown-item"],
          ["completed", "failed", "interrupted", "declined"].includes(item.lifecycleStatus ?? item.status ?? ""),
        );
        continue;
      }
      if (
        item.citations?.length ||
        item.resource_links?.length ||
        item.generatedFiles?.length ||
        item.content?.length
      ) {
        unsupported.add("message-resources");
        turnWarnings.push("message-resources");
      }
      const uuid = `${turn.id}:item:${item.id}`;
      if (options.onPartialCoworkReply && item.type === "agentMessage" &&
          turn.status === "inProgress" && itemIsRunning(item)) {
        if (text) options.onPartialCoworkReply({ id: uuid, text });
        continue;
      }
      rows.push({
        type: "assistant",
        uuid,
        parentUuid,
        sessionId: conversation.id,
        timestamp,
        isSidechain: false,
        message: {
          ...(options.onPartialCoworkReply && item.type === "agentMessage" ? { id: uuid } : {}),
          role: "assistant",
          content: [{ type: "text", text }],
        },
      });
      parentUuid = uuid;
    }
    if (mode === "code" && turn.status === "completed" && !turn.compaction) {
      for (let index = rows.length - 1; index >= firstRow; index--) {
        const row = rows[index];
        if (row.isSidechain || row.parent_tool_use_id || row.type === "system") continue;
        if (row.type === "assistant" && !row.message.stop_reason &&
            Array.isArray(row.message.content) && row.message.content.at(-1)?.type === "text")
          row.message.stop_reason = "end_turn";
        break;
      }
    }
    if (turnWarnings.length)
      diagnostic(`${turn.id}:notice:metadata`, timestamp, [...new Set(turnWarnings)]);
    for (const entry of pendingNotices) writeNotice(entry);
    if (options.onPartialCoworkReply && turn.status === "inProgress") {
      for (let index = firstRow; index < rows.length; index++) {
        const row = rows[index];
        if (row.type === "assistant" && !row.parent_tool_use_id &&
            Array.isArray(row.message.content) && row.message.content.at(-1)?.type === "text")
          row.message.stop_reason = "pause_turn";
      }
    }
    if (codeTurnStoppedByUser(turn)) {
      const uuid = `${turn.id}:user-interrupt`;
      rows.push({
        type: "user", uuid, parentUuid, sessionId: conversation.id, timestamp, isSidechain: false,
        message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
      });
      parentUuid = uuid;
    } else if (
      (turn.status === "failed" || turn.status === "interrupted") &&
      (!turn.compaction || turn.error)
    ) {
      if (quota) {
        const holdUuid = `${turn.id}:rate-limit`;
        rows.push({
          type: "rate_limit_event", uuid: holdUuid, parentUuid,
          sessionId: conversation.id, timestamp, isSidechain: false,
          rate_limit_info: quota, message: { role: "assistant", content: [] },
        });
        parentUuid = holdUuid;
      }
      const uuid = `${turn.id}:error`;
      rows.push({
        type: "assistant",
        uuid,
        parentUuid,
        sessionId: conversation.id,
        timestamp,
        isSidechain: false,
        isApiErrorMessage: true,
        ...(quota ? {
          error: "rate_limit" as const, api_error: "rate_limit" as const,
          api_error_status: 429 as const, api_error_params: { rate_limit_info: quota },
        } : {}),
        message: {
          role: "assistant",
          ...(turn.refusedPrompt ? { stop_reason: "refusal" as const } : {}),
          content: [
            {
              type: "text",
              text:
                (quota ? "You've hit your usage limit." : turn.error) ||
                (turn.status === "interrupted"
                  ? turn.stopReason === "restart"
                    ? "The app closed before this response finished."
                    : "The response was interrupted."
                  : "The response could not be completed."),
            },
          ],
        },
      });
      parentUuid = uuid;
    }
    const usage = turn.contextUsage;
    if (usage && !turn.compaction) {
      for (let index = rows.length - 1; index >= firstRow; index--) {
        const row = rows[index];
        if (row.type !== "assistant" || row.parent_tool_use_id || row.isApiErrorMessage) continue;
        const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
        row.message.usage = {
          input_tokens: usage.inputTokens - cached,
          cache_read_input_tokens: cached,
          output_tokens: usage.outputTokens,
        };
        break;
      }
    }
    options.onTurnEnd?.(turn, rows.length);
  }
  return { rows, unsupported: [...unsupported].sort() };
}

/** LocalSessions.getTranscriptPage, matching the official pager's cursor rules. */
export function pageCodeTranscript(
  rows: CodeTranscriptRow[],
  beforeUuid: string,
  limit: number,
) {
  if (typeof beforeUuid !== "string")
    throw new TypeError("Transcript cursor must be a string.");
  const count = normalizeCodeTranscriptLimit(limit);
  const end = beforeUuid
    ? rows.findIndex((row) => row.uuid === beforeUuid)
    : rows.length;
  if (end < 0)
    return {
      messages: [],
      hasMore: false,
      found: false,
      totalRows: rows.length,
    };
  const start = Math.max(0, end - count);
  return {
    messages: rows.slice(start, end),
    hasMore: start > 0,
    found: true,
    totalRows: rows.length,
  };
}

/** Clamp without 32-bit wraparound; invalid bridge arguments are rejected. */
export function normalizeCodeTranscriptLimit(
  limit: number = 1000,
  maximum = 1000,
): number {
  if (typeof limit !== "number" || !Number.isFinite(limit))
    throw new TypeError("Transcript limit must be a finite number.");
  return Math.max(1, Math.min(Math.floor(limit), maximum));
}
