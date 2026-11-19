import { chatPermissionToWire, type ChatPermissionMode } from "../../../shared/chat-permission-mode";
import type { ChatElicitationHost } from "./chat-elicitation";
import { chatConnectorPreferences } from "./chat-connector-preferences";
import { researchReportAttachment } from "./research-report-files";
import { researchReportArtifactBlock, researchReportVersions } from "./research-report-artifact";
import { commandDeclineElicitations } from "./command-decline-projection";
import { mcpAuthRequired } from "./connector-auth";
import type { CommandDeclineCard } from "../command-decline-host";
import { researchBlock, RESEARCH_ADVANCED } from "./research-projection";
import { generatedOutputAttachments, generatedWorkspaceOutputs } from "./generated-output-files";
import { inlineDisplayKey } from "../../../shared/inline-attachment-display";
import { projectInlineAttachmentDisplays, type InlineDisplayProjection, type InlineDisplayAnswer } from "./inline-attachment-displays";
import {parsePersistedCompletionQuotes} from "../../../shared/completion-quotes";
/**
 * ConversationService/StreamTimeline: the Connect (protobuf, server-streaming)
 * RPC through which the official front-end loads and follows a chat
 * transcript. The message schema is the one embedded in the build
 * (build/official-ui/data/conversation-protocol.json); the transcript is the
 * Claudex conversation (turns of prompt + items), sent as one ConversationUpdate
 * with replace_all_state and then followed through the app's
 * "conversation-turn" events while the stream stays open.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type http from "node:http";
import {
  create,
  createFileRegistry,
  fromBinary,
  fromJson,
  toBinary,
  type DescFile,
  type DescMessage,
  type FileRegistry,
} from "@bufbuild/protobuf";
import {
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  file_google_protobuf_any,
  file_google_protobuf_descriptor,
  file_google_protobuf_duration,
  file_google_protobuf_empty,
  file_google_protobuf_struct,
  file_google_protobuf_timestamp,
  file_google_protobuf_wrappers,
  timestampFromMs,
} from "@bufbuild/protobuf/wkt";
import type { Conversation, Item, Turn } from "../../../shared/types";
import { cleanCitations, uniqueSources } from "../../../shared/gateway-signals";
import { projectWebCitationText } from "../../../shared/web-citation-text";
import { officialChatMemoryMode } from "../../../shared/official-ui-web";
import { aliasListeners, assistantMessageId, messageIndex, pendingSends, resolveConversationId, turnMessageIds, userMessageId, waitingTimelines, type MessageRef, type PendingSend } from "./conversations";
import { learnAttachment, fileDisplayName } from "./files";
import { bindAdapterScope } from "./scope";
import { organizationUuid } from "./context";
import type { AdapterContext } from "./context";
import { codeToolTranscript } from "../native/code-tool-transcript";
import { nativeTranslator } from "../../app/native-i18n";
import { officialLocale } from "../locale";

const PACKAGE = "anthropic.bard.api.v1alpha";
const SERVICE = `${PACKAGE}.ConversationService`;
export const STREAM_TIMELINE_PATH = `/claudeai-rpc/${SERVICE}/StreamTimeline`;
const wellKnown: Record<string, DescFile> = Object.fromEntries(
  [
    file_google_protobuf_any,
    file_google_protobuf_descriptor,
    file_google_protobuf_duration,
    file_google_protobuf_empty,
    file_google_protobuf_struct,
    file_google_protobuf_timestamp,
    file_google_protobuf_wrappers,
  ].map((f) => [f.proto.name, f]),
);

/**
 * The embedded descriptors come from protobuf-es, which drops each file's
 * dependency list; it is recovered from the type references, the files are
 * ordered so definitions precede uses, and the set is registered at once.
 */
