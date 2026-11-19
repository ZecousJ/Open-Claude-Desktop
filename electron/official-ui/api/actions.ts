import { isResearchCommand, researchConnectorEnabled, researchUnavailable, researchUnavailableMessages } from "../../../shared/research";
import { chatPermissionFromWire } from "../../../shared/chat-permission-mode";
import { routeForModel } from "../../../shared/provider-routes";
import type { ClientPolicy } from "../../../shared/client-policy";
import { applyReplyFeedback } from "./reply-feedback";
import { supportedResearchMode } from "./research-projection";
import { ResearchStopError, stopResearchTask } from "./research-stop";
import { appendSendIdentity, lookupAppendSend, reserveAppendSend, durableAppendSend, type AppendSendReceipt } from "./append-send-receipts";
import { inlineDisplayForSend, projectInlineAttachmentDisplays, inlineDisplayHistory } from "./inline-attachment-displays";
import type { InlineAttachmentDisplay } from "../../../shared/inline-attachment-display";
import {normalizeCompletionQuotes} from "./completion-quotes";
import {resolveCompletionQuoteSources} from "./completion-quote-source";
import {userMessageId,assistantMessageId} from "./conversations";
/**
 * ConversationService/PerformAction (unary Connect, protobuf or JSON): the
 * mutations the official front-end sends for a chat. Each case maps to the
 * Claudex IPC handler the classic renderer uses for the same thing:
 *   send_message            → "send" (new prompt), "retryResponse" (input mode
 *                             RETRY under a prompt), "editPrompt" (a prompt
 *                             under an earlier reply)
 *   stop_generation, stop_research_task → "interrupt"
 *   message_feedback        → "setReplyFeedback" (+ "submitReplyFeedback" with a comment)
 *   rename / star / archive → "updateConversation"
 *   update_conversation_settings → "setConversationWebSearch",
 *                             "setConversationResearch"; effort and model wait for the next send
 *   set_conversation_model  → "updateConversation" { model }
 *   set_current_leaf        → "selectChatLeaf"
 *   continue_branch_as_new_chat → "forkConversation"
 *   respond_to_elicitation  → host-bound ordinary command decline only
 * The front-end's own message ids are remembered per Claudex turn so the
 * timeline it already drew matches the frames that follow.
 */
import type http from "node:http";
import { fromBinary, fromJson, toBinary, isFieldSet, type DescMessage, type FileRegistry } from "@bufbuild/protobuf";
import type { Conversation, Turn } from "../../../shared/types";
import type { SessionConnectorPreference } from "../../../shared/session-connector-preference";
import { officialChatMemoryMode } from "../../../shared/official-ui-web";
import { organizationUuid, type AdapterContext } from "./context";
import { nativeChatKnowledgeChoices, saveChatConnectorPreferences, withChatConnectorPreferences } from "./chat-connector-preferences";
import { deepCreate } from "./timeline";
import {
  conversationAliases,
  isChat,
  messageRef,
  pendingSends,
  registerPendingSend,
  rememberTurnIds,
  resolveConversationId,
} from "./conversations";
import { aliasCloudAttachments, bindIncognitoFiles, knownFile } from "./files";
import { canSearch } from "./bootstrap";
import { effortOf, savedChatEffort } from "./model-selection-preferences";
import { ScopedMap, currentAdapterScope } from "./scope";
import { respondToCommandElicitation } from "./elicitation-response";
import { prepareDerivedTextAttachment, storePreparedDerivedTextAttachment } from "./derived-text-attachment";
import { selectStoredChatLeaf } from "./rest-conversation-leaf";
import { readOfficialSkillReferences } from "./skill-references";

const PACKAGE = "anthropic.bard.api.v1alpha";
export const PERFORM_ACTION_PATH = `/claudeai-rpc/${PACKAGE}.ConversationService/PerformAction`;
const INPUT_MODE_RETRY = 2;
const CLIENT_PLATFORM_ANDROID = 4;
const FEEDBACK_UPVOTE = 1, FEEDBACK_DOWNVOTE = 2, FEEDBACK_UNSPECIFIED = 0;
const RESEARCH_OFF = 0;
const wireUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** A new conversation's send still creating it, by the page's id (a stop waits for its real id). */
import { creatingConversations as creating } from "./incognito";

