import { bootstrapCompactor } from "./official-bootstrap-catalog";
import { isBootstrapRead } from "../../shared/official-bootstrap-catalog";
import { officialDesignArtifactKind } from "../../shared/official-design-artifacts";
import { officialOrganizationProjectTarget } from "../../shared/official-project-organizations";
import { officialDirectorySubmissionTarget } from "../../shared/official-directory-submissions";
import { isOfficialDesignCreateRetry, isOfficialResearchStop, officialSpendLimitActionOrganization } from "../../shared/official-ui-web";
import { supportedResearchMode } from "../../electron/official-ui/api/research-projection";
import { officialReplyFeedbackTarget } from "../../shared/official-reply-feedback";
import { parseOfficialConnectorPreference, parseOfficialToolPreferences, type OfficialToolPreferences } from "../../shared/official-connector-preferences";
import { withNativeCompletionAttachments } from "../../electron/official-ui/api/native-completion-attachments";
import { officialSideQuestionAction } from "../../shared/official-side-question";
import { officialMelangePrivacyRoute, officialMelangeRoute } from "../../shared/official-melange";
import { validOfficialInline } from "./official-ui-excerpt";
import { officialCodeUploadOrganization } from "../../shared/official-code-followup";
import { isOfficialCodeHistoryPath } from "../../shared/official-code-history";
import { codeTriggerOperationAllowed, isOfficialCodeTriggerPath, isOfficialCodeTriggerRead, officialCodeTriggerRequest, type OfficialCodeTriggerRequest } from "../../shared/official-code-triggers";
import {isOfficialAppearanceAction, validAppearanceRequest} from '../../shared/official-appearance-capability';
import { officialMemoryAction } from "../../shared/official-memory-capability";
/**
 * Restricted, in-process bridge for the official Web UI. This is not wired
 * through an explicitly enabled runner route. Requests use an authenticated context and
 * its existing guarded dispatcher; no browser-provided account or filesystem
 * path is accepted. Only named, bounded mutations are enabled with actions.
 */
import { Readable, Writable } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import type http from "node:http";
import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const compressBody = promisify(gzip);
import { fromBinary, isFieldSet } from "@bufbuild/protobuf";
import { z } from "zod";
import type { AppEvent, Conversation, PublicAccount, Settings, Snapshot } from "../../shared/types";
import type { ModelCatalog } from "../../shared/model-catalog-api";
import { isOfficialUiQuery, isOfficialUiDocumentConversion, isOfficialUiFileReadPath, isOfficialUiConversationCreation, isOfficialUiProjectMove, isOfficialUiModelPreference, isOfficialUiProjectMetadataUpdate, isOfficialUiProjectCreation, isOfficialUiProjectDeletion, isOfficialUiProjectMemoryUpdate, officialUiProjectKnowledgeMutation, officialUiTransferMaxBytes, officialUiRequestLimit, officialChatMemoryMode, officialUiReadMaxBytes, officialUiRequestMaxBytes, officialUiTimelinePath, officialUiActionPath, type OfficialUiReadRequest, type OfficialUiReadResponse } from "../../shared/official-ui-web";
import { effortOf } from "../../electron/official-ui/api/model-selection-preferences";
import { createApiAdapter } from "../../electron/official-ui/api/index";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { guardCall, type GuardOptions } from "./method-guard";
import { registryFor } from "../../electron/official-ui/api/timeline";
import { finishOfficialAction, readOfficialAction, reserveOfficialAction } from "./official-ui-receipts";
import { officialChatElicitationResult, officialUiIncognitoDiscardTarget, officialChatLeafTarget, officialUiConversationMutation, isOfficialUiCompletionSubmission, isOfficialUiRetrySubmission, isOfficialUiArtifactPublication } from "../../shared/official-ui-web";
import { isOfficialUiConversationSharingMutation } from "../../shared/official-ui-web";
import { isOfficialSkillCreation, isOfficialSkillDeletion, isOfficialSkillToggle, officialSkillCopyRenameMethod, officialSkillUploadKind } from "../../shared/official-ui-web";
import { validateOfficialConversationMutation } from "./official-ui-conversation-mutation";
import { resolveConversationId } from "../../electron/official-ui/api/conversations";
import { currentAdapterScope } from "../../electron/official-ui/api/scope";
import { isOfficialUiLargeResponse } from "../../shared/official-ui-web";
import { officialChatUploadOrganization, isOfficialUiChatBulkDelete, officialCustomConnectorTarget, officialConnectorLifecycleTarget, type OfficialConnectorLifecycleTarget } from "../../shared/official-ui-web";

import { officialOrganizationPluginMutation } from "../../shared/official-plugin-organizations";
import type { AdapterContext } from "../../electron/official-ui/api/context";

