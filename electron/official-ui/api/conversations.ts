import { researchReportVersions } from "./research-report-artifact";
import { parseOfficialConnectorPreferenceBody } from "../../../shared/official-connector-preferences";
import { parseOfficialChatReadState } from "../../../shared/official-ui-web";
import { chatConnectorErrorResponse, chatConnectorPreferences, saveChatConnectorPreferences } from "./chat-connector-preferences";
import { promptKey, inlineDisplayKey } from "../../../shared/inline-attachment-display";
export { promptKey } from "../../../shared/inline-attachment-display";
import { saveConversationSearchSettings } from "./conversation-search-settings";
import { discardIncognitoRoute } from "./incognito";
/**
 * Chat conversations as the front-end lists and reads them
 * (`GET …/chat_conversations_v2`, `GET …/chat_conversations/<id>`), from the
 * account's Claudex conversations (the Store). Shapes follow the official
 * answers recorded on 2026-10-30; fields Claudex has no value for stay null.
 */
import type http from "node:http";
import { bulkDeleteRoute } from "./bulk-delete";
import { projectMoveRoute } from "./project-move";
import { historyListRoute } from "./history-list";
import type { Conversation, Turn } from "../../../shared/types";
import { empty, organizationUuid, readJson, reply, type AdapterContext } from "./context";
import { learnAttachment, uploadAnswer } from "./files";
import { completionBlocks } from "./completion-content";
import { projectInlineAttachmentDisplays, inlineDisplayHistory, type InlineDisplayProjection } from "./inline-attachment-displays";
import { readState, writeState } from "./state";
import { ScopedMap, ScopedSet, scopedValue } from "./scope";

const iso = (ms: number | undefined) => new Date(ms ?? 0).toISOString();

/** A conversation's creation and last activity, from its turns. */
export function conversationTimes(c: Conversation) {
  const turns = c.turns ?? [];
  const created = c.createdAt || turns[0]?.createdAt || 0;
  const updated = c.updatedAt || turns[turns.length - 1]?.createdAt || created;
  return { created, updated };
}

export function isChat(c: Pick<Conversation, "mode">) {
  return c.mode === "chat" || c.mode === "cowork";
}

/** The list row (chat_conversations_v2 `data[]`). */
export function conversationRow(c: Conversation, ctx?: AdapterContext) {
  const { created, updated } = conversationTimes(c);
  const enabledMcpTools = ctx && c.mode === "chat" ? chatConnectorPreferences(ctx, c) : undefined;
  return {
    uuid: conversationPageId(c.id),
    name: c.title ?? "",
    summary: "",
    model: c.model,
    created_at: iso(created),
    updated_at: iso(updated),
    is_starred: !!c.pinned,
    is_archived: !!(c as any).archived,
    is_temporary: !!c.incognito,
    ...(c.mode === "chat" && {
      unread: c.unread === true,
      revision_ns: String(BigInt(c.readStateRevision ?? 0) * 1_000_000n),
      has_settled: c.turns.some(turn => turn.status !== "inProgress"),
    }),
    ...(c.memoryDisabled ? { chat_memory_mode: "disabled" } : {}),
    is_multiplayer: false,
    platform: "CLAUDE_AI",
    project_uuid: c.projectId ?? null,
    ...(c.projectOrganizationId && { claudex_project_organization_uuid: c.projectOrganizationId }),
    project: c.projectId ? { uuid: c.projectId } : null,
    settings: {
      enabled_web_search: !!c.webSearch,
      ...(enabledMcpTools ? { enabled_mcp_tools: enabledMcpTools } : {}),
      ...(c.research ? { compass_mode: "advanced" } : {}),
      thinking_mode: "auto",
      effort_level: c.effort ?? null,
      paprika_mode: null,
      ...(c.memoryDisabled ? { chat_memory_mode: "disabled" } : {}),
    },
    current_leaf_message_uuid: leafMessageId(c),
  };
}

/**
 * The page's conversation id → the id the service gave the conversation, when
 * a send could not create it under the page's id (a cloud conversation is
 * created by the runner). Both ids reach the same conversation.
 */