export function loadRegistry(protocolPath: string): FileRegistry {
  const entries: { descriptor: unknown }[] = JSON.parse(fs.readFileSync(protocolPath, "utf8"));
  const files = [
    ...new Map(
      entries
        .map((e) => fromJson(FileDescriptorProtoSchema, e.descriptor as any))
        .filter((f) => !wellKnown[f.name])
        .map((f) => [f.name, f] as const),
    ).values(),
  ];
  const definer = new Map<string, string>();
  for (const f of files) for (const t of [...f.messageType, ...f.enumType]) definer.set(`${f.package}.${t.name}`, f.name);
  const references = (f: (typeof files)[number]) => {
    const names = new Set<string>();
    const walk = (m: any) => {
      for (const field of m.field ?? []) if (field.typeName) names.add(field.typeName.replace(/^\./, ""));
      for (const n of m.nestedType ?? []) walk(n);
    };
    for (const m of f.messageType) walk(m);
    for (const s of f.service) for (const m of s.method) { names.add(m.inputType.replace(/^\./, "")); names.add(m.outputType.replace(/^\./, "")); }
    const deps = new Set<string>();
    for (const n of names) {
      const parts = n.split(".");
      if (n.startsWith("google.protobuf.")) {
        const file = `google/protobuf/${parts[2].replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}.proto`;
        if (wellKnown[file]) deps.add(file);
        continue;
      }
      for (let i = parts.length; i > 0; i--) {
        const file = definer.get(parts.slice(0, i).join("."));
        if (file) { if (file !== f.name) deps.add(file); break; }
      }
    }
    return [...deps];
  };
  for (const f of files) f.dependency = references(f);
  const ordered: typeof files = [];
  const placed = new Set<string>(), visiting = new Set<string>();
  const place = (f: (typeof files)[number]) => {
    if (placed.has(f.name)) return;
    if (visiting.has(f.name)) throw new Error(`Cyclic imports in ${protocolPath}: ${f.name}`);
    visiting.add(f.name);
    for (const d of f.dependency) { const dep = files.find((o) => o.name === d); if (dep) place(dep); }
    visiting.delete(f.name); placed.add(f.name); ordered.push(f);
  };
  for (const f of files) place(f);
  return createFileRegistry(create(FileDescriptorSetSchema, { file: [...Object.values(wellKnown).map((w) => w.proto), ...ordered] }));
}

/** Builds a message from a plain init by walking the schema (nested messages, lists, oneof cases). */
export function deepCreate(schema: DescMessage, init: any): any {
  const out: any = {};
  for (const f of schema.fields) {
    if (f.oneof) continue;
    const v = init?.[f.localName];
    if (v === undefined || v === null) continue;
    if (f.fieldKind === "message") out[f.localName] = deepCreate(f.message, v);
    else if (f.fieldKind === "list" && f.listKind === "message") out[f.localName] = (v as any[]).map((item) => deepCreate(f.message!, item));
    else out[f.localName] = v;
  }
  for (const o of schema.oneofs) {
    const v = init?.[o.localName];
    if (!v?.case) continue;
    const f = o.fields.find((field) => field.localName === v.case);
    if (!f) throw new Error(`No case ${v.case} in oneof ${schema.typeName}.${o.name}`);
    out[o.localName] = { case: v.case, value: f.fieldKind === "message" ? deepCreate(f.message, v.value) : v.value };
  }
  return create(schema, out);
}

const envelope = (flags: number, payload: Uint8Array) => {
  const head = Buffer.alloc(5);
  head[0] = flags;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};
const ts = (ms: number | undefined) => (ms ? timestampFromMs(ms) : undefined);

// Enum values from the build's descriptors (conversation.proto, content.proto, streaming.proto).
const STATUS_IDLE = 1, STATUS_RUNNING = 2, STATUS_WAITING_FOR_INPUT = 3, STATUS_ERROR = 5;
const ROLE_USER = 1, ROLE_ASSISTANT = 2;
const STOP_END_TURN = 1, STOP_USER_CANCELED = 10, STOP_ERROR = 11;
const GROUP_INLINE = 1;
const BLOCK_RUNNING = 1, BLOCK_COMPLETE = 2, BLOCK_ERROR = 3, BLOCK_CANCELLED = 5;
const TOOL_ROW_SHELL = 2, TOOL_ROW_WEB_SEARCH = 7;
const INPUT_SUMMARY_COMMAND = 2;
const STYLE_PLAIN = 1, STYLE_MARKDOWN = 2, STYLE_CODE = 3;
const WORK_MODE_CHAT = 1;
const INPUT_MODE_TEXT = 1, TURN_START_USER = 1;
const REBASE_BOOT = 1;
const ELICITATION_PENDING = 1, ELICITATION_MCP_AUTH = 6;
const DISPOSITION_RUNNING = 1, DISPOSITION_FINISHED = 2, DISPOSITION_ERRORED = 3;

const blockState = (status: string | undefined) =>
  status === "inProgress" ? BLOCK_RUNNING : status === "failed" ? BLOCK_ERROR : status === "interrupted" ? BLOCK_CANCELLED : BLOCK_COMPLETE;