export interface RunnerOfficialHost {
  designArtifacts?: AdapterContext["designArtifacts"];
  organizationProjects?: AdapterContext["organizationProjects"];
  organizationPlugins?: Pick<AdapterContext, "readPluginOrganization" | "readOrganizationPluginStates" |
    "readOrganizationPluginDetails" | "setOrganizationPluginEnabled" | "removeOrganizationPlugin">;
  webSearchAllowed?(): boolean;
  readonly allowDirectorySubmissions?: boolean;
  readonly directoryTermsUrl?: string;
  readonly spendLimitMutation?: import("../../electron/official-ui/api/context").AdapterContext["spendLimitMutation"];
  readonly allowCompletionConnectorMetadata?: boolean;
  remoteConnectorSkills?: import("../../electron/official-ui/api/context").AdapterContext["remoteConnectorSkills"];
  knowledgeOffer?: import("../../electron/official-ui/api/context").AdapterContext["knowledgeOffer"];
  chatPermissionModes?: import("../../electron/official-ui/api/context").AdapterContext["chatPermissionModes"];
  chatElicitation?: import("../../electron/official-ui/api/context").AdapterContext["chatElicitation"];
  isIncognitoConversation?(id: string): boolean;
  documentRuntime?: string;
  readonly officialCodeTerminalAvailable?: boolean;
  readonly officialCodeWorkspaceDiffAvailable?: boolean;
  readonly officialCodeRewindAvailable?: boolean;
  readonly officialCodeSettingsAvailable?: boolean;
  codeUltracodeAvailable?: import("../../electron/official-ui/api/context").AdapterContext["codeUltracodeAvailable"];
  officialCodeRoutineFireUrl?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeRoutineFireUrl"];
  officialCodeWorkspaceDirectory?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeWorkspaceDirectory"];
  officialCodeApprovals?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeApprovals"];
  officialCodeStopPersistence?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeStopPersistence"];
  officialCodeHeldInputs?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeHeldInputs"];
  officialCodeQueueInputs?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeQueueInputs"];
  officialCodeCommands?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeCommands"];
  officialCodeAgentHistory?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeAgentHistory"];
  image?: import("../../electron/official-ui/api/context").AdapterContext["image"];
  officialCodeCommandControls?: import("../../electron/official-ui/api/context").AdapterContext["officialCodeCommandControls"];
  officialCoworkApprovalControls?: import("../../electron/official-ui/api/context").AdapterContext["officialCoworkApprovalControls"];
  melange?: import("../../electron/official-ui/api/context").AdapterContext["melange"];
  classicMelangeSources?: import("../../electron/official-ui/api/context").AdapterContext["classicMelangeSources"];
  melangeSignal?: import("../../electron/official-ui/api/context").AdapterContext["melangeSignal"];
  sideQuestionGateway?: import("../../electron/official-ui/api/context").AdapterContext["sideQuestionGateway"];
  artifactPublishing?: import("../../electron/official-ui/api/context").AdapterContext["artifactPublishing"];
  richQuoteActions?: boolean;
  readModelPreference?: import("../../electron/official-ui/api/context").AdapterContext["readModelPreference"];
  saveModelPreference?: import("../../electron/official-ui/api/context").AdapterContext["saveModelPreference"];
  allowProjectKnowledgeChanges?: boolean;
  readonly allowSkillCreation?: boolean;
  readonly allowSkillVersionSave?: boolean;
  readonly allowSkillUpload?: boolean;
  readonly allowSkillDelete?: boolean;
  readonly allowSkillToggle?: boolean;
  readonly allowSkillCopyRename?: boolean;
  createProject?: import("../../electron/official-ui/api/context").AdapterContext["createProject"];
  deleteProject?: import("../../electron/official-ui/api/context").AdapterContext["deleteProject"];
  createEmptyChat?: import("../../electron/official-ui/api/context").AdapterContext["createEmptyChat"];
  updateProjectMetadata?: import("../../electron/official-ui/api/context").AdapterContext["updateProjectMetadata"];
  authorizeProjectMemoryUpdate?: import("../../electron/official-ui/api/context").AdapterContext["authorizeProjectMemoryUpdate"];
  saveAppearanceLocale?: import("../../electron/official-ui/api/context").AdapterContext["saveAppearanceLocale"];
  saveAppearanceFont?: import("../../electron/official-ui/api/context").AdapterContext["saveAppearanceFont"];
  authorizeConnectorPreferences?: import("../../electron/official-ui/api/context").AdapterContext["authorizeConnectorPreferences"];
  authorizeCustomConnector?: import("../../electron/official-ui/api/context").AdapterContext["authorizeCustomConnector"];
  readonly allowCustomConnectorCreation?: boolean;
  authorizeConnectorLifecycle?: import("../../electron/official-ui/api/context").AdapterContext["authorizeConnectorLifecycle"];
  connectorAuthPromptAvailable?: import("../../electron/official-ui/api/context").AdapterContext["connectorAuthPromptAvailable"];
  connectorAlwaysAllow?: import("../../electron/official-ui/api/context").AdapterContext["connectorAlwaysAllow"];
  authorizeAppearanceSettings?: import("../../electron/official-ui/api/context").AdapterContext["authorizeAppearanceSettings"];
  authorizeMemoryAction?: import("../../electron/official-ui/api/context").AdapterContext["authorizeMemoryAction"];
  memoryResetAvailable?: import("../../electron/official-ui/api/context").AdapterContext["memoryResetAvailable"];
  memoryGenerationAvailable?: import("../../electron/official-ui/api/context").AdapterContext["memoryGenerationAvailable"];
  memoryPreferenceActions?: import("../../electron/official-ui/api/context").AdapterContext["memoryPreferenceActions"];
  readMemorySettings?: import("../../electron/official-ui/api/context").AdapterContext["readMemorySettings"];
  prepareCompletionAttachments?: import("../../electron/official-ui/api/context").AdapterContext["prepareCompletionAttachments"];
  submitCompletionWithAttachments?: import("../../electron/official-ui/api/context").AdapterContext["submitCompletionWithAttachments"];
  account(): PublicAccount | undefined;
  settings(): Settings;
  isCurrent?(): boolean;
  readSnapshot?(): Snapshot | undefined;
  historyInventory?(): {
    list: NonNullable<AdapterContext["conversationInventory"]>;
    load: AdapterContext["loadConversation"];
  } | undefined;
  /** Stable only for one authenticated activation. */
  sessionIdentity(): unknown;
  stateDirectory(): string;
  ratings?(): Record<string, "up" | "down">;
  onEvent(listener: (event: AppEvent) => void): () => void;
  appVersion: string;
  log(...args: unknown[]): void;
}

/** Must invoke the existing Dispatcher.run for the already authenticated user. */
export type GuardedRunnerCall = (method: string, args: unknown[]) => Promise<unknown>;

const uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const retryInputMode = 2;
const androidPlatform = 4;
const stopIntent = 1;
const sendFields = ["messageId", "assistantMessageId", "text", "model", "timezone", "locale", "clientPlatform", "settingsUpdate", "parentMessageId", "chatMemoryMode", "projectId", "isTemporary", "quotes", "inlineAttachments", "attachments", "hiddenContext"];
const retryFields = ["assistantMessageId", "parentMessageId", "inputMode", "model", "timezone", "locale", "clientPlatform", "chatMemoryMode"];
const chatMemoryModes = new Set(Object.values(officialChatMemoryMode));
const chatToolSearchModes = new Set([0, 1, 2, 3]);

class OfficialUiReadLimitError extends Error {}

class CapturedResponse extends Writable {
  constructor(private readonly limit = officialUiReadMaxBytes) { super(); }
  statusCode = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  bytes = 0;
  onChunk?: () => void;
  writeHead(status: number, headers: Record<string, string> = {}) { this.statusCode = status; this.headers = headers; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return callback(new OfficialUiReadLimitError("The official Web response is too large."));
    this.chunks.push(Buffer.from(chunk)); this.onChunk?.(); callback();
  }
}