/** Told when a page id gets its conversation (a timeline waiting for that id reads it now). */
export const aliasListeners = new ScopedSet<(pageId: string) => void>("alias-listeners");
const aliasPageIndex = () => scopedValue<{ value?: Map<string, string> }>("conversation-page-index", () => ({}));
class AliasMap extends ScopedMap<string, string> {
  constructor() { super("conversation-aliases"); }
  restore(key: string, value: string) { aliasPageIndex().value = undefined; return super.set(key, value); }
  override delete(key: string) { aliasPageIndex().value = undefined; return super.delete(key); }
  override clear() { aliasPageIndex().value = undefined; super.clear(); }
  override set(key: string, value: string) {
    aliasPageIndex().value = undefined;
    super.set(key, value);
    writeState("aliases", () => [...this].slice(-5000));
    for (const listener of aliasListeners) listener(key);
    return this;
  }
}
export const conversationAliases = new AliasMap();
export const resolveConversationId = (id: string) => conversationAliases.get(id) ?? id;
/** Keep list/cache identity equal to the page's streamed identity. Otherwise
 * the official Recents cache retains both the provisional page and service IDs.
 * The first owned alias stays stable across follow-ups and adapter reloads. */
export function conversationPageId(id: string) {
  const real = resolveConversationId(id);
  const cached = aliasPageIndex();
  if (!cached.value) {
    cached.value = new Map();
    for (const [page, target] of conversationAliases) if (!cached.value.has(target)) cached.value.set(target, page);
  }
  return cached.value.get(real) ?? real;
}

/** A send the page made for a conversation the service has not created yet (a provisional first frame). */
export interface PendingSend {
  text: string;
  messageId: string;
  assistantMessageId: string;
  at: number;
  memoryDisabled?: true;
  /** The send failed: the turn shows this error. */
  error?: string;
}
export const pendingSends = new ScopedMap<string, PendingSend>("pending-sends");
/** Timelines still waiting for their conversation, by the page's conversation id: a later send tells them what to show meanwhile. */
export const waitingTimelines = new ScopedMap<string, Set<(send: PendingSend) => void>>("waiting-timelines");
export function registerPendingSend(id: string, send: PendingSend) {
  pendingSends.set(id, send);
  for (const notify of waitingTimelines.get(id) ?? []) notify(send);
}

/** The ids the front-end chose for a turn it started (PerformAction send_message). */
export const turnMessageIds = new ScopedMap<string, { user: string; assistant: string }>("turn-message-ids");
/** The front-end's id for a prompt it sent, by prompt key. */
export const promptMessageIds = new ScopedMap<string, string>("prompt-message-ids");
const temporaryTurnMessageIds = new ScopedMap<string, { user: string; assistant: string }>("temporary-turn-message-ids");
const temporaryPromptMessageIds = new ScopedMap<string, string>("temporary-prompt-message-ids");
export function forgetTemporaryTurnIds(turns: Turn[]) {
  for (const turn of turns) {
    temporaryTurnMessageIds.delete(turn.id);
    temporaryPromptMessageIds.delete(promptKey(turn));
  }
}
/** Restores the aliases and the page's message ids after a restart. */
export function loadConversationState() {
  for (const [page, real] of readState<[string, string][]>("aliases", [])) conversationAliases.restore(page, real);
  const ids = readState<{ turns?: [string, { user: string; assistant: string }][]; prompts?: [string, string][] }>("message-ids", {});
  for (const [k, v] of ids.turns ?? []) turnMessageIds.set(k, v);
  for (const [k, v] of ids.prompts ?? []) promptMessageIds.set(k, v);
}
const saveMessageIds = () =>
  writeState("message-ids", () => ({ turns: [...turnMessageIds].slice(-5000), prompts: [...promptMessageIds].slice(-5000) }));
export const userMessageId = (turn: Turn) =>
  turn.officialChatMessageIds?.user ?? temporaryPromptMessageIds.get(promptKey(turn)) ?? promptMessageIds.get(promptKey(turn)) ?? temporaryTurnMessageIds.get(turn.id)?.user ?? turnMessageIds.get(turn.id)?.user ?? `${promptKey(turn)}:user`;