function textCitations(item: Item, projected: ReturnType<typeof projectWebCitationText>, blockId: string) {
  const citations = cleanCitations(item.citations, item.text?.length ?? 0);
  if (!citations.length) return undefined;
  const { text, displayOffset } = projected;
  // The gateway records UTF-16 spans. The original renderer indexes code points.
  const points = new Uint32Array(text.length + 1);
  let units = 0, count = 0;
  for (const char of text) {
    units += char.length;
    points[units] = ++count;
  }
  return citations.flatMap(({ url, title, start, end }, index) => {
    const from = displayOffset(start), to = displayOffset(end);
    if ((from > 0 && !points[from]) || (to > 0 && !points[to])) return [];
    return [{
      uuid: `${blockId}:citation:${index}`,
      url,
      title: title ?? url,
      startIndex: points[from],
      endIndex: points[to],
      metadata: { case: "webpageMetadata", value: { siteDomain: new URL(url).hostname } },
    }];
  });
}

/** One Claudex item as the content block(s) the front-end draws. */
function blocksOf(item: Item, groupId: string, prefix: string, turnStatus: Turn["status"], running: boolean): any[] {
  // The item still being produced is the running one; everything before it is done.
  const complete = item.lifecycleStatus === "completed" || item.lifecycleStatus === "failed" || !running;
  const base = { displayGroupId: groupId, isComplete: complete, state: complete ? blockState(item.lifecycleStatus ?? turnStatus) : BLOCK_RUNNING };
  switch (item.type) {
    case "agentMessage": {
      const id = `${prefix}:${item.id}`;
      const projected = projectWebCitationText(item.text ?? "");
      return [{ ...base, id, text: projected.text, textFormat: { style: STYLE_MARKDOWN }, citations: textCitations(item, projected, id) }];
    }
    case "reasoning": {
      const summaries = (item.summary ?? []).filter(Boolean).map((summary) => ({ summary }));
      // A running thinking block shows the animated dots and the latest summary; an empty finished one shows nothing.
      if (!summaries.length && !item.text && complete) return [];
      // STYLE_PLAIN marks a thinking block for the client (bU/mie in the hub module).
      return [{ ...base, id: `${prefix}:${item.id}`, text: item.text ?? "", textFormat: { style: STYLE_PLAIN }, summaries }];
    }
    case "commandExecution":
      return [{
        ...base,
        id: `${prefix}:${item.id}`,
        rowKind: TOOL_ROW_SHELL,
        toolDisplayName: "Bash",
        title: item.description ?? item.command ?? "Command",
        inputSummaryKind: INPUT_SUMMARY_COMMAND,
        inputSummary: item.command ?? "",
        text: item.aggregatedOutput ?? "",
        textFormat: { style: STYLE_CODE, language: "text" },
      }];
    case "fileChange":
      return [{
        ...base,
        id: `${prefix}:${item.id}`,
        toolDisplayName: "Edit",
        title: (item.changes ?? []).map((c) => c.path).join(", ") || "File change",
        inputSummary: (item.changes ?? []).map((c) => c.path).join(", "),
        text: (item.changes ?? []).map((c) => c.diff).join("\n"),
        textFormat: { style: STYLE_CODE, language: "diff" },
      }];
    case "webSearch": {
      const query = typeof item.query === "string" ? item.query : "";
      const finished = item.status === "completed" || item.status === "failed";
      const sources = uniqueSources(item.sources ?? []);
      return [{
        ...base,
        ...(finished ? { isComplete: true, state: blockState(item.status) } : {}),
        id: `${prefix}:${item.id}`,
        rowKind: TOOL_ROW_WEB_SEARCH,
        toolDisplayName: "Web search",
        title: query || "Web search",
        inputSummary: query,
        ...(sources.length ? { displayContent: { content: { case: "richItems", value: {
          isTrusted: true,
          items: sources.map(({ title, url }) => ({ title: title ?? url, url })),
        } } } } : {}),
      }];
    }
    case "mcpToolCall":
    case "dynamicToolCall": {
      const tool = codeToolTranscript(item);
      const state = blockState(item.lifecycleStatus ?? item.status);
      return [{
        ...base,
        ...(tool.complete ? {
          isComplete: true,
          state: state === BLOCK_CANCELLED ? state : tool.failed ? BLOCK_ERROR : BLOCK_COMPLETE,
        } : {}),
        id: `${prefix}:${item.id}`,
        toolDisplayName: item.tool ?? "Tool",
        title: item.tool ?? "Tool",
        inputSummary: tool.progress ?? "",
        text: tool.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n"),
      }];
    }
    default:
      return [];
  }
}

const FILE_KIND_IMAGE = 1, FILE_KIND_BLOB = 2, FILE_KIND_DOCUMENT = 3;
const FEEDBACK_UPVOTE = 1, FEEDBACK_FLAG = 2;