export function createRunnerOfficialAdapter(host: RunnerOfficialHost, dispatch: GuardedRunnerCall, root: string, guard: GuardOptions, options: { allowTextActions?: boolean; allowChatArtifactReview?: boolean; allowConversationProjectMove?: boolean; allowMemoryControls?: boolean; allowAppearanceSettings?: boolean; isChatBulkDeleteCurrent?: (lease: string) => boolean } = {}) {
  type ConnectorChoices = { pageId: string; tools: OfficialToolPreferences };
  type MetadataWrite = { conversationId: string; patch: { title: string } | { pinned: boolean } | { archived: boolean } };
  const actionLease = new AsyncLocalStorage<{ current: () => boolean; metadataWrite?: MetadataWrite; feedbackConversation?: string; connectorChoices?: ConnectorChoices; customConnector?: "add" | "probe"; connectorLifecycle?: OfficialConnectorLifecycleTarget; triggerKind?: OfficialCodeTriggerRequest["kind"]; chatLeaf?: boolean; chatForkSource?: string; chatForkDestination?: string; skillUpload?: boolean; chatRootEdit?: boolean; chatBulkDelete?: boolean; incognitoDiscard?: string; incognitoDraft?: string }>();
  const triggerWrites = new Set<unknown>();
  const call = async (method: string, ...args: unknown[]) => {
    const scope = currentAdapterScope();
    const assertCurrent = () => {
      if (scope.owner !== host.account()?.id || scope.sessionIdentity !== host.sessionIdentity() || host.isCurrent?.() === false || actionLease.getStore()?.current() === false)
        throw Error("The account changed during this request.");
    };
    assertCurrent();
    const discardTarget = actionLease.getStore()?.incognitoDiscard;
    if (method === "discardIncognito" && (!discardTarget || args[0] !== resolveConversationId(discardTarget) ||
        (actionLease.getStore()?.incognitoDraft ? args.length !== 2 || args[1] !== actionLease.getStore()?.incognitoDraft : args.length !== 1)))
      throw Error("The temporary conversation changed.");
    const metadataWrite = actionLease.getStore()?.metadataWrite;
    if (metadataWrite && method !== "snapshot" && (method !== "updateConversation" ||
        args.length !== 2 || args[0] !== metadataWrite.conversationId ||
        JSON.stringify(args[1]) !== JSON.stringify(metadataWrite.patch)))
      throw Error("The conversation metadata request changed.");
    const feedbackConversation = actionLease.getStore()?.feedbackConversation;
    if (feedbackConversation && !(
      method === "snapshot" && args.length === 0 ||
      method === "conversationTurns" && args.length === 1 && args[0] === feedbackConversation ||
      method === "setReplyFeedback" && args.length === 4 && args[0] === feedbackConversation && JSON.stringify(args[3]) === '{"localOnly":true}' ||
      method === "submitReplyFeedback" && args.length === 1 && !!args[0] && typeof args[0] === "object" && (args[0] as { conversationId?: unknown }).conversationId === feedbackConversation
    )) throw Error("The feedback request changed.");
    // Accounting has an exact read-only REST route and account-bound service handlers.
    const triggerKind = actionLease.getStore()?.triggerKind;
    const triggerOperation = triggerKind && codeTriggerOperationAllowed(triggerKind, method);
    const chatLeaf = method === "selectChatLeaf" && actionLease.getStore()?.chatLeaf === true;
    const chatForkScope = actionLease.getStore();
    const chatFork = method === "forkConversation" && !!chatForkScope?.chatForkSource &&
      resolveConversationId(chatForkScope.chatForkSource) === args[0] &&
      !!args[1] && typeof args[1] === "object" &&
      (args[1] as { conversationId?: unknown }).conversationId === chatForkScope.chatForkDestination;
    const lifecycle = actionLease.getStore()?.connectorLifecycle;
    if (lifecycle) {
      if (args.length !== 1 || typeof args[0] !== "string" ||
          method !== (lifecycle.kind === "refresh" ? "refreshConnectorTools" : "removeConnector"))
        throw Error("The connector lifecycle request changed.");
      host.authorizeConnectorLifecycle?.(lifecycle, args[0]);
    }
    if (!(lifecycle?.kind === "refresh") && !chatLeaf && !chatFork && !(method === "probeConnector" && actionLease.getStore()?.customConnector === "probe") && !["usageOverview", "usageBreakdown", "usageRecords"].includes(method) &&
        !(triggerOperation && (method === "officialCodeRoutineRun" || method === "officialCodeRoutineCancel")))
      guardCall(method, method === "installSkillFiles" && actionLease.getStore()?.skillUpload ? args.slice(0, 1) : args, guard);
    const result = await dispatch(method, args);
    assertCurrent();
    return result;
  };
  const snapshot = async () => host.readSnapshot?.() ?? await call("snapshot") as Snapshot;
  let engineRest: ReturnType<typeof withNativeCompletionAttachments>;
  const context = {
    documentRuntime: host.documentRuntime,
    get melange() { return options.allowTextActions && guard.modes.includes("chat") ? host.melange : undefined; },
    get classicMelangeSources() { return options.allowTextActions ? host.classicMelangeSources : undefined; },
    melangeSignal: host.melangeSignal,
    get allowCompletionConnectorMetadata() {
      return options.allowTextActions === true && host.allowCompletionConnectorMetadata === true;
    },
    get remoteConnectorSkills() {
      return options.allowTextActions && guard.modes.some((mode) => mode === "chat" || mode === "cowork")
        ? host.remoteConnectorSkills : undefined;
    },
    knowledgeOffer: host.knowledgeOffer,
    get chatElicitation() { return options.allowTextActions ? host.chatElicitation : undefined; },
    get chatPermissionModes() { return options.allowTextActions ? host.chatPermissionModes : undefined; },
    get sideQuestionGateway() { return options.allowTextActions && host.richQuoteActions === true ? host.sideQuestionGateway : undefined; },
    get allowProjectKnowledgeChanges() { return options.allowTextActions === true && host.allowProjectKnowledgeChanges === true; },
    get allowSkillCreation() { return options.allowTextActions === true && host.allowSkillCreation === true; },
    get allowSkillVersionSave() { return options.allowTextActions === true && host.allowSkillVersionSave === true; },
    get allowSkillUpload() { return options.allowTextActions === true && host.allowSkillUpload === true; },
    get allowSkillDelete() { return options.allowTextActions === true && host.allowSkillDelete === true; },
    get allowSkillToggle() { return options.allowTextActions === true && host.allowSkillToggle === true; },
    get allowSkillCopyRename() { return options.allowTextActions === true && host.allowSkillCopyRename === true; },
    get createProject() { return options.allowTextActions ? host.createProject : undefined; },
    get deleteProject() { return options.allowTextActions ? host.deleteProject : undefined; },
    get createEmptyChat() { return options.allowTextActions ? host.createEmptyChat : undefined; },
    get designArtifacts() { return options.allowTextActions ? host.designArtifacts : undefined; },
    get allowArtifactPublishing() { return options.allowChatArtifactReview === true; },
    get allowConversationSharing() { return options.allowTextActions === true && options.allowChatArtifactReview === true; },
    artifactPublishing: host.artifactPublishing,
    get allowChatArtifactReview() { return options.allowChatArtifactReview === true; },
    get allowConversationProjectMove() { return options.allowConversationProjectMove === true; },
    get updateProjectMetadata() { return options.allowTextActions ? host.updateProjectMetadata : undefined; },
    get authorizeProjectMemoryUpdate() { return options.allowTextActions ? host.authorizeProjectMemoryUpdate : undefined; },
    readModelPreference: host.readModelPreference,
    saveModelPreference: host.saveModelPreference,
    authorizeMemoryAction: host.authorizeMemoryAction,
    memoryResetAvailable: host.memoryResetAvailable,
    memoryGenerationAvailable: host.memoryGenerationAvailable,
    memoryPreferenceActions: host.memoryPreferenceActions,
    readMemorySettings: host.readMemorySettings,
    authorizeAppearanceSettings: host.authorizeAppearanceSettings,
    authorizeCustomConnector: host.authorizeCustomConnector,
    authorizeConnectorLifecycle: host.authorizeConnectorLifecycle,
    connectorAlwaysAllow: host.connectorAlwaysAllow,
    get directoryTermsUrl() { return host.directoryTermsUrl; },
    get allowDirectorySubmissions() { return options.allowTextActions === true && host.allowDirectorySubmissions === true; },
    get allowCustomConnectorCreation() { return options.allowTextActions === true && host.allowCustomConnectorCreation === true; },
    authorizeConnectorPreferences(kind: "account" | "chat", pageId?: string) {
      const lease = actionLease.getStore();
      if (!host.authorizeConnectorPreferences || lease &&
          (kind !== "chat" || lease.connectorChoices?.pageId !== pageId || !lease.current()))
        throw Error("The connector settings request changed.");
      host.authorizeConnectorPreferences(kind, pageId);
    },
    chatConnectorChoicesForAction(pageId: string) {
      const choices = actionLease.getStore()?.connectorChoices;
      return choices?.pageId === pageId ? choices.tools : undefined;
    },
    saveAppearanceFont: host.saveAppearanceFont,
    saveAppearanceLocale: host.saveAppearanceLocale,
    root, readOnly: true, strictActionSemantics: true,
    ...host.organizationPlugins,
    get organizationProjects() { return host.organizationProjects; },
    webSearchAllowed: host.webSearchAllowed,
    get spendLimitMutation() { return host.spendLimitMutation; },
    get allowIncognitoDiscard() { return !!actionLease.getStore()?.incognitoDiscard; },
    get allowChatBulkDelete() { return actionLease.getStore()?.chatBulkDelete === true; },
    get allowChatRetry() { return options.allowTextActions === true && guard.modes.includes("chat"); },
    get allowChatRootEdit() { return actionLease.getStore()?.chatRootEdit === true; },
    get allowChatLeafSelection() { return actionLease.getStore()?.chatLeaf === true; },
    isCurrent: () => {
      const scope = currentAdapterScope();
      return scope.owner === host.account()?.id && scope.sessionIdentity === host.sessionIdentity() &&
        host.isCurrent?.() !== false &&
        host.spendLimitMutation?.current() !== false && actionLease.getStore()?.current() !== false;
    },
    get richQuoteActions() { return options.allowTextActions === true && host.richQuoteActions === true; },
    usageSummaryProtocol: "readonly-v1" as const,
    officialCodeHistory: guard.modes.includes("code"),
    get officialCodeSettingsAvailable() { return host.officialCodeSettingsAvailable; },
    codeUltracodeAvailable: host.codeUltracodeAvailable,
    officialCodeTriggerModes: guard.modes.filter((mode): mode is "code" | "cowork" => mode === "code" || mode === "cowork"),
    get officialCodeTriggerWrites() { return options.allowTextActions === true && guard.modes.includes("code"); },
    officialCodeRoutineFireUrl: host.officialCodeRoutineFireUrl,
    get officialCodeRewindAvailable() { return options.allowTextActions === true && guard.modes.includes("code") && host.officialCodeRewindAvailable === true; },
    get officialCodeTerminalAvailable() { return options.allowTextActions === true && host.officialCodeTerminalAvailable === true; },
    get officialCodeWorkspaceDiffAvailable() { return options.allowTextActions === true && guard.modes.includes("code") && host.officialCodeWorkspaceDiffAvailable === true; },
    get officialCodeWorkspaceDirectory() { return options.allowTextActions && guard.modes.includes("code") ? host.officialCodeWorkspaceDirectory : undefined; },
    officialCodeApprovals: host.officialCodeApprovals,
    officialCodeStopPersistence: host.officialCodeStopPersistence,
    officialCodeHeldInputs: host.officialCodeHeldInputs,
    officialCodeQueueInputs: host.officialCodeQueueInputs,
    officialCodeCommands: host.officialCodeCommands,
    officialCodeAgentHistory: host.officialCodeAgentHistory,
    officialCodeCommandControls: host.officialCodeCommandControls,
    officialCoworkApprovalControls: host.officialCoworkApprovalControls,
    officialCoworkHistory: guard.modes.includes("cowork"),
    get officialCoworkFollowupAvailable() { return options.allowTextActions === true && host.richQuoteActions === true && guard.modes.includes("cowork"); },
    get officialCodeUpload() { return options.allowTextActions === true && guard.modes.includes("code"); },
    get officialChatUpload() { return options.allowTextActions === true && host.richQuoteActions === true && (guard.modes.includes("chat") || guard.modes.includes("cowork")); },
    get image() { return host.image; },
    generatedFileReadMaxBytes: officialUiReadMaxBytes,
    account: () => host.account(), settings: () => host.settings(), sessionIdentity: () => host.sessionIdentity(),
    stateDirectory: () => host.stateDirectory(), onEvent: (listener: (event: AppEvent) => void) => host.onEvent(listener),
    get connectorAuthPromptAvailable() { return options.allowTextActions ? host.connectorAuthPromptAvailable : undefined; },
    appVersion: host.appVersion, log: (...args: unknown[]) => host.log(...args),
    call, snapshot,
    ratings: () => host.ratings?.() ?? {},
    get prepareCompletionAttachments() {
      if (!options.allowTextActions || host.richQuoteActions !== true) return host.prepareCompletionAttachments;
      return engineRest.prepareCompletionAttachments;
    },
    get submitCompletionWithAttachments() {
      return options.allowTextActions && host.richQuoteActions === true ? engineRest.submitCompletionWithAttachments : host.submitCompletionWithAttachments;
    },
    listConversations: async () => (await snapshot()).conversations,
    conversationInventory: () => host.historyInventory?.()?.list(),
    loadConversation: async (id: string) => {
      const history = host.historyInventory?.();
      if (history) return history.load(id);
      const c = (await snapshot()).conversations.find((row) => row.id === id);
      if (!c) return undefined;
      const full = await call("conversationTurns", id) as Pick<Conversation, "turns" | "savedBranches">;
      return { ...c, turns: full.turns, savedBranches: full.savedBranches ?? c.savedBranches };
    },
    modelCatalog: async () => await call("modelCatalog") as ModelCatalog | null,
  };
  engineRest=withNativeCompletionAttachments(new Proxy(context,{
    get(target,key,receiver){
      if(key==="readOnly")return false;
      if(key==="prepareCompletionAttachments" || key==="submitCompletionWithAttachments")return undefined;
      return Reflect.get(target,key,receiver);
    },
  }));
  let timelineVersion = 0;
  type ActionReplay = { hash: string; answer: Promise<OfficialUiReadResponse> };
  const inFlightActions = new Map<string, ActionReplay>();
  const temporaryActionReceipts = new Map<string, ActionReplay>();
  const temporaryConversations = new Set<string>();
  let receiptIdentity: unknown = host.sessionIdentity();
  let receiptOwner: string | undefined, receiptRoot: string | undefined;
  const compactBootstrap = bootstrapCompactor(root);
  const adapter = createApiAdapter(context, { scoped: true, migrateLegacy: false, restCompletion: true,
    timelineWaitMs: options.allowTextActions ? undefined : 0, nextTimelineVersion: () => String(++timelineVersion) });
  const run = async (request: OfficialUiReadRequest, stream?: (run: (response: http.ServerResponse) => Promise<boolean>) => Promise<OfficialUiReadResponse>): Promise<OfficialUiReadResponse> => {
    if (!host.account()) return { status: 401, contentType: "application/json", body: Buffer.from('{"error":"Sign in to continue."}') };
    if (!request.path.startsWith("/") || request.path.startsWith("//"))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid path."}') };
    let url: URL;
    try { url = new URL(request.path, "http://localhost"); }
    catch { return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid path."}') }; }
    const designCreation = officialDesignArtifactKind(request.method, request.path) === "create";
    const trigger = officialCodeTriggerRequest(request.method, url.pathname, url.search);
    const triggerWrite = trigger && !isOfficialCodeTriggerRead(trigger) && context.officialCodeTriggerWrites;
    if (request.codeOrganizationId !== undefined && (!(isOfficialCodeHistoryPath(url.pathname) || isOfficialCodeTriggerPath(url.pathname)) ||
        typeof request.codeOrganizationId !== "string" || !new RegExp(`^${uuid}$`).test(request.codeOrganizationId)))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid Code organization."}') };
    const codeUpload = context.officialCodeUpload && officialCodeUploadOrganization(request.method, request.path);
    const chatUpload = context.officialChatUpload && officialChatUploadOrganization(request.method, request.path);
    const modelPreference = options.allowTextActions && !url.search && isOfficialUiModelPreference(request.method, url.pathname);
    let connector;
    try { connector = parseOfficialConnectorPreference(request); }
    catch { return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid connector settings request."}') }; }
    if (connector && (!options.allowTextActions || !host.authorizeConnectorPreferences))
      return { status: 403, contentType: "application/json", body: Buffer.from('{"error":"Connector settings are unavailable."}') };
    const customConnector = officialCustomConnectorTarget(request.method, request.path);
    if (customConnector && (!context.allowCustomConnectorCreation || !host.authorizeCustomConnector))
      return { status: 403, contentType: "application/json", body: Buffer.from('{"error":"Custom connector creation is unavailable."}') };
    const connectorLifecycle = officialConnectorLifecycleTarget(request.method, request.path);
    if (connectorLifecycle && (!options.allowTextActions || !host.authorizeConnectorLifecycle))
      return { status: 403, contentType: "application/json", body: Buffer.from('{"error":"Connector changes are unavailable."}') };
    if (connectorLifecycle && request.body?.byteLength)
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Connector lifecycle requests do not accept a body."}') };
    const appearance = !connector && options.allowAppearanceSettings && !url.search && isOfficialAppearanceAction(request.method,url.pathname);
    if(appearance){
      try{if(!(request.body instanceof Uint8Array)||request.body.length>1024||!/^application\/json(?:\s*;.*)?$/i.test(request.contentType??"")||!validAppearanceRequest(request.method,url.pathname,JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(request.body))))throw Error();}
      catch{return {status:400,contentType:"application/json",body:Buffer.from('{"error":"Invalid appearance settings request."}')};}
    }
    const memoryAction = officialMemoryAction(request.method, request.path);
    const memory = host.authorizeMemoryAction &&
      (memoryAction === "controls" ? options.allowMemoryControls : memoryAction && options.allowTextActions);
    const bodylessMemoryReset = memory && memoryAction === "reset" && !request.body?.byteLength;
    const melange = options.allowTextActions ? officialMelangeRoute(request.method, url.pathname, url.search) : undefined;
    const privacy = context.melange && officialMelangePrivacyRoute(request.method, url.pathname, url.search);
    if (melange?.operation === "edit" && !stream)
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Use the Web memory edit stream."}') };
    const sideQuestion = options.allowTextActions && !url.search && officialSideQuestionAction(request.method,url.pathname);
    const directorySubmission = context.allowDirectorySubmissions &&
      officialDirectorySubmissionTarget(request.method, request.path);
    const action = options.allowTextActions && request.method === "POST" && url.pathname === officialUiActionPath && !url.search;
    const spendLimitWrite = !!context.spendLimitMutation?.save &&
      !!officialSpendLimitActionOrganization(request.method, request.path);
    const chatElicitationResult = options.allowTextActions && guard.modes.includes("chat") && !url.search && !!host.chatElicitation && officialChatElicitationResult(request.method, url.pathname);
    const restFeedback = options.allowTextActions && guard.modes.includes("chat") && !url.search && officialReplyFeedbackTarget(request.method, url.pathname);
    const leaf = options.allowTextActions && guard.modes.includes("chat") && !url.search &&
      !!officialChatLeafTarget(request.method, url.pathname);
    const completion = options.allowTextActions && !url.search && (
      isOfficialUiCompletionSubmission(request.method, url.pathname) ||
      context.allowChatRetry && isOfficialUiRetrySubmission(request.method, url.pathname));
    const incognitoDiscard = options.allowTextActions && guard.modes.includes("chat") && officialUiIncognitoDiscardTarget(request.method, request.path);
    const chatBulkDelete = options.allowTextActions && guard.modes.includes("chat") && !!request.capabilityLease && !!options.isChatBulkDeleteCurrent?.(request.capabilityLease) && isOfficialUiChatBulkDelete(request.method, request.path);
    const createChat = options.allowTextActions && !url.search && isOfficialUiConversationCreation(request.method, url.pathname);
    const documentConversion = isOfficialUiDocumentConversion(request.method, request.path);
    const projectKnowledge = options.allowTextActions && host.allowProjectKnowledgeChanges && !url.search && officialUiProjectKnowledgeMutation(request.method, url.pathname);
    const projectMove = options.allowConversationProjectMove && !url.search && isOfficialUiProjectMove(request.method, url.pathname);
    const createProject = options.allowTextActions && !url.search && isOfficialUiProjectCreation(request.method, url.pathname);
    const createSkill = isOfficialSkillCreation(request.method, request.path) && context.allowSkillCreation;
    const skillUploadRoute = officialSkillUploadKind(request.method, request.path);
    const skillUpload = !!skillUploadRoute && (context.allowSkillUpload || skillUploadRoute === "legacy" && context.allowSkillVersionSave);
    const skillDelete = isOfficialSkillDeletion(request.method, request.path) && context.allowSkillDelete;
    const skillToggle = isOfficialSkillToggle(request.method, request.path) && context.allowSkillToggle;
    const skillChange = skillDelete || skillToggle || !!officialSkillCopyRenameMethod(request.method, request.path) && context.allowSkillCopyRename;
    const deleteProject = context.deleteProject && isOfficialUiProjectDeletion(request.method, request.path);
    const projectMetadata = options.allowTextActions && !url.search && isOfficialUiProjectMetadataUpdate(request.method, url.pathname);
    const projectMemory = context.authorizeProjectMemoryUpdate && isOfficialUiProjectMemoryUpdate(request.method, request.path);
    const publication = options.allowChatArtifactReview && !url.search && isOfficialUiArtifactPublication(request.method, url.pathname);
    const sharing = context.allowConversationSharing && !url.search && isOfficialUiConversationSharingMutation(request.method, url.pathname);
    const researchStop = options.allowTextActions && guard.modes.includes("chat") && !url.search && isOfficialResearchStop(request.method, url.pathname);
    const mutation = !connector && options.allowTextActions && officialUiConversationMutation(request.method, url.pathname + url.search);
    const pluginMutation = options.allowTextActions && host.organizationPlugins && officialOrganizationPluginMutation(request.method, request.path);
    const organizationProject = officialOrganizationProjectTarget(request.method, url.pathname);
    const organizationProjectWrite = options.allowTextActions && host.organizationProjects && request.method !== "GET" &&
      organizationProject && "organization" in organizationProject &&
      organizationProject.organization !== organizationUuid(host.account()?.id ?? "") && !url.search;
    if (url.origin !== "http://localhost" || isOfficialUiFileReadPath(url.pathname) && !!url.search || !isOfficialUiQuery(request.method, url.pathname, url.search) && !action && !chatElicitationResult && !researchStop && !restFeedback && !leaf && !sideQuestion && !melange && !privacy && !connector && !customConnector && !connectorLifecycle && !mutation && !completion && !chatBulkDelete && !incognitoDiscard && !designCreation && !createChat && !createProject && !createSkill && !skillUpload && !skillChange && !deleteProject && !projectKnowledge && !projectMove && !projectMetadata && !projectMemory && !memory && !appearance && !modelPreference && !codeUpload && !chatUpload && !publication && !sharing && !triggerWrite && !spendLimitWrite && !directorySubmission && !pluginMutation && !organizationProjectWrite)
      return { status: 501, contentType: "application/json", body: Buffer.from('{"error":"This official Web request is not supported yet."}') };
    if (publication && request.method === "POST" && (!(request.body instanceof Uint8Array) || request.body.byteLength > officialUiRequestLimit(request.method, url.pathname) || !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")))
      return {status:400,contentType:"application/json",body:Buffer.from('{"error":"Invalid publication request."}')};
    if (modelPreference && (!(request.body instanceof Uint8Array) || request.body.byteLength > 4096 || !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")))
      return {status:400,contentType:"application/json",body:Buffer.from('{"error":"Invalid model preference request."}')};
    if (skillChange && !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? ""))
      return { status: 400, contentType: "application/json", body: Buffer.from(JSON.stringify({
        error: skillToggle ? "Invalid skill toggle request." : "Invalid skill change request.",
      })) };
    if (customConnector && !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? ""))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Custom connector requests require JSON."}') };
    if (projectMove && (!(request.body instanceof Uint8Array) || request.body.byteLength > officialUiRequestLimit(request.method, url.pathname) || !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid project move."}') };
    if (memory && ((!bodylessMemoryReset && !(request.body instanceof Uint8Array)) ||
        (request.body?.byteLength ?? 0) > officialUiRequestMaxBytes ||
        ((!bodylessMemoryReset || request.contentType) && !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? ""))))
      return {status:400,contentType:"application/json",body:Buffer.from('{"error":"Invalid memory request."}')};
    if (leaf && (!(request.body instanceof Uint8Array) ||
        request.body.byteLength > 4096 || !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "")))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid version selection request."}') };
    if (mutation && !validateOfficialConversationMutation(request))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid conversation mutation."}') };
    if (request.method === "GET" && (request.body !== undefined || request.contentType !== undefined))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid official Web query."}') };
    if (!directorySubmission && !mutation && !publication && !incognitoDiscard && !connectorLifecycle && !memory && privacy?.operation !== "cleanup-start" && (request.method === "POST" || projectMetadata) && (!(request.body instanceof Uint8Array) || request.body.byteLength > officialUiRequestLimit(request.method, codeUpload || skillUpload ? request.path : url.pathname) ||
        !(codeUpload || chatUpload || documentConversion || skillUpload || projectKnowledge === "upload" ? /^multipart\/form-data(?:\s*;.*)?$/i : /^application\/(?:json|proto|connect\+proto)(?:\s*;.*)?$/i).test(request.contentType ?? "")))
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid official Web query."}') };
    let incognitoDraft: string | undefined;
    if (incognitoDiscard && (request.body !== undefined || request.contentType !== undefined)) {
      try {
        if (!(request.body instanceof Uint8Array) || request.body.byteLength > 4096 ||
            !/^application\/json(?:\s*;.*)?$/i.test(request.contentType ?? "") ||
            request.body.byteLength === 0) throw Error();
        incognitoDraft = z.object({ draftId: z.string().uuid() }).strict().parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body))).draftId;
      } catch {
        return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid temporary conversation request."}') };
      }
    }
    const timeline = url.pathname === officialUiTimelinePath;
    if (timeline) {
      const body = request.body!;
      // Connect envelopes must be complete, uncompressed and bounded before
      // they reach the desktop parser. Never inflate network input here.
      if (!/^application\/connect\+proto(?:\s*;.*)?$/i.test(request.contentType ?? "") || body.length < 5 || body[0] !== 0 ||
          Buffer.from(body.buffer, body.byteOffset, body.byteLength).readUInt32BE(1) !== body.length - 5)
        return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid timeline request."}') };
    }
    let receipt: { key: string; hash: string; file: string } | undefined;
    let connectorChoices: ConnectorChoices | undefined;
    let actionCurrent = () => true;
    let temporaryAction = false;
    let temporaryReceipt: { key: string; hash: string } | undefined;
    const retiredAction = (): OfficialUiReadResponse => ({
      status: 409, contentType: "application/json", body: Buffer.from(JSON.stringify({
        error: customConnector || connectorLifecycle
          ? "The account activation changed. Reopen connectors before retrying."
          : skillUpload || skillChange
          ? "The account activation changed. Reopen the skill before retrying."
          : "The account activation changed. Check the conversation before retrying.",
      })),
    });
    if (trigger) {
      const identity = host.sessionIdentity(), owner = host.account()?.id, stateRoot = host.stateDirectory();
      actionCurrent = () => !!owner && host.account()?.id === owner && host.sessionIdentity() === identity && host.stateDirectory() === stateRoot;
    }
    if (action || chatElicitationResult || restFeedback || leaf || skillUpload || skillChange || completion || researchStop || chatBulkDelete || incognitoDiscard || customConnector || connectorLifecycle || organizationProjectWrite) {
      const identity = host.sessionIdentity(), owner = host.account()?.id, stateRoot = host.stateDirectory();
      if (identity === undefined || identity === null || identity === "" || !owner)
        return retiredAction();
      actionCurrent = () => host.account()?.id === owner && host.sessionIdentity() === identity && host.stateDirectory() === stateRoot &&
        (!chatBulkDelete || !!request.capabilityLease && options.isChatBulkDeleteCurrent?.(request.capabilityLease) === true);
      if (!actionCurrent()) return retiredAction();
      if (receiptIdentity !== identity || receiptOwner !== owner || receiptRoot !== stateRoot) {
        inFlightActions.clear(); temporaryActionReceipts.clear(); temporaryConversations.clear();
        receiptIdentity = identity; receiptOwner = owner; receiptRoot = stateRoot;
      }
    }
    let metadataWrite: MetadataWrite | undefined;
    let feedbackConversation: string | undefined = restFeedback ? resolveConversationId(restFeedback.conversationId) : undefined;
    let chatLeaf = leaf;
    let chatForkSource: string | undefined;
    let chatForkDestination: string | undefined;
    if (action) {
      const stateRoot = host.stateDirectory();
      let mutationReceipt: { key: string; hash: string } | undefined;
      try {
        if (!/^application\/proto(?:\s*;.*)?$/.test(request.contentType ?? "")) throw Error("encoding");
        const schema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.PerformActionRequest")!;
        const parsed: any = fromBinary(schema, request.body!);
        const unknown = (value: any): boolean => !!value && typeof value === "object" &&
          (Array.isArray(value.$unknown) && value.$unknown.length > 0 || Object.values(value).some((entry) => unknown(entry)));
        if (unknown(parsed) || !parsed.header || !new RegExp(`^${uuid}$`).test(parsed.header.conversationId ?? ""))
          throw Error("unsupported");
        const send = parsed.action?.case === "sendMessage" ? parsed.action.value : undefined;
        temporaryAction = !!send?.isTemporary || temporaryConversations.has(parsed.header.conversationId);
        if (send?.isTemporary) temporaryConversations.add(parsed.header.conversationId);
        if (request.body!.byteLength > 2 * 1024 * 1024 && !send?.inlineAttachments?.length)
          throw Error("unsupported");
        const mutation = parsed.header?.mutationId;
        const sendSchema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.SendMessage")!;
        const fields = send ? sendSchema.fields.filter((field) => isFieldSet(send, field)).map((field) => field.localName) : [];
        const retry = send?.inputMode === retryInputMode;
        const settings = send?.settingsUpdate?.settings;
        const settingSchema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.ConversationSettings")!;
        const updateSchema = registryFor(root).getMessage("anthropic.bard.api.v1alpha.UpdateConversationSettings")!;
        const settingFields = settings ? settingSchema.fields.filter((field) => isFieldSet(settings, field)).map((field) => field.localName) : [];
        const updateFields = send?.settingsUpdate ? updateSchema.fields.filter((field) => isFieldSet(send.settingsUpdate, field)).map((field) => field.localName) : [];
        if (process.env.CLAUDEX_RUNNER_OFFICIAL_ACTION_DIAGNOSTICS === "1") {
          host.log("[official-web] action field names", JSON.stringify(fields), "settings", JSON.stringify(settingFields),
            "settingValues", JSON.stringify({ web: settings?.enabledWebSearch, research: settings?.researchMode, toolSearch: settings?.toolSearchMode,
              mcpCount: Object.keys(settings?.enabledMcpTools?.tools ?? {}).length }),
            "hasMutation", !!mutation, "case", parsed.action?.case ?? "none");
        }
        if (parsed.action?.case === "warmTurn") {
          // The original client omits mutationId for this optional hint.
          // The native action handler acknowledges it without running its intended send.
          if (mutation) throw Error("unsupported");
        } else {
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(mutation?.sessionId ?? "") ||
              !/^[1-9][0-9]{0,19}$/.test(String(mutation?.version ?? ""))) throw Error("unsupported");
          chatLeaf = parsed.action?.case === "setCurrentLeaf" && guard.modes.includes("chat") &&
            parsed.header.existingOnly === true &&
            typeof parsed.action.value.currentLeafMessageId === "string" &&
            parsed.action.value.currentLeafMessageId.length > 0 && parsed.action.value.currentLeafMessageId.length <= 512;
          const fork = parsed.action?.case === "continueBranchAsNewChat" ? parsed.action.value : undefined;
          if (fork && guard.modes.includes("chat") && request.capabilityLease &&
              new RegExp(`^${uuid}$`).test(fork.sourceConversationId ?? "") &&
              fork.sourceConversationId !== parsed.header.conversationId &&
              typeof fork.throughMessageId === "string" && fork.throughMessageId.length > 0 && fork.throughMessageId.length <= 512)
            { chatForkSource = fork.sourceConversationId; chatForkDestination = parsed.header.conversationId; }
          const metadataAction = parsed.action?.case;
          if (guard.modes.includes("chat") && (metadataAction === "renameConversation" || metadataAction === "starConversation" || metadataAction === "archiveConversation")) {
            const patch = metadataAction === "renameConversation" ? { title: parsed.action.value.title ?? "" }
              : metadataAction === "starConversation" ? { pinned: !!parsed.action.value.starred }
              : { archived: !!parsed.action.value.archived };
            metadataWrite = { conversationId: resolveConversationId(parsed.header.conversationId), patch };
          }
          const metadata = !!metadataWrite;
          const feedback = parsed.action?.case === "messageFeedback" ? parsed.action.value : undefined;
          if (feedback && guard.modes.includes("chat") &&
              typeof feedback.messageId === "string" && feedback.messageId.length > 0 && feedback.messageId.length <= 512 &&
              (feedback.comment === undefined || typeof feedback.comment === "string" && feedback.comment.length <= 4000))
            feedbackConversation = resolveConversationId(parsed.header.conversationId);
          const stop = parsed.action?.case === "stopGeneration" ? parsed.action.value : undefined;
          const stopGeneration = stop && guard.modes.includes("chat") &&
            (stop.intent === undefined || stop.intent === stopIntent) &&
            (stop.stoppingMessageId === undefined || stop.stoppingMessageId.length <= 512);
          const modelId = parsed.action?.case === "setConversationModel" ? parsed.action.value.model?.id : undefined;
          const setChatModel = guard.modes.includes("chat") && modelId?.case === "identifier" &&
            typeof modelId.value === "string" && modelId.value.length > 0 && modelId.value.length <= 200;
          const settingsAction = parsed.action?.case === "updateConversationSettings"
            ? parsed.action.value : undefined;
          const settingsPatch = settingsAction?.settings;
          const connectorPatch = settingsPatch?.enabledMcpTools;
          const connectorUpdate = connectorPatch !== undefined && Object.keys(connectorPatch.tools).length > 0 &&
            updateSchema.fields.every((field) => field.localName === "settings" || !isFieldSet(settingsAction, field)) &&
            settingSchema.fields.every((field) => field.localName === "enabledMcpTools" || !isFieldSet(settingsPatch, field));
          const settingsUpdate = connectorUpdate || settingsPatch !== undefined && guard.modes.includes("chat") &&
            (typeof settingsPatch.enabledWebSearch === "boolean" || !!effortOf(settingsPatch.effortLevelToken) || [1, 2].includes(settingsPatch.permissionMode) || isFieldSet(settingsPatch, settingSchema.fields.find((field) => field.localName === "researchMode")!)) &&
            supportedResearchMode(settingsPatch.researchMode) &&
            (settingsPatch.permissionMode === undefined || [1, 2].includes(settingsPatch.permissionMode)) &&
            (settingsPatch.effortLevelToken === undefined || !!effortOf(settingsPatch.effortLevelToken)) &&
            settingSchema.fields.every((field) =>
              ["enabledWebSearch", "researchMode", "effortLevelToken", "permissionMode"].includes(field.localName) || !isFieldSet(settingsPatch, field));
          const stopResearch = parsed.action?.case === "stopResearchTask" && guard.modes.includes("chat") && new RegExp(`^${uuid}$`).test(parsed.action.value.taskId ?? "");
          const elicitation = parsed.action?.case === "respondToElicitation" && guard.modes.includes("chat") && !!host.chatElicitation;
          if (!chatLeaf && !chatForkSource && !metadata && !feedbackConversation && !setChatModel && !settingsUpdate && !stopGeneration && !stopResearch && !elicitation && (!send || !new RegExp(`^${uuid}$`).test(send.assistantMessageId ?? "") ||
              fields.some((name) => !(retry ? retryFields : sendFields).includes(name)) ||
              (send.projectId && !new RegExp(`^${uuid}$`).test(send.projectId)) ||
              (send.inlineAttachments?.length ?? 0) + (send.attachments?.length ?? 0) > 12 ||
              (send.attachments?.length && (!context.officialChatUpload || !request.capabilityLease ||
                send.attachments.some((item: {id?: string}) => !new RegExp(`^${uuid}$`).test(item.id ?? "")) ||
                new Set(send.attachments.map((item: {id: string}) => item.id)).size !== send.attachments.length)) ||
              (send.inlineAttachments ?? []).some((item: any) => !validOfficialInline(item)) ||
              !chatMemoryModes.has(send.chatMemoryMode) ||
              (retry
                ? (!parsed.header.existingOnly && send.clientPlatform !== androidPlatform) || !send.parentMessageId || send.parentMessageId.length > 500
                : !new RegExp(`^${uuid}$`).test(send.messageId ?? "") || typeof send.text !== "string" ||
                  (!send.text.trim() && !(send.quotes?.length || send.inlineAttachments?.length || send.attachments?.length)) ||
                  send.text.length > 200_000) ||
              updateFields.some((name) => name !== "settings") ||
              settingFields.some((name) => !["enabledWebSearch", "enabledMcpTools", "researchMode", "toolSearchMode", "effortLevelToken", "permissionMode"].includes(name)) ||
              (settings?.permissionMode !== undefined && ![1, 2].includes(settings.permissionMode)) ||
              (settings?.effortLevelToken !== undefined && !effortOf(settings.effortLevelToken)) ||
              !supportedResearchMode(settings?.researchMode) || !chatToolSearchModes.has(settings?.toolSearchMode ?? 0))) throw Error("unsupported");
          const tools = connectorUpdate ? connectorPatch.tools : settings?.enabledMcpTools?.tools;
          if (tools && Object.keys(tools).length) {
            if (!host.authorizeConnectorPreferences || !guard.modes.includes("chat")) throw Error("unsupported");
            connectorChoices = {
              pageId: parsed.header.conversationId,
              tools: parseOfficialToolPreferences(tools),
            };
          }
          if (!temporaryAction && host.isIncognitoConversation) {
            temporaryAction = host.isIncognitoConversation(resolveConversationId(parsed.header.conversationId));
          } else if (!temporaryAction && parsed.header.existingOnly) {
            const snapshot = await dispatch("snapshot", []) as Snapshot;
            if (!actionCurrent()) return retiredAction();
            temporaryAction = !!snapshot.conversations.find(c => c.id === resolveConversationId(parsed.header.conversationId))?.incognito;
          }
          mutationReceipt = {
            key: `${mutation.sessionId}:${mutation.version}`,
            hash: createHash("sha256").update(request.contentType!).update(request.body!).digest("hex"),
          };
        }
      } catch {
        return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"This official Web action is not supported."}') };
      }
      if (mutationReceipt) {
        const { key, hash } = mutationReceipt;
        const prior = inFlightActions.get(key) ?? temporaryActionReceipts.get(key);
        if (prior) {
          if (prior.hash !== hash) return { status: 409, contentType: "application/json", body: Buffer.from('{"error":"Mutation id already used."}') };
          try {
            const value = await prior.answer;
            return actionCurrent() ? value : retiredAction();
          } catch (error) {
            if (!actionCurrent()) return retiredAction();
            throw error;
          }
        }
        try {
          if (!actionCurrent()) return retiredAction();
          const reserved = temporaryAction
            ? readOfficialAction(stateRoot, key, hash)
            : reserveOfficialAction(stateRoot, key, hash);
          if (!actionCurrent()) return retiredAction();
          switch (reserved?.kind) {
            case "done": return reserved.answer;
            case "conflict": return { status: 409, contentType: "application/json", body: Buffer.from('{"error":"Mutation id already used."}') };
            case "pending": return { status: 409, contentType: "application/json", body: Buffer.from('{"error":"The previous action may have completed. Check the conversation before retrying."}') };
            case "reserved": receipt = { key, hash, file: reserved.file }; break;
            case undefined:
              if (temporaryActionReceipts.size >= 256) return { status: 429, contentType: "application/json", body: Buffer.from('{"error":"Too many experimental actions in this session."}') };
              temporaryReceipt = mutationReceipt;
          }
        } catch {
          return { status: 503, contentType: "application/json", body: Buffer.from('{"error":"The action could not be recorded safely. Try again later."}') };
        }
      }
    }
    const requestedOrg = codeUpload || chatUpload || new RegExp(`^/(?:api/organizations|(?:edge-)?api/bootstrap)/(${uuid})(?:/|$)`).exec(url.pathname)?.[1];
    const account = host.account();
    const organizationProjectChat = !!host.organizationProjects && new RegExp(
      `^/api/organizations/${uuid}/chat_conversations/${uuid}/(?:completion|retry_completion2?|stop_response|claudex_completion/${uuid})$`,
    ).test(url.pathname);
    if (!account || requestedOrg && requestedOrg.toLowerCase() !== organizationUuid(account.id) &&
        !organizationProject && !organizationProjectChat)
      return { status: 404, contentType: "application/json", body: Buffer.from('{"error":"Organization not found."}') };
    const execute = async (): Promise<OfficialUiReadResponse> => {
    if (!actionCurrent()) return retiredAction();
    const input = Readable.from(request.body ? [Buffer.from(request.body)] : []) as http.IncomingMessage;
    input.method = request.method; input.url = `${url.pathname}${url.search}`;
    input.headers = {
      ...(request.contentType ? { "content-type": request.contentType } : {}),
      ...(request.codeOrganizationId ? { "x-organization-uuid": request.codeOrganizationId } : {}),
      ...(privacy && request.privacyOrganizationId ? { "x-organization-uuid": request.privacyOrganizationId } : {}),
      ...("objectTransfer" in request && request.objectTransfer === true ? { "x-claudex-object-transfer": "1" } : {}),
    };
    if (stream) return stream(response => adapter(input, response));
    const largeResponse = isOfficialUiLargeResponse(request.method, url.pathname);
    const output = new CapturedResponse(largeResponse ? officialUiTransferMaxBytes : officialUiReadMaxBytes);
    const finished = new Promise<void>((resolve, reject) => { output.once("finish", resolve); output.once("error", reject); });
    // The route can throw before we await the stream; attach a rejection
    // handler immediately so an oversized response cannot become unhandled.
    void finished.catch(() => {});
    const firstChunk = timeline ? new Promise<void>((resolve, reject) => {
      output.onChunk = resolve;
      output.once("error", reject);
    }) : undefined;
    void firstChunk?.catch(() => {});
    try {
      const handled = await adapter(input, output as unknown as http.ServerResponse);
      if (!handled && !output.writableEnded) { output.statusCode = 404; output.end(); }
      if (firstChunk) {
        await Promise.race([firstChunk, finished.then(() => { throw Error("The timeline ended before its first frame."); })]);
      } else await finished;
    } catch (error) {
      output.destroy();
      if (error instanceof OfficialUiReadLimitError)
        return { status: 413, contentType: "application/json", body: Buffer.from('{"error":"The official Web response is too large."}') };
      throw error;
    }
    const body = output.chunks.length === 1 ? output.chunks[0] : Buffer.concat(output.chunks);
    const status = output.statusCode;
    const designRetry = isOfficialDesignCreateRetry(request.method, input.url, status);
    const retryAfter = output.headers["Retry-After"];
    const frameRefusal = output.headers["X-Frame-Refusal"];
    const attachmentName = output.headers["X-Claudex-Store-Attachment"];
    const answer: OfficialUiReadResponse = {
      status,
      contentType: output.headers["Content-Type"] ?? "application/octet-stream",
      body: status === 200 && request.bootstrapCatalogRevision && isBootstrapRead(request.method, request.path)
        ? compactBootstrap(body, request.bootstrapCatalogRevision) : body,
      ...(output.headers["Content-Disposition"] ? { contentDisposition: output.headers["Content-Disposition"] } : {}),
      ...(designRetry && retryAfter === "1" ? { retryAfter } : {}),
      ...(designRetry && status === 409 && frameRefusal === "create_in_flight" ? { frameRefusal } : {}),
      ...(attachmentName ? { attachmentName: decodeURIComponent(attachmentName) } : {}),
    };
    if (firstChunk) output.destroy();
    if (largeResponse && !attachmentName && request.acceptEncoding === "gzip" && answer.body.length > 256 * 1024) {
      const compressed = await compressBody(answer.body, { level: 1 });
      if (compressed.length < answer.body.length)
        return { ...answer, body: compressed, bodyEncoding: "gzip" };
    }
    return answer;
    };
    const scopedExecute = () => action || chatElicitationResult || restFeedback || leaf || trigger || skillUpload || skillChange || completion || researchStop || chatBulkDelete || incognitoDiscard || customConnector || connectorLifecycle
      ? actionLease.run({ current: actionCurrent, metadataWrite, feedbackConversation, connectorChoices, customConnector: customConnector?.kind, connectorLifecycle: connectorLifecycle ?? undefined, triggerKind: trigger?.kind, chatLeaf, chatForkSource, chatForkDestination, skillUpload, chatBulkDelete, incognitoDiscard: incognitoDiscard || undefined, incognitoDraft,
          chatRootEdit: !!completion && !!request.capabilityLease && host.richQuoteActions === true && guard.modes.includes("chat") }, execute)
      : execute();
    const writeOwner = host.sessionIdentity();
    if (triggerWrite && triggerWrites.has(writeOwner))
      return { status: 409, contentType: "application/json", body: Buffer.from('{"type":"error","error":{"type":"api_error","message":"A scheduled task change is already in progress."}}') };
    if (triggerWrite) triggerWrites.add(writeOwner);
    const execution = scopedExecute().finally(() => {
      if (triggerWrite) triggerWrites.delete(writeOwner);
    });
    const answer = execution.then((value) => {
      if (!actionCurrent()) return retiredAction();
      if (receipt) finishOfficialAction(receipt.file, receipt.hash, value);
      return actionCurrent() ? value : retiredAction();
    }).catch((error) => {
      if (!actionCurrent()) return retiredAction();
      throw error;
    });
    if (receipt) {
      const { key, hash } = receipt;
      const tracked = answer.finally(() => {
        if (inFlightActions.get(key)?.answer === tracked) inFlightActions.delete(key);
      });
      inFlightActions.set(key, { hash, answer: tracked });
      return tracked;
    }
    if (temporaryReceipt) temporaryActionReceipts.set(temporaryReceipt.key, { hash: temporaryReceipt.hash, answer });
    return answer;
  };
  return Object.assign((request: OfficialUiReadRequest) => run(request), { stream: run });
}