export const assistantMessageId = (turn: Turn) => turn.officialChatMessageIds?.assistant ?? temporaryTurnMessageIds.get(turn.id)?.assistant ?? turnMessageIds.get(turn.id)?.assistant ?? `${turn.id}:assistant`;
/** Remembers the page's ids for a turn a send produced. */
export function rememberTurnIds(turn: Turn, ids: { user?: string; assistant?: string }, temporary = false) {
  if (turn.officialChatMessageIds &&
      (!ids.user || ids.user === turn.officialChatMessageIds.user) &&
      (!ids.assistant || ids.assistant === turn.officialChatMessageIds.assistant)) return;
  const key = promptKey(turn);
  if (temporary) {
    if (ids.user) temporaryPromptMessageIds.set(key, ids.user);
    if (ids.assistant) temporaryTurnMessageIds.set(turn.id, { user: ids.user ?? userMessageId(turn), assistant: ids.assistant });
    return;
  }
  const promptChanged = !!ids.user && promptMessageIds.get(key) !== ids.user;
  if (promptChanged) promptMessageIds.set(key, ids.user!);
  const prior = turnMessageIds.get(turn.id), user = ids.user ?? userMessageId(turn);
  const turnChanged = !!ids.assistant && (prior?.assistant !== ids.assistant || prior?.user !== user);
  if (turnChanged) turnMessageIds.set(turn.id, { user, assistant: ids.assistant! });
  if (promptChanged || turnChanged) saveMessageIds();
}

/** What a message id of a drawn transcript stands for, per conversation (filled by the timeline). */
export interface MessageRef { turnId: string; kind: "user" | "assistant"; branchId: string; active: boolean }
export const messageIndex = new ScopedMap<string, Map<string, MessageRef>>("message-index");
export function messageRef(conversationId: string, messageId: string): MessageRef | undefined {
  return messageIndex.get(resolveConversationId(conversationId))?.get(messageId) ?? messageIndex.get(conversationId)?.get(messageId);
}

export function leafMessageId(c: Conversation) {
  const last = (c.turns ?? [])[c.turns.length - 1];
  return last ? assistantMessageId(last) : null;
}

class RestHistoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** REST message-tree consumer: shared-m-w-0::NN/WK/LC. Preserve the same
 * prompt/reply IDs and saved branches as conversationUpdate; do not concatenate
 * branches or manufacture empty history. Text and reasoning retain their order;
 * unsupported rich content is explicit rather than silently discarded.
 */