/** A turn's attachment as the protocol Attachment the user message carries. */
function attachmentOf(a: Turn["attachments"][number], org: string, conversationId: string, display?: InlineDisplayAnswer, name?: string, temporary?: boolean) {
  const file = learnAttachment(a, conversationId, temporary);
  const id = display ? a.id : file.id;
  const url = (variant: string) => `/api/${org}/files/${id}/${variant}`;
  return {
    id,
    fileName: display?.file_name ?? name ?? a.name,
    fileSize: BigInt(a.size ?? 0),
    mediaType: file.mediaType,
    fileKind: file.kind === "image" ? FILE_KIND_IMAGE : file.kind === "document" ? FILE_KIND_DOCUMENT : FILE_KIND_BLOB,
    url: url(file.kind === "image" ? "preview" : "contents"),
    thumbnailUrl: file.kind === "image" ? url("thumbnail") : "",
    downloadUrl: url("contents"),
    textExtracted: a.kind === "text",
    ...(file.width ? { previewWidth: file.width, previewHeight: file.height ?? 0 } : {}),
  };
}

export interface TranscriptExtras {
  commandDeclines?: readonly CommandDeclineCard[];
  chatElicitations?: (
    Awaited<ReturnType<ChatElicitationHost["list"]>>[number] |
    Awaited<ReturnType<NonNullable<AdapterContext["chatComputerUse"]>["list"]>>[number]
  )[];
  chatPermission?: ChatPermissionMode;
  connectorAuthPromptAvailable?: AdapterContext["connectorAuthPromptAvailable"];
  modelRequestRejectedMessage?: string;
  inlineDisplays?: InlineDisplayProjection;
  enabledMcpTools?: Record<string, boolean>;
  /** The organization the file URLs live under. */
  org: string;
  /** Reply ratings by JSON [conversationId, turnId] (electron/conversations/reply-feedback.ts). */
  ratings?: Record<string, "up" | "down">;
  /** The Claudex conversation id (the page may know it under an alias). */
  conversationId?: string;
  registry?: FileRegistry;
}

const modelRequestRejectedMessage = "This response didn’t load.";

function modelRequestRejected(turn: Turn) {
  return turn.status === "failed" &&
    turn.error?.includes("The model service returned HTTP 400:") &&
    /"code\\?"\s*:\s*\\?"invalid_request\\?"/.test(turn.error);
}

/**
 * The whole transcript as the update the client applies on boot. Every saved
 * branch is drawn too (shared/branches.ts), so a retried reply or an edited
 * prompt shows the page's version switcher; the active path ends at the
 * current leaf.
 */