/** Choices the page made for a conversation that apply from its next send. */
interface NextSend { effort?: string; model?: string }
export const nextSendChoices = new ScopedMap<string, NextSend>("next-send-choices");

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createActionRpc(ctx: AdapterContext, registry: FileRegistry, options: { durableAppend?: boolean } = {}) {
  const message = (name: string): DescMessage => {
    const m = registry.getMessage(`${PACKAGE}.${name}`);
    if (!m) throw new Error(`No message ${name} in the conversation protocol`);
    return m;
  };
  const RequestSchema = message("PerformActionRequest");
  const ResponseSchema = message("PerformActionResponse");
  const feedbackTypes = new Set(registry.getEnum(`${PACKAGE}.FeedbackType`)?.values.map(value => value.number) ?? []);
  const providerFor = (c?: Conversation) => {
    const settings = ctx.settings();
    return (
      (c && settings.providers.find((p) => p.id === c.providerId)) ??
      settings.providers.find((p) => p.backend === "sub2api") ??
      settings.providers[0]
    );
  };
  const latestTurn = (c: Conversation | undefined) => c?.turns?.[c.turns.length - 1];
  /** The page's attachments (uploaded files and inline text) as Claudex attachment ids. */
  const attachmentIds = async (send: any, incognitoConversation?: string) => {
    const ids: string[] = [], inlineAttachmentDisplays: InlineAttachmentDisplay[] = [];
    if ((send.attachments?.length ?? 0) + (send.inlineAttachments?.length ?? 0) > 12)
      throw new Error("Attach at most 12 files to this message.");
    for (const a of send.attachments ?? []) {
      if (typeof a.id !== "string" || !a.id) throw new Error("An attachment has no usable file identity. Add it again.");
      const file = knownFile(a.id);
      if (!file || (file.incognitoDraft && !incognitoConversation))
        throw new Error(`${a.fileName || "A file"} is no longer available. Attach it again.`);
      ids.push(a.id);
    }
    bindIncognitoFiles(ids, incognitoConversation);
    const inlineAttachments = (send.inlineAttachments ?? []).map((inline: {
      fileName?: string;
      fileType?: string;
      extractedContent: string;
    }) => ({
      prepared: prepareDerivedTextAttachment(inline),
      display: inline.fileName ? inlineDisplayForSend("inline", {
        file_name: inline.fileName,
        file_type: inline.fileType ?? "",
      }, inline.extractedContent) : undefined,
    }));
    for (const { prepared, display } of inlineAttachments) {
      const file = await storePreparedDerivedTextAttachment(ctx, prepared, incognitoConversation);
      ids.push(file.id);
      if (display) inlineAttachmentDisplays.push({ ...display, attachmentId: file.id });
    }
    return {ids, inlineAttachmentDisplays};
  };
  return async (req: http.IncomingMessage, res: http.ServerResponse, p: string): Promise<boolean> => {
    if (req.method !== "POST" || p !== PERFORM_ACTION_PATH) return false;
    const binary = (req.headers["content-type"] ?? "").includes("proto");
    const body = await readBody(req);
    let request: any;
    try {
      request = binary ? fromBinary(RequestSchema, body) : fromJson(RequestSchema, JSON.parse(body.toString("utf8") || "{}"), { ignoreUnknownFields: true });
    } catch (error) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "invalid_argument", message: String(error) }));
      return true;
    }
    const header = request.header ?? {};
    const pageConversationId: string = header.conversationId ?? "";
    const conversationId = pageConversationId ? resolveConversationId(pageConversationId) : "";
    const action = request.action ?? { case: undefined };
    const highWaterMark = header.mutationId && { sessionId: header.mutationId.sessionId, version: header.mutationId.version };
    let finishAppend: ((answer: { ack: Record<string, unknown> }) => void) | undefined;
    let appendFailureMessageId: string | undefined;
    const respond = (init: { ack: Record<string, unknown> }) => {
      finishAppend?.(init);
      res.writeHead(200, { "Content-Type": binary ? "application/proto" : "application/json" });
      res.end(binary ? Buffer.from(toBinary(ResponseSchema, deepCreate(ResponseSchema, init))) : JSON.stringify(init, (_k, v) => (typeof v === "bigint" ? Number(v) : v)));
      return true;
    };
    const ack = (extra: Record<string, unknown> = {}) =>
      respond({ ack: { highWaterMark, outcome: { case: "applied", value: true }, ...extra } });
    // Set only after the active transcript resolves this request to an edit.
    let editFailureMessageId: string | undefined;
    // Correlation settles the original retry stub even if its target disappeared.
    // It does not authorize a retry; all existing target checks still run below.
    const retryFailure = action.case === "sendMessage" && action.value.inputMode === INPUT_MODE_RETRY
      && typeof action.value.parentMessageId === "string" && !!action.value.parentMessageId
      && typeof action.value.assistantMessageId === "string" && !!action.value.assistantMessageId
      && !action.value.messageId;
    const refuse = (code: string, text: string) => {
      ctx.log("[official-ui] action refused", action.case, code, text);
      // The original metadata, settings, branch-copy and Stop consumers bind refusals to the issuing mutation,
      // and its existing notice callbacks use the protocol's snake_case names.
      const metadataAction = action.case === "renameConversation" ? "rename_conversation"
        : action.case === "starConversation" ? "star_conversation"
        : action.case === "archiveConversation" ? "archive_conversation"
        : action.case === "continueBranchAsNewChat" ? "continue_branch_as_new_chat"
        : action.case === "stopGeneration" ? "stop_generation"
        : action.case === "stopResearchTask" ? "stop_research_task"
        : action.case === "messageFeedback" ? "message_feedback"
        : action.case === "respondToElicitation" ? "respond_to_elicitation"
        : action.case === "setConversationModel" && ctx.strictActionSemantics ? "set_conversation_model"
        : action.case === "updateConversationSettings" ? "update_conversation_settings" : undefined;
      return respond({ ack: { ...((metadataAction || editFailureMessageId || appendFailureMessageId || retryFailure) && header.mutationId ? { highWaterMark: { sessionId: header.mutationId.sessionId, version: header.mutationId.version } } : {}), outcome: { case: "error", value: { error: { type: code, message: text, displayMessage: text, retryable: false }, action: (editFailureMessageId || appendFailureMessageId || retryFailure) ? "send_message" : metadataAction ?? String(action.case ?? ""), ...((editFailureMessageId || appendFailureMessageId) ? { messageId: editFailureMessageId || appendFailureMessageId } : {}) } } } });
    };
    const load = () => (conversationId ? ctx.loadConversation(conversationId) : Promise.resolve(undefined));
    try {
      switch (action.case) {
        case "sendMessage": {
          let send = action.value;
          let skillReferences = readOfficialSkillReferences(send.text ?? "", send.hiddenContext, !ctx.strictActionSemantics);
          if (skillReferences && send.inputMode === INPUT_MODE_RETRY)
            return refuse("invalid_argument", "A retry uses the original skill selection.");
          const owner=ctx.account()?.id, identity=ctx.sessionIdentity?.();
          const current=()=>!!owner && identity!=null && ctx.account()?.id===owner && ctx.sessionIdentity?.()===identity && ctx.isCurrent?.()!==false;
          const existing = await load();
          const android = ctx.strictActionSemantics && send.clientPlatform === CLIENT_PLATFORM_ANDROID;
          const retry = send.inputMode === INPUT_MODE_RETRY;
          const receiptRequest = android ? { ...request, header: { ...header, mutationId: undefined, clientCapabilities: undefined } } : request;
          const appendIdentity = !retry || android
            ? appendSendIdentity(header.mutationId, send, toBinary(RequestSchema, receiptRequest), android ? { conversationId: pageConversationId, retry } : undefined)
            : undefined;
          const replayAppend = async (receipt: AppendSendReceipt): Promise<boolean | undefined> => {
            if (receipt.kind === "missing") return undefined;
            appendFailureMessageId = send.messageId;
            if (receipt.kind === "reserved") { finishAppend = receipt.finish; return undefined; }
            if (receipt.kind === "conflict") return refuse("invalid_argument", "Mutation id already used.");
            const answer = await receipt.answer;
            if (!current()) return refuse("mutation_unconfirmed", "The account changed. Reopen the conversation.");
            return respond(android ? { ack: { ...answer.ack, highWaterMark } } : answer);
          };
          // Before parent resolution: the accepted append's old parent must not
          // become an edit target when the same request is delivered again.
          if (appendIdentity) {
            const replayed = await replayAppend(lookupAppendSend(appendIdentity));
            if (replayed !== undefined) return replayed;
          }
          const temporary = existing ? !!existing.incognito : !!send.isTemporary;
          const durable = (options.durableAppend || android && ctx.stateDirectory !== undefined) && !!appendIdentity && !temporary &&
            (!!existing || !send.parentMessageId && !header.existingOnly);
          if (durable && appendIdentity) {
            appendFailureMessageId = send.messageId;
            const prior = durableAppendSend(ctx, appendIdentity, false);
            if (prior === "conflict") return refuse("invalid_argument", "Mutation id already used.");
            if (prior === "pending") {
              if (android && current() && existing &&
                  [...existing.turns, ...(existing.savedBranches ?? []).flatMap(branch => branch.turns)].some(turn =>
                    (retry || userMessageId(turn) === send.messageId) && assistantMessageId(turn) === send.assistantMessageId))
                return ack();
              return refuse("mutation_unconfirmed", "The previous send could not be confirmed. Reopen the conversation before retrying.");
            }
          }
          if (ctx.strictActionSemantics && send.projectId) {
            appendFailureMessageId = send.messageId;
            if (existing && existing.projectId !== send.projectId)
              return refuse("invalid_argument", "This conversation's project changed. Reopen it before sending.");
            const snapshot = await ctx.snapshot(true);
            if (!current()) return refuse("mutation_unconfirmed", "The account changed. Reopen the conversation.");
            const projects = snapshot.projects?.filter(project => project.id === send.projectId && (project.kind ?? "chat") === "chat");
            if (projects?.length !== 1)
              return refuse("not_found", "Project not found. Reopen the project before sending.");
          }
          let completionQuotes: import("../../../shared/completion-quotes").CompletionQuote[] | undefined;
          if(send.quotes?.length){
            const resolved=resolveCompletionQuoteSources({conversation:existing,current,userMessageId,assistantMessageId,messageRef:id=>messageRef(pageConversationId,id)},send.quotes);
            const prepared=normalizeCompletionQuotes({text:send.text??"",quotes:resolved.quotes});
            if(prepared.text.length>200000) return refuse("invalid_argument","The quoted message exceeds the message limit.");
            if (skillReferences?.length) {
              const offset = prepared.text.length - prepared.typedText.length;
              skillReferences = skillReferences.map(ref => ({ ...ref, start: ref.start + offset, end: ref.end + offset }));
            }
            send={...send,text:prepared.text};completionQuotes=prepared.quotes;
          }
          const quoteCall=async(name:string,...args:unknown[])=>{
            if(completionQuotes) {
              if(!current())throw Error("The quote account changed.");
              const fresh = await load();
              resolveCompletionQuoteSources({
                conversation: fresh, current, userMessageId, assistantMessageId,
                messageRef: id => messageRef(pageConversationId, id),
              }, send.quotes);
            }
            const result=await ctx.call(name,...args);
            if(completionQuotes && !current())throw Error("The quote account changed.");
            return result;
          };
          const provider = providerFor(existing);
          if (!provider) return refuse("invalid_request", "No model service is configured.");
          const toolSettings = send.settingsUpdate?.settings?.enabledMcpTools?.tools;
          const connectorChoices = ctx.chatConnectorChoicesForAction?.(pageConversationId) ??
            (!ctx.strictActionSemantics && !ctx.readOnly && toolSettings && Object.keys(toolSettings).length
              ? nativeChatKnowledgeChoices(toolSettings) : undefined);
          if (connectorChoices && !owner)
            return refuse("invalid_request", "The connector account changed.");
          const withConnectorChoices = (submit: (initial?: SessionConnectorPreference) => Promise<unknown>) =>
            connectorChoices && owner
              ? withChatConnectorPreferences(ctx, {
                  kind: "chat", organizationId: organizationUuid(owner),
                  pageId: pageConversationId, tools: connectorChoices,
                }, resolveConversationId, { kind: "send", newChat: !existing }, (_row, initial) => submit(initial))
              : submit();
          const choices = nextSendChoices.get(conversationId) ?? {};
          const settings = send.settingsUpdate?.settings ?? {};
          const requestedPermission = settings.permissionMode === undefined ? undefined : chatPermissionFromWire(settings.permissionMode);
          if (settings.permissionMode !== undefined && (!requestedPermission || !ctx.chatPermissionModes?.includes(requestedPermission)))
            return refuse("invalid_argument", "This permission mode is not supported.");
          const chatPermission = requestedPermission ?? existing?.chatPermissionMode;
          if (requestedPermission && existing &&
              (existing.mode !== "chat" || existing.archived || existing.linkedToComputer ||
               existing.chatDeviceBinding || existing.deviceChatOrigin?.active ||
               existing.sessionAuthors && (existing.sessionAuthors.ownerAccountUuid !== owner ||
                existing.sessionAuthors.viewerAccountUuid !== owner)))
            return refuse("invalid_request", "This conversation cannot change permission mode.");
          if (chatPermission) {
            const chatPolicy = await ctx.call("clientPolicy") as ClientPolicy;
            if (!chatPolicy.permissionModes.includes(chatPermission === "auto" ? "auto" : "manual"))
              return refuse("invalid_request", "This permission mode is not allowed.");
          }
          if (!supportedResearchMode(settings.researchMode)) return refuse("invalid_argument", "This research mode is not supported.");
          const memoryMode = send.chatMemoryMode ?? officialChatMemoryMode.unspecified;
          if (
            memoryMode !== officialChatMemoryMode.unspecified &&
            memoryMode !== officialChatMemoryMode.enabled &&
            memoryMode !== officialChatMemoryMode.disabled
          )
            return refuse("invalid_argument", "The requested chat memory setting is unavailable.");
          const memoryDisabled = memoryMode === officialChatMemoryMode.disabled;
          if (
            existing &&
            memoryMode !== officialChatMemoryMode.unspecified &&
            memoryDisabled !== !!existing.memoryDisabled
          )
            return refuse("invalid_argument", "Memory use is set when starting a Chat.");
          const model =
            send.model?.id?.case === "identifier" && send.model.id.value
              ? send.model.id.value
              : choices.model ?? existing?.model ?? provider.model;
          const requestedEffort = effortOf(settings.effortLevelToken) ?? effortOf(choices.effort);
          if (ctx.strictActionSemantics && (
            (settings.effortLevelToken !== undefined && !effortOf(settings.effortLevelToken)) ||
            (requestedEffort && !(await ctx.modelCatalog())?.items.some((item) => item.id === model && item.efforts?.includes(requestedEffort)))
          )) return refuse("invalid_argument", "The requested effort is not supported by this model.");
          const effort = requestedEffort ?? (!existing?.turns.length && !existing?.effort ? await savedChatEffort(ctx, model) : undefined);
          // A model without web search never gets it: a conversation that had it on turns it off first.
          const searchable = canSearch(ctx, model);
          if (ctx.strictActionSemantics && settings.enabledWebSearch === true && !searchable)
            return refuse("invalid_request", "Web search is not available for this model.");
          // Optional proto presence matters: absent = append; explicit "" =
          // root edit only when an existing transcript has a first prompt.
          const hasParent = send.parentMessageId !== undefined;
          const parent = send.parentMessageId ? messageRef(pageConversationId, send.parentMessageId) : undefined;
          let editTarget: Turn | undefined, retryTarget: Turn | undefined;
          if (header.existingOnly && !existing)
            return refuse("not_found", "The conversation is no longer available.");
          if (!retry && hasParent && send.parentMessageId === "" && !existing?.turns.length)
            return refuse("not_found", "The first message is no longer available.");
          if (hasParent && send.parentMessageId && (!existing || !parent || !parent.active))
            return refuse("branch_unavailable", "That message is not on the active conversation branch. Reopen the conversation.");
          if (retry) {
            retryTarget = parent && existing?.turns.find(turn => turn.id === parent.turnId);
            if (!retryTarget) return refuse("not_found", "Choose an existing reply or prompt to retry.");
          } else if (existing && hasParent) {
            if (!send.parentMessageId) editTarget = existing.turns[0];
            else {
              if (parent?.kind !== "assistant") return refuse("invalid_argument", "An edited prompt must follow an assistant reply.");
              const at = existing.turns.findIndex(turn => turn.id === parent.turnId);
              if (at < 0) return refuse("not_found", "The parent reply is no longer available.");
              editTarget = existing.turns[at + 1];
            }
          }
          if (editTarget && typeof send.messageId === "string" && send.messageId)
            editFailureMessageId = send.messageId;
          if (editTarget && (!current() || (existing?.sessionAuthors &&
              (existing.sessionAuthors.ownerAccountUuid !== owner || existing.sessionAuthors.viewerAccountUuid !== owner))))
            return refuse("not_found", "The conversation is no longer available.");
          if (editTarget && (typeof send.text !== "string" || !send.text.trim()))
            return refuse("invalid_argument", "Enter the edited message before saving.");
          if ((editTarget || retryTarget) && settings.effortLevelToken !== undefined && !effortOf(settings.effortLevelToken))
            return refuse("invalid_argument", "The requested effort is not supported.");
          if(retryTarget && completionQuotes && send.text!==retryTarget.prompt)return refuse("invalid_argument","A retry cannot replace its quoted prompt.");
          if(completionQuotes && !current())return refuse("invalid_request","The quote account changed.");
          const officialChatMessageIds =
            wireUuid.test(send.assistantMessageId ?? "") && (retryTarget || wireUuid.test(send.messageId ?? ""))
              ? { user: retryTarget ? userMessageId(retryTarget) : send.messageId, assistant: send.assistantMessageId }
              : undefined;
          if (officialChatMessageIds && officialChatMessageIds.user.toLowerCase() === officialChatMessageIds.assistant.toLowerCase())
            return refuse("invalid_argument", "The prompt and response must have different message IDs.");
          if (appendIdentity) {
            const replayed = await replayAppend(reserveAppendSend(appendIdentity));
            if (replayed !== undefined) return replayed;
            if (durable && !editTarget) {
              const receipt = durableAppendSend(ctx, appendIdentity, true);
              if (receipt === "conflict") return refuse("invalid_argument", "Mutation id already used.");
              if (receipt !== "reserved") return refuse("mutation_unconfirmed", "The previous send could not be confirmed. Reopen the conversation before retrying.");
            }
          }
          const researchCommand = typeof send.text === "string" && isResearchCommand(send.text);
          const requestedWebSearch = researchCommand && settings.enabledWebSearch === false ? undefined
            : settings.enabledWebSearch === undefined ? undefined : !!settings.enabledWebSearch && searchable;
          const requestedResearch = researchCommand ? true : settings.researchMode === undefined ? undefined : settings.researchMode !== RESEARCH_OFF;
          if (researchCommand) {
            const policy = await ctx.call("clientPolicy") as ClientPolicy;
            const catalog = await ctx.modelCatalog();
            if (!current()) return refuse("invalid_request", "The research account changed.");
            const reason = researchUnavailable({ policy, mode: "chat", incognito: temporary, provider, model,
              catalogItem: catalog?.items.find(item => item.id === model),
              searchIntegrationEnabled: researchConnectorEnabled(ctx.settings(), policy, existing?.connectorOverrides) });
            if (reason) return refuse("invalid_request", researchUnavailableMessages[reason]);
          }
          if (existing && requestedResearch !== undefined) {
            if (requestedResearch !== !!existing.research || requestedWebSearch !== undefined)
              await quoteCall("setConversationResearch", conversationId, requestedResearch,
                ...(requestedWebSearch === undefined ? [] : [{ webSearch: requestedWebSearch }]));
          } else if (existing && requestedWebSearch !== undefined && requestedWebSearch !== !!existing.webSearch)
            await quoteCall("setConversationWebSearch", conversationId, requestedWebSearch);
          else if (existing?.webSearch && !searchable) await quoteCall("setConversationWebSearch", conversationId, false);
          ctx.log("[official-ui] send", JSON.stringify({ model: send.model?.id, chosen: model, effort, parent: send.parentMessageId ?? null, inputMode: send.inputMode, web: settings.enabledWebSearch, files: (send.attachments ?? []).length + (send.inlineAttachments ?? []).length }));
          if (editTarget || retryTarget) {
            // Edit submits the complete composer attachment snapshot. RETRY
            // normally has no attachment declaration and preserves the prompt's files.
            const replaceAttachments = !!editTarget || (send.attachments?.length ?? 0) > 0 || (send.inlineAttachments?.length ?? 0) > 0;
            const prepared = replaceAttachments ? await attachmentIds(send, existing?.incognito ? conversationId : undefined) : undefined;
            const ids = prepared?.ids;
            const target = (editTarget ?? retryTarget)!;
            const capturesLegacy = prepared && !("inlineAttachmentDisplays" in target) && prepared.ids.some(id => !target.attachments.some(file => file.id === id));
            let retainedDisplays = target.inlineAttachmentDisplays;
            if (capturesLegacy) {
              if (!current()) throw Error("The attachment account changed.");
              const projection = await projectInlineAttachmentDisplays(ctx, existing!, { user: userMessageId, assistant: assistantMessageId });
              if (!current()) throw Error("The attachment account changed.");
              retainedDisplays = inlineDisplayHistory(existing!, projection, { user: userMessageId, assistant: assistantMessageId }).filter(row => row.turnId === target.id).map(row => row.display);
            }
            const inlineAttachmentDisplays = prepared && (prepared.inlineAttachmentDisplays.length || capturesLegacy)
              ? [...(retainedDisplays ?? []).filter(display => prepared.ids.includes(display.attachmentId)), ...prepared.inlineAttachmentDisplays]
              : undefined;
            if (editTarget && !current()) return refuse("mutation_unconfirmed", "The account changed. Reopen the conversation.");
            if(completionQuotes && !current())return refuse("invalid_request","The quote account changed.");
            const options = {...(inlineAttachmentDisplays === undefined ? {} : {inlineAttachmentDisplays}), ...(completionQuotes===undefined?{}:{completionQuotes}), ...(ids === undefined ? {} : { attachments: ids.map(id => ({id})) }), ...(effort ? {effort} : {}), ...(skillReferences ? { skillReferences } : {}), ...(officialChatMessageIds ? { officialChatMessageIds } : {})};
            const extra = Object.keys(options).length ? [options] : [];
            const before = new Set(existing!.turns.map(turn => turn.id));
            const result = await withConnectorChoices(() => retryTarget
              ? quoteCall("retryResponse", conversationId, retryTarget.id, provider.id, model, ...extra)
              : quoteCall("editPrompt", conversationId, editTarget!.id, send.text, provider.id, model, ...extra)) as Conversation | undefined;
            const created = latestTurn(result);
            if (!result || result.id !== conversationId || !created || !created.id || before.has(created.id))
              return refuse("mutation_unconfirmed", "The new message version could not be confirmed. Reopen the conversation before retrying.");
            rememberTurnIds(created, { ...(editTarget ? { user: send.messageId } : {}), assistant: send.assistantMessageId }, !!existing?.incognito);
            return ack();
          }
          const displayScope = currentAdapterScope(), displayRoot = ctx.stateDirectory?.();
          const hasInlineDisplay = (send.inlineAttachments?.length ?? 0) > 0;
          const displayCurrent = () => current() && currentAdapterScope() === displayScope && ctx.stateDirectory?.() === displayRoot;
          if (hasInlineDisplay && !displayCurrent()) return refuse("invalid_request", "The attachment account changed.");
          const preparedAttachments = await attachmentIds(send, temporary ? conversationId : undefined);
          const attachments = preparedAttachments.ids;
          if (hasInlineDisplay && !displayCurrent()) return refuse("invalid_request", "The attachment account changed.");
          if(completionQuotes && !current())return refuse("invalid_request","The quote account changed.");
          // Pending first messages remain visible while admission assigns the
          // stored conversation and turn IDs.
          const pending = pageConversationId && !existing && send.messageId && send.assistantMessageId
            ? {
                text: send.text ?? "",
                messageId: send.messageId,
                assistantMessageId: send.assistantMessageId,
                at: Date.now(),
                ...(memoryDisabled ? { memoryDisabled: true as const } : {}),
              }
            : undefined;
          if (pending) registerPendingSend(pageConversationId, pending);
          const sending = withConnectorChoices(initial => quoteCall("send", {
            ...(existing ? { conversationId } : conversationId ? { newConversationId: conversationId } : {}),
            text: send.text ?? "",
            ...(officialChatMessageIds && { officialChatMessageIds }),
            ...(skillReferences ? { skillReferences } : {}),
            ...(completionQuotes===undefined?{}:{completionQuotes}),
            mode: "chat",
            ...(chatPermission ? { taskPermission: chatPermission } : {}),
            ...(initial && Object.keys(initial.connectorOverrides).length ? { connectorOverrides: initial.connectorOverrides } : {}),
            ...(initial && Object.keys(initial.connectorToolOverrides).length ? { connectorToolOverrides: initial.connectorToolOverrides } : {}),
            attachments: attachments.map((id) => ({ id })),
            ...(preparedAttachments.inlineAttachmentDisplays.length ? {inlineAttachmentDisplays:preparedAttachments.inlineAttachmentDisplays} : {}),
            providerId: provider.id,
            model,
            ...(effort ? { effort } : {}),
            // Web search only when the page turned it on; the model must offer it.
            ...(requestedWebSearch === undefined ? {} : { webSearch: requestedWebSearch }),
            ...(requestedResearch === undefined ? {} : { research: requestedResearch }),
            incognito: temporary || undefined,
            ...(!existing && memoryDisabled ? { memoryDisabled: true } : {}),
            projectId: send.projectId || existing?.projectId || undefined,
          })) as Promise<Conversation>;
          const settled = sending.then(async (result) => {
            pendingSends.delete(pageConversationId);
            if (pageConversationId && result?.id && result.id !== pageConversationId && !result.incognito) conversationAliases.set(pageConversationId, result.id);
            const turn = latestTurn(result);
            if (turn) {
              rememberTurnIds(turn, { user: send.messageId, assistant: send.assistantMessageId }, !!result?.incognito);
              if (!turn.inlineAttachmentDisplays?.length) aliasCloudAttachments(attachments, turn.attachments ?? []);
            }
            nextSendChoices.delete(conversationId);
            return result;
          }, (error) => {
            // A new chat that could not start: its timeline shows the failed turn.
            if (pending) registerPendingSend(pageConversationId, { ...pending, error: error instanceof Error ? error.message : String(error) });
            throw error;
          });
          if (!existing && pageConversationId) {
            const done = settled.catch(() => undefined).finally(() => creating.delete(pageConversationId));
            creating.set(pageConversationId, done);
          }
          await settled;
          return ack();
        }
        case "stopGeneration": {
          const stoppingMessageId = action.value.stoppingMessageId;
          const owner = ctx.account()?.id, identity = ctx.sessionIdentity?.();
          const current = () => !!owner && identity != null && ctx.account()?.id === owner &&
            ctx.sessionIdentity?.() === identity && ctx.isCurrent?.() !== false;
          const pendingCreation = creating.get(pageConversationId);
          if (pendingCreation) await Promise.race([pendingCreation, new Promise((resolve) => setTimeout(resolve, 30000))]);
          const id = resolveConversationId(pageConversationId);
          if (!stoppingMessageId && !ctx.strictActionSemantics) {
            await ctx.call("interrupt", id);
            return ack();
          }
          if (!current()) return refuse("stop_unconfirmed", "The stop request could not be confirmed for this account.");
          const conversation = await ctx.loadConversation(id);
          if (!current() || resolveConversationId(pageConversationId) !== id)
            return refuse("stop_unconfirmed", "The conversation changed before the stop request could be confirmed.");
          const turn = latestTurn(conversation);
          if (!conversation || conversation.id !== id || conversation.mode !== "chat" ||
              (conversation.sessionAuthors?.ownerAccountUuid && conversation.sessionAuthors.ownerAccountUuid !== owner) ||
              !turn || (ctx.strictActionSemantics && (turn.id.startsWith("pending-") ||
                (!conversation.threadId && !conversation.chatDeviceBinding))))
            return refuse("stop_target_unavailable", "That message is no longer the current turn. Reopen the conversation.");
          if (stoppingMessageId) {
            const ref = messageRef(pageConversationId, stoppingMessageId);
            if (!ref?.active || ref.turnId !== turn.id ||
                (ref.kind === "assistant" ? assistantMessageId(turn) : userMessageId(turn)) !== stoppingMessageId)
              return refuse("stop_target_unavailable", "That message is no longer the current turn. Reopen the conversation.");
          }
          const result = await ctx.call("interrupt", id, {
            turnId: turn.id,
            turnCreatedAt: turn.createdAt,
            conversationCreatedAt: conversation.createdAt,
            ...(conversation.threadId && !conversation.chatDeviceBinding ? { threadId: conversation.threadId } : {}),
          });
          if (!current() || resolveConversationId(pageConversationId) !== id ||
              !result || typeof result !== "object" || !("status" in result) ||
              (result.status !== "accepted" && result.status !== "already_finished"))
            return refuse("stop_unconfirmed", "The stop request could not be confirmed for that turn. Reopen the conversation.");
          // Acceptance is not a terminal event. Only the exact already-terminal CAS
          // result can report NOTHING_RUNNING; never synthesize TURN_CANCELED.
          return ack(result.status === "already_finished" ? { stopGenerationEffect: 2 } : {});
        }
        case "stopResearchTask": {
          try { await stopResearchTask(ctx, pageConversationId, action.value.taskId); return ack(); }
          catch (error) {
            return refuse(error instanceof ResearchStopError ? error.code : "stop_unconfirmed",
              error instanceof ResearchStopError ? error.message : "The research stop could not be confirmed.");
          }
        }
        case "messageFeedback": {
          const result = await applyReplyFeedback(ctx, pageConversationId, {
            messageId: action.value.messageId ?? "",
            type: action.value.type ?? FEEDBACK_UNSPECIFIED,
            ...(action.value.comment !== undefined ? { comment: action.value.comment } : {}),
          }, feedbackTypes);
          if (result) return refuse(result.code, result.message);
          return ack();
        }
        case "renameConversation":
        case "starConversation":
        case "archiveConversation": {
          if (ctx.strictActionSemantics &&
              !(await ctx.listConversations()).some((row) => row.id === conversationId && isChat(row)))
            return refuse("not_found", "Conversation not found.");
          const patch = action.case === "renameConversation"
            ? { title: action.value.title ?? "" }
            : action.case === "starConversation"
              ? { pinned: !!action.value.starred }
              : { archived: !!action.value.archived };
          await ctx.call("updateConversation", conversationId, patch);
          return ack();
        }
        case "updateConversationSettings": {
          const settings = action.value.settings ?? {};
          const tools = settings.enabledMcpTools === undefined ? undefined :
            ctx.chatConnectorChoicesForAction?.(pageConversationId) ??
            (!ctx.strictActionSemantics && !ctx.readOnly ? nativeChatKnowledgeChoices(settings.enabledMcpTools.tools) : undefined);
          if (tools || ctx.strictActionSemantics && settings.enabledMcpTools !== undefined) {
            if (message("ConversationSettings").fields.some(field => field.localName !== "enabledMcpTools" && isFieldSet(settings, field)))
              return refuse("invalid_argument", "Update connector preferences separately.");
            const owner = ctx.account()?.id;
            if (!owner || !tools) return refuse("invalid_request", "Connector preferences are unavailable.");
            await saveChatConnectorPreferences(ctx, {
              kind: "chat", organizationId: organizationUuid(owner), pageId: pageConversationId, tools,
            }, resolveConversationId);
            return ack();
          }
          if (settings.permissionMode !== undefined) {
            if (message("ConversationSettings").fields.some(field => field.localName !== "permissionMode" && isFieldSet(settings, field)))
              return refuse("invalid_argument", "Update the permission mode separately.");
            const permission = chatPermissionFromWire(settings.permissionMode);
            if (!permission || !ctx.chatPermissionModes?.includes(permission)) return refuse("invalid_argument", "This permission mode is not supported.");
            const existing = await load();
            const owner = ctx.account()?.id;
            if (!owner || existing?.mode !== "chat" || existing.archived || existing.linkedToComputer ||
                existing.chatDeviceBinding || existing.deviceChatOrigin?.active ||
                ctx.isCloudConversation?.(conversationId) ||
                existing.sessionAuthors && (existing.sessionAuthors.ownerAccountUuid !== owner ||
                  existing.sessionAuthors.viewerAccountUuid !== owner))
              return refuse("not_found", "Conversation not found.");
            const policy = await ctx.call("clientPolicy") as ClientPolicy;
            if (!policy.permissionModes.includes(permission === "auto" ? "auto" : "manual"))
              return refuse("invalid_request", "This permission mode is not allowed.");
            const updated = await ctx.call("updateConversation", conversationId, { chatPermissionMode: permission }) as Conversation | undefined;
            if (updated?.id !== conversationId || updated.chatPermissionMode !== permission)
              return refuse("api_error", "The permission mode could not be confirmed.");
            return ack();
          }
          if (ctx.strictActionSemantics) {
            if (!supportedResearchMode(settings.researchMode)) return refuse("invalid_argument", "This research mode is not supported.");
            const existing = await load();
            if (existing?.mode !== "chat") return refuse("not_found", "Conversation not found.");
            const effort = effortOf(settings.effortLevelToken);
            if (settings.effortLevelToken !== undefined && (!effort ||
                !(await ctx.modelCatalog())?.items.some((item) => item.id === existing.model && item.efforts?.includes(effort))))
              return refuse("invalid_argument", "The requested effort is not supported by this model.");
            if (settings.enabledWebSearch !== undefined) {
              if (settings.enabledWebSearch &&
                  !(await ctx.modelCatalog())?.items.some((item) => item.id === existing.model && item.webSearch === "native"))
                return refuse("invalid_request", "Web search is not available for this model.");
            }
            if (settings.researchMode !== undefined) {
              const enabled = settings.researchMode !== RESEARCH_OFF;
              const updated = await ctx.call("setConversationResearch", conversationId, enabled,
                ...(settings.enabledWebSearch === undefined ? [] : [{ webSearch: settings.enabledWebSearch }])) as Conversation | undefined;
              if (updated?.id !== conversationId || !!updated.research !== enabled ||
                  settings.enabledWebSearch !== undefined && !!updated.webSearch !== settings.enabledWebSearch)
                return refuse("api_error", "The research setting could not be confirmed.");
            } else if (settings.enabledWebSearch !== undefined) {
              const updated = await ctx.call("setConversationWebSearch", conversationId, settings.enabledWebSearch) as Conversation | undefined;
              if (updated?.id !== conversationId || !!updated.webSearch !== settings.enabledWebSearch)
                return refuse("api_error", "The web search setting could not be confirmed.");
            }
            if (effort) nextSendChoices.set(conversationId, { ...nextSendChoices.get(conversationId), effort });
            return ack();
          }
          if (!supportedResearchMode(settings.researchMode)) return refuse("invalid_argument", "This research mode is not supported.");
          const existing = await load();
          if (existing) {
            if (settings.researchMode !== undefined) {
              if ((settings.researchMode !== RESEARCH_OFF) !== !!existing.research || settings.enabledWebSearch !== undefined)
                await ctx.call("setConversationResearch", conversationId, settings.researchMode !== RESEARCH_OFF,
                  ...(settings.enabledWebSearch === undefined ? [] : [{ webSearch: !!settings.enabledWebSearch }]));
            } else if (settings.enabledWebSearch !== undefined && !!settings.enabledWebSearch !== !!existing.webSearch)
              await ctx.call("setConversationWebSearch", conversationId, !!settings.enabledWebSearch);
          }
          const effort = effortOf(settings.effortLevelToken);
          if (effort) nextSendChoices.set(conversationId, { ...nextSendChoices.get(conversationId), effort });
          return ack();
        }
        case "setConversationModel": {
          const id = action.value.model?.id;
          const model = id?.case === "identifier" ? id.value : undefined;
          if (ctx.strictActionSemantics) {
            const owner = ctx.account()?.id;
            const existing = (await ctx.listConversations()).find((row) => row.id === conversationId);
            if (!owner || existing?.mode !== "chat" || existing.archived ||
                existing.linkedToComputer || existing.chatDeviceBinding || existing.deviceChatOrigin?.active ||
                existing.sessionAuthors && (existing.sessionAuthors.ownerAccountUuid !== owner ||
                  existing.sessionAuthors.viewerAccountUuid !== owner))
              return refuse("not_found", "Conversation not found.");
            const catalog = await ctx.modelCatalog();
            const items = catalog?.items.filter((entry) => entry.id === model);
            const item = items?.length === 1 ? items[0] : undefined;
            const { providers, effort: defaultEffort } = ctx.settings();
            const provider = providers.find((entry) => entry.id === existing.providerId);
            if (!item || !provider || !(provider.model === item.id || provider.models.includes(item.id) || routeForModel(provider, item.id)))
              return refuse("invalid_argument", "The requested Chat model is unavailable.");
            const choices = nextSendChoices.get(conversationId);
            const offered = item.efforts ?? [];
            const effort = [effortOf(choices?.effort), existing.effort, effortOf(item.defaultEffort), defaultEffort, ...offered.map(effortOf)]
              .find((choice) => choice !== undefined && offered.includes(choice));
            const saved = await ctx.call("updateConversation", conversationId, {
              model: item.id, providerId: provider.id, ...(effort === undefined ? {} : { effort }),
            }) as Conversation | undefined;
            if (saved?.id !== conversationId || saved.model !== item.id)
              return refuse("mutation_unconfirmed", "The Chat model change could not be confirmed. Reopen the conversation before retrying.");
            if (choices?.effort && !offered.some((choice) => choice === choices.effort))
              nextSendChoices.delete(conversationId);
            return ack();
          }
          if (model) {
            nextSendChoices.set(conversationId, { ...nextSendChoices.get(conversationId), model });
            if (await load()) await ctx.call("updateConversation", conversationId, { model });
          }
          return ack();
        }
        case "setCurrentLeaf": {
          const id = action.value.currentLeafMessageId;
          const owner = ctx.account()?.id, identity = ctx.sessionIdentity?.();
          const current = () => !!owner && identity != null && identity !== "" &&
            ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity && ctx.isCurrent?.() !== false;
          if ((ctx.readOnly && !ctx.allowChatLeafSelection) || typeof id !== "string" || !id || id.length > 512)
            return refuse("branch_unavailable", "Choose a saved reply on this conversation.");
          const saved = await selectStoredChatLeaf(ctx, conversationId, id, current);
          return saved && typeof saved !== "string" ? ack() : refuse("branch_unavailable", "The saved version could not be confirmed. Reopen the conversation.");
        }
        case "continueBranchAsNewChat": {
          const sourcePage = action.value.sourceConversationId;
          const throughId = action.value.throughMessageId;
          if (typeof sourcePage !== "string" || !sourcePage ||
              typeof throughId !== "string" || !throughId || throughId.length > 512 ||
              !wireUuid.test(pageConversationId) || conversationId !== pageConversationId)
            return refuse("invalid_argument", "Choose a completed reply and a new conversation.");
          const owner = ctx.account()?.id, identity = ctx.sessionIdentity?.();
          const current = () => !!owner && identity != null &&
            ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity && ctx.isCurrent?.() !== false;
          const source = resolveConversationId(sourcePage);
          if (!current() || source.toLowerCase() === pageConversationId.toLowerCase())
            return refuse("invalid_argument", "The source or new conversation changed. Reopen the source chat.");
          // Never borrow a message from the destination or silently fork the latest reply.
          const through = messageRef(source, throughId);
          if (!through || through.kind !== "assistant")
            return refuse("not_found", "Choose a completed assistant reply in the source conversation.");
          const sourceConversation = await ctx.loadConversation(source);
          if (!current() || sourceConversation?.mode !== "chat" || sourceConversation.incognito)
            return refuse("not_found", "The source conversation is no longer available.");
          const branches = through.active ? [] : (sourceConversation.savedBranches ?? []).filter(branch => branch.id === through.branchId);
          if (!through.active && branches.length !== 1)
            return refuse("branch_unavailable", "That saved branch could not be resolved. Reopen the conversation.");
          const target = (through.active ? sourceConversation.turns : branches[0].turns).find(turn => turn.id === through.turnId);
          if (!target || target.status !== "completed")
            return refuse("branch_unavailable", "That completed reply is no longer available on the source branch.");
          let fork: Conversation | undefined;
          try {
            fork = (await ctx.call("forkConversation", source, {
              conversationId: pageConversationId,
              turnId: through.turnId,
              ...(!through.active ? { branchId: through.branchId } : {}),
            })) as Conversation | undefined;
          } catch {
            return refuse("fork_unconfirmed", "The new chat could not be confirmed. Check your chats before retrying.");
          }
          if (!current() || fork?.id !== pageConversationId ||
              fork.forkedFrom?.conversationId !== source || fork.forkedFrom.turnId !== through.turnId)
            return refuse("fork_unconfirmed", "The new chat could not be confirmed. Check your chats before retrying.");
          return ack();
        }
        case "respondToElicitation": {
          if (!ctx.readOnly && (await ctx.chatComputerUse?.respond(conversationId, action.value))) return ack();
          const response = await ctx.chatElicitation?.respond(conversationId, action.value);
          if (response?.claimed) return response.error ? refuse(response.error.code, response.error.message) : ack();
          const refusal = await respondToCommandElicitation(ctx, conversationId, action.value);
          return refusal ? refuse(refusal.code, refusal.message) : ack();
        }
        case "refreshConversation":
        case "refreshReadState":
        case "warmTurn":
        case "reportFolderAccess":
        case "abandonInlineComparison":
        case "dismissSafetyFlag":
        case "reloadSkills":
          return ack();
        default:
          return refuse("unimplemented", `Claudex does not support the ${String(action.case)} action.`);
      }
    } catch (error) {
      return refuse("api_error", error instanceof Error ? error.message : String(error));
    }
  };
}