export function conversationRestMessages(c: Conversation, organization?: string, inlineDisplays: InlineDisplayProjection = new Map(), ratings?: ReturnType<NonNullable<AdapterContext["ratings"]>>) {
  const messages = new Map<string, any>();
  const refs = new Map<string, MessageRef>();
  let bytes = 0, count = 0;
  const output = organization ? { organization, conversationId: c.id, conversation: c } : undefined;
  const branches = [
    ...(c.savedBranches ?? []).map(b => ({ id: b.id, turns: b.turns, active: false })),
    { id: c.activeBranchId ?? "original", turns: c.turns ?? [], active: true },
  ];
  if (branches.length > 200) throw new RestHistoryError(413, "The conversation history is too large.");
  const add = (id: string, parent: string, sender: "human" | "assistant", text: string, turn: Turn, branch: typeof branches[number], content: any[] = [{ type: "text", text, citations: [] }], stopReason: string | null = null) => {
    const attachments = sender === "human" ? turn.attachments ?? [] : [];
    if (!Array.isArray(attachments) || attachments.length > 12) throw new RestHistoryError(413, "The conversation has too many attachments.");
    if (attachments.length && !organization) throw new RestHistoryError(501, "The attachment organization is unavailable.");
    if (attachments.some(a => !a || typeof a.id !== "string" || !a.id || typeof a.name !== "string" || !a.name || !Number.isSafeInteger(a.size) || a.size < 0) || new Set(attachments.map(a => a.id)).size !== attachments.length) throw new RestHistoryError(500, "The conversation attachments are invalid.");
    const inline = attachments.flatMap(a => inlineDisplays.has(inlineDisplayKey(turn.id, a.id)) ? [inlineDisplays.get(inlineDisplayKey(turn.id, a.id))!] : []);
    const files = attachments.filter(a => !inlineDisplays.has(inlineDisplayKey(turn.id, a.id))).map(a => {
      const file = learnAttachment(a, c.id, c.incognito);
      if (file.name !== a.name || file.size !== a.size) throw new RestHistoryError(409, "The attachment identity changed.");
      const name = inlineDisplays.fileNames?.get(inlineDisplayKey(turn.id, a.id)) ?? a.name;
      return { ...uploadAnswer(organization!, { ...file, inlineDisplay: undefined, name }), ...(file.id !== a.id ? { serverFileUuid: a.id } : {}) };
    });
    const prior = messages.get(id);
    if (prior && (prior.parent_message_uuid !== parent || prior.text !== text || prior.sender !== sender || JSON.stringify(prior.content) !== JSON.stringify(content) || prior.stop_reason !== stopReason || JSON.stringify(prior.files_v2) !== JSON.stringify(files) || JSON.stringify(prior.attachments) !== JSON.stringify(inline)))
      throw new RestHistoryError(409, "The conversation has conflicting message identities.");
    if (!prior) {
      bytes += Buffer.byteLength(JSON.stringify({content, files, inline}), "utf8");
      if (++count > 10000 || bytes > 3 * 1024 * 1024) throw new RestHistoryError(413, "The conversation history is too large.");
      const rating = sender === "assistant" && !c.incognito ? ratings?.[JSON.stringify([c.id, turn.id])] : undefined;
      messages.set(id, {
      uuid: id, parent_message_uuid: parent, index: messages.size, sender,
      text, content,
      created_at: iso(turn.createdAt ?? c.createdAt), updated_at: iso(turn.createdAt ?? c.updatedAt),
      attachments: inline, files, files_v2: files, sync_sources: [], truncated: false,
      stop_reason: stopReason,
      ...(rating ? { chat_feedback: { type: rating === "up" ? "upvote" : "flag" } } : {}),
    });
    }
    if (!refs.has(id) || branch.active) refs.set(id, { turnId: turn.id, kind: sender === "human" ? "user" : "assistant", branchId: branch.id, active: branch.active });
  };
  for (const branch of branches) {
    if (!Array.isArray(branch.turns) || branch.turns.length > 5000) throw new RestHistoryError(413, "The conversation history is too large.");
    const reports = new Map(organization ? researchReportVersions(organization, c, branch.turns).map(report => [report.turn, report]) : []);
    let parent = "00000000-0000-4000-8000-000000000000";
    for (const turn of branch.turns) {
      if (turn.compaction)
        throw new RestHistoryError(501, "This conversation contains rich history that requires the timeline transport.");
      if (typeof turn.prompt !== "string" || !Array.isArray(turn.items)) throw new RestHistoryError(500, "The conversation history is invalid.");
      if (turn.items.length > 10000 || Buffer.byteLength(turn.prompt, "utf8") > 3 * 1024 * 1024) throw new RestHistoryError(413, "The conversation history is too large.");
      let content: any[];
      try {
        content = completionBlocks(turn, false, output && { ...output, researchArtifact: reports.get(turn) }).map(block => ({ ...block.start,
          ...(block.start.type === "text" ? { text: block.text ?? block.start.text ?? "" } : {}),
          ...(block.start.type === "tool_use" && block.text !== undefined ? { input: JSON.parse(block.text || "{}"), partial_json: block.text } : {}),
          ...(block.authRequired ? { mcp_auth_required: block.authRequired } : {}),
          ...(block.start.type === "thinking" ? { thinking: block.text ?? "", summaries: (block.summaries ?? []).map(summary => ({ summary })) } : {}),
        }));
      } catch {
        throw new RestHistoryError(501, "This conversation contains content that requires the timeline transport.");
      }
      const parts = content.filter(block => block.type === "text").map(block => block.text);
      const user = userMessageId(turn), assistant = assistantMessageId(turn);
      add(user, parent, "human", turn.prompt, turn, branch);
      const limits: Record<string, string> = { length: "max_tokens", tool_use_limit: "tool_use_limit", conversation_length_limit: "conversation_length_limit", usage_limit: "usage_limit" };
      const stoppedByRestart = turn.status === "interrupted" && turn.stopReason === "restart";
      if (!["completed", "inProgress", "interrupted", "failed"].includes(turn.status) || (turn.stopReason && !limits[turn.stopReason] && !stoppedByRestart))
        throw new RestHistoryError(501, "The conversation stop state is unsupported.");
      const stopReason = (turn.status === "failed" || (turn.error && turn.status !== "interrupted")) ? "error" : turn.status === "interrupted" ? "user_canceled" : turn.status === "inProgress" ? null : turn.stopReason ? limits[turn.stopReason] : "end_turn";
      add(assistant, user, "assistant", parts.join("\n\n"), turn, branch, content.length ? content : [{ type: "text", text: "", citations: [] }], stopReason);
      parent = assistant;
    }
  }
  return { messages: [...messages.values()], refs };
}