export function conversationUpdate(c: Conversation, statementOnly: boolean, extras: TranscriptExtras = { org: "" }) {
  const turns = c.turns ?? [];
  const last = turns[turns.length - 1];
  const running = last?.status === "inProgress";
  const outputs = generatedWorkspaceOutputs(extras.org, extras.conversationId ?? c.id, turns);
  const outputSchema = extras.registry?.getMessage("anthropic.bard.api.v1alpha.WorkspaceOutputs");
  const conversation = {
    id: c.id,
    title: c.title ?? "",
    status: extras.commandDeclines?.length || extras.chatElicitations?.length ? STATUS_WAITING_FOR_INPUT : running ? STATUS_RUNNING : last?.status === "failed" ? STATUS_ERROR : STATUS_IDLE,
    createdAt: ts(c.createdAt), updatedAt: ts(c.updatedAt),
    model: c.model ? { id: { case: "identifier", value: c.model } } : { id: { case: "default", value: true } },
    currentLeafMessageId: last ? assistantMessageId(last) : undefined,
    settings: {
      enabledWebSearch: !!c.webSearch,
      ...(extras.enabledMcpTools ? { enabledMcpTools: { tools: extras.enabledMcpTools } } : {}),
      enabledArtifacts: true,
      ...(extras.chatPermission ? { permissionMode: chatPermissionToWire(extras.chatPermission) } : {}),
      effortLevelToken: c.effort ?? "",
      ...(c.research ? { researchMode: RESEARCH_ADVANCED } : {}),
      ...(c.memoryDisabled ? { chatMemoryMode: officialChatMemoryMode.disabled } : {}),
    },
    isStarred: !!c.pinned, isArchived: !!(c as any).archived, isTemporary: !!c.incognito, summary: "",
    workMode: WORK_MODE_CHAT, permissionModeSupported: extras.chatPermission !== undefined, nativeAutoModeAvailable: extras.chatPermission !== undefined, hasAssistantOutputs: outputs.length > 0, interruptAllowed: running,
    outputs,
    ...(outputSchema ? { extras: [{ typeUrl: "type.googleapis.com/anthropic.bard.api.v1alpha.WorkspaceOutputs", value: toBinary(outputSchema, deepCreate(outputSchema, {outputs})) }] } : {}),
    ...(c.projectId ? { projectId: c.projectId } : {}),
  };
  if (statementOnly) return { replaceAllState: false, conversation, conversationStatement: true };
  const messages: any[] = [], displayGroups: any[] = [], contentBlocks: any[] = [];
  const index = new Map<string, MessageRef>();
  const commandDeclines = commandDeclineElicitations(extras.commandDeclines ?? [], c.id);
  const connectorAuth = c.mode === "chat" && last && extras.connectorAuthPromptAvailable
    ? last.items.flatMap((item) => {
      if (!item.server || !item.mcpAuthRejectionUrl) return [];
      const auth = mcpAuthRequired(item, `${last.id}:${item.id}`);
      if (!auth || !extras.connectorAuthPromptAvailable?.(item.server, item.mcpAuthRejectionUrl)) return [];
      return [{
        id: `${assistantMessageId(last)}:${item.id}`,
        conversationId: c.id,
        request: {
          status: ELICITATION_PENDING,
          kind: ELICITATION_MCP_AUTH,
          originServerId: auth.server_id,
          toolUseId: auth.tool_use_id,
          holdsConversation: false,
          requiresUserInteraction: true,
        },
      }];
    })
    : [];
  const branches = [
    ...(c.savedBranches ?? []).map((b) => ({ id: b.id, turns: b.turns, active: false })),
    { id: c.activeBranchId ?? "original", turns, active: true },
  ];
  const storedConversation = { ...c, id: extras.conversationId ?? c.id };
  const reportOwner = c.sessionAuthors?.ownerAccountUuid;
  const reportsAllowed = !reportOwner || organizationUuid(reportOwner) === extras.org;
  // The active path is drawn last so its ids win in the index.
  for (const branch of branches) {
    const reportByTurn = new Map(reportsAllowed
      ? researchReportVersions(extras.org, storedConversation, branch.turns).map(report => [report.turn, report])
      : []);
    let parent: string | undefined;
    branch.turns.forEach((turn, position) => {
      const userId = userMessageId(turn), assistantId = assistantMessageId(turn);
      if (!index.has(userId) || branch.active) index.set(userId, { turnId: turn.id, kind: "user", branchId: branch.id, active: branch.active });
      if (!index.has(assistantId) || branch.active) index.set(assistantId, { turnId: turn.id, kind: "assistant", branchId: branch.id, active: branch.active });
      if (!messages.some((m) => m.id === userId)) {
        messages.push({
          id: userId, conversationId: c.id, role: ROLE_USER, index: position * 2, isComplete: true, createdAt: ts(turn.createdAt),
          parentMessageId: parent, inputMode: INPUT_MODE_TEXT, turnStartKind: TURN_START_USER, siblingsViewable: true,
          ...(turn.completionQuotes===undefined?{}:{quotes:parsePersistedCompletionQuotes(turn.prompt,turn.completionQuotes)}),
          attachments: (turn.attachments ?? []).map((a) => {
            const key = inlineDisplayKey(turn.id, a.id);
            return attachmentOf(a, extras.org, extras.conversationId ?? c.id, extras.inlineDisplays?.get(key), extras.inlineDisplays?.fileNames?.get(key), c.incognito);
          }),
        });
        displayGroups.push({ id: `${userId}:g0`, messageId: userId, index: 0, style: GROUP_INLINE, isComplete: true });
        contentBlocks.push({ id: `${userId}:b0`, displayGroupId: `${userId}:g0`, index: 0, isComplete: true, state: BLOCK_COMPLETE, text: turn.prompt ?? "", textFormat: { style: STYLE_MARKDOWN } });
      }
      parent = assistantId;
      if (messages.some((m) => m.id === assistantId)) return;
      const done = turn.status !== "inProgress";
      const report = reportByTurn.get(turn);
      const rating = extras.ratings?.[JSON.stringify([extras.conversationId ?? c.id, turn.id])];
      messages.push({
        id: assistantId, conversationId: c.id, role: ROLE_ASSISTANT, index: position * 2 + 1, isComplete: done,
        stopReason: turn.status === "completed" ? STOP_END_TURN : turn.status === "interrupted" ? STOP_USER_CANCELED : turn.status === "failed" ? STOP_ERROR : 0,
        createdAt: ts(turn.createdAt), parentMessageId: userId, siblingsViewable: true,
        attachments: [...generatedOutputAttachments(extras.org, extras.conversationId ?? c.id, turn),
          ...(!report && reportsAllowed ? [researchReportAttachment(extras.org, storedConversation, turn)].filter(Boolean) : [])],
        ...(rating ? { feedback: rating === "up" ? FEEDBACK_UPVOTE : FEEDBACK_FLAG } : {}),
      });
      const groupId = `${assistantId}:g0`;
      displayGroups.push({ id: groupId, messageId: assistantId, index: 0, style: GROUP_INLINE, isComplete: done });
      const items = (turn.items ?? []).filter(item => item.type !== "agentMessage" || item.id !== report?.sourceItemId);
      const blocks = items.flatMap((item, i) => blocksOf(item, groupId, assistantId, turn.status, !done && i === items.length - 1));
      if (report) blocks.unshift(researchReportArtifactBlock(report, groupId));
      const research = researchBlock(extras.org, storedConversation, turn, groupId, ts);
      if (research) blocks.unshift(research);
      // A turn that has produced nothing yet stays an empty running reply: the
      // page draws its waiting dots for that (official desktop recording, 2026-10-31);
      // a running thinking block would draw the thinking row instead.
      blocks.forEach((block, i) => contentBlocks.push({ ...block, index: i }));
      if (turn.status === "failed" && turn.error) {
        const text = modelRequestRejected(turn) ? extras.modelRequestRejectedMessage ?? modelRequestRejectedMessage : turn.error;
        contentBlocks.push({ id: `${assistantId}:error`, displayGroupId: groupId, index: blocks.length, isComplete: true, state: BLOCK_ERROR, text, textFormat: { style: STYLE_PLAIN }, title: "Error" });
      }
    });
  }
  messageIndex.set(c.id, index);
  return {
    replaceAllState: true, conversation, messages, displayGroups, contentBlocks, rebaseReason: REBASE_BOOT,
    elicitations: [...commandDeclines, ...(extras.chatElicitations ?? []), ...connectorAuth]
      .map((card, index) => ({ ...card, conversationId: c.id, index })),
    turnDisposition: last ? { triggerMessageId: userMessageId(last), state: running ? DISPOSITION_RUNNING : last.status === "failed" ? DISPOSITION_ERRORED : DISPOSITION_FINISHED } : undefined,
  };
}

