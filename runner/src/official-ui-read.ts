import { bootstrapCatalogRevision, isBootstrapRead } from "../../shared/official-bootstrap-catalog";
import { officialDesignArtifactKind, officialDesignCreateMaxBytes } from "../../shared/official-design-artifacts";
import { createOfficialBlankDesign, type OfficialDesignCreationInput } from "../../electron/official-ui/design-creation";
import { organizationKnowledgeRequest } from "../../electron/official-ui/api/organization-projects";
import { officialOrganizationProjectTarget } from "../../shared/official-project-organizations";
import { parseOfficialCapabilityPreferenceRequest } from "../../shared/official-capability-preferences";
import { termsPath } from "../../shared/account-profile-api";
import { officialDirectorySubmissionTarget } from "../../shared/official-directory-submissions";
import { reserveOfficialCoworkWarm, claimOfficialCoworkWarm, readOfficialCoworkWarm, discardOfficialCoworkWarm } from "./official-cowork-warm";
import { isResearchCommand } from "../../shared/research";
import { engineChatElicitation } from "../../electron/official-ui/api/chat-elicitation-engine";
import { availableChatPermissionModes } from "../../shared/chat-permission-mode";
import { isOfficialResearchStop, isOfficialUiFileReadPath } from "../../shared/official-ui-web";
import { officialReplyFeedbackTarget } from "../../shared/official-reply-feedback";
import { officialChatUploadOrganization, officialConnectorAuthTarget, officialCustomConnectorTarget, officialConnectorLifecycleTarget, type OfficialConnectorLifecycleTarget, officialUiSegmentedRequestLimit, officialCoworkMcpReconciliation } from "../../shared/official-ui-web";
import { reconcileOfficialCoworkMcp } from "./official-cowork-mcp";
import { submitOfficialCoworkFollowup } from "./official-cowork-followup";
import { officialCoworkApprovalControls, officialCoworkApprovalSession, respondOfficialCoworkApproval } from "./official-cowork-approvals";
import { deleteOfficialCoworkSession } from "./official-cowork-delete";
import { connectorUuid, matchesConnectorAuthRejection } from "../../electron/official-ui/api/connector-auth";
import { remoteConnectorSkillsFor } from "../../electron/connectors/remote-skills";
import { connectorAllowed } from "../../shared/client-policy-rules";
import { ConnectorOAuthRevocationError } from "./connector-oauth";
import { parseOfficialConnectorPreference, type OfficialConnectorPreference } from "../../shared/official-connector-preferences";
import { resolveConversationId } from "../../electron/official-ui/api/conversations";
import { readOwnedTurnAttachment } from "../../electron/ipc/owned-turn-attachment";
import { ownedSideQuestionGateway } from "../../electron/engine/side-question-gateway-host";
import { officialSideQuestionAction } from "../../shared/official-side-question";
import { officialMelangeEditRequest, officialMelangePrivacyRoute, officialMelangeRoute } from "../../shared/official-melange";
import { officialMelangeEdits, type MelangeEditOwner } from "./official-melange-edit";
import { classicSourcesForMelange, existingMelangeForAccount, readyMelangeForAccount } from "../../electron/memory/melange-host";
import { isWebTabId } from "../../shared/web-protocol";
import { officialCodeFollowupPath, officialCodeReceiptPath, officialCodeUploadOrganization } from "../../shared/official-code-followup";
import { modelFallbackWire, parseOfficialModelFallbackRequest } from "../../shared/official-model-fallback";
import { codeSettingsWire, officialCodeSettingsPath, parseOfficialCodeSettingsRequest, savedCodeSettings } from "../../shared/official-code-settings";
import { isOfficialCodeUserSettingsChecksum, officialCodeUserSettingsChecksum, officialCodeUserSettingsMaxBytes, officialCodeUserSettingsOrganization, officialCodeUserSettingsWire, parseOfficialCodeUserSettingsWrite, type OfficialCodeUserSettings } from "../../shared/official-code-user-settings";
import { LinkRequestError } from "./control-link";
import { resumeOfficialCodeQueues, confirmOfficialCodeReceipt, officialCodeHeldInputs, officialCodeQueueInputs, readOfficialCodeQueueAttachment, submitOfficialCodeFollowup } from "./official-code-followup";
import { isOfficialCodeHistoryPath, officialCodeHistoryRequest, officialCodeConnectorSelection, officialCodeMarkRead, officialCodeMutation, officialCodeSessionCreation } from "../../shared/official-code-history";
import { createOfficialCodeSession } from "./official-code-creation";
import { saveOfficialCodeConnectorSelection } from "./official-code-connectors";
import { acknowledgeOfficialCodeRead, registerOfficialCodeViewer } from "./official-code-read-state";
import { officialCodeViewerSession } from "../../shared/official-code-viewers";
import { mutateOfficialCodeSession } from "./official-code-mutation";
import { officialCodeTerminalRequest } from "../../shared/official-code-terminal";
import { runOfficialCodeTerminal } from "./official-code-terminals";
import { officialCodePullRequestCreate } from "../../shared/official-code-pull-requests";
import { createOfficialCodePullRequest, officialCodePullRequestError } from "./official-code-pull-requests";
import { officialCodePrMonitorOperation } from "../../shared/official-code-pr-monitor";
import { officialCodePrMonitor } from "./official-code-pr-monitor";
import { officialCodePreviewControl } from "../../shared/official-code-preview";
import { runOfficialCodePreviewControl } from "./official-code-preview";
import { officialCodeWorkspaceDirectory } from "./official-code-workspace-files";
import { officialCodeCommands } from "./official-code-commands";
import { readCodeAgent } from "../../electron/ipc/workflow";
import { codeAgentOwner } from "../../electron/engine/code-agent-threads";
import { officialCodeCommandControls } from "./official-code-command-approvals";
import { isOfficialSessionFilePath, isOfficialWorkspaceDownloadPath, officialWorkspaceDownload } from "../../shared/official-workspace-download";
import { readOfficialWorkspaceDownload } from "./official-workspace-download";
import { isOfficialCodeWorkspacePath, officialCodeWorkspace } from "../../shared/official-code-workspace";
import { readOfficialCodeWorkspace } from "./official-code-workspace";
import {officialLocales} from "../../electron/official-ui/locale";
import {saveAppearanceFont,saveAppearanceLocale} from './official-ui-appearance-save';
import {createAppearanceAuthority} from './official-ui-appearance-authority';
import {officialAppearanceCapabilitiesPath,isOfficialAppearanceAction,isOfficialLocaleAction,validAppearanceBody,validLocaleBody} from '../../shared/official-appearance-capability';
import {createMemoryAuthority} from './official-ui-memory-authority';
import { officialMemoryAction, officialMemoryCapabilitiesPath, officialMemorySettingsPreference, parseOfficialMemorySettings, type OfficialMemoryAction } from "../../shared/official-memory-capability";
import {CompletionAttachmentError} from "../../electron/official-ui/api/completion-attachments";
/** Authenticated official UI queries and bounded actions over the existing runner link. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeSpendLimitSource } from "../../electron/account/spend-limit-read";
import { officialSpendLimitActionOrganization, officialSpendLimitBodyBytes, officialUsageSummaryOrganization } from "../../shared/official-ui-web";
import type { AdapterContext } from "../../electron/official-ui/api/context";
import { officialOrganizationPluginMutation, pluginOrganizationServicePath } from "../../shared/official-plugin-organizations";
import type { OrganizationPluginMethod } from "./dispatcher-support";
import { z } from "zod";
import path from "node:path";
import { persistEmptyChat, type EmptyChatInput } from "../../electron/official-ui/api/chat-creation";
import { newConversationSpace } from "./session-stage";
import { publishAttachmentObject, readUpload, uploadRef } from "./attachments";
import { decodeWireValue, encodeWireValue } from "../../shared/web-wire";
import { webErrorCodes } from "../../shared/web-protocol";
import { guardCall } from "./method-guard";
import { webArtifactPublication } from "./official-ui-artifact-publication";
import { createRunnerOfficialAdapter, type RunnerOfficialHost } from "./official-ui-adapter";
import { isOfficialUiLargeResponse, isOfficialUiQuery, officialUiDefaultsPath, officialUiReadMaxBytes, officialUiRecentsPath, officialUiTimelinePath, type OfficialUiReadRequest, type OfficialUiReadResponse } from "../../shared/official-ui-web";
import { officialResponseChunk, officialResponseChunkPrefix } from "../../shared/official-response-transfer";
import { officialResponseTransfers } from "./official-response-transfer";
import { createStrictTextSession } from "./official-ui-text-authority";
import { officialCoworkCreation, officialChatElicitationResult, officialUiIncognitoDiscardTarget, officialUiActionPath, officialUiCapabilitiesPath, isOfficialUiCompletionSubmission, isOfficialUiRetrySubmission, isOfficialUiConversationCreation, isOfficialUiProjectMove, isOfficialUiModelPreference, isOfficialUiProjectMetadataUpdate, isOfficialUiProjectCreation, isOfficialUiProjectDeletion, isOfficialUiProjectMemoryUpdate, officialUiProjectKnowledgeMutation, officialUiRequestLimit, officialUiConversationMutation, isOfficialUiAction, isOfficialUiArtifactPublication, isOfficialUiChatBulkDelete } from "../../shared/official-ui-web";
import { createOfficialCoworkSession } from "./official-cowork-creation";
import { officialCoworkDeviceManagement, officialCoworkDevices } from "../../shared/official-ui-web";
import { coworkMemoryIfMatch, coworkMemoryMaxRequestBytes, coworkMemoryRevision, officialCoworkMemory } from "../../shared/official-cowork-memory";
import { officialCoworkMemoryResponse } from "./official-cowork-memory";
import { manageOfficialCoworkDevices, readOfficialCoworkDevices } from "./official-cowork-devices";
import { knowledgeFileLimit } from "../../shared/collections-api";
import type { ProjectMetadataPatch } from "../../shared/project-access";
import type { Conversation, Project } from "../../shared/types";
import type { Dispatcher, CallFrame } from "./dispatcher";
import type { WebAppContext } from "./web-app-context";
import { registerUsageStatsHandlers } from "../../electron/ipc/usage-stats";
import { loadKnowledgeOffer } from "../../electron/ipc/knowledge";
import { hiwonderKnowledgeAllowed } from "../../shared/knowledge-api";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { McpAppToolbox } from "../../electron/official-ui/api/mcp-app-toolbox";
import { codeMcpAppAllowsTool } from "../../electron/official-ui/api/code-mcp-app-scope";
import { savedConnectorHeaders } from "../../electron/connectors/connector-clients";
import { officialMcpAppToolboxTarget } from "../../shared/official-ui-web";
import { officialDocumentTokenOrganization } from "../../shared/official-ui-web";
import { officialChatLeafTarget, isOfficialUiConversationSharingMutation } from "../../shared/official-ui-web";
import { isOfficialSkillCreation, isOfficialSkillDeletion, isOfficialSkillToggle, officialSkillCopyRenameMethod, officialSkillUploadKind } from "../../shared/official-ui-web";
import { officialSkillAuthoring } from "../../electron/skills/skill-folder";
import { issueOfficialDocumentPreviewToken } from "./official-document-preview";
import { cloudCodeSessionKey, isOwnedCloudCodeSession } from "../../electron/official-ui/api/cloud-code-history";
import { matchesOfficialInlineUpload, matchesOfficialRestTextUpload } from "./official-ui-excerpt";
import { codeTriggerOperationAllowed, officialCodeTriggerRequest } from "../../shared/official-code-triggers";
import { officialNotificationPreferencesOrganization, officialNotificationPreferencesWire } from "../../shared/official-notification-preferences";

const githubCompareInput = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  base: z.string().min(1).max(255),
  head: z.string().min(1).max(255),
  ghe_configuration_id: z.literal(0).optional(),
});
const githubCompareCommit = z.object({
  sha: z.string(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string(), email: z.string(), date: z.string() }).nullish(),
  }),
});
const connectorOAuthCallback = z.union([
  z.strictObject({ state: z.string().min(1).max(512), code: z.string().min(1).max(8192), iss: z.url().max(2048).optional() }),
  z.strictObject({ state: z.string().min(1).max(512), error: z.enum(["access_denied", "authorization_failed"]) }),
]);

type SpendLimitMutation = NonNullable<AdapterContext["spendLimitMutation"]>;
const spendLimitLeases = new WeakMap<object, Map<string, string>>();
const adapters = new WeakMap<Dispatcher, WeakMap<WebAppContext, {
  run(frame: CallFrame, request: OfficialUiReadRequest, shell: boolean, connector: OfficialConnectorPreference | undefined, edit?: { id: string; owner: MelangeEditOwner }, spendLimitMutation?: SpendLimitMutation): Promise<OfficialUiReadResponse>;
}>>();
const chatSessions = new WeakMap<Dispatcher, WeakMap<WebAppContext, ReturnType<typeof createStrictTextSession>>>();
const appearanceAuthorities = new WeakMap<Dispatcher,WeakMap<WebAppContext,ReturnType<typeof createAppearanceAuthority>>>();
const memoryAuthorities = new WeakMap<Dispatcher,WeakMap<WebAppContext,ReturnType<typeof createMemoryAuthority>>>();
// Historical previews resolve only IDs learned from this account's history.
// The existing guarded turnAttachment handler owns profile-store confinement.
const allowedInternal = new Set(["clientPolicy", "readGeneratedFile", "snapshot", "searchConversations", "activeSessions", "artifactNotes", "conversationTurns", "turnAttachment", "modelCatalog", "mcpServers", "listApprovedDirectory", "listSkills", "listPlugins", "readPlugin", "memoryStatus", "memoryControlsState", "planUsage", "billingInfo", "spendLimit", "usageOverview", "usageBreakdown", "usageRecords", "listProjectKnowledge", "readProjectKnowledge"]);
const mcpAppToolbox = new McpAppToolbox();

function isShellQuery(method: string, url: URL) {
  const { pathname, search, searchParams } = url;
  if (!isOfficialUiQuery(method, pathname, search)) return false;
  if (method === "POST")
    return !search && (pathname === officialUiDefaultsPath || pathname === officialUiTimelinePath);
  if (method !== "GET") return false;
  if (/^\/(?:edge-)?api\/bootstrap(?:\/[^/]+\/(?:app_start|current_user_access))?$/.test(pathname)) return true;
  if (/^\/api\/(?:account|account_profile|organizations(?:\/[a-f0-9-]{36})?)$/.test(pathname)) return true;
  if (/^\/api\/organizations\/[^/]+\/(?:memory\/settings|chat_conversations\/[^/]+)$/.test(pathname)) return true;
  return /^\/api\/organizations\/[^/]+\/chat_conversations_v2$/.test(pathname) && !searchParams.get("searchQuery")?.trim();
}

export async function officialUiRead(dispatcher: Dispatcher, frame: CallFrame) {
  const root = dispatcher.options.officialUiRoot;
  if (!root) throw Object.assign(Error("Not available on the web."), { code: webErrorCodes.methodUnavailable });
  const action = frame.method === "officialUiAction";
  const args = decodeWireValue(frame.args);
  if (!Array.isArray(args) || args.length !== 1 || !args[0] || typeof args[0] !== "object" || Array.isArray(args[0]))
    throw Object.assign(Error("Invalid official Web request."), { code: webErrorCodes.badRequest });
  const request = args[0] as Record<string, unknown>;
  const triggerRoute = (method: string, path: string) => {
    const index = path.indexOf("?");
    return officialCodeTriggerRequest(method, index < 0 ? path : path.slice(0, index), index < 0 ? "" : path.slice(index));
  };
  const codeTrigger = typeof request.method === "string" && typeof request.path === "string"
    ? triggerRoute(request.method, request.path) : undefined;
  const codeRead = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodeMarkRead(request.method, request.path);
  const codeViewer = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodeViewerSession(request.method, request.path);
  const codeMutation = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodeMutation(request.method, request.path);
  const codeTerminal = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodeTerminalRequest(request.method, request.path);
  const codePullRequest = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodePullRequestCreate(request.method, request.path);
  const codePrMonitor = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodePrMonitorOperation(request.method, request.path);
  const codePreview = typeof request.method === "string" && typeof request.path === "string" &&
    officialCodePreviewControl(request.method, request.path);
  const coworkMemory = typeof request.method === "string" && typeof request.path === "string" &&
    officialCoworkMemory(request.method, request.path);
  const codeUserSettings = (request.method === "GET" || request.method === "PUT") &&
    typeof request.path === "string" && officialCodeUserSettingsOrganization(request.path);
  const uploadedBody = uploadRef(request.body);
  const segments: unknown[] | undefined = Array.isArray(request.bodySegments) ? request.bodySegments : undefined;
  const appConnector = typeof request.method === "string" && typeof request.path === "string" ?
    officialMcpAppToolboxTarget(request.method, request.path) : undefined;
  if (Object.keys(request).some((key) => !["method", "path", "contentType", "body", "bodySegments", "capabilityLease", "acceptEncoding", "bootstrapCatalogRevision", "codeOrganizationId", "privacyOrganizationId", "codeReadRevision", "responseTransfer", "objectTransfer", "coworkMemoryEpoch", "coworkMemoryIfMatch", "codeUserSettingsChecksum", "mcpAppToolbox"].includes(key)) ||
      !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(request.method as string) ||
      typeof request.path !== "string" || request.path.length > 2048 ||
      (request.contentType !== undefined && (typeof request.contentType !== "string" || request.contentType.length > 256)) ||
      (request.body !== undefined && !(request.body instanceof Uint8Array) && uploadedBody === undefined) ||
      (request.bodySegments !== undefined && (!segments || request.body !== undefined)) ||
      (request.acceptEncoding !== undefined && request.acceptEncoding !== "gzip") ||
      (request.bootstrapCatalogRevision !== undefined && (!isBootstrapRead(String(request.method), String(request.path)) || !bootstrapCatalogRevision.safeParse(request.bootstrapCatalogRevision).success)) ||
      (request.privacyOrganizationId !== undefined && (typeof request.privacyOrganizationId !== "string" ||
        request.privacyOrganizationId.length !== 36)) ||
      (request.codeReadRevision !== undefined &&
        (!codeRead || typeof request.codeReadRevision !== "number" || !Number.isSafeInteger(request.codeReadRevision) || request.codeReadRevision < 0)) ||
      (request.responseTransfer !== undefined && request.responseTransfer !== true) ||
      (request.objectTransfer !== undefined && (request.objectTransfer !== true ||
        request.method !== "GET" || !isOfficialUiFileReadPath(request.path.split("?")[0]))) ||
      (request.coworkMemoryEpoch !== undefined && (!coworkMemory || coworkMemory.operation === "read" ||
        typeof request.coworkMemoryEpoch !== "string" || !coworkMemoryRevision.test(request.coworkMemoryEpoch))) ||
      (request.coworkMemoryIfMatch !== undefined && (!coworkMemory || coworkMemory.operation !== "patch" ||
        typeof request.coworkMemoryIfMatch !== "string" || !coworkMemoryIfMatch.test(request.coworkMemoryIfMatch))) ||
      (request.codeUserSettingsChecksum !== undefined && (!codeUserSettings ||
        !isOfficialCodeUserSettingsChecksum(request.codeUserSettingsChecksum))) ||
      (request.mcpAppToolbox !== undefined && !appConnector) ||
      (request.codeOrganizationId !== undefined && (typeof request.codeOrganizationId !== "string" ||
        request.codeOrganizationId.length > 36 ||
        (request.path !== "/v1/code/github/compare-refs" && !isOfficialCodeHistoryPath(request.path.split("?")[0]) && !isOfficialSessionFilePath(request.path.split("?")[0]) && !isOfficialCodeWorkspacePath(request.path.split("?")[0]) && !officialCodeFollowupPath(request.method as string, request.path) && !officialCodeConnectorSelection(request.method as string, request.path) && !codeRead && !codeViewer && !codeMutation && !codeTerminal && !codePreview && !codeTrigger && !codePullRequest && !codePrMonitor))) ||
      (request.capabilityLease !== undefined && (typeof request.capabilityLease !== "string" || request.capabilityLease.length > 128)))
    throw Object.assign(Error("Invalid official Web request."), { code: webErrorCodes.badRequest });
  const reject = (status: number, message: string) => ({ status, contentType: "application/json", body: Buffer.from(JSON.stringify({ error: message })) });
  const method = request.method as OfficialUiReadRequest["method"];
  const notificationOrganization = !action && officialNotificationPreferencesOrganization(request.path.split("?", 1)[0]);
  if (notificationOrganization) {
    if (method !== "GET") return reject(405, "Unsupported notification preferences method.");
    if (request.path.includes("?") || request.body !== undefined || segments || request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(400, "Invalid notification preferences request.");
    const read = await dispatcher.accountSettingsFor(frame);
    const account = frame.signal?.aborted ? undefined : read(frame.user.accessToken);
    if (!account) return reject(409, "The account activation changed.");
    if (notificationOrganization !== organizationUuid(account.accountId)) return reject(404, "Organization not found.");
    const body = Buffer.from(JSON.stringify(officialNotificationPreferencesWire(account.settings)));
    return { status: 200, contentType: "application/json", body };
  }
  const customConnector = officialCustomConnectorTarget(method, request.path);
  const connectorLifecycle = officialConnectorLifecycleTarget(method, request.path);
  const connectorAuth = officialConnectorAuthTarget(method, request.path);
  let connector: OfficialConnectorPreference | undefined;
  let codeSettings: ReturnType<typeof parseOfficialCodeSettingsRequest>;
  let modelFallback: ReturnType<typeof parseOfficialModelFallbackRequest>;
  let capabilityPreference: ReturnType<typeof parseOfficialCapabilityPreferenceRequest>;
  try {
    const accountSettingsRequest = { method, path: request.path,
      contentType: request.contentType as string | undefined,
      body: request.body instanceof Uint8Array ? request.body : undefined };
    connector = parseOfficialConnectorPreference(accountSettingsRequest);
    if (!connector) codeSettings = parseOfficialCodeSettingsRequest(accountSettingsRequest);
    if (!connector && !codeSettings) modelFallback = parseOfficialModelFallbackRequest(accountSettingsRequest);
    if (!connector && !codeSettings && !modelFallback) capabilityPreference = parseOfficialCapabilityPreferenceRequest(accountSettingsRequest);
  } catch (error) {
    return reject(400, error instanceof Error ? error.message : "Invalid settings request.");
  }
  const spendLimitAction = officialSpendLimitActionOrganization(method, request.path);
  const spendLimitSummary = officialUsageSummaryOrganization(method, request.path);
  const appearanceAction = !connector && !codeSettings && !modelFallback && !capabilityPreference && isOfficialAppearanceAction(method, request.path);
  const memoryAction = officialMemoryAction(method, request.path);
  const melangeEdit = officialMelangeEditRequest(method, request.path);
  const modelPreference = isOfficialUiModelPreference(request.method as string, request.path);
  const projectMove = isOfficialUiProjectMove(request.method as string, request.path);
  const projectKnowledge = officialUiProjectKnowledgeMutation(request.method as string, request.path);
  const segmentedLimit = segments && officialUiSegmentedRequestLimit(method, request.path);
  if (segments && (!segmentedLimit || segments.length < 2 ||
      segments.length > Math.ceil(segmentedLimit / knowledgeFileLimit)))
    throw Object.assign(Error("Invalid official Web request."), { code: webErrorCodes.badRequest });
  const designCreation = officialDesignArtifactKind(method, request.path) === "create";
  const projectCreation = isOfficialUiProjectCreation(request.method as string, request.path);
  const skillCreation = isOfficialSkillCreation(method, request.path);
  const skillUpload = officialSkillUploadKind(method, request.path);
  const skillChange = isOfficialSkillDeletion(method, request.path) || isOfficialSkillToggle(method, request.path) || !!officialSkillCopyRenameMethod(method, request.path);
  const organizationPluginMutation = officialOrganizationPluginMutation(method, request.path);
  const projectMetadata = isOfficialUiProjectMetadataUpdate(request.method as string, request.path);
  const projectOrganizationWrite = action && officialOrganizationProjectTarget(method, request.path.split("?")[0]);
  const projectDeletion = isOfficialUiProjectDeletion(method, request.path);
  const projectMemory = isOfficialUiProjectMemoryUpdate(method, request.path);
  const codeCreation = officialCodeSessionCreation(method, request.path);
  const coworkCreation = officialCoworkCreation(method, request.path);
  const codeFollowup = officialCodeFollowupPath(request.method as string, request.path);
  const codeUpload = officialCodeUploadOrganization(request.method as string, request.path);
  const chatUpload = officialChatUploadOrganization(method, request.path);
  const codeConnectors = officialCodeConnectorSelection(request.method as string, request.path);
  const coworkMcp = officialCoworkMcpReconciliation(request.method as string, request.path);
  const sideQuestionAction = officialSideQuestionAction(request.method as string, request.path as string);
  const directorySubmission = officialDirectorySubmissionTarget(method, request.path);
  const chatAction = action && !directorySubmission && !spendLimitAction && !appearanceAction && !memoryAction && !codeSettings && !codeUserSettings && !codeCreation && !coworkCreation && !codeFollowup && !codeConnectors && !coworkMcp && !codeRead && !codeViewer && !codeMutation && !codeTerminal && !codeTrigger && !codePullRequest && !codePrMonitor;
  const publicationAction = isOfficialUiArtifactPublication(request.method as string, request.path as string);
  const sharingAction = isOfficialUiConversationSharingMutation(method, request.path);
  const leafAction = officialChatLeafTarget(method, request.path);
  const chatBulkDelete = isOfficialUiChatBulkDelete(method, request.path);
  const incognitoDiscard = officialUiIncognitoDiscardTarget(method, request.path);

  if (action && !(appearanceAction ? dispatcher.options.officialUiAppearanceSettings : memoryAction === "controls" ? dispatcher.options.officialUiMemoryControls : dispatcher.options.officialUiActions))
    throw Object.assign(Error("Not available on the web."), {code:webErrorCodes.methodUnavailable});
  if (isOfficialUiAction(request.method as string, request.path as string) !== action)
    throw Object.assign(Error("Invalid official Web request."), { code: webErrorCodes.badRequest });
  if (spendLimitAction && (!(request.body instanceof Uint8Array) ||
      request.body.byteLength > officialSpendLimitBodyBytes || segments ||
      typeof request.contentType !== "string" || !/^application\/json(?:\s*;.*)?$/i.test(request.contentType)))
    return reject(400, "Invalid spend-limit request.");
  if (projectMemory && uploadedBody !== undefined)
    return reject(400, "Project memory settings require inline JSON.");
  if (projectDeletion && (uploadedBody !== undefined || request.body instanceof Uint8Array && request.body.byteLength))
    return reject(400, "Project deletion does not accept a request body.");
  if (connectorLifecycle && (uploadedBody !== undefined || request.body instanceof Uint8Array && request.body.byteLength))
    return reject(400, "Connector lifecycle requests do not accept a body.");
  if (organizationPluginMutation && (uploadedBody !== undefined || segments ||
      (organizationPluginMutation.kind === "remove" ? request.body !== undefined || request.contentType !== undefined :
        !(request.body instanceof Uint8Array) || request.body.byteLength > 1024 ||
        typeof request.contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(request.contentType))))
    return reject(400, "Invalid organization plugin request.");
  if (connectorAuth?.kind === "logout" &&
      (request.body !== undefined || request.contentType !== undefined ||
        request.acceptEncoding !== undefined || request.responseTransfer !== undefined))
    return reject(400, "Invalid connector sign-out request.");
  if (memoryAction && memoryAction !== "controls" && uploadedBody !== undefined)
    return reject(400, "Invalid memory request.");
  const url = new URL(request.path, "http://localhost");
  const shellQuery = !action && !uploadedBody && !segments && request.capabilityLease === undefined &&
    url.origin === "http://localhost" && request.path === url.pathname + url.search &&
    (coworkMemory && coworkMemory.operation === "read" || officialResponseChunk(method, request.path) || isShellQuery(method, url));
  const existing = dispatcher.context(frame.user.id);
  const ctx = await (shellQuery && (!existing || existing.closed) ? dispatcher.shellContextFor(frame) : dispatcher.contextFor(frame));
  const shell = shellQuery && dispatcher.context(ctx.userId) !== ctx;
  const contextCurrent = () => shell ? dispatcher.isShellContextCurrent(ctx) : dispatcher.context(ctx.userId) === ctx;
  if (ctx.userId !== frame.user.id || ctx.signedOut || ctx.closedFlag || shell && !contextCurrent())
    throw Object.assign(Error("The session has ended."), { code: webErrorCodes.badRequest });
  ctx.reclaimCaches?.();
  ctx.setAccessToken(frame.user.accessToken);
  ctx.lastActive = dispatcher.now();
  if (codeViewer) {
    if (ctx.accountRetiring || frame.signal?.aborted || dispatcher.context(ctx.userId) !== ctx)
      return reject(409, "The account activation changed.");
    return registerOfficialCodeViewer(ctx, codeViewer, request, dispatcher.guard.modes, ctx.lastActive);
  }
  if (organizationPluginMutation && organizationPluginMutation.organization !== organizationUuid(ctx.activeAccount?.id ?? ""))
    return reject(404, "Organization not found.");
  const coworkDeviceManagement = officialCoworkDeviceManagement(method, request.path);
  if (coworkDeviceManagement)
    return manageOfficialCoworkDevices(coworkDeviceManagement, request, ctx, () =>
      !ctx.closedFlag && !ctx.signedOut && !ctx.accountRetiring && !frame.signal?.aborted &&
      dispatcher.context(ctx.userId) === ctx);
  if (directorySubmission) {
    if (directorySubmission.organizationId !== organizationUuid(ctx.activeAccount?.id ?? ""))
      return reject(404, "Organization not found.");
    if (!dispatcher.options.officialUiActions || !ctx.remote?.ready)
      return reject(501, "Directory submissions are unavailable on this host.");
    if (segments || uploadedBody || request.capabilityLease !== undefined)
      return reject(400, "Invalid directory submission request.");
  }
  let spendLimitMutation: SpendLimitMutation | undefined;
  if (spendLimitAction || spendLimitSummary) {
    const owner = ctx.activeAccount?.id;
    const activation = ctx.officialSessionIdentity();
    const backend = ctx.remote?.backend;
    const session = frame.user.webSession?.id;
    const current = () => !!owner && ctx.activeAccount?.id === owner &&
      ctx.officialSessionIdentity() === activation && ctx.remote?.backend === backend &&
      !ctx.closedFlag && !ctx.signedOut && !ctx.accountRetiring && !frame.signal?.aborted &&
      dispatcher.context(ctx.userId) === ctx;
    if (!owner || !current()) return reject(409, "The account activation changed.");
    if ((spendLimitAction ?? spendLimitSummary) !== organizationUuid(owner))
      return reject(404, "Organization not found.");
    if (backend && session && dispatcher.options.officialUiActions) {
      let leases = spendLimitLeases.get(activation);
      if (!leases) {
        leases = new Map();
        spendLimitLeases.set(activation, leases);
      }
      let activationLease = leases.get(session);
      if (!activationLease && spendLimitSummary) {
        activationLease = randomUUID();
        leases.set(session, activationLease);
      }
      if (activationLease && (!spendLimitAction || request.capabilityLease === activationLease)) {
        const baseUrl = backend.accounts.baseUrl;
        const token = frame.user.accessToken;
        spendLimitMutation = {
          activationLease,
          current,
          ...(spendLimitAction ? {
            async save(limitUsd) {
              if (!current()) throw Error("The account activation changed.");
              const saved = await writeSpendLimitSource({ baseUrl, fetch: ctx.runtime.fetch, token, limitUsd });
              if (!current()) throw Error("The account activation changed.");
              return saved;
            },
          } : {}),
        };
      }
    }
    if (spendLimitAction && !spendLimitMutation)
      return reject(409, "Reload Usage before changing the spend limit.");
  }
  if (method === "GET" && request.path === officialCodeSettingsPath) {
    if (request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(400, "Invalid Code settings query.");
    if (!ctx.activeAccount || ctx.accountRetiring || dispatcher.context(ctx.userId) !== ctx)
      return reject(409, "The account activation changed.");
    if (!dispatcher.options.officialUiActions || dispatcher.options.officialUiStrictTextChat !== undefined ||
        !dispatcher.guard.modes.includes("chat") || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code settings are unavailable on this host.");
    const fields = codeSettingsWire(savedCodeSettings(ctx.store.settings));
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(fields)) };
  }
  const finishLargeResponse = async (answer: OfficialUiReadResponse, identity: unknown) => {
    const current = () => !ctx.closedFlag && !ctx.signedOut && !!ctx.activeAccount &&
      contextCurrent() && ctx.officialSessionIdentity() === identity;
    if (!current())
      return reject(409, "The account activation changed.");
    if (answer.status === 200 && answer.attachmentName && answer.body.byteLength > 0 &&
        request.objectTransfer === true && !answer.bodyEncoding) {
      const objectTransfer = await publishAttachmentObject(dispatcher.options.link, frame.user.id, {
        name: answer.attachmentName, mime: answer.contentType, bytes: answer.body,
      }, frame.signal).catch(() => undefined);
      if (!current()) return reject(409, "The account activation changed.");
      if (objectTransfer) return { ...answer, body: new Uint8Array(0), objectTransfer };
    }
    if (answer.body.byteLength <= officialUiReadMaxBytes) return answer;
    if (request.responseTransfer !== true) return reject(413, "The official Web response is too large.");
    return officialResponseTransfers(ctx).start(answer, dispatcher.now()) ??
      reject(503, "Too many official Web responses are being transferred. Try again later.");
  };
  if (coworkMemory) {
    const owner = ctx.activeAccount?.id, identity = ctx.officialSessionIdentity(), store = ctx.store;
    const current = () => !!owner && ctx.activeAccount?.id === owner && ctx.store === store &&
      identity === ctx.officialSessionIdentity() && contextCurrent() &&
      !ctx.accountRetiring && !ctx.closedFlag && !ctx.signedOut && !frame.signal?.aborted;
    if (!current()) return reject(409, "The account activation changed.");
    if (coworkMemory.organization !== organizationUuid(owner!)) return reject(404, "Organization not found.");
    if (!dispatcher.options.officialUiActions || !dispatcher.guard.modes.includes("cowork"))
      return reject(501, "Cowork memory is unavailable on this host.");
    if (segments || request.capabilityLease !== undefined || (uploadedBody && coworkMemory.operation !== "patch"))
      return reject(400, "Invalid Cowork memory request.");
    if (uploadedBody) {
      request.body = await readUpload(
        { request: (op, user, data) => dispatcher.options.link.request(op, user, data) },
        frame.user.id, uploadedBody, coworkMemoryMaxRequestBytes,
      );
    }
    const answer = await officialCoworkMemoryResponse(coworkMemory, request, ctx.coworkMemoryService,
      frame.user.accessToken, current, frame.signal);
    return finishLargeResponse(answer, identity);
  }
  if (request.path.startsWith(officialResponseChunkPrefix)) {
    const chunk = officialResponseChunk(request.method as string, request.path);
    if (!chunk || request.body !== undefined || request.contentType !== undefined ||
        request.capabilityLease !== undefined || request.acceptEncoding !== undefined || request.responseTransfer !== undefined)
      return reject(400, "Invalid official Web response chunk request.");
    if (!ctx.activeAccount || !contextCurrent())
      return reject(409, "The account activation changed.");
    const answer = officialResponseTransfers(ctx).read(chunk, dispatcher.now());
    if (answer === null) return reject(416, "Invalid official Web response chunk offset.");
    return answer ?? reject(404, "The official Web response transfer has ended.");
  }
  const documentOrganization = officialDocumentTokenOrganization(request.method as string, request.path);
  if (codePreview) return runOfficialCodePreviewControl(dispatcher, frame, ctx, codePreview, request);
  if (documentOrganization) {
    if (request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(400, "Invalid document preview token request.");
    if (!ctx.activeAccount || documentOrganization !== organizationUuid(ctx.activeAccount.id))
      return reject(403, "Organization not found.");
    if (!frame.user.webSession) return reject(401, "Sign in to preview documents.");
    const token = issueOfficialDocumentPreviewToken(dispatcher, ctx, frame.user.webSession);
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ token })) };
  }
  const melangeRoute = officialMelangeRoute(method, url.pathname, url.search);
  const privacy = officialMelangePrivacyRoute(method, url.pathname, url.search);
  const privacyHeaderRequired = !!privacy && url.pathname.startsWith("/v1/privacy-consents");
  if (!privacyHeaderRequired && request.privacyOrganizationId !== undefined)
    return reject(400, "Invalid privacy consent request.");
  const triggerOrganization = request.codeOrganizationId ?? (codeTrigger?.kind === "environments" ? codeTrigger.organization : undefined);
  if (codeTrigger && (!ctx.activeAccount || typeof triggerOrganization !== "string" || triggerOrganization.toLowerCase() !== organizationUuid(ctx.activeAccount.id) ||
      !dispatcher.guard.modes.some((mode) => mode === "code" || mode === "cowork")))
    return reject(403, "Scheduled tasks are unavailable for this account.");
  if (method === "POST" && request.path === "/v1/code/github/compare-refs") {
    if (action || !dispatcher.guard.modes.includes("code") || !ctx.activeAccount ||
        request.codeOrganizationId !== organizationUuid(ctx.activeAccount.id))
      return reject(403, "Repository comparison is unavailable.");
    let input: z.infer<typeof githubCompareInput>;
    try {
      if (!(request.body instanceof Uint8Array) || request.body.byteLength > 4096 ||
          typeof request.contentType !== "string" || !/^application\/json(?:\s*;|$)/i.test(request.contentType)) throw Error();
      input = githubCompareInput.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
    } catch { return reject(400, "Invalid repository comparison."); }
    const repo = input.repo;
    const owner = ctx.activeAccount.id;
    const identity = ctx.officialSessionIdentity();
    const match = ctx.store.conversations.find((conversation) =>
      isOwnedCloudCodeSession(conversation, owner) &&
      [conversation.repository?.url, ...(conversation.sessionRepositories ?? []).map((item) => item.url)]
        .some((value) => {
          const parsed = value ? URL.parse(value) : null;
          return parsed?.hostname === "github.com" &&
            parsed.pathname.replace(/^\//, "").replace(/\.git\/?$/, "").replace(/\/$/, "").toLowerCase() === repo.toLowerCase();
        }));
    if (!match) return reject(404, "Repository not found.");
    if (!ctx.runtime?.transport) return reject(503, "Repository comparison is unavailable.");
    try {
      const answer = await ctx.runtime.transport.request("github.api", ctx.userId, {
        url: `https://github.com/${repo}`, action: "repository.compare", base: input.base, head: input.head,
      });
      if (ctx.signedOut || ctx.closedFlag || dispatcher.context(ctx.userId) !== ctx || ctx.activeAccount?.id !== owner ||
          ctx.officialSessionIdentity() !== identity)
        return reject(409, "The account activation changed.");
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) return reject(502, "Repository comparison is unavailable.");
      const result = answer as Record<string, unknown>;
      if (!Array.isArray(result.files)) return reject(502, "Repository comparison is unavailable.");
      const merge = result.merge_base_commit;
      const commits = Array.isArray(result.commits) ? result.commits.flatMap((entry: unknown) => {
        const parsed = githubCompareCommit.safeParse(entry);
        if (!parsed.success) return [];
        const { sha, commit: { message, author } } = parsed.data;
        return [{ sha, short_sha: sha.slice(0, 7),
          subject: message.split("\n", 1)[0], author_name: author?.name ?? "",
          author_email: author?.email ?? "", date: Math.floor((Date.parse(author?.date ?? "") || 0) / 1000) }];
      }) : undefined;
      const body = Buffer.from(JSON.stringify({
        base_branch: input.base, head_branch: input.head, diff_url: result.html_url ?? "",
        ahead_by: result.ahead_by, behind_by: result.behind_by, total_commits: result.total_commits,
        files: result.files, ...(commits ? { commits } : {}),
        merge_base: merge && typeof merge === "object" && "sha" in merge ? merge.sha : undefined,
      }));
      return body.byteLength <= officialUiReadMaxBytes
        ? { status: 200, contentType: "application/json", body }
        : reject(413, "Repository comparison is too large.");
    } catch { return reject(503, "Repository comparison is unavailable."); }
  }
  if (isOfficialCodeWorkspacePath(url.pathname)) {
    const query = officialCodeWorkspace(method, url.pathname, url.search);
    if (!query || request.path !== url.pathname + url.search || url.origin !== "http://localhost" ||
        url.hash || request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(400, "Invalid Code workspace query.");
    const owner = ctx.activeAccount?.id;
    const store = ctx.store;
    const identity = ctx.officialSessionIdentity();
    const current = () => !!owner && ctx.activeAccount?.id === owner &&
      ctx.store === store && ctx.officialSessionIdentity() === identity &&
      !ctx.closedFlag && !ctx.signedOut && dispatcher.context(ctx.userId) === ctx;
    if (!current()) return reject(409, "The account changed during the workspace read.");
    const answer = await readOfficialCodeWorkspace(ctx, query, request.codeOrganizationId, dispatcher.guard.modes);
    return current() ? answer : reject(409, "The account changed during the workspace read.");
  }
  if (isOfficialWorkspaceDownloadPath(url.pathname)) {
    const query = officialWorkspaceDownload(request.method as string, url.pathname, url.search);
    if (!query || !request.path.startsWith("/") || request.path.startsWith("//") ||
        url.origin !== "http://localhost" || url.hash || request.body !== undefined ||
        request.contentType !== undefined || request.capabilityLease !== undefined)
      return { status: 400, contentType: "application/json", body: Buffer.from('{"error":"Invalid workspace file query."}') };
    if (ctx.closedFlag || ctx.signedOut || dispatcher.context(ctx.userId) !== ctx)
      throw Error("The account changed during this request.");
    return readOfficialWorkspaceDownload(ctx, query, request.codeOrganizationId, dispatcher.guard.modes);
  }
  if (method === "GET" && !action && dispatcher.guard.modes.includes("cowork") &&
      request.path === url.pathname + url.search && !url.hash && url.origin === "http://localhost" &&
      request.body === undefined && request.contentType === undefined && request.capabilityLease === undefined) {
    const query = officialCodeHistoryRequest(method, url.pathname, url.search);
    if (query && (query.kind === "session" || (query.kind === "events" && query.cursor === null) ||
        (query.kind === "stream" && query.from === 0 && !query.afterEventId))) {
      const warm = readOfficialCoworkWarm(frame, ctx, query, request.codeOrganizationId,
        () => !ctx.closedFlag && !ctx.signedOut && dispatcher.context(ctx.userId) === ctx);
      if (warm) return warm;
    }
  }
  let sessionMap = chatSessions.get(dispatcher);
  if (!sessionMap) { sessionMap = new WeakMap(); chatSessions.set(dispatcher, sessionMap); }
  let chat = sessionMap.get(ctx);
  if (!chat || !chat.current()) {
    chat = createStrictTextSession({
      accountId: () => ctx.activeAccount?.id,
      identity: () => ctx.officialSessionIdentity(), stateRoot: () => ctx.store.root,
      isCurrent: () => !ctx.closedFlag && !ctx.signedOut && contextCurrent(),
      enabled: () => dispatcher.options.officialUiStrictTextChat !== undefined,
      actionsEnabled: () => !!dispatcher.options.officialUiActions && dispatcher.guard.modes.includes("chat"),
      executor: () => dispatcher.options.officialUiStrictTextChat?.executor,
      ownedAttachmentIdentity: (id) => ctx.selectedAttachments.get(id),
      lookupOwnedAttachment: (id) => { const a=ctx.selectedAttachments.get(id); return a && {id:a.id,name:a.name,size:a.size,kind:a.kind}; },
    });
    sessionMap.set(ctx, chat);
  }
  if (codeUserSettings) {
    const owner = ctx.activeAccount?.id;
    const store = ctx.store;
    const current = () => ctx.activeAccount?.id === owner && ctx.store === store &&
      chat.current() && !ctx.accountRetiring && !frame.signal?.aborted &&
      (!action || chat.accepts(request.capabilityLease));
    if (!owner || !current()) return reject(409, "The account activation changed.");
    if (codeUserSettings !== organizationUuid(owner)) return reject(404, "Organization not found.");
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(404, "Cloud Code user settings are unavailable.");
    const answer = (status: number, row: OfficialCodeUserSettings | undefined) => ({
      status,
      contentType: "application/json",
      body: status === 304 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(officialCodeUserSettingsWire(owner, row))),
    });
    const checksum = typeof request.codeUserSettingsChecksum === "string" ? request.codeUserSettingsChecksum : undefined;
    if (method === "GET") {
      if (request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
        return reject(400, "Invalid Code user settings query.");
      const row = store.settings.officialCodeUserSettings;
      return answer(checksum === officialCodeUserSettingsChecksum(row) ? 304 : 200, row);
    }
    if (!(request.body instanceof Uint8Array) || typeof request.contentType !== "string" ||
        !/^application\/json(?:\s*;.*)?$/i.test(request.contentType))
      return reject(400, "Code user settings require inline JSON.");
    if (request.body.byteLength > officialCodeUserSettingsMaxBytes)
      return reject(413, "Code user settings are too large.");
    const entries = parseOfficialCodeUserSettingsWrite(request.body);
    if (!entries) return reject(400, "Invalid Code user settings entries.");
    try {
      const result = await store.persistCodeUserSettings(entries, checksum, current);
      return current() ? answer(result.matched ? 200 : 412, result.row) : reject(409, "The account activation changed.");
    } catch (error) {
      if (!current()) return reject(409, "The account activation changed.");
      if (error instanceof LinkRequestError && error.code === webErrorCodes.tooLarge)
        return reject(413, "Code user settings are too large.");
      return reject(503, "The Code user settings save could not be confirmed.");
    }
  }
  if (appConnector) {
    const owner = ctx.activeAccount?.id;
    const store = ctx.store;
    const activation = ctx.officialSessionIdentity();
    const connectors = ctx.connectors;
    const fetch = connectors?.fetch;
    const current = () => !!owner && ctx.activeAccount?.id === owner &&
      !ctx.closedFlag && !ctx.signedOut && !ctx.accountRetiring && ctx.store === store &&
      ctx.connectors === connectors && ctx.officialSessionIdentity() === activation && dispatcher.context(ctx.userId) === ctx;
    if (method !== "GET" && (!action || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
      return reject(409, "A current authenticated MCP App capability is required.");
    if (!owner || !fetch || !current()) return reject(501, "MCP Apps are unavailable.");
    if (uploadedBody !== undefined || segments || method !== "POST" && (request.body !== undefined || request.contentType !== undefined))
      return reject(400, "Invalid MCP App transport request.");
    return mcpAppToolbox.handle({
      ...appConnector,
      accountId: owner,
      headers: request.mcpAppToolbox,
      ...(request.body instanceof Uint8Array ? { body: request.body } : {}),
      ...(typeof request.contentType === "string" ? { contentType: request.contentType } : {}),
      signal: frame.signal,
      host: {
        activation,
        settings: () => store.settings,
        policy: () => ctx.policy(),
        current,
        fetch,
        onRetire: (close) => ctx.onAccountDeactivating(close),
        async codeScope({ sessionId, toolUseId }, { serverName, toolName }) {
          const key = /^(?:session|cse)_([a-f0-9]{32})$/.exec(sessionId)?.[1];
          if (!key || !current()) return false;
          const conversation = store.conversations.find((row) =>
            isOwnedCloudCodeSession(row, owner) &&
            (!row.sessionAuthors || row.sessionAuthors.viewerAccountUuid === owner) &&
            cloudCodeSessionKey(row, owner) === key,
          );
          return codeMcpAppAllowsTool(conversation, toolUseId, serverName, toolName);
        },
        headers(name, url) {
          const saved = savedConnectorHeaders(store.root, name, url);
          const token = connectors.getToken?.(name);
          return token ? { ...saved, Authorization: `Bearer ${token}` } : saved;
        },
      },
    });
  }
  // Capability replies identify the authenticated Web user; adapter storage keeps its internal account UUID.
  if (request.path === officialUiCapabilitiesPath) {
    if (action || request.method !== "GET" || request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(400, "Invalid capabilities query.");
    const descriptor = await chat.describe();
    return chat.current() ? { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({...descriptor, accountId: String(frame.user.id)})) } : reject(409, "The account activation changed.");
  }
  if (capabilityPreference) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat"))
      return reject(501, "Capability preferences are unavailable on this host.");
    const store = ctx.store;
    const current = () => !ctx.accountRetiring && ctx.store === store &&
      chat.current() && chat.accepts(request.capabilityLease) && !frame.signal?.aborted;
    if (!current()) return reject(409, "A current authenticated capability lease is required.");
    try {
      if (!(await store.persistCapabilityPreference(capabilityPreference, current)))
        return reject(409, "Disable code execution before changing Artifacts.");
    } catch {
      return current() ? reject(503, "The capability preference could not be confirmed.")
        : reject(409, "The account activation changed.");
    }
    if (!current()) return reject(409, "The account activation changed.");
    ctx.settingsChanged();
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(capabilityPreference)) };
  }
  if (modelFallback) {
    if (chat.mode !== "engine-chat" ||
        !dispatcher.guard.modes.includes(modelFallback.kind === "code" ? "code" : "chat") ||
        (modelFallback.kind === "model" && modelFallback.resetCode && !dispatcher.guard.modes.includes("code")))
      return reject(501, "Model fallback settings are unavailable on this host.");
    const store = ctx.store;
    const current = () => !ctx.accountRetiring && ctx.store === store &&
      chat.current() && chat.accepts(request.capabilityLease) && !frame.signal?.aborted;
    if (!current()) return reject(409, "A current authenticated capability lease is required.");
    try {
      if (!(await store.persistModelFallback(modelFallback, current)))
        return reject(409, "Model fallback settings changed. Reload settings before saving.");
    } catch {
      return current()
        ? reject(503, "The model fallback setting could not be confirmed.")
        : reject(409, "The account activation changed.");
    }
    if (!current()) return reject(409, "The account activation changed.");
    ctx.settingsChanged();
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(modelFallbackWire(modelFallback))) };
  }
  if (codeSettings) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code settings are unavailable on this host.");
    const store = ctx.store;
    const current = () => !ctx.accountRetiring && ctx.store === store &&
      chat.current() && chat.accepts(request.capabilityLease);
    if (!current()) return reject(409, "A current authenticated capability lease is required.");
    try {
      await store.persistCodeSettings(codeSettings.patch, current);
    } catch {
      return current()
        ? reject(503, "The Code settings save could not be confirmed.")
        : reject(409, "The account activation changed.");
    }
    if (!current()) return reject(409, "The account activation changed.");
    ctx.settingsChanged();
    return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(codeSettings.wire)) };
  }
  if (privacy) {
    if (request.path !== url.pathname + url.search || uploadedBody !== undefined)
      return reject(400, "Invalid privacy consent request.");
    if (ctx.accountRetiring || chat.mode !== "engine-chat")
      return reject(501, "This memory mode is unavailable.");
    const organization = organizationUuid(ctx.activeAccount?.id ?? "");
    if (privacyHeaderRequired && request.privacyOrganizationId !== organization ||
        privacy.organization !== undefined && privacy.organization !== organization)
      return reject(404, "Organization not found.");
    if (action && !chat.accepts(request.capabilityLease))
      return reject(409, "A current authenticated capability lease is required.");
  }
  let melangeOwner: MelangeEditOwner | undefined;
  if (melangeRoute || melangeEdit) {
    if (request.path !== url.pathname + url.search || (method === "POST") !== action)
      return reject(400, "Invalid memory request.");
    if (ctx.accountRetiring || chat.mode !== "engine-chat")
      return reject(501, "This memory mode is unavailable.");
    if (uploadedBody !== undefined)
      return reject(400, "Memory requests require inline JSON.");
    const organization = (melangeRoute ?? melangeEdit)?.organization;
    if (organization !== organizationUuid(ctx.activeAccount?.id ?? ""))
      return reject(404, "Organization not found.");
    if (melangeRoute?.operation === "edit")
      return reject(400, "Use the Web memory edit stream.");
    if (melangeEdit) {
      const { tabId, webSession } = frame.user;
      if (!isWebTabId(tabId) || !webSession) return reject(401, "Sign in to edit memory.");
      melangeOwner = { activation: ctx.officialSessionIdentity(), tab: tabId, session: webSession.id };
      if (melangeEdit.kind !== "start") {
        if (request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
          return reject(400, "Invalid memory edit request.");
        const edits = officialMelangeEdits(ctx);
        return melangeEdit.kind === "poll"
          ? edits.poll(melangeEdit.id, melangeOwner, melangeEdit.cursor)
          : edits.stop(melangeEdit.id, melangeOwner);
      }
    }
    if (action && !chat.accepts(request.capabilityLease))
      return reject(409, "A current authenticated capability lease is required.");
  }
  const codeReceipt = officialCodeReceiptPath(request.method as string, request.path);
  if (codeReceipt) {
    if (!dispatcher.guard.modes.includes("code") || request.body !== undefined ||
        request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(403, "Code message confirmation is unavailable.");
    return confirmOfficialCodeReceipt(ctx, codeReceipt.key, codeReceipt.eventId, () =>
      !ctx.closedFlag && !ctx.signedOut && dispatcher.context(ctx.userId) === ctx);
  }
  const coworkDevices = officialCoworkDevices(method, request.path);
  if (coworkDevices) {
    if (request.body !== undefined || request.contentType !== undefined || request.capabilityLease !== undefined)
      return reject(400, "Invalid Cowork device query.");
    if (!dispatcher.options.officialUiActions || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("cowork"))
      return reject(501, "Cloud Cowork device selection is unavailable on this host.");
    const owner = ctx.activeAccount?.id;
    const identity = ctx.officialSessionIdentity();
    const current = () => !ctx.accountRetiring && dispatcher.context(ctx.userId) === ctx &&
      ctx.activeAccount?.id === owner && ctx.officialSessionIdentity() === identity;
    if (!owner) return reject(409, "The account activation changed.");
    return readOfficialCoworkDevices(coworkDevices, owner, () => ctx.chatDeviceController.directory(), current);
  }
  if (coworkCreation) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("cowork"))
      return reject(501, "Cloud Cowork session creation is unavailable on this host.");
    if (uploadedBody !== undefined) {
      request.body = await readUpload(
        { request: (op, user, data) => dispatcher.options.link.request(op, user, data) },
        frame.user.id, uploadedBody, officialUiRequestLimit(method, request.path),
      );
    }
    const current = () => !ctx.accountRetiring && chat.accepts(request.capabilityLease);
    return reserveOfficialCoworkWarm(frame, ctx, coworkCreation, request, current) ??
      createOfficialCoworkSession(dispatcher, frame, ctx, coworkCreation, request, current);
  }
  if (codeCreation) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code session creation is unavailable on this host.");
    return createOfficialCodeSession(ctx, request,
      () => !ctx.accountRetiring && chat.accepts(request.capabilityLease));
  }
  if (codeUpload && (!action || chat.mode !== "engine-chat" ||
      !dispatcher.guard.modes.includes("code") || !chat.accepts(request.capabilityLease)))
    return reject(403, "A current Code attachment capability is required.");
  if (chatUpload && (!action || chat.mode !== "engine-chat" ||
      !(dispatcher.guard.modes.includes("chat") || dispatcher.guard.modes.includes("cowork")) || !chat.accepts(request.capabilityLease)))
    return reject(403, "A current attachment capability is required.");
  if (chatUpload && (!ctx.activeAccount || chatUpload !== organizationUuid(ctx.activeAccount.id)))
    return reject(404, "Organization not found.");
  if (codeFollowup) {
    if (uploadedBody !== undefined && action && chat.mode === "engine-chat" &&
        (dispatcher.guard.modes.includes("code") ||
          codeFollowup.wrapped && dispatcher.guard.modes.includes("cowork"))) {
      const capabilityLease = request.capabilityLease;
      if (!chat.accepts(capabilityLease))
        return reject(409, "A current authenticated capability lease is required.");
      request.body = await readUpload(
        { request: (op, user, data) => dispatcher.options.link.request(op, user, data) },
        frame.user.id, uploadedBody, officialUiRequestLimit("POST", request.path),
      );
      if (!chat.accepts(capabilityLease))
        return reject(409, "The account activation changed.");
    }
    if (codeFollowup.wrapped && action && chat.mode === "engine-chat" && dispatcher.guard.modes.includes("cowork")) {
      const warm = await claimOfficialCoworkWarm(dispatcher, frame, ctx, codeFollowup.key, request,
        () => !ctx.accountRetiring && chat.accepts(request.capabilityLease));
      if (warm) return warm;
    }
    const coworkSession = codeFollowup.wrapped && dispatcher.guard.modes.includes("cowork") &&
      officialCoworkApprovalSession(ctx, codeFollowup.key);
    if (coworkSession && action && chat.mode === "engine-chat") {
      const current = () => !ctx.accountRetiring && chat.accepts(request.capabilityLease);
      if (!current()) return reject(409, "A current authenticated capability lease is required.");
      return respondOfficialCoworkApproval(ctx, coworkSession, codeFollowup.key, request, current) ??
        submitOfficialCoworkFollowup(dispatcher, frame, ctx, codeFollowup.key, request, current);
    }
    if (!action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code follow-ups are unavailable on this host.");
    const capabilityLease = request.capabilityLease;
    if (!chat.accepts(capabilityLease))
      return reject(409, "A current authenticated capability lease is required.");
    const identity = ctx.officialSessionIdentity();
    const answer = await submitOfficialCodeFollowup(dispatcher, frame, ctx, codeFollowup, request,
      () => chat.accepts(capabilityLease));
    return answer.body.byteLength > officialUiReadMaxBytes
      ? finishLargeResponse(answer, identity)
      : answer;
  }
  if (codeConnectors) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code connector changes are unavailable on this host.");
    const current = () => chat.current() && chat.accepts(request.capabilityLease);
    if (!current()) return reject(409, "A current authenticated capability lease is required.");
    return saveOfficialCodeConnectorSelection(ctx, codeConnectors, request, current);
  }
  if (coworkMcp) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("cowork"))
      return reject(501, "Cloud Cowork connector reconciliation is unavailable on this host.");
    const current = () => chat.current() && chat.accepts(request.capabilityLease);
    if (!current()) return reject(409, "A current authenticated capability lease is required.");
    return reconcileOfficialCoworkMcp(ctx, coworkMcp, request, current);
  }
  if (codeRead) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code read updates are unavailable on this host.");
    const current = () => chat.current() && chat.accepts(request.capabilityLease);
    if (!current()) return reject(409, "A current authenticated capability lease is required.");
    return acknowledgeOfficialCodeRead(ctx, codeRead, request, current);
  }
  if (codeMutation) {
    if (codeMutation.kind === "delete" && action && chat.mode === "engine-chat" &&
        dispatcher.guard.modes.includes("cowork")) {
      const discarded = discardOfficialCoworkWarm(frame, ctx, codeMutation.key, request,
        () => !ctx.accountRetiring && chat.current() && chat.accepts(request.capabilityLease));
      if (discarded) return discarded;
    }
    if (codeMutation.kind === "delete" && officialCoworkApprovalSession(ctx, codeMutation.key)) {
      if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("cowork"))
        return reject(501, "Cloud Cowork deletion is unavailable on this host.");
      return deleteOfficialCoworkSession(dispatcher, frame, ctx, codeMutation.key, request,
        () => !ctx.accountRetiring && chat.current() && chat.accepts(request.capabilityLease));
    }
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code session changes are unavailable on this host.");
    return mutateOfficialCodeSession(ctx, codeMutation, request,
      () => !ctx.accountRetiring && chat.current() && chat.accepts(request.capabilityLease));
  }
  if (codePullRequest) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return officialCodePullRequestError(501, "Cloud Code pull requests are unavailable on this host.");
    if (uploadedBody !== undefined)
      return officialCodePullRequestError(400, "Pull request creation requires inline JSON.");
    return createOfficialCodePullRequest(ctx, codePullRequest, request,
      () => !ctx.accountRetiring && !frame.signal?.aborted && chat.current() && chat.accepts(request.capabilityLease));
  }
  if (codePrMonitor) {
    if (!dispatcher.guard.modes.includes("code") || (action && chat.mode !== "engine-chat"))
      return reject(501, "Cloud Code pull request monitoring is unavailable on this host.");
    return officialCodePrMonitor(ctx, codePrMonitor, request,
      () => !ctx.accountRetiring && !frame.signal?.aborted && chat.current() &&
        (!action || chat.accepts(request.capabilityLease)));
  }
  if (codeTerminal) {
    if (chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("code"))
      return reject(501, "Cloud Code terminals are unavailable on this host.");
    return runOfficialCodeTerminal(dispatcher, frame, ctx, codeTerminal.key, request,
      () => !ctx.accountRetiring && chat.accepts(request.capabilityLease));
  }
  let memoryMap=memoryAuthorities.get(dispatcher);
  if(!memoryMap){memoryMap=new WeakMap();memoryAuthorities.set(dispatcher,memoryMap);}
  let memory=memoryMap.get(ctx);
  if(!memory||!memory.current()){
    memory=createMemoryAuthority({accountId:()=>ctx.activeAccount?.id,identity:()=>ctx.officialSessionIdentity(),root:()=>ctx.store.root,
      service:()=>ctx.services?.memory?.service,current:()=>!ctx.closedFlag&&!ctx.signedOut&&!ctx.accountRetiring&&contextCurrent(),
      controlsEnabled:()=>dispatcher.options.officialUiMemoryControls===true,
      resetEnabled:()=>dispatcher.options.officialUiActions===true,
      preferencesEnabled: () => dispatcher.options.officialUiActions === true && chat.mode === "engine-chat",
      synthesisAvailable: () => {
        const { providers, activeProviderId } = ctx.store.settings;
        return dispatcher.methods.includes("synthesizeMemory") && ctx.handlers.has("synthesizeMemory") &&
          providers.some(provider => provider.id === activeProviderId);
      },
    });
    memoryMap.set(ctx,memory);
  }
  if(request.path===officialMemoryCapabilitiesPath){
    if(action||request.method!=="GET"||request.body!==undefined||request.contentType!==undefined||request.capabilityLease!==undefined)
      return reject(400,"Invalid memory capabilities query.");
    const descriptor=memory.describe();
    return memory.current()?{status:200,contentType:"application/json",body:Buffer.from(JSON.stringify({...descriptor, accountId: String(frame.user.id)}))}:reject(409,"The account activation changed.");
  }
  if (memoryAction) {
    if (!memory.accepts(request.capabilityLease)) return reject(409, "A current authenticated memory capability lease is required.");
    if (!memory.ready(memoryAction)) return reject(501, "This memory operation is unavailable.");
  }
  let appearanceMap=appearanceAuthorities.get(dispatcher);
  if(!appearanceMap){appearanceMap=new WeakMap();appearanceAuthorities.set(dispatcher,appearanceMap);}
  let appearance=appearanceMap.get(ctx);
  if(!appearance||!appearance.current()){
    appearance=createAppearanceAuthority({accountId:()=>ctx.activeAccount?.id,identity:()=>ctx.officialSessionIdentity(),root:()=>ctx.store.root,
      current:()=>!ctx.closedFlag&&!ctx.signedOut&&dispatcher.context(ctx.userId)===ctx,
      enabled:()=>dispatcher.options.officialUiAppearanceSettings===true,locales:()=>officialLocales(root)});
    appearanceMap.set(ctx,appearance);
  }
  if(request.path===officialAppearanceCapabilitiesPath){
    if(action||request.method!=="GET"||request.body!==undefined||request.contentType!==undefined||request.capabilityLease!==undefined)
      return reject(400,"Invalid appearance capabilities query.");
    return appearance.current()?{status:200,contentType:"application/json",body:Buffer.from(JSON.stringify({...appearance.describe(), accountId: String(frame.user.id)}))}:reject(409,"The account activation changed.");
  }
  if(appearanceAction){
    if(!appearance.accepts(request.capabilityLease))return reject(409,"A current authenticated appearance capability lease is required.");
    if(appearance.describe().appearance.state!=="ready")return reject(501,"Appearance settings are unavailable.");
  }
  if (connectorAuth) {
    if (!action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease))
      return reject(409, "A current authenticated Chat capability is required.");
    const account = ctx.activeAccount;
    if (!account || connectorAuth.organizationId !== organizationUuid(account.id))
      return reject(404, "Connector not found.");
    const name = Object.keys(ctx.store.settings.mcpServers).find(value => connectorUuid(value) === connectorAuth.serverId);
    const host = ctx.connectors;
    const store = ctx.store;
    const identity = ctx.officialSessionIdentity();
    const config = name && store.settings.mcpServers[name] as Record<string, unknown> | undefined;
    if (!name || !config || typeof config.url !== "string" || config.command || config.enabled === false || !host ||
        !connectorAllowed(ctx.policy(), name, config))
      return reject(404, "Connector not found.");
    const resource = config.url;
    const transport = config.claudex_transport;
    const current = () => {
      const target = store.settings.mcpServers[name] as Record<string, unknown> | undefined;
      return !ctx.closedFlag && !ctx.signedOut && !ctx.accountRetiring && dispatcher.context(ctx.userId) === ctx &&
        ctx.activeAccount?.id === account.id && ctx.officialSessionIdentity() === identity &&
        ctx.store === store && ctx.connectors === host &&
        target?.url === resource && target.claudex_transport === transport &&
        !target.command && target.enabled !== false && connectorAllowed(ctx.policy(), name, target) &&
        chat.accepts(request.capabilityLease);
    };
    const catalog = ctx.mcpConfig;
    const discover = async () => {
      const result = await catalog.readCatalog(name);
      if (!current()) throw Error("The account or connector changed.");
      return result.servers.find(server => server.name === name);
    };
    if (connectorAuth.kind === "logout") {
      const oauth = ctx.connectorOAuth;
      if (!oauth) return reject(501, "Connector sign-out is unavailable.");
      if (!current()) return reject(409, "The account or connector changed.");
      try {
        await oauth.revoke(name, resource);
      } catch (error) {
        if (!current() || error instanceof ConnectorOAuthRevocationError && error.reason === "retired")
          return reject(409, "The account or connector changed.");
        if (error instanceof ConnectorOAuthRevocationError && error.reason === "unavailable")
          return reject(409, "OAuth sign-out is unavailable for this connector.");
        return reject(503, "Connector authorization could not be revoked. Try again.");
      }
      if (!current()) return reject(409, "The account or connector changed.");
      try {
        catalog.clearAuthFailure(name);
        if ((await discover())?.authStatus === "notLoggedIn")
          return { status: 204, contentType: "application/json", body: Buffer.alloc(0) };
      } catch {}
      return current()
        ? reject(503, "The connector signed out, but its connection status could not be confirmed.")
        : reject(409, "The account or connector changed.");
    }
    try {
      if (connectorAuth.kind === "start") {
        const params = url.searchParams;
        const returnUrl = params.get("claudex_return_url");
        if (params.get("response_format") !== "json" || !returnUrl || request.body !== undefined)
          return reject(400, "Invalid connector sign-in request.");
        const redirect = URL.parse(returnUrl);
        if (!redirect || !["https:", "http:"].includes(redirect.protocol) || redirect.username || redirect.password || redirect.hash ||
            (ctx.runtime?.serviceUrl && redirect.origin !== new URL(ctx.runtime.publicUrl ?? ctx.runtime.serviceUrl).origin))
          return reject(400, "Invalid connector sign-in request.");
        const conversationId = params.get("conversation_uuid");
        const toolUseId = params.get("tool_use_id");
        const toolRejection = conversationId !== null || toolUseId !== null;
        if (toolRejection) {
          const conversation = store.conversations.find((row) => row.id === conversationId);
          if (params.get("after_auth_rejection") !== "true" || !toolUseId ||
              !matchesConnectorAuthRejection(conversation, name, resource, toolUseId))
            return reject(404, "Connector tool call not found.");
        }
        catalog.clearAuthFailure(name);
        const server = await discover();
        if (!toolRejection && server?.state === "ready" && server.authStatus !== "notLoggedIn")
          return { status: 200, contentType: "application/json", body: Buffer.from('{"connected":true}') };
        if ((!toolRejection && server?.authStatus !== "notLoggedIn") || !host.beginLogin)
          return reject(503, "Connector discovery failed.");
        const address = await dispatcher.run({ ...frame, method: "connectConnector", args: encodeWireValue([name, returnUrl]) as unknown[] }, { context: ctx, identity });
        if (typeof address !== "string") return reject(503, "Connector sign-in is unavailable.");
        if (!current()) return reject(409, "The account or connector changed.");
        const state = new URL(address).searchParams.get("state");
        if (!state) return reject(502, "Connector sign-in is unavailable.");
        return { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ auth_url: address, state })) };
      }
      if (!host.completeLogin || !(request.body instanceof Uint8Array) || request.body.byteLength > 16384) {
        catalog.markAuthFailure(name);
        return reject(400, "Invalid connector callback.");
      }
      const callback = connectorOAuthCallback.safeParse(JSON.parse(Buffer.from(request.body).toString("utf8")));
      if (!callback.success) {
        catalog.markAuthFailure(name);
        return reject(400, "Invalid connector callback.");
      }
      const body = callback.data;
      if ("error" in body) {
        const oauth = ctx.connectorOAuth;
        if (!oauth) return reject(501, "Connector sign-in is unavailable.");
        if (!current()) return reject(409, "The account or connector changed.");
        if (oauth.cancel(body.state, name) !== name) return reject(404, "Connector sign-in attempt not found.");
        return { status: 204, contentType: "application/json", body: Buffer.alloc(0) };
      }
      const completed = await dispatcher.run({ ...frame, method: "completeConnectorLogin", args: encodeWireValue([body.state, body.code, name, body.iss]) as unknown[] }, { context: ctx, identity });
      if (!current() || completed !== name) return reject(409, "The account or connector changed.");
      const server = await discover();
      if (server?.state !== "ready" || server.authStatus !== "bearerToken") {
        catalog.markAuthFailure(name);
        return reject(503, "Connector authentication could not be confirmed.");
      }
      return { status: 200, contentType: "application/json", body: Buffer.from('{"connected":true}') };
    } catch {
      if (current()) catalog.markAuthFailure(name);
      return reject(current() ? 503 : 409, "Connector sign-in failed.");
    }
  }
  if (incognitoDiscard && (ctx.accountRetiring || !action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if (chatBulkDelete && (ctx.accountRetiring || !action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if (isOfficialResearchStop(method, request.path) && (ctx.accountRetiring || !action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if (officialReplyFeedbackTarget(method, request.path) && (ctx.accountRetiring || !action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if (leafAction && (!action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if (connector && (!action || chat.mode !== "engine-chat" || !dispatcher.guard.modes.includes("chat") || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if (customConnector) {
    if (!chat.accepts(request.capabilityLease) || ctx.accountRetiring)
      return reject(409, "A current authenticated Chat capability is required.");
    if (customConnector.organizationId !== organizationUuid(ctx.activeAccount?.id ?? ""))
      return reject(404, "Organization not found.");
    if (uploadedBody !== undefined)
      return reject(400, "Custom connector requests require inline JSON.");
  }
  if (connectorLifecycle) {
    if (chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease) || ctx.accountRetiring)
      return reject(409, "A current authenticated Chat capability is required.");
    if (connectorLifecycle.organizationId !== organizationUuid(ctx.activeAccount?.id ?? ""))
      return reject(404, "Organization not found.");
    if (!ctx.policy().localMcpEditing || !ctx.mcpConfig?.commitCustomConnector ||
        connectorLifecycle.kind === "refresh" && !ctx.mcpConfig.readCatalog)
      return reject(403, "Connector changes are unavailable.");
  }
  if (designCreation && (ctx.accountRetiring || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated capability lease is required to create a Design artifact.");
  if (designCreation && (uploadedBody !== undefined || segments || !(request.body instanceof Uint8Array) ||
      request.body.byteLength > officialDesignCreateMaxBytes || !/^application\/json(?:\s*;|$)/i.test(request.contentType ?? "")))
    return reject(400, "Design creation requires an inline JSON body.");
  if (sideQuestionAction && (!action || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if ((publicationAction || sharingAction) && (!action || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated Chat capability is required.");
  if ((skillCreation || skillUpload) && (ctx.accountRetiring || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated capability lease is required to save a skill.");
  if (skillChange && (ctx.accountRetiring || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
    return reject(409, "A current authenticated capability lease is required to change a skill.");
  if (skillChange && uploadedBody !== undefined)
    return reject(400, "Skill changes require an inline JSON body.");
  if (organizationPluginMutation && (ctx.accountRetiring || chat.mode !== "engine-chat" || !chat.accepts(request.capabilityLease)))
    return reject(409, "Reload the plugin library before changing a plugin.");
  // Older authenticated engine actions predate capability discovery. Strict
  // requests and callers that negotiate a lease must use the current lease.
  if (chatAction && (modelPreference || projectMove || projectMetadata || projectCreation || projectDeletion || projectKnowledge || projectMemory || projectOrganizationWrite || chat.mode === "strict-text" || request.capabilityLease !== undefined) && !chat.accepts(request.capabilityLease))
    return reject(409, "A current authenticated capability lease is required.");
  if (chatAction && chat.mode === "strict-text") {
    const projectChatRoute = /^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)\/(?:completion|retry_completion2?|stop_response)$/.exec(url.pathname);
    if (projectChatRoute && (projectChatRoute[1] !== organizationUuid(ctx.activeAccount?.id ?? "") ||
        ctx.store.conversations.find(c => c.id === projectChatRoute[2])?.projectOrganizationId))
      return reject(403, "Organization project chats require the standard Chat engine.");
    if (isOfficialUiRetrySubmission(request.method as string, request.path as string))
      return reject(501, "Strict text mode does not support message retries.");
    if (!isOfficialUiCompletionSubmission(request.method as string, request.path as string) && officialUiConversationMutation(request.method as string, request.path as string) !== "stop")
      return reject(501, "Strict text mode does not support this action.");
    // Strict execution is not owned by the legacy conversation engine. Until
    // the executor supplies an operation-bound cancellation handle, never send
    // its Stop to generic interrupt (which could target an unrelated run).
    if (officialUiConversationMutation(request.method as string, request.path as string) === "stop")
      return reject(501, "Strict text cancellation is unavailable: no original executor cancellation handle is installed.");
    // Discovery is repeated before reserving disk state, but is not an execution
    // permit. The executor is checked again at the canonical send boundary.
    if (isOfficialUiCompletionSubmission(request.method as string, request.path as string)) {
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body as Uint8Array));
        if (typeof value?.prompt === "string" && isResearchCommand(value.prompt) ||
            value?.create_conversation_params?.compass_mode === "advanced")
          return reject(501, "Research is unavailable in strict text mode.");
      } catch { /* The adapter rejects malformed requests. */ }
      const capability = await chat.describe();
      if (!chat.current()) return reject(409, "The account activation changed.");
      if (capability.textChat.state !== "ready") return reject(501, "Strict text execution is unavailable.");
    }
  } else if (chatAction && request.capabilityLease !== undefined && chat.mode !== "engine-chat") {
    return reject(501, "Chat engine actions are unavailable.");
  } else if (!action && request.capabilityLease !== undefined) {
    return reject(400, "Capability leases are only accepted for actions.");
  }
  if (uploadedBody !== undefined || segments) {
    if (request.method === "GET") return reject(400, "A read request cannot contain an uploaded body.");
    if (skillUpload) {
      const organization = ctx.activeAccount && organizationUuid(ctx.activeAccount.id);
      if (!organization || url.pathname.split("/")[3]?.toLowerCase() !== organization)
        return reject(404, "Organization not found.");
      if (typeof request.contentType !== "string" || !/^multipart\/form-data(?:\s*;.*)?$/i.test(request.contentType))
        return reject(400, "Skill uploads require a multipart body.");
    }
    const identity = ctx.officialSessionIdentity();
    const transport = { request: dispatcher.options.link.request.bind(dispatcher.options.link) };
    if (segments && segmentedLimit) {
      const parts: Uint8Array[] = [];
      let total = 0;
      for (const segment of segments) {
        const remaining = Math.min(knowledgeFileLimit, segmentedLimit - total);
        const id = uploadRef(segment);
        const bytes = id ? await readUpload(transport, frame.user.id, id, remaining) : segment;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > remaining)
          return reject(400, "Invalid upload body.");
        parts.push(bytes);
        total += bytes.byteLength;
      }
      request.body = Buffer.concat(parts, total);
    } else if (uploadedBody !== undefined) {
      request.body = await readUpload(transport, frame.user.id, uploadedBody,
        officialUiRequestLimit(request.method as string, request.path));
    }
    if (ctx.closedFlag || ctx.signedOut || skillUpload && ctx.accountRetiring || dispatcher.context(ctx.userId) !== ctx || ctx.officialSessionIdentity() !== identity || !chat.current())
      return reject(409, "The account activation changed.");
  }

  let byContext = adapters.get(dispatcher);
  if (!byContext) { byContext = new WeakMap(); adapters.set(dispatcher, byContext); }
  let entry = byContext.get(ctx);
  if (!entry) {
    let usageReaders: Map<string, (...args: any[]) => unknown> | undefined;
    const scope = new AsyncLocalStorage<{ frame: CallFrame; identity: unknown; shell: boolean; chat?: ReturnType<typeof createStrictTextSession>; memory?: { action: OfficialMemoryAction; authority: ReturnType<typeof createMemoryAuthority> }; appearance?: ReturnType<typeof createAppearanceAuthority>; request: OfficialUiReadRequest; spendLimitMutation?: SpendLimitMutation; connector?: OfficialConnectorPreference; customConnector?: ReturnType<typeof officialCustomConnectorTarget>; connectorLifecycle?: OfficialConnectorLifecycleTarget }>();
    const isCurrent = (identity: unknown) => {
      const call = scope.getStore();
      return !ctx.closedFlag && !ctx.signedOut && ctx.officialSessionIdentity() === identity &&
        (call?.shell
          ? !call.frame.signal?.aborted && dispatcher.isShellContextCurrent(ctx)
          : dispatcher.context(ctx.userId) === ctx);
    };
    const refreshListedDevices = (conversations: readonly Conversation[]) => {
      if (conversations.some(conversation => conversation.chatDeviceBinding))
        void ctx.chatDeviceController.refresh().catch(error => ctx.log(String(error)));
    };
    const currentChat = () => {
      const call = scope.getStore();
      const chat = chatSessions.get(dispatcher)?.get(ctx);
      return call && call.frame.user.id === ctx.userId && chat?.mode === "engine-chat" &&
        chat.current() && isCurrent(call.identity) && !ctx.accountRetiring &&
        dispatcher.options.officialUiActions && dispatcher.guard.modes.includes("chat") ? call : undefined;
    };
    let chatElicitation: ReturnType<typeof engineChatElicitation> | undefined;
    let elicitationIdentity: unknown;
    const canCreateCustomConnector = () => {
      const chat = chatSessions.get(dispatcher)?.get(ctx);
      return chat?.mode === "engine-chat" && chat.current() && !ctx.accountRetiring &&
        !!ctx.connectors?.fetch && ctx.policy().localMcpEditing &&
        ctx.handlers.has("probeConnector") && ctx.handlers.has("addCustomConnector");
    };
    const authorizeCustomConnector = (kind: "add" | "probe") => {
      const call = scope.getStore();
      if (!call || call.frame.method !== "officialUiAction" || call.customConnector?.kind !== kind ||
          call.customConnector.organizationId !== organizationUuid(ctx.activeAccount?.id ?? "") ||
          !isCurrent(call.identity) || !call.chat?.accepts(call.request.capabilityLease) || !canCreateCustomConnector())
        throw Error("Custom connector creation is unavailable.");
    };
    const authorizeConnectorLifecycle = (target: OfficialConnectorLifecycleTarget, name: string) => {
      const call = scope.getStore();
      const server = ctx.store.settings.mcpServers[name];
      if (!call || call.frame.method !== "officialUiAction" ||
          call.connectorLifecycle?.kind !== target.kind ||
          call.connectorLifecycle.serverId !== target.serverId ||
          call.connectorLifecycle.organizationId !== target.organizationId ||
          target.organizationId !== organizationUuid(ctx.activeAccount?.id ?? "") ||
          target.serverId !== connectorUuid(name) ||
          !isCurrent(call.identity) || ctx.accountRetiring ||
          call.chat?.mode !== "engine-chat" || !call.chat.accepts(call.request.capabilityLease) ||
          !ctx.policy().localMcpEditing || !ctx.mcpConfig?.commitCustomConnector ||
          !Object.hasOwn(ctx.store.settings.mcpServers, name) ||
          !server || typeof server !== "object" || !("url" in server) ||
          typeof server.url !== "string" || "command" in server ||
          target.kind === "refresh" && (!ctx.mcpConfig.readCatalog ||
            "enabled" in server && server.enabled === false || !connectorAllowed(ctx.policy(), name, server)))
        throw Error("The connector lifecycle request changed.");
    };
    const authorizeConnectorPreferences = (kind: "account" | "chat", pageId?: string) => {
      const call = scope.getStore();
      if (!call || call.frame.method !== "officialUiAction" || call.chat?.mode !== "engine-chat" ||
          !call.chat.current() || !isCurrent(call.identity))
        throw Error("The connector settings request changed.");
      const rest = call.connector?.kind === kind && (call.connector.kind !== "chat" ||
        call.connector.pageId === pageId && call.connector.organizationId === organizationUuid(ctx.activeAccount?.id ?? ""));
      // The adapter verifies the protobuf action and its exact page before calling this authority.
      const send = kind === "chat" && call.request.path === officialUiActionPath &&
        call.request.method === "POST" && call.chat.accepts(call.request.capabilityLease);
      if (!rest && !send)
        throw Error("The connector settings request changed.");
    };
    const dispatch = async (method: string, originalArgs: unknown[]) => {
      const call = scope.getStore();
      const custom = call?.customConnector;
      const customConnectorProbe = custom?.kind === "probe" && method === "probeConnector";
      const customConnectorAdd = custom?.kind === "add" && method === "addCustomConnector";
      if (custom) {
        authorizeCustomConnector(custom.kind);
        if (!customConnectorProbe && !customConnectorAdd && method !== "mcpServers" &&
            !(custom?.kind === "add" && method === "listApprovedDirectory"))
          throw Error("Custom connector creation does not authorize this operation.");
      }
      const lifecycle = call?.connectorLifecycle;
      const lifecycleMethod = lifecycle?.kind === "refresh" ? "refreshConnectorTools" : "removeConnector";
      const lifecycleName = originalArgs[0];
      if (lifecycle) {
        if (method !== lifecycleMethod || originalArgs.length !== 1 || typeof lifecycleName !== "string")
          throw Error("The connector lifecycle request changed.");
        authorizeConnectorLifecycle(lifecycle, lifecycleName);
      }
      const connectorWrite = call?.connector && (
        call.connector.kind === "account"
          ? method === "setConnectorToolPermissions"
          : method === "updateConversation" && originalArgs.length === 2 &&
            originalArgs[0] === resolveConversationId(call.connector.pageId));
      if (call?.connector) {
        authorizeConnectorPreferences(call.connector.kind, call.connector.kind === "chat" ? call.connector.pageId : undefined);
        if (!connectorWrite && !allowedInternal.has(method))
          throw Error("Connector preferences do not authorize this operation.");
      }
      const discard = method === "discardIncognito" && call?.chat?.mode === "engine-chat" &&
        call.frame.method === "officialUiAction" && call.chat.accepts(call.request.capabilityLease) &&
        originalArgs[0] === resolveConversationId(officialUiIncognitoDiscardTarget(call.request.method, call.request.path) ?? "") &&
        (originalArgs.length === 1 || originalArgs.length === 2 && (() => {
          try {
            const body = call.request.body;
            if (!(body instanceof Uint8Array)) return false;
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
            return value && Object.keys(value).length === 1 && value.draftId === originalArgs[1] && typeof value.draftId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.draftId);
          } catch { return false; }
        })());
      const fileUpload = call?.chat?.mode === "engine-chat" && call.frame.method === "officialUiAction" &&
        method === "addAttachmentData" && (officialCodeUploadOrganization(call.request.method, call.request.path) ||
          officialChatUploadOrganization(call.request.method, call.request.path));
      const isExistingTemporary = (id: string) => ctx.store.conversations.some(c => c.id === resolveConversationId(id) && !!c.incognito);
      const derivedUpload = call?.chat?.mode === "engine-chat" && call.frame.method === "officialUiAction" &&
        method === "addAttachmentData" && (matchesOfficialInlineUpload(call.request, root, originalArgs, isExistingTemporary) || matchesOfficialRestTextUpload(call.request, originalArgs, isExistingTemporary));
      const retry = method === "retryResponse" && call?.chat?.mode === "engine-chat" &&
        (call.request.path === officialUiActionPath || isOfficialUiRetrySubmission(call.request.method, call.request.path));
      const edit = method === "editPrompt" && call?.frame.method === "officialUiAction" &&
        (call.request.path === officialUiActionPath && call.request.method === "POST" ||
          isOfficialUiCompletionSubmission(call.request.method, call.request.path)) &&
        call.chat?.mode === "engine-chat" && dispatcher.guard.modes.includes("chat") &&
        call.chat.accepts(call.request.capabilityLease);
      const leafPage = call && officialChatLeafTarget(call.request.method, call.request.path);
      const leafSelection = method === "selectChatLeaf" && call?.frame.method === "officialUiAction" &&
        call.chat?.mode === "engine-chat" && (leafPage
          ? originalArgs[0] === resolveConversationId(leafPage)
          : call.request.path === officialUiActionPath);
      const chatFork = method === "forkConversation" && call?.frame.method === "officialUiAction" &&
        call.request.path === officialUiActionPath && call.chat?.mode === "engine-chat" &&
        dispatcher.guard.modes.includes("chat") && call.chat.accepts(call.request.capabilityLease);
      const skillWrite = method === "saveSkill" && originalArgs[1] === officialSkillAuthoring &&
        call?.frame.method === "officialUiAction" &&
        call.chat?.mode === "engine-chat" && call.chat.accepts(call.request.capabilityLease) &&
        isOfficialSkillCreation(call.request.method, call.request.path);
      const skillUpload = method === "installSkillFiles" &&
        call?.frame.method === "officialUiAction" &&
        call.chat?.mode === "engine-chat" && call.chat.accepts(call.request.capabilityLease) &&
        !!officialSkillUploadKind(call.request.method, call.request.path);
      const skillChange = call?.frame.method === "officialUiAction" &&
        call.chat?.mode === "engine-chat" && call.chat.accepts(call.request.capabilityLease) &&
        (method === "deleteSkill" && isOfficialSkillDeletion(call.request.method, call.request.path) ||
          method === "setSkillEnabled" && isOfficialSkillToggle(call.request.method, call.request.path) ||
          method === officialSkillCopyRenameMethod(call.request.method, call.request.path));
      const knowledgeAction = call?.chat?.mode === "engine-chat" && call.frame.method === "officialUiAction"
        ? officialUiProjectKnowledgeMutation(call.request.method, call.request.path) : undefined;
      const knowledgeMethod = knowledgeAction === "upload" ? "addProjectKnowledgeFiles"
        : knowledgeAction === "text" ? "addProjectKnowledgeText" : knowledgeAction === "delete" ? "removeProjectKnowledge" : undefined;
      const knowledgeWrite = (method === knowledgeMethod || knowledgeAction === "upload" && method === "confirmProjectKnowledgeUpload") &&
        typeof originalArgs[0] === "string" &&
        call?.request.path.split("/")[5] === originalArgs[0];
      const trigger = call && triggerRoute(call.request.method, call.request.path);
      const triggerOperation = trigger && codeTriggerOperationAllowed(trigger.kind, method);
      const internalTrigger = triggerOperation && (method === "officialCodeRoutineRun" || method === "officialCodeRoutineCancel");
      const submission = call && officialDirectorySubmissionTarget(call.request.method, call.request.path);
      const directoryOperation = !!submission && dispatcher.options.officialUiActions &&
        (method === "listDirectorySubmissions" ||
          submission.write && ["saveDirectorySubmission", "deleteDirectorySubmission", "publishDirectorySubmission", "verifyDirectorySubmissionTools"].includes(method));
      const researchReportRead = method === "readResearchReport" && call?.frame.method === "officialUiRead" &&
        call.request.method === "GET" && isOfficialUiFileReadPath(call.request.path);
      const replyFeedback = call?.frame.method === "officialUiAction" &&
        (call.request.path === officialUiActionPath || !!officialReplyFeedbackTarget(call.request.method, call.request.path)) && call.chat?.mode === "engine-chat" &&
        call.chat.accepts(call.request.capabilityLease) &&
        (method === "setReplyFeedback" || method === "submitReplyFeedback");
      const memoryAction = call?.memory?.action;
      const memoryWrite = memoryAction === "controls" && method === "replaceMemoryControls" ||
        memoryAction === "reset" && method === "resetMemory" ||
        memoryAction === "synthesize" && method === "synthesizeMemory" ||
        memoryAction === "settings" && (method === "resetMemory" || method === "setMemoryPrefs");
      if (!call || call.frame.user.id !== ctx.userId || !isCurrent(call.identity) ||
          !(directoryOperation || researchReportRead || discard || replyFeedback || triggerOperation || connectorWrite || lifecycle || customConnectorProbe || customConnectorAdd || retry || edit || leafSelection || chatFork || skillWrite || skillUpload || skillChange || knowledgeWrite || fileUpload || derivedUpload || allowedInternal.has(method) || memoryWrite || call.frame.method === "officialUiAction" && dispatcher.options.officialUiActions &&
            ["send", "setConversationWebSearch", "setConversationResearch", "updateConversation", "deleteConversation", "interrupt"].includes(method)))
        throw Object.assign(Error("The account or request changed."), { code: webErrorCodes.badRequest });
      if(call.appearance){
        call.appearance.assertAppearance();
        if(!allowedInternal.has(method))throw Error("Appearance does not authorize this operation.");
      }
      const usageRoute = call.frame.method === "officialUiRead" && call.request.method === "GET"
        ? /^\/api\/organizations\/[^/]+\/claudex_usage_activity\/(overview|breakdown|records)(?:\?|$)/.exec(call.request.path)?.[1] : undefined;
      const accountingRead = ({ overview: "usageOverview", breakdown: "usageBreakdown", records: "usageRecords" } as Record<string, string>)[usageRoute ?? ""] === method;
      if (!accountingRead && !internalTrigger && !leafSelection && !chatFork && !customConnectorProbe && lifecycle?.kind !== "refresh") guardCall(method, skillUpload ? originalArgs.slice(0, 1) : originalArgs, dispatcher.guard);
      const assertMemoryCurrent = () => {
        if (!call.memory?.authority.accepts(call.request.capabilityLease) ||
            !call.memory.authority.ready(call.memory.action))
          throw Error("This memory operation is unavailable.");
      };
      if (call.memory) {
        if (!call.memory.authority.accepts(call.request.capabilityLease) ||
            (!allowedInternal.has(method) && !memoryWrite))
          throw Error("The memory request changed.");

        if (method === "replaceMemoryControls" &&
            (originalArgs.length !== 4 || JSON.stringify(originalArgs[3]) !== '{"nonGenerating":true}'))
          throw Error("Non-generating memory controls are required.");
        if (method === "resetMemory" &&
            (originalArgs.length !== 2 || JSON.stringify(originalArgs[1]) !== '{"classicOnly":true}' ||
              memoryAction === "settings" && originalArgs[0] !== undefined))
          throw Error("The memory reset scope changed.");
        if (method === "setMemoryPrefs") {
          const intent = parseOfficialMemorySettings(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(call.request.body)));
          if (!intent || intent.kind === "mode" && intent.mode === "melange")
            throw Error("The memory settings request changed.");
          const { key, enabled } = officialMemorySettingsPreference(intent);
          const disableOnly = key === "generate" && !enabled;
          const allowed = disableOnly ? call.memory.authority.canPause() : call.memory.authority.preferences()?.[key];
          const expected = disableOnly ? [{ generate: false }, { disableOnly: true }] : [{ [key]: enabled }];
          if (!allowed || JSON.stringify(originalArgs) !== JSON.stringify(expected))
            throw Error("The memory settings request changed.");
        }
      }
      if (call.chat && (!call.chat.current() || isOfficialUiChatBulkDelete(call.request.method, call.request.path) &&
          (ctx.accountRetiring || !call.chat.accepts(call.request.capabilityLease)))) throw Error("The account activation changed.");
      if (call.chat?.mode === "strict-text") {
        if (method === "send") {
          const input = originalArgs[0];
          if (input && typeof input === "object" && "incognito" in input && input.incognito === true)
            throw Error("Temporary chats are unavailable in strict text mode.");
          return call.chat.execute(call.request, input);
        }
        if (!allowedInternal.has(method)) throw Error("Strict text mode does not support this operation.");
      }
      if (call.shell) {
        let value: unknown;
        if (method === "modelCatalog" && originalArgs.length === 0 ||
            method === "memoryStatus" && originalArgs.length === 1 && JSON.stringify(originalArgs[0]) === '{"snapshotOnly":true}') {
          const handler = ctx.handlers.get(method);
          if (!handler || !dispatcher.methods.includes(method)) throw Error("The read is unavailable.");
          value = await handler(...originalArgs);
        } else if (method === "turnAttachment" && originalArgs.length === 2 &&
            typeof originalArgs[0] === "string" && typeof originalArgs[1] === "string") {
          const [conversationId, attachmentId] = originalArgs;
          const store = ctx.store;
          const conversation = await store.readConversation(conversationId);
          if (!isCurrent(call.identity)) throw Error("The account activation changed.");
          const found = conversation && readOwnedTurnAttachment({ root: store.root, conversation: () => conversation }, conversationId, attachmentId);
          value = found ? { data: found.data } : null;
        } else throw Error("The read requires loaded history.");
        if (!isCurrent(call.identity)) throw Error("The account activation changed.");
        return value;
      }
      // These browser-owned RPC names remain unavailable over the runner network.
      // The account-scoped REST adapter uses their existing validated read handlers.
      if (accountingRead && !usageReaders) {
        usageReaders = new Map();
        registerUsageStatsHandlers((name, handler) => { usageReaders!.set(name, handler); }, ctx);
      }
      const result = internalTrigger
        ? await dispatcher.run({ ...call.frame, method, args: encodeWireValue(originalArgs) as unknown[] }, { context: ctx, identity: call.identity, officialRoutine: true })
        : accountingRead
        ? await usageReaders!.get(method)!(...originalArgs)
        : await dispatcher.run({ ...call.frame, method, args: encodeWireValue(skillWrite ? originalArgs.slice(0, 1) : originalArgs) as unknown[] }, {
          context: ctx, identity: call.identity, officialInventory: method === "mcpServers", officialSkillAuthoring: skillWrite, officialSkillUpload: skillUpload,
          ...(memoryWrite ? { assertMemoryCurrent } : {}),
          ...(leafSelection ? { officialChatLeaf: true as const } : {}),
          ...(chatFork ? { officialChatFork: true as const } : {}),
          ...(customConnectorProbe ? { officialConnectorProbe: true as const } : {}),
          ...(lifecycle && typeof lifecycleName === "string" ? {
            officialConnectorLifecycle: {
              method: lifecycleMethod,
              assertCurrent: () => authorizeConnectorLifecycle(lifecycle, lifecycleName),
            },
          } : {}),
        });
      if (!isCurrent(call.identity) || call.chat && !call.chat.current() || call.memory && !call.memory.authority.current() || call.appearance && !call.appearance.current()) throw Error("The account activation changed.");
      if (method === "turnAttachment" && result == null && dispatcher.guard.modes.includes("code") &&
          typeof originalArgs[0] === "string" && typeof originalArgs[1] === "string")
        return readOfficialCodeQueueAttachment(dispatcher, call.frame, ctx, originalArgs[0], originalArgs[1]);
      if (method === "mcpServers") {
        const catalog = result as import("../../shared/settings-desktop-api").McpServers;
        return { ...catalog, servers: catalog.servers.map(server => server.authStatus === "notLoggedIn" && server.state === "ready" ? { ...server, state: "stopped" as const } : server) };
      }
      if (fileUpload || derivedUpload) {
        const id = (result as { id?: unknown })?.id;
        const stored = typeof id === "string" && ctx.selectedAttachments.get(id);
        if (!stored) throw Error("The upload could not be verified.");
        return stored; // Internal adapter checks the path; the browser receives uploadAnswer.
      }
      return result;
    };
    const attachmentScope = () => {
      const active=scope.getStore();
      if(active?.chat?.mode !== "strict-text")
        throw new CompletionAttachmentError(501,"attachments_unavailable","Attachment sending requires a verified strict executor; ordinary text actions do not enable attachments.");
      if(!isCurrent(active.identity) || !active.chat.current())
        throw new CompletionAttachmentError(409,"attachment_activation_changed","The account activation changed before attachment sending.");
      return { session: active.chat, request: active.request };
    };
    const createEmptyChat = (input: EmptyChatInput) => {
      const call = scope.getStore();
      if (call?.chat?.mode !== "engine-chat" ||
          !isOfficialUiConversationCreation(call.request.method, call.request.path))
        throw Error("Independent Chat creation is unavailable.");
      const store = ctx.store;
      return persistEmptyChat(input, store,
        () => ctx.store === store && isCurrent(call.identity) && call.chat!.current(),
        () => {
          const environment = newConversationSpace();
          return { environment, cwd: path.join(ctx.spaceRoot(environment.spaceId), "workspace") };
        },
        (conversation) => ctx.push({ type: "conversation", conversation: structuredClone(conversation) }),
      );
    };
    const createProject = async (project: Project) => {
      const call = scope.getStore();
      if (call?.chat?.mode !== "engine-chat" || !isOfficialUiProjectCreation(call.request.method, call.request.path))
        throw Error("Project creation is unavailable.");
      const store = ctx.store;
      const saved = await store.persistProjectCreation(project,
        () => ctx.store === store && isCurrent(call.identity) && call.chat!.current());
      ctx.push({ type: "resync" });
      return saved;
    };
    const updateProjectMetadata = async (projectId: string, patch: ProjectMetadataPatch) => {
      const call = scope.getStore();
      if (call?.chat?.mode !== "engine-chat" || !isOfficialUiProjectMetadataUpdate(call.request.method, call.request.path))
        throw Error("Project metadata updates are unavailable.");
      const store = ctx.store;
      const saved = await store.persistProjectMetadata(projectId, patch,
        () => ctx.store === store && isCurrent(call.identity) && call.chat!.current());
      if (saved) ctx.push({ type: "resync" });
      return saved;
    };
    const deleteProject = async (projectId: string) => {
      const call = scope.getStore();
      const owner = ctx.activeAccount?.id;
      if (!call || !owner || call.frame.method !== "officialUiAction" ||
          call.chat?.mode !== "engine-chat" || !call.chat.accepts(call.request.capabilityLease) ||
          !isCurrent(call.identity) || call.request.method !== "DELETE" ||
          call.request.path !== `/api/organizations/${organizationUuid(owner)}/projects/${projectId}`)
        throw Error("Project deletion is unavailable.");
      await dispatcher.run({
        ...call.frame,
        method: "deleteProject",
        args: [{ id: projectId, mode: "cascade" }],
      }, { context: ctx, identity: call.identity });
    };
    let publication: ReturnType<typeof webArtifactPublication> | undefined;
    let publicationIdentity: unknown;
    let publicationOwner: string | undefined;
    let publicationRoot: string | undefined;
    const canManageOrganizationPlugins = () => dispatcher.options.officialUiActions === true &&
      dispatcher.options.officialUiStrictTextChat === undefined;
    const withOrganizationPluginRequest = () => {
      const call = scope.getStore();
      const remote = ctx.remote;
      const current = () => !!call && isCurrent(call.identity) && !ctx.accountRetiring &&
        ctx.remote === remote && !call.frame.signal?.aborted;
      if (!call || !remote?.ready || !current()) throw Error("The account changed.");
      return { call, remote, current };
    };
    const runOrganizationPlugin = async (
      method: OrganizationPluginMethod,
      args: unknown[],
    ) => {
      const { call, current } = withOrganizationPluginRequest();
      const assertCurrent = () => {
        if (!current() || !canManageOrganizationPlugins()) throw Error("Organization plugin management is unavailable.");
        if (method === "setOrganizationPluginEnabled" || method === "removeOrganizationPlugin") {
          const target = officialOrganizationPluginMutation(call.request.method, call.request.path);
          const kind = method === "removeOrganizationPlugin" ? "remove" : "enable";
          if (call.frame.method !== "officialUiAction" || target?.kind !== kind || target.id !== args[0] ||
              target.organization !== organizationUuid(ctx.activeAccount?.id ?? "") || !call.chat?.accepts(call.request.capabilityLease))
            throw Error("The organization plugin request changed.");
        } else if (call.frame.method !== "officialUiRead") {
          throw Error("Organization plugin reads require a query.");
        }
      };
      assertCurrent();
      return dispatcher.run({ ...call.frame, method, args: encodeWireValue(args) as unknown[] }, {
        context: ctx, identity: call.identity, organizationPlugin: { method, assertCurrent },
      });
    };
    const organizationPlugins: RunnerOfficialHost["organizationPlugins"] = {
      readPluginOrganization(target) {
        const { remote, current } = withOrganizationPluginRequest();
        return remote.session.authorized(token => remote.backend.client.call(pluginOrganizationServicePath(target), { token }), current);
      },
      readOrganizationPluginStates: async candidates => canManageOrganizationPlugins()
        ? await runOrganizationPlugin("readOrganizationPluginStates", [candidates]) as Awaited<ReturnType<NonNullable<AdapterContext["readOrganizationPluginStates"]>>>
        : undefined,
      readOrganizationPluginDetails: async id => canManageOrganizationPlugins()
        ? await runOrganizationPlugin("readOrganizationPluginDetails", [id]) as Awaited<ReturnType<NonNullable<AdapterContext["readOrganizationPluginDetails"]>>>
        : undefined,
      setOrganizationPluginEnabled: (id, enabled) => runOrganizationPlugin("setOrganizationPluginEnabled", [id, enabled]),
      removeOrganizationPlugin: id => runOrganizationPlugin("removeOrganizationPlugin", [id]),
    };
    const organizationProjectAuthorization = (write: boolean) => {
      const active = scope.getStore();
      const remote = ctx.remote;
      const current = () => !!active && isCurrent(active.identity) && !ctx.accountRetiring &&
        ctx.remote === remote && !active.frame.signal?.aborted;
      if (!active || !remote?.ready || !current()) throw Error("The account changed.");
      if (write && (active.frame.method !== "officialUiAction" || active.chat?.mode !== "engine-chat" ||
          !active.chat.accepts(active.request.capabilityLease)))
        throw Error("Organization project changes are unavailable.");
      return { remote, current };
    };
    const organizationProjects: NonNullable<RunnerOfficialHost["organizationProjects"]> = {
      get baseUrl() { return ctx.runtime.serviceUrl; },
      call(route, method, body) {
        const { remote, current } = organizationProjectAuthorization(Boolean(method && method !== "GET"));
        return remote.session.authorized(token => remote.backend.client.call(route, { token, method, body }), current);
      },
      readKnowledge(route) {
        const { remote, current } = organizationProjectAuthorization(false);
        return remote.session.authorized(token =>
          organizationKnowledgeRequest(remote.backend.client, token, route), current);
      },
      uploadKnowledge(route, bytes, mediaType) {
        const { remote, current } = organizationProjectAuthorization(true);
        return remote.session.authorized(token =>
          organizationKnowledgeRequest(remote.backend.client, token, route, { bytes, mediaType }), current);
      },
    };
    const host = {
      organizationPlugins,
      get organizationProjects() { return ctx.remote?.ready ? organizationProjects : undefined; },
      webSearchAllowed: () => ctx.policy().webSearch,
      get spendLimitMutation() { return scope.getStore()?.spendLimitMutation; },
      melange: async (discover = true) => {
        const call = scope.getStore();
        if (!call || ctx.accountRetiring || !isCurrent(call.identity) ||
            chatSessions.get(dispatcher)?.get(ctx)?.mode !== "engine-chat") return undefined;
        const service = discover ? await readyMelangeForAccount(ctx) : existingMelangeForAccount(ctx);
        return !ctx.accountRetiring && isCurrent(call.identity) ? service : undefined;
      },
      authorizeProjectMemoryUpdate: (projectId: string) => {
        const call = scope.getStore();
        const owner = ctx.activeAccount?.id;
        return !!call && !!owner && !ctx.accountRetiring && call.frame.method === "officialUiAction" &&
          call.chat?.mode === "engine-chat" && call.chat.accepts(call.request.capabilityLease) &&
          isCurrent(call.identity) && call.request.method === "PUT" &&
          call.request.path === `/api/organizations/${organizationUuid(owner)}/projects/${projectId}/settings`;
      },
      classicMelangeSources: () => classicSourcesForMelange(ctx),
      melangeSignal: () => scope.getStore()?.frame.signal,
      get chatPermissionModes() {
        return currentChat() ? availableChatPermissionModes(ctx.policy()) : undefined;
      },
      get chatElicitation() {
        const call = currentChat();
        const owner = ctx.activeAccount?.id;
        if (!call || !owner) return;
        const { identity } = call;
        if (!chatElicitation || elicitationIdentity !== identity) {
          const store = ctx.store;
          const current = () => isCurrent(identity) && ctx.store === store &&
            ctx.activeAccount?.id === owner && !ctx.accountRetiring;
          elicitationIdentity = identity;
          chatElicitation = engineChatElicitation({
            current,
            canRespond: () => {
              const action = currentChat();
              return !!action && action.identity === identity &&
                action.frame.method === "officialUiAction" && action.request.method === "POST" &&
                (action.request.path === officialUiActionPath || officialChatElicitationResult(action.request.method, action.request.path)) &&
                action.chat?.accepts(action.request.capabilityLease) === true;
            },
            conversation: id => {
              const row = store.conversations.find(candidate => candidate.id === id);
              if (row && (!row.sessionAuthors || row.sessionAuthors.ownerAccountUuid === owner &&
                  row.sessionAuthors.viewerAccountUuid === owner)) return row;
            },
            engine: id => ctx.engines.running(id),
          });
        }
        return chatElicitation;
      },
      authorizeConnectorPreferences,
      authorizeCustomConnector,
      authorizeConnectorLifecycle,
      get allowDirectorySubmissions() {
        return dispatcher.options.officialUiActions === true && !!ctx.remote?.ready && !ctx.accountRetiring;
      },
      get directoryTermsUrl() {
        return ctx.remote?.ready ? new URL(termsPath, ctx.remote.backend.accounts.baseUrl).href : undefined;
      },
      get allowCustomConnectorCreation() { return canCreateCustomConnector(); },
      sideQuestionGateway: async (conversation: import("../../shared/types").Conversation, model: string, signal: AbortSignal) => {
        const call=scope.getStore();
        if(!call?.chat || call.chat.mode!=="engine-chat" || call.frame.method!=="officialUiAction" || !officialSideQuestionAction(call.request.method,call.request.path) || !isCurrent(call.identity) || !call.chat.current())throw Error("Side questions are unavailable on this host.");
        const store=ctx.store,engine=ctx.engine,chat=call.chat;
        return ownedSideQuestionGateway({engine,store,conversation,model,signal,current:()=>ctx.store===store && ctx.engine===engine && isCurrent(call.identity) && chat.current()});
      },
      artifactPublishing: () => {
        if (chatSessions.get(dispatcher)?.get(ctx)?.mode !== "engine-chat" ||
            !dispatcher.guard.modes.includes("chat") || !ctx.session || ctx.closedFlag || ctx.signedOut) return undefined;
        const identity = ctx.officialSessionIdentity(), owner = ctx.activeAccount?.id, root = ctx.store.root;
        if (!owner) return undefined;
        if (publication && (publication.closed || publicationIdentity !== identity || publicationOwner !== owner || publicationRoot !== root)) {
          publication.close();
          publication = undefined;
        }
        if (!publication) {
          publicationIdentity = identity; publicationOwner = owner; publicationRoot = root;
          publication = webArtifactPublication(ctx);
        }
        return publication;
      },
      get richQuoteActions() { return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat"; },
      get officialCodeSettingsAvailable() {
        return dispatcher.options.officialUiActions === true && !ctx.accountRetiring &&
          dispatcher.guard.modes.includes("code") && chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat";
      },
      get allowCompletionConnectorMetadata() {
        const call = currentChat();
        return call?.frame.method === "officialUiAction" &&
          call.chat?.accepts(call.request.capabilityLease) === true;
      },
      readModelPreference: (surface: string) => ctx.store.settings.officialModelPreferences?.[surface] ?? {},
      saveModelPreference: async (surface: string, patch: Parameters<NonNullable<import("../../electron/official-ui/api/context").AdapterContext["saveModelPreference"]>>[1]) => {
        const call = scope.getStore();
        if (!call?.chat || call.chat.mode !== "engine-chat" || call.frame.method !== "officialUiAction" ||
            !isOfficialUiModelPreference(call.request.method, call.request.path) || !isCurrent(call.identity) || !call.chat.current())
          throw Error("Model preference changes are unavailable.");
        const store = ctx.store, previous = store.settings;
        const value = {...previous.officialModelPreferences?.[surface]};
        if (patch.model === null) delete value.model;
        else if (patch.model !== undefined) value.model = patch.model;
        if (patch.thinking === null) delete value.thinking;
        else if (patch.thinking !== undefined) value.thinking = patch.thinking;
        const next = {...previous, officialModelPreferences: {...previous.officialModelPreferences, [surface]: value}};
        store.settings = next;
        try { await store.persistModelPreference(); }
        catch (error) { if (ctx.store === store && isCurrent(call.identity) && store.settings === next) store.settings = previous; throw error; }
        if (ctx.store !== store || !isCurrent(call.identity) || !call.chat.current()) throw Error("The account activation changed.");
        if (JSON.stringify(store.settings.officialModelPreferences?.[surface]) !== JSON.stringify(value)) throw Error("The model preference was superseded. Reload its current value.");
        ctx.settingsListeners.emit(store.settings);
      },
      get allowProjectKnowledgeChanges() { return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat"; },
      get createProject() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" ? createProject : undefined;
      },
      get deleteProject() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" ? deleteProject : undefined;
      },
      get updateProjectMetadata() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" ? updateProjectMetadata : undefined;
      },
      get designArtifacts() {
        const call = scope.getStore();
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        const store = ctx.store;
        const { providers, activeProviderId } = store.settings;
        const provider = providers.find((item) => item.id === activeProviderId && item.model) ??
          providers.find((item) => item.model);
        if (!call || !chat || chat.mode !== "engine-chat" || !provider ||
            !dispatcher.options.officialUiActions || !dispatcher.guard.modes.includes("chat") ||
            !ctx.handlers.has("createBlankArtifact")) return undefined;
        const current = () => !call.frame.signal?.aborted && !ctx.accountRetiring &&
          isCurrent(call.identity) && ctx.store === store && chat.current();
        if (!current()) return undefined;
        return {
          async create(input: OfficialDesignCreationInput) {
            if (!current() || call.frame.method !== "officialUiAction" ||
                !chat.accepts(call.request.capabilityLease) ||
                officialDesignArtifactKind(call.request.method, call.request.path) !== "create")
              throw Error("Design creation is unavailable.");
            const result = await createOfficialBlankDesign(input, [provider], (artifact) => dispatcher.run({
              ...call.frame,
              method: "createBlankArtifact",
              args: [artifact],
            }, { context: ctx, identity: call.identity }));
            if (!current() || !chat.accepts(call.request.capabilityLease)) throw Error("The account changed.");
            return result;
          },
        };
      },
      get createEmptyChat() {
        return dispatcher.options.officialUiStrictTextChat === undefined && dispatcher.guard.modes.includes("chat")
          ? createEmptyChat : undefined;
      },
      saveAppearanceLocale: async (locale: string) => {
        const call=scope.getStore();
        if(!call?.appearance||call.frame.method!=="officialUiAction"||!isCurrent(call.identity)||!isOfficialLocaleAction(call.request.method,call.request.path))throw Error("Language changes are not available on this host.");
        const requested=call.request.body && JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(call.request.body));
        if(!validLocaleBody(requested)||requested.locale!==locale)throw Error("Invalid language request.");
        call.appearance.assertAppearance();
        const store=ctx.store;
        await saveAppearanceLocale({locale,store,policy:ctx.policy(),current:()=>ctx.store===store&&isCurrent(call.identity)&&call.appearance!.current(),changed:settings=>ctx.settingsListeners.emit(settings)});
      },
      saveAppearanceFont: async (font: import("../../shared/types").ChatFont) => {
        const call=scope.getStore();
        if(!call?.appearance||call.frame.method!=="officialUiAction"||!isCurrent(call.identity)||!isOfficialAppearanceAction(call.request.method,call.request.path))throw Error("Appearance settings are unavailable.");
        const requested=call.request.body && JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(call.request.body));
        if(!validAppearanceBody(requested)||requested.chat_font!==font)throw Error("Only the requested response font may change.");
        call.appearance.assertAppearance();
        const store=ctx.store;
        await saveAppearanceFont({font,store,policy:ctx.policy(),current:()=>ctx.store===store&&isCurrent(call.identity)&&call.appearance!.current(),changed:settings=>ctx.settingsListeners.emit(settings)});
      },
      authorizeAppearanceSettings: async () => {
        const call=scope.getStore();
        if(!call?.appearance||call.frame.method!=="officialUiAction"||!isCurrent(call.identity)||!isOfficialAppearanceAction(call.request.method,call.request.path))throw Error("Appearance settings are unavailable.");
        call.appearance.assertAppearance();
      },
      authorizeMemoryAction: (action: OfficialMemoryAction) => {
        const call = scope.getStore();
        if (!call?.memory || call.memory.action !== action || !isCurrent(call.identity) ||
            !call.memory.authority.accepts(call.request.capabilityLease) || !call.memory.authority.ready(action))
          throw Error("This memory operation is unavailable.");
      },
      memoryResetAvailable: () => memoryAuthorities.get(dispatcher)?.get(ctx)?.canPause() === true,
      memoryGenerationAvailable: () => memoryAuthorities.get(dispatcher)?.get(ctx)?.ready("synthesize") === true,
      memoryPreferenceActions: () => memoryAuthorities.get(dispatcher)?.get(ctx)?.preferences(),
      connectorAlwaysAllow: () => ctx.policy().approvalsAlwaysAllow,
      knowledgeOffer: async () => {
        const call = scope.getStore();
        if (!call || !isCurrent(call.identity) || ctx.accountRetiring)
          return undefined;
        const offer = await loadKnowledgeOffer(ctx);
        return offer && isCurrent(call.identity) && !ctx.accountRetiring &&
          hiwonderKnowledgeAllowed(ctx.policy(), offer.baseUrl) ? offer : undefined;
      },
      remoteConnectorSkills: () => {
        const call = scope.getStore();
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        return call && isCurrent(call.identity) && !ctx.accountRetiring &&
          chat?.mode === "engine-chat" && chat.current()
          ? remoteConnectorSkillsFor(ctx.store) : undefined;
      },
      readMemorySettings: async () => {
        const call = scope.getStore();
        if (!call || !isCurrent(call.identity) || ctx.accountRetiring)
          throw Error("The account activation changed.");
        return ctx.services.memory?.service.readSettings();
      },
      prepareCompletionAttachments: (input: import("../../electron/official-ui/api/completion-attachments").CompletionAttachmentInput) => attachmentScope().session.prepareAttachments(input),
      submitCompletionWithAttachments: (send: Record<string,unknown>, attachments: import("../../electron/official-ui/api/completion-attachments").PreparedCompletionAttachment[]) => {
        const { session, request } = attachmentScope();
        if (send.incognito === true) throw Error("Temporary chats are unavailable in strict text mode.");
        guardCall("send", [send], dispatcher.guard);
        return session.execute(request,send,attachments);
      },
      account: () => ctx.closedFlag || ctx.signedOut ? undefined : ctx.activeAccount,
      get allowSkillCreation() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" &&
          !ctx.accountRetiring && dispatcher.methods.includes("saveSkill");
      },
      get allowSkillVersionSave() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" &&
          !ctx.accountRetiring && dispatcher.methods.includes("installSkillFiles");
      },
      get allowSkillUpload() {
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        return chat?.mode === "engine-chat" && chat.current() && !ctx.accountRetiring &&
          ctx.handlers?.has("installSkillFiles") && dispatcher.methods.includes("installSkillFiles");
      },
      get allowSkillDelete() {
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        return chat?.mode === "engine-chat" && chat.current() && !ctx.accountRetiring &&
          ctx.handlers?.has("deleteSkill") && dispatcher.methods.includes("deleteSkill");
      },
      get allowSkillToggle() {
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        return chat?.mode === "engine-chat" && chat.current() && !ctx.accountRetiring &&
          ctx.handlers?.has("setSkillEnabled") && dispatcher.methods.includes("setSkillEnabled");
      },
      get allowSkillCopyRename() {
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        return chat?.mode === "engine-chat" && chat.current() && !ctx.accountRetiring &&
          ["duplicateSkill", "renameSkill"].every(method => ctx.handlers?.has(method) && dispatcher.methods.includes(method));
      },
      get officialCodeRewindAvailable() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat";
      },
      get officialCodeTerminalAvailable() {
        return !!ctx.runtime?.sandboxDriver && chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat";
      },
      get officialCodeWorkspaceDiffAvailable() {
        return typeof ctx.runtime?.workingTree === "function" &&
          chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat";
      },
      officialCodeWorkspaceDirectory: (conversation: Conversation) => officialCodeWorkspaceDirectory(ctx, conversation),
      codeUltracodeAvailable: (providerId: string, model: string, id?: string) => {
        const call = scope.getStore();
        if (!call || !isCurrent(call.identity)) return false;
        const conversation = id ? ctx.store.conversations.find((row) => row.id === id) : undefined;
        if (id && (!conversation || conversation.mode !== "code" ||
          conversation.environment?.kind === "ssh" || conversation.environment?.kind === "wsl")) return false;
        return ctx.engine.codeUltracodeAvailable(providerId, model);
      },
      officialCodeApprovals: () => ctx.engine?.approvals ?? [],
      officialCoworkApprovalControls: (id: string) => {
        const call = scope.getStore();
        const chat = chatSessions.get(dispatcher)?.get(ctx);
        return call && isCurrent(call.identity) && chat?.mode === "engine-chat" && chat.current()
          ? officialCoworkApprovalControls(ctx, id) : [];
      },
      officialCodeStopPersistence: {
        confirmed: (conversation: Conversation) => ctx.store.hasConfirmedCodeStops(conversation),
        confirm: (conversation: Conversation) => {
          const call = scope.getStore();
          const store = ctx.store;
          return store.confirmCodeStops(conversation, () =>
            !!call && ctx.store === store && isCurrent(call.identity));
        },
      },
      officialCodeHeldInputs: (id: string) => officialCodeHeldInputs(ctx.store.conversation(id)),
      officialCodeQueueInputs: (id: string) => {
        const call = scope.getStore();
        if (call && isCurrent(call.identity) && dispatcher.options.officialUiActions &&
            dispatcher.guard.modes.includes("code") && chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat") {
          resumeOfficialCodeQueues(dispatcher, call.frame, ctx, () => isCurrent(call.identity));
          return officialCodeQueueInputs(dispatcher, call.frame, ctx, ctx.store.conversation(id));
        }
      },
      officialCodeCommands: (id: string) => {
        const call = scope.getStore();
        if (call && isCurrent(call.identity) && dispatcher.options.officialUiActions &&
            chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat")
          return officialCodeCommands(ctx, ctx.store.conversation(id));
      },
      officialCodeAgentHistory: async (id: string, agentId: string, resume: boolean) => {
        const call = scope.getStore();
        if (!call) return;
        const store = ctx.store;
        const conversation = store.conversation(id);
        const owner = ctx.activeAccount?.id;
        const current = () => !!owner && isCurrent(call.identity) && ctx.store === store &&
          store.conversations.includes(conversation) && isOwnedCloudCodeSession(conversation, owner) &&
          !conversation.linkedToComputer && !conversation.chatDeviceBinding &&
          (!conversation.sessionAuthors || conversation.sessionAuthors.viewerAccountUuid === owner);
        if (!current()) return;
        const item = codeAgentOwner(conversation, agentId);
        if (!item) return;
        if (!resume && !conversation.archived) {
          try {
            await readCodeAgent({ store, engine: ctx.engineFor(id), current, push: (event) => ctx.push(event) }, id, agentId);
          } catch {
            if (!item.agentThreads?.[agentId]) return;
          }
        }
        return current() ? conversation : undefined;
      },
      officialCodeCommandControls: (id: string) => {
        const call = scope.getStore();
        return call && isCurrent(call.identity) && dispatcher.options.officialUiActions &&
          chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat"
            ? officialCodeCommandControls(ctx, id) : [];
      },
      settings: () => ctx.store.settings,
      isCurrent: () => {
        const call = scope.getStore();
        return !!call && isCurrent(call.identity);
      },
      readSnapshot: () => {
        const call = scope.getStore();
        if (call?.frame.method !== "officialUiRead" ||
            call.request.path !== officialUiRecentsPath) return undefined;
        if (!isCurrent(call.identity)) throw Error("The account activation changed.");
        const snapshot = ctx.snapshot();
        refreshListedDevices(snapshot.conversations);
        return {
          ...snapshot,
          approvals: [...snapshot.approvals, ...ctx.chatDeviceController.pendingApprovals()],
        };
      },
      historyInventory: () => {
        const call = scope.getStore();
        if (!call || !call.shell && (call.frame.method !== "officialUiRead" ||
            !isShellQuery(call.request.method, new URL(call.request.path, "http://localhost"))))
          return undefined;
        const store = ctx.store;
        const assertCurrent = () => {
          if (!isCurrent(call.identity) || ctx.store !== store)
            throw Error("The account activation changed.");
        };
        assertCurrent();
        if (call.shell)
          return {
            list: () => store.conversationInventory() ?? store.conversations,
            load: async (id: string) => {
              const conversation = await store.readConversation(id);
              assertCurrent();
              return conversation;
            },
          };
        const load = (id: string) =>
          store.conversations.some(conversation => conversation.id === id) ? store.conversation(id) : undefined;
        return {
          list: () => {
            refreshListedDevices(store.conversations);
            return store.conversations;
          },
          load: async (id: string) => {
            const conversation = load(id);
            if (!conversation?.chatDeviceBinding) return conversation;
            await ctx.chatDeviceController.refresh();
            assertCurrent();
            return load(id);
          },
        };
      },
      isIncognitoConversation: (id: string) => ctx.store.conversations.some(c => c.id === id && !!c.incognito),
      officialCodeRoutineFireUrl: (id: string) => new URL(`/api/v1/claudex/routines/${encodeURIComponent(id)}/fire`, ctx.runtime.serviceUrl).href,
      documentRuntime: process.env.CLAUDEX_RUNNER_DOCUMENT_RUNTIME,
      get image() {
        const call = scope.getStore();
        const size = ctx.runtime?.imageSize;
        return size && call && officialChatUploadOrganization(call.request.method, call.request.path)
          ? { size } : undefined;
      },
      sessionIdentity: () => ctx.officialSessionIdentity(), stateDirectory: () => ctx.store.root,
      connectorAuthPromptAvailable: (name: string, url: string) => {
        const call = scope.getStore();
        const server = ctx.store.settings.mcpServers[name] as { url?: unknown; enabled?: unknown } | undefined;
        return !!call && isCurrent(call.identity) &&
          chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" &&
          server?.url === url && server.enabled !== false && connectorAllowed(ctx.policy(), name, server) &&
          !ctx.mcpConfig.isAuthenticated(name, url);
      },
      ratings: () => ctx.replyFeedback.all(),
      onEvent: (listener: Parameters<WebAppContext["onEvent"]>[0]) => ctx.onEvent(listener),
      appVersion: ctx.appVersion, log: (...args: unknown[]) => ctx.log(args.map(String).join(" ")),
    };
    const adapter = createRunnerOfficialAdapter(host, dispatch, root, dispatcher.guard, {
      get allowTextActions() { return dispatcher.options.officialUiActions === true; },
      isChatBulkDeleteCurrent(lease) {
        const authority = chatSessions.get(dispatcher)?.get(ctx);
        return !ctx.accountRetiring && authority?.mode === "engine-chat" && authority.accepts(lease) === true;
      },
      get allowChatArtifactReview() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat" && dispatcher.guard.modes.includes("chat");
      },
      get allowConversationProjectMove() {
        return chatSessions.get(dispatcher)?.get(ctx)?.mode === "engine-chat";
      },
      get allowMemoryControls() { return dispatcher.options.officialUiMemoryControls === true; },
      get allowAppearanceSettings() { return dispatcher.options.officialUiAppearanceSettings === true; },
    });
    entry = {
      run(callFrame, input, shell, connector, edit, spendLimitMutation) {
        const action = callFrame.method === "officialUiAction";
        const appearance = action && !connector && isOfficialAppearanceAction(input.method, input.path);
        const memoryAction = action && officialMemoryAction(input.method, input.path);
        return scope.run({
          frame: callFrame, identity: ctx.officialSessionIdentity(), request: input, shell, connector, spendLimitMutation,
          customConnector: officialCustomConnectorTarget(input.method, input.path),
          connectorLifecycle: officialConnectorLifecycleTarget(input.method, input.path),
          ...(appearance ? { appearance: appearanceAuthorities.get(dispatcher)!.get(ctx)! } : {}),
          ...(memoryAction ? { memory: { action: memoryAction, authority: memoryAuthorities.get(dispatcher)!.get(ctx)! } } : {}),
          ...(action && !officialDirectorySubmissionTarget(input.method, input.path) && !spendLimitMutation && !appearance && !memoryAction && !triggerRoute(input.method, input.path) ? { chat: chatSessions.get(dispatcher)!.get(ctx)! } : {}),
        }, () => {
          if (!edit) return adapter(input);
          return adapter.stream(input, run => officialMelangeEdits(ctx).start(edit.id, edit.owner,
            () => !ctx.accountRetiring && isCurrent(edit.owner.activation) &&
              chatSessions.get(dispatcher)?.get(ctx)?.accepts(input.capabilityLease) === true,
            run, callFrame.signal));
        });
      },
    };
    byContext.set(ctx, entry);
  }
  const identity = ctx.officialSessionIdentity();
  const edit = melangeEdit?.kind === "start" && melangeOwner ? { id: melangeEdit.id, owner: melangeOwner } : undefined;
  const result = entry.run(frame, { method: request.method as OfficialUiReadRequest["method"],
    path: melangeEdit?.kind === "start" ? `/api/organizations/${melangeEdit.organization}/melange/edit` : request.path,
    ...(request.acceptEncoding === "gzip" ? { acceptEncoding: "gzip" as const } : {}),
    ...(typeof request.bootstrapCatalogRevision === "string" ? { bootstrapCatalogRevision: request.bootstrapCatalogRevision } : {}),
    ...(typeof request.codeOrganizationId === "string" ? { codeOrganizationId: request.codeOrganizationId } : {}),
    ...(typeof request.privacyOrganizationId === "string" ? { privacyOrganizationId: request.privacyOrganizationId } : {}),
    ...(typeof request.contentType === "string" ? { contentType: request.contentType } : {}),
    ...(typeof request.capabilityLease === "string" ? { capabilityLease: request.capabilityLease } : {}),
    ...(request.body instanceof Uint8Array ? { body: request.body } : {}) }, shell, connector, edit, spendLimitMutation);
  const largeResponse = isOfficialUiLargeResponse(request.method as string, url.pathname);
  if (!chatAction && !largeResponse && !shell) return result;
  const shellChanged = () => shell && (!contextCurrent() || frame.signal?.aborted || ctx.officialSessionIdentity() !== identity);
  const retiredShell = () => reject(409, "The account activation changed.");
  const answer = await result.catch(error => {
    if (shellChanged()) return retiredShell();
    throw error;
  });
  if (shellChanged()) return retiredShell();
  if (chatAction && !chat.current())
    return reject(409, projectDeletion
      ? "The account activation changed. Check the project list before retrying."
      : customConnector || connectorLifecycle
        ? "The account activation changed. Reopen connectors before retrying."
      : skillUpload || skillChange
        ? "The account activation changed. Reopen the skill before retrying."
        : "The account activation changed. Check the conversation before retrying.");
  if (!largeResponse) return answer;
  return finishLargeResponse(answer, identity);
}