export async function conversationsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (await discardIncognitoRoute(req, res, p, url, ctx, resolveConversationId)) return true;
  if (await bulkDeleteRoute(req, res, p, url, ctx, resolveConversationId)) return true;
  if (await projectMoveRoute(req, res, p, url, ctx, resolveConversationId)) return true;
  // A restricted runner may expose these mutations only for conversations in
  // its captured account. Keep alias resolution inside the account scope.
  if (ctx.strictActionSemantics && method !== "GET") {
    const target = /\/chat_conversations\/([^/]+)(?:\/(?:stop_response|read_state))?$/.exec(p);
    if (target) {
      const owned = await ctx.loadConversation(resolveConversationId(target[1]));
      if (!owned || !isChat(owned)) return reply(res, { error: "Conversation not found" }, 404);
    }
  }
  // The page's REST stop (legacy transport, shared-0): the same interrupt as stop_generation.
  const stop = /\/chat_conversations\/([^/]+)\/stop_response$/.exec(p);
  if (stop && method === "POST") {
    await ctx.call("interrupt", resolveConversationId(stop[1]));
    return empty(res);
  }
  // Which transport serves the conversation: none to report (404 is the page's default).
  if (/\/chat_conversations\/[^/]+\/serving$/.test(p))
    return reply(res, { type: "error", error: { type: "not_found_error", message: "Not found" } }, 404);
  const readState = /\/chat_conversations\/([^/]+)\/read_state$/.exec(p);
  if (readState) {
    if (method !== "POST" && method !== "PUT") return reply(res, { unread: false });
    const mutation = parseOfficialChatReadState(method, await readJson(req).catch(() => undefined));
    if (!mutation)
      return reply(res, { type: "error", error: { type: "invalid_request_error", message: "Invalid chat read state." } }, 400);
    const id = resolveConversationId(readState[1]);
    if (mutation.format === "original") {
      const conversation = await ctx.loadConversation(id);
      if (conversation?.mode !== "chat")
        return reply(res, { type: "error", error: { type: "not_found_error", message: "Conversation not found." } }, 404);
    }
    const saved = await ctx.call("updateConversation", id, { unread: mutation.unread });
    if (mutation.format === "legacy") return reply(res, { unread: false });
    if (!saved || typeof saved !== "object" || !("readStateRevision" in saved) ||
        typeof saved.readStateRevision !== "number" || !Number.isSafeInteger(saved.readStateRevision) ||
        saved.readStateRevision <= 0 || ("unread" in saved && saved.unread === true) !== mutation.unread)
      return reply(res, { type: "error", error: { type: "api_error", message: "The chat read state could not be confirmed." } }, 503);
    const revision = iso(saved.readStateRevision);
    return reply(res, { written: true, revision, ...(mutation.unread ? {} : { last_read_at: revision }) });
  }
  const one = /\/chat_conversations\/([^/]+)$/.exec(p);
  if (one && method === "DELETE") {
    await ctx.call("deleteConversation", resolveConversationId(one[1]));
    return empty(res);
  }
  if (one && (method === "PUT" || method === "PATCH")) {
    const settingsOwner = ctx.account()?.id, settingsIdentity = ctx.sessionIdentity?.(),
      settingsDirectory = ctx.stateDirectory?.();
    const body = await readJson(req).catch(() => ({}));
    if (body && typeof body === "object" && Object.hasOwn(body, "settings")) {
      if (ctx.account()?.id !== settingsOwner || ctx.sessionIdentity?.() !== settingsIdentity ||
          ctx.stateDirectory?.() !== settingsDirectory || ctx.isCurrent?.() === false)
        return reply(res, { error: { type: "api_error", message: "The account changed during this request." } }, 409);
      try {
        const connector = parseOfficialConnectorPreferenceBody(method, p + url.search, body);
        if (connector?.kind === "chat") {
          const saved = await saveChatConnectorPreferences(ctx, connector, resolveConversationId);
          return reply(res, { ...conversationRow(saved, ctx), uuid: connector.pageId });
        }
      } catch (error) {
        const { status, message } = chatConnectorErrorResponse(error);
        return reply(res, { error: { type: "api_error", message } }, status);
      }
      return saveConversationSearchSettings(res, p, body, one[1], resolveConversationId, ctx, (row) => conversationRow(row, ctx));
    }
    const update: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) update.title = body.name;
    if (typeof body.is_starred === "boolean") update.pinned = body.is_starred;
    if (typeof body.is_archived === "boolean") update.archived = body.is_archived;
    if ("project_uuid" in body) update.projectId = body.project_uuid || null;
    const id = resolveConversationId(one[1]);
    if (Object.keys(update).length) {
      try { await ctx.call("updateConversation", id, update); }
      catch (error) {
        // Archive has side effects before persistence. Preserve its explicit
        // unknown-outcome message through the original API error UI; do not
        // claim rollback or invite a blind retry after an unconfirmed write.
        const archiveUnknown = "The archive update could not be confirmed. Some session changes may already have occurred; reopen before retrying.";
        if (Object.keys(update).length === 1 && typeof update.archived === "boolean" &&
            error instanceof Error && error.message === archiveUnknown)
          return reply(res, { type: "error", error: { type: "api_error", message: archiveUnknown,
            details: { error_visibility: "user_facing" } } }, 500);
        throw error;
      }
    }
    const c = await ctx.loadConversation(id);
    return c ? reply(res, conversationRow(c)) : empty(res);
  }
  if (await historyListRoute(req, res, p, url, ctx)) return true;
  if (p.endsWith("/chat_conversations")) return reply(res, []);
  const detail = /\/chat_conversations\/([^/]+)$/.exec(p);
  if (detail) {
    const owner = ctx.account()?.id, activation = ctx.sessionIdentity?.(), stateDirectory = ctx.stateDirectory?.();
    const org = /^\/api\/organizations\/([^/]+)\//.exec(p)?.[1];
    if (!owner || org !== organizationUuid(owner)) return reply(res, { error: { type: "not_found_error", message: "Conversation not found" } }, 404);
    const current = () => { if (ctx.account()?.id !== owner || ctx.sessionIdentity?.() !== activation || ctx.stateDirectory?.() !== stateDirectory || ctx.isCurrent?.() === false) throw new RestHistoryError(409, "The account changed during this request."); };
    try {
      current();
      const c = await ctx.loadConversation(resolveConversationId(detail[1]));
      current();
      if (!c || !isChat(c)) return reply(res, { error: { type: "not_found_error", message: "Conversation not found" } }, 404);
      if (url.search === "?claudex_project_binding=1") {
        if (c.sessionAuthors?.ownerAccountUuid && c.sessionAuthors.ownerAccountUuid !== owner)
          return reply(res, { error: { type: "not_found_error", message: "Conversation not found" } }, 404);
        return reply(res, { claudex_project_organization_uuid: c.projectOrganizationId ?? null });
      }
      // Keep a bounded metadata-only fallback when inline text exceeds the response budget.
      const inlineDisplays = await projectInlineAttachmentDisplays(ctx, c, { user: userMessageId, assistant: assistantMessageId });
      current();
      if (url.search === "?claudex_inline_displays=1") {
        const value = { uuid: detail[1], claudex_inline_attachment_displays: inlineDisplayHistory(c, inlineDisplays, { user: userMessageId, assistant: assistantMessageId }) };
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024) throw new RestHistoryError(413, "The conversation display metadata is too large.");
        current();
        return reply(res, value);
      }
      const ratings = ctx.ratings?.();
      const baseHistory = conversationRestMessages(c, org, Object.assign(new Map(), { fileNames: inlineDisplays.fileNames }), ratings);
      let history=baseHistory;
      try { history=conversationRestMessages(c,org,inlineDisplays,ratings); }
      catch(error) { if(!(error instanceof RestHistoryError) || error.status!==413) throw error; }
      const row = { ...conversationRow(c, ctx), uuid: detail[1],
        ...(ctx.localCall && !ctx.readOnly && c.mode === "chat" && c.importedSessionResumePending && c.sessionAuthors?.ownerAccountUuid === owner
          ? { claudex_imported_resume_session_id: c.id } : {}),
      };
      let value = { ...row, chat_messages: history.messages, claudex_inline_attachment_displays: inlineDisplayHistory(c, inlineDisplays, { user: userMessageId, assistant: assistantMessageId }) };
      if(Buffer.byteLength(JSON.stringify(value),"utf8")>4*1024*1024 && history!==baseHistory) {
        history=baseHistory;
        value={...row,chat_messages:history.messages,claudex_inline_attachment_displays:[]};
      }
      if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024) throw new RestHistoryError(413, "The conversation history is too large.");
      current();
      messageIndex.set(c.id, history.refs);
      return reply(res, value);
    } catch (error) {
      // Local upload proofs can reject before the post-read account check.
      // Preserve the account-conflict response even when a source read failed.
      try { current(); } catch (changed) { error = changed; }
      return reply(res, { error: { type: "invalid_request_error", message: error instanceof RestHistoryError ? error.message : "The conversation history could not be read." } }, error instanceof RestHistoryError ? error.status : 500);
    }
  }
  return false;
}