const registries = new Map<string, FileRegistry>();
/** The build's protocol, parsed once per bundle root. */
export function registryFor(root: string) {
  let registry = registries.get(root);
  if (!registry) {
    registry = loadRegistry(path.join(root, "data", "conversation-protocol.json"));
    registries.set(root, registry);
  }
  return registry;
}

/** Reads the conversation now, or once the app reports it (a send that created it, or its first turn). */
export async function waitForConversation(ctx: AdapterContext, id: string, timeoutMs: number, signal?: AbortSignal): Promise<Conversation | undefined> {
  if (signal?.aborted) return undefined;
  const read = async () => { try { return await ctx.loadConversation(resolveConversationId(id)); } catch (error) { ctx.log("[official-ui] conversation read failed", error); return undefined; } };
  // Listen before the first read: an alias or event arriving while it runs still counts.
  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return;
      if (ctx.isCurrent && !ctx.isCurrent()) { done = true; cleanup(); resolve(undefined); return; }
      const found = await read();
      if (found && !done) { done = true; cleanup(); resolve(found); }
    };
    const unsubscribe = ctx.onEvent(bindAdapterScope((event) => {
      const target = resolveConversationId(id);
      if ((event.type === "conversation" && event.conversation?.id === target) ||
          (event.type === "conversation-turn" && event.conversationId === target) ||
          (event.type === "resync" && ctx.isCloudConversation?.(target))) void finish();
    }));
    const onAlias = (pageId: string) => { if (pageId === id) void finish(); };
    aliasListeners.add(onAlias);
    // A slow path (a cloud conversation created under another id) is also polled.
    const poll = setInterval(() => void finish(), 3000);
    const timer = setTimeout(() => { if (!done) { done = true; cleanup(); resolve(undefined); } }, timeoutMs);
    const abort = () => { if (!done) { done = true; cleanup(); resolve(undefined); } };
    const cleanup = () => { clearTimeout(timer); clearInterval(poll); unsubscribe(); aliasListeners.delete(onAlias); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void finish();
  });
}

export function createTimelineRpc(ctx: AdapterContext, options: { heartbeatMs?: number; missingConversationWaitMs?: number; nextVersion?: () => string } = {}) {
  const registry = registryFor(ctx.root);
  const message = (name: string): DescMessage => {
    const m = registry.getMessage(`${PACKAGE}.${name}`);
    if (!m) throw new Error(`No message ${name} in the conversation protocol`);
    return m;
  };
  const RequestSchema = message("StreamTimelineRequest");
  const ResponseSchema = message("StreamTimelineResponse");
  const service = registry.getService(SERVICE);
  const reportViewing = service?.methods.find((m) => m.name === "ReportViewing");
  return (req: http.IncomingMessage, res: http.ServerResponse, p: string): boolean => {
    if (req.method !== "POST") return false;
    if (reportViewing && p === `/claudeai-rpc/${SERVICE}/ReportViewing`) {
      // Viewing telemetry (unary): the empty ReportViewingResponse, in the request's encoding.
      req.resume();
      req.on("end", () => {
        const binary = (req.headers["content-type"] ?? "").includes("proto");
        res.writeHead(200, { "Content-Type": binary ? "application/proto" : "application/json" });
        res.end(binary ? Buffer.from(toBinary(reportViewing.output, create(reportViewing.output))) : "{}");
      });
      return true;
    }
    if (p !== STREAM_TIMELINE_PATH) return false;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    const onEnd = bindAdapterScope(async () => {
      let body = Buffer.concat(chunks);
      const compressed = (body[0] ?? 0) & 1;
      if (body.length >= 5) body = body.subarray(5);
      if (compressed || req.headers["connect-content-encoding"] === "gzip") { try { body = zlib.gunzipSync(body); } catch {} }
      let request: any;
      try { request = fromBinary(RequestSchema, body); } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ code: "invalid_argument", message: String(error) }));
      }
      res.writeHead(200, { "Content-Type": "application/connect+proto", "Cache-Control": "no-store" });
      const closed = new AbortController();
      res.once("close", () => closed.abort());
      const send = (init: Record<string, unknown>) => {
        if (ctx.isCurrent && !ctx.isCurrent()) { if (!res.writableEnded && !res.destroyed) res.end(); return; }
        if (!res.writableEnded && !res.destroyed) res.write(envelope(0, toBinary(ResponseSchema, deepCreate(ResponseSchema, init))));
      };
      let frames = 0;
      let translateFailure: ReturnType<typeof nativeTranslator> | undefined;
      const extras = (): TranscriptExtras => {
        const account = ctx.account();
        return { org: account ? organizationUuid(account.id) : "", ratings: ctx.ratings?.(), registry, connectorAuthPromptAvailable: ctx.connectorAuthPromptAvailable };
      };
      const update = async (c: Conversation, statement: boolean) => {
        const inlineDisplays = !statement && [...c.turns, ...(c.savedBranches ?? []).flatMap(branch => branch.turns)].some(turn => turn.inlineAttachmentDisplays?.length || (!("inlineAttachmentDisplays" in turn) && turn.attachments.length))
          ? await projectInlineAttachmentDisplays(ctx, c, { user: userMessageId, assistant: assistantMessageId }) : undefined;
        const chatElicitations = !statement && c.mode === "chat"
          ? [
              ...(await ctx.chatElicitation?.list(c.id) ?? []),
              ...(ctx.readOnly ? [] : await ctx.chatComputerUse?.list(c.id) ?? []),
            ] : undefined;
        const translate = !statement && (c.turns.some(modelRequestRejected) ||
          c.savedBranches?.some(branch => branch.turns.some(modelRequestRejected)))
          ? await (translateFailure ??= nativeTranslator(officialLocale(ctx))) : undefined;
        if (ctx.isCurrent?.() === false || closed.signal.aborted) return;
        frames++;
        const commandDeclines = ctx.readOnly || ctx.chatElicitation ? [] : ctx.commandDeclines?.list(c.id);
        const chatPermission = c.mode === "chat" && !c.archived && !c.linkedToComputer &&
          !c.chatDeviceBinding && !c.deviceChatOrigin?.active && !ctx.isCloudConversation?.(c.id) && ctx.chatPermissionModes?.includes("auto")
          ? c.chatPermissionMode ?? ((c.senderPermission ?? ctx.settings().taskPermission) === "auto" ? "auto" : "default") : undefined;
        send({ event: { event: { case: "update", value: conversationUpdate({ ...c, id: request.conversationId }, statement, { ...extras(), conversationId: c.id, commandDeclines, chatElicitations, chatPermission, inlineDisplays, modelRequestRejectedMessage: translate?.(modelRequestRejectedMessage), enabledMcpTools: c.mode === "chat" ? chatConnectorPreferences(ctx, c) : undefined }) }, version: { value: options.nextVersion?.() ?? String(frames) }, leaseEpoch: 1n } });
      };
      // A page that just sent its first message opens the stream before the
      // send created the conversation: show that send as a running turn now,
      // then wait for the conversation instead of refusing.
      const provisional = (pending: PendingSend) => {
        const turn = { id: `pending:${pending.messageId}`, prompt: pending.text, attachments: [], items: [], status: pending.error ? ("failed" as const) : ("inProgress" as const), ...(pending.error ? { error: pending.error } : {}), createdAt: pending.at };
        turnMessageIds.set(turn.id, { user: pending.messageId, assistant: pending.assistantMessageId });
        update({
          id: request.conversationId, title: "", mode: "chat", turns: [turn],
          createdAt: pending.at, updatedAt: pending.at, memoryDisabled: pending.memoryDisabled,
        } as unknown as Conversation, false);
      };
      const pending = pendingSends.get(request.conversationId);
      if (pending && !request.conversationStatement) provisional(pending);
      // The send may arrive after this stream opened: show it as soon as it does.
      const waiters = waitingTimelines.get(request.conversationId) ?? new Set();
      waitingTimelines.set(request.conversationId, waiters);
      const onSend = (send: PendingSend) => { if (!request.conversationStatement) provisional(send); };
      waiters.add(onSend);
      ctx.log("[official-ui] timeline open", request.conversationId, request.conversationStatement ? "statement" : "full");
      let changedWhileLoading = false;
      let queueUpdate: ((target: string) => void) | undefined;
      const unsubscribe = ctx.onEvent(bindAdapterScope((event) => {
        const target = resolveConversationId(request.conversationId);
        const changed = (event.type === "conversation" && event.conversation?.id === target) || ((event.type === "conversation-turn" || event.type === "research") && event.conversationId === target) ||
          (event.type === "approval" && event.approval.conversationId === target) || event.type === "approval-resolved" ||
          (event.type === "resync" && ctx.isCloudConversation?.(target)) ||
          (event.type === "computer-use" && !!ctx.chatComputerUse &&
            (event.request?.conversationId === target || !!event.resolved));
        if (!changed) return;
        if (queueUpdate) queueUpdate(target);
        else changedWhileLoading = true;
      }));
      const unsubscribeDeclines = ctx.commandDeclines?.subscribe(bindAdapterScope((conversationId) => {
        if (conversationId !== resolveConversationId(request.conversationId)) return;
        if (queueUpdate) queueUpdate(conversationId);
        else changedWhileLoading = true;
      }));
      closed.signal.addEventListener("abort", () => { unsubscribe(); unsubscribeDeclines?.(); }, { once: true });
      if (closed.signal.aborted) { unsubscribe(); unsubscribeDeclines?.(); return; }
      const waitMs = options.missingConversationWaitMs ?? 45_000;
      const conversation = waitMs > 0
        ? await waitForConversation(ctx, request.conversationId, waitMs, closed.signal)
        : await ctx.loadConversation(resolveConversationId(request.conversationId));
      ctx.log("[official-ui] timeline ready", request.conversationId, conversation ? `${conversation.turns?.length ?? 0} turns` : "missing");
      waiters.delete(onSend);
      if (!waiters.size) waitingTimelines.delete(request.conversationId);
      if (closed.signal.aborted) return;
      if (!conversation) {
        send({ event: { event: { case: "error", value: { type: "not_found", message: `No conversation ${request.conversationId}`, displayMessage: "This conversation is not on this device.", retryable: false, notFound: {} } } } });
        return res.end(envelope(2, Buffer.from("{}")));
      }
      const failed = (error: unknown) => {
        ctx.log("[official-ui] timeline failed", error);
        if (!res.destroyed && !res.writableEnded) res.end();
      };
      let chain = Promise.resolve().then(() => update(conversation, !!request.conversationStatement)).catch(failed);
      queueUpdate = (target) => {
        chain = chain.then(async () => {
          const current = await ctx.loadConversation(target).catch(() => undefined);
          if (current) await update(current, false);
        }).catch(failed);
      };
      if (changedWhileLoading) queueUpdate(resolveConversationId(request.conversationId));
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) return clearInterval(timer);
        if (ctx.isCurrent && !ctx.isCurrent()) { clearInterval(timer); unsubscribe(); unsubscribeDeclines?.(); res.end(); return; }
        send({ event: { event: { case: "heartbeat", value: { otherFramesSent: frames } } } });
      }, options.heartbeatMs ?? 25000);
      closed.signal.addEventListener("abort", () => { clearInterval(timer); }, { once: true });
      if (closed.signal.aborted) clearInterval(timer);
    });
    req.on("end", () => { void onEnd().catch((error) => { ctx.log("[official-ui] timeline failed", error); if (!res.destroyed && !res.writableEnded) res.end(); }); });
    return true;
  };
}

