import { officialDesignArtifactKind, officialDesignArtifactTarget, officialDesignCreateMaxBytes } from "./official-design-artifacts";
import { officialDirectorySubmissionTarget, officialDirectorySubmissionMaxBytes } from "./official-directory-submissions";
import { officialReplyFeedbackTarget } from "./official-reply-feedback";
import { officialChatConnectorTarget } from "./official-connector-preferences";
import { officialSideQuestionAction, officialSideQuestionRead } from "./official-side-question";
import { officialCodeFollowupPath, officialCodeReceiptPath, officialCodeUploadOrganization, officialCodeUploadMaxBytes } from "./official-code-followup";
import { isOfficialCodeHistoryPath, isOfficialCodeTeleportPath, officialCodeConnectorSelection, officialCodeHistoryRequest, officialCodeMarkRead, officialCodeMutation, officialCodeMutationMaxBytes, officialCodeSessionCreation } from "./official-code-history";
import { officialCodeViewerMaxBytes, officialCodeViewerSession } from "./official-code-viewers";
import { officialCodeTerminalMaxBytes, officialCodeTerminalRequest } from "./official-code-terminal";
import { officialUsageActivityQuery } from "./official-usage-activity";
import {isOfficialAppearanceAction} from './official-appearance-capability';
import { officialMemoryAction } from "./official-memory-capability";
import { officialMelangeEditBodyBytes, officialMelangeEditRequest, officialMelangeImportBodyBytes, officialMelangePrivacyRoute, officialMelangeRoute } from "./official-melange";
import { isOfficialWorkspaceDownloadPath, officialWorkspaceDownload } from "./official-workspace-download";
import { isOfficialCodeWorkspacePath, officialCodeWorkspace } from "./official-code-workspace";
import { knowledgeFileLimit } from "./collections-api";
import { builtInAttachmentBytes } from "./client-policy";
import { officialResponseChunk, type OfficialResponseTransfer } from "./official-response-transfer";
import { officialCodePullRequestCreate, officialCodePullRequestCreateMaxBytes } from "./official-code-pull-requests";
import { officialCodePrMonitorActionMaxBytes, officialCodePrMonitorOperation, officialCodePrMonitorStatusMaxBytes } from "./official-code-pr-monitor";
import { officialCodePreviewControl } from "./official-code-preview";
import { isOfficialCodeTriggerPath, isOfficialCodeTriggerRead, officialCodeTriggerRequest } from "./official-code-triggers";
import { officialShareIdPattern } from "./official-share-link";
import { officialCodeSettingsPath } from "./official-code-settings";
import { officialCodeUserSettingsMaxBytes, officialCodeUserSettingsOrganization } from "./official-code-user-settings";
import { coworkMemoryMaxRequestBytes, officialCoworkMemory } from "./official-cowork-memory";
import { officialOrganizationPluginMutation, officialPluginOrganizationTarget } from "./official-plugin-organizations";
import { officialOrganizationProjectTarget } from "./official-project-organizations";
/** Narrow, experimental bridge for official Web reads and explicitly enabled actions. */
export interface OfficialUiReadRequest { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string; bootstrapCatalogRevision?: string; contentType?: string; body?: Uint8Array; capabilityLease?: string; codeOrganizationId?: string; privacyOrganizationId?: string; codeReadRevision?: number; acceptEncoding?: "gzip"; coworkMemoryEpoch?: string; coworkMemoryIfMatch?: string; codeUserSettingsChecksum?: string; mcpAppToolbox?: OfficialMcpAppToolboxHeaders }
export type OfficialUiWireRequest = OfficialUiReadRequest & { responseTransfer?: true; objectTransfer?: true };
export interface OfficialUiReadResponse {
  status: number;
  contentType: string;
  body: Uint8Array;
  contentDisposition?: string;
  bodyEncoding?: "gzip";
  mcpSessionId?: string;
  retryAfter?: "1";
  frameRefusal?: "create_in_flight";
  attachmentName?: string;
}
export type OfficialUiWireResponse = OfficialUiReadResponse & (
  | { responseTransfer?: undefined; responseOffset?: undefined; objectTransfer?: { url: string; size: number } }
  | { responseTransfer: OfficialResponseTransfer; responseOffset?: undefined }
  | { responseTransfer?: undefined; responseOffset: number }
);
/** Fits the existing 16 MiB runner-link frame after base64 encoding. */
export const officialUiReadMaxBytes = 4 * 1024 * 1024;
export const officialUiRequestMaxBytes = 64 * 1024;
/** The original composer allows 4 MiB of inline text, plus the protobuf prompt and metadata. */
export const officialUiActionMaxBytes = 5 * 1024 * 1024;
/** Leave space for the stored Code event envelope when images are read back. */
export const officialCodeFollowupMaxBytes = officialUiReadMaxBytes - officialUiRequestMaxBytes;
export const officialUiDefaultsPath = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/GetNewConversationDefaults";
/** The runner returns one bounded timeline frame per query; the browser follows account events. */
export const officialUiTimelinePath = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline";
export const officialUiActionPath = "/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction";

/** ChatMemoryMode values in the official conversation protocol. */
export const officialChatMemoryMode = { unspecified: 0, enabled: 1, disabled: 2 } as const;

export const officialUiRecentsPath = "/claudeai-rpc/anthropic.claudeai_chats.api.v1alpha.RecentsService/ListRecents";

export function isOfficialDesignCreateRetry(method: string, path: string, status: number) {
  if (status !== 409 && status !== 503) return false;
  const target = officialDesignArtifactTarget(method, path);
  return target?.kind === "create" && !!target.query?.idempotency_key;
}

const uuid = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const mcpAppToolboxPath = new RegExp(`^/v1/toolbox/shttp/mcp/(${uuid})$`);
export type OfficialMcpAppToolboxMethod = "POST" | "GET" | "DELETE";
export function officialMcpAppToolboxTarget(method: string, path: string): { method: OfficialMcpAppToolboxMethod; connectorId: string } | undefined {
  if (method !== "POST" && method !== "GET" && method !== "DELETE") return undefined;
  const match = mcpAppToolboxPath.exec(path);
  if (match?.[0] === path) return { method, connectorId: match[1] };
}
export function isOfficialMcpSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}
export interface OfficialMcpAppToolboxHeaders {
  organizationId: string;
  clientSessionId: string;
  sessionId?: string;
  protocolVersion?: string;
}
export function officialMcpAppToolboxHeaders(header: (name: string) => string | null | undefined): OfficialMcpAppToolboxHeaders {
  return {
    organizationId: header("x-organization-uuid") ?? "",
    clientSessionId: header("x-mcp-client-session-id") ?? "",
    sessionId: header("mcp-session-id") ?? undefined,
    protocolVersion: header("mcp-protocol-version") ?? undefined,
  };
}
const customConnectorPath = new RegExp(`^/api/organizations/(${uuid})/mcp/(remote_servers|probe)$`);
export function officialCustomConnectorTarget(method: string, path: string) {
  if (method !== "POST") return undefined;
  const match = customConnectorPath.exec(path);
  if (!match) return undefined;
  return { organizationId: match[1], kind: match[2] === "probe" ? "probe" as const : "add" as const };
}
const connectorLifecyclePath = new RegExp(`^/api/organizations/(${uuid})/mcp/remote_servers/(${uuid})(/clear_cache)?$`);
type ConnectorLifecycleScope = { organizationId: string; serverId: string };
export type OfficialConnectorLifecycleTarget = ConnectorLifecycleScope & (
  | { kind: "refresh" }
  | { kind: "remove" }
);
export function officialConnectorLifecycleTarget(method: string, path: string): OfficialConnectorLifecycleTarget | undefined {
  const match = connectorLifecyclePath.exec(path);
  if (!match) return undefined;
  const [, organizationId, serverId, refresh] = match;
  if (method === "POST" && refresh) return { kind: "refresh", organizationId, serverId };
  if (method === "DELETE" && !refresh) return { kind: "remove", organizationId, serverId };
}
// Original r$/JL/NV/zS consumers and historical attachment assets use these
// two URL forms. Opaque IDs retain the native composer's 500-character bound;
// they are registry keys, never filesystem paths or URL-encoded path segments.
const fileReadPath = new RegExp(`^/api/(?:organizations/)?${uuid}/files/(?:[A-Za-z0-9_-]{1,500}/(?:contents|content_preview|preview|thumbnail)|${uuid}/document_pdf)$`);
const documentTokenPath = new RegExp(`^/api/organizations/(${uuid})/convert_pdf_token$`);
const documentConversionPath = new RegExp(`^/api/organizations/${uuid}/convert_document$`);
const chatUploadPath = new RegExp(`^/api/(?:(${uuid})/upload|organizations/(${uuid})/cowork/attachments)$`);
export const officialChatUploadMaxBytes = builtInAttachmentBytes.document + 64 * 1024;
export function officialChatUploadOrganization(method: string, path: string) {
  const match = method === "POST" ? chatUploadPath.exec(path) : null;
  return match?.[1] ?? match?.[2];
}
export function isOfficialUiDocumentConversion(method: string, path: string) {
  return method === "POST" && documentConversionPath.test(path);
}
export function officialDocumentTokenOrganization(method: string, path: string) {
  return method === "POST" ? documentTokenPath.exec(path)?.[1] : undefined;
}
export const verifyDocumentPreviewTokenMethod = "verifyDocumentPreviewToken";
export const documentPreviewTokenHeader = "x-convert-pdf-token";
export const documentPreviewTokenVerificationPath = "/api/v1/claudex/web/document-preview-token";
const usageSummaryPath = new RegExp(`^/api/organizations/(${uuid})/claudex_usage_summary$`);
const spendLimitPath = new RegExp(`^/api/organizations/(${uuid})/overage_spend_limit$`);
export const officialSpendLimitActivationHeader = "x-claudex-spend-limit-activation";
export const officialSpendLimitBodyBytes = 1024;
export function officialUsageSummaryOrganization(method: string, path: string) {
  if (method !== "GET") return undefined;
  const query = path.indexOf("?");
  const match = usageSummaryPath.exec(query === -1 ? path : path.slice(0, query));
  return match && (path === match[0] || path === `${match[0]}?fresh=1`) ? match[1] : undefined;
}
export function officialSpendLimitActionOrganization(method: string, path: string) {
  const match = method === "PUT" ? spendLimitPath.exec(path) : undefined;
  return match?.[0] === path ? match?.[1] : undefined;
}
export function isOfficialUiUsageSummarySearch(search: string) { return search === "" || search === "?fresh=1"; }
const skillArchiveDownloadPath = new RegExp(`^/api/organizations/${uuid}/skills/download-dot-skill-file$`);
const skillCreationPath = new RegExp(`^/api/organizations/${uuid}/(?:plugins/account-author|skills/create-simple-skill)$`);
const skillUploadPath = new RegExp(`^/api/organizations/${uuid}/(skills/upload-skill|marketplaces/own-uploads/plugins/account-upload)(?:\\?[^#]*)?$`);
const skillDeletePath = new RegExp(`^/api/organizations/${uuid}/skills/delete-skill$`);
const skillTogglePath = new RegExp(`^/api/organizations/${uuid}/skills/(?:enable-skill|disable-skill)$`);
const skillCopyRenamePath = new RegExp(`^/api/organizations/${uuid}/skills/(duplicate|rename)-skill$`);
export const officialSkillCreateMaxBytes = 20 * 1024 * 1024;
export const MAX_OFFICIAL_SKILL_VERSION_SAVE_BYTES = 22 * 1024 * 1024;
export const officialSkillUploadMaxBytes = 30 * 1024 * 1024 + 64 * 1024;
export const officialSkillDeleteMaxBytes = 4096;
export const officialSkillToggleMaxBytes = 4096;
export const officialSkillCopyRenameMaxBytes = 4096;
export function isOfficialSkillCreation(method: string, pathname: string) {
  return method === "POST" && skillCreationPath.test(pathname);
}
export function officialSkillUploadKind(method: string, path: string): "legacy" | "account" | undefined {
  const route = method === "POST" && skillUploadPath.exec(path)?.[1];
  if (route) return route === "skills/upload-skill" ? "legacy" : "account";
}
export function isOfficialSkillDeletion(method: string, path: string): boolean {
  return method === "POST" && skillDeletePath.test(path);
}
export function isOfficialSkillToggle(method: string, path: string): boolean {
  return method === "POST" && skillTogglePath.test(path);
}
export function officialSkillCopyRenameMethod(method: string, path: string): "duplicateSkill" | "renameSkill" | undefined {
  const action = method === "POST" && skillCopyRenamePath.exec(path)?.[1];
  if (action === "duplicate") return "duplicateSkill";
  if (action === "rename") return "renameSkill";
}
const sharingConversation = `/api/organizations/${uuid}/chat_conversations/${uuid}`;
const latestSharePath = new RegExp(`^${sharingConversation}/latest$`);
const sharingReadPaths = [
  latestSharePath,
  new RegExp(`^${sharingConversation}/(?:share_access|shares|access_requests)$`),
  new RegExp(`^/api/organizations/${uuid}/shares$`),
  new RegExp(`^/api/__claudex/share-url/${officialShareIdPattern}$`),
];
const shareConversationPath = new RegExp(`^${sharingConversation}/share$`);
const revokeSharePath = new RegExp(`^/api/organizations/${uuid}/share/${officialShareIdPattern}$`);
const revokeShareGrantPath = new RegExp(`^/api/organizations/${uuid}/chat_snapshots/${officialShareIdPattern}/grants/${uuid}$`);

export function isOfficialUiConversationSharingMutation(method: string, path: string) {
  return method === "POST" && shareConversationPath.test(path) ||
    method === "DELETE" && (revokeSharePath.test(path) || revokeShareGrantPath.test(path));
}

const readable = [
  ...sharingReadPaths,
  /^\/api\/claudex\/appearance-capabilities\/version1$/,
  /^\/api\/claudex\/memory-capabilities\/version1$/,
  /^\/api\/claudex\/official-capabilities\/version1$/,
  usageSummaryPath,
  new RegExp(`^/api/organizations/${uuid}/claudex_usage_activity/(?:overview|breakdown|records)$`),
  /^\/api\/account$/,
  /^\/api\/frame\/artifacts$/,
  new RegExp(`^/api/organizations/${uuid}/artifacts/${uuid}/versions$`),
  new RegExp(`^/api/organizations/${uuid}/published_artifacts$`),
  /^\/api\/account_profile$/,
  /^\/api\/auth\/sessions\/list-active$/,
  // Exact reads expose truthful unavailable errors, never security mutations.
  /^\/api\/auth\/(?:mfa|trusted_devices)$/,
  /^\/api\/account\/deletion-allowed$/,
  /^\/api\/organizations$/,
  /^\/api\/organizations\/discoverable$/,
  fileReadPath,
  new RegExp(`^/api/organizations/${uuid}$`),
  /^\/(?:edge-)?api\/bootstrap$/,
  new RegExp(`^/(?:edge-)?api/bootstrap/${uuid}/(?:app_start|current_user_access)$`),
  new RegExp(`^/api/organizations/${uuid}/chat_conversations_v2$`),
  new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}$`),
  new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/serving$`),
  new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/task/${uuid}/status$`),
  new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/claudex_completion/${uuid}$`),
  new RegExp(`^/api/organizations/${uuid}/projects(?:_v2)?$`),
  new RegExp(`^/api/organizations/${uuid}/projects(?:_v2)?/count$`),
  new RegExp(`^/api/organizations/${uuid}/projects(?:_v2)?/${uuid}(?:/(?:docs|files|kb/stats|conversations(?:_v2)?|accounts|settings|syncs))?$`),
  new RegExp(`^/api/organizations/${uuid}/projects/${uuid}/docs/${uuid}$`),
  new RegExp(`^/api/organizations/${uuid}/projects/${uuid}/knowledge/${uuid}$`),
  new RegExp(`^/api/organizations/${uuid}/mcp/remote_servers(?:_with_connection)?$`),
  new RegExp(`^/api/organizations/${uuid}/mcp/v2/bootstrap$`),
  /^\/api\/directory\/(?:servers|plugins)$/,
  new RegExp(`^/api/organizations/${uuid}/directory/plugins$`),
  new RegExp(`^/api/organizations/${uuid}/mcp/remote_servers/${uuid}(?:/tool_policies)?$`),
  new RegExp(`^/api/organizations/${uuid}/skills/(?:list-skills|list-org-skills)$`),
  skillArchiveDownloadPath,
  new RegExp(`^/api/organizations/${uuid}/library/mine$`),
  new RegExp(`^/api/organizations/${uuid}/library/discover/browse$`),
  new RegExp(`^/api/organizations/${uuid}/plugins/(?:list-plugins|plugin_[a-f0-9]{24})$`),
  new RegExp(`^/api/organizations/${uuid}/memory(?:/settings)?$`),
  new RegExp(`^/api/organizations/${uuid}/(?:usage|prepaid/credits|overage_spend_limit)$`),
  // Claudex has no vendor domain-claim or vendor experience enrollment.
  new RegExp(`^/api/organizations/${uuid}/pending_domain_claim$`),
  new RegExp(`^/api/organizations/${uuid}/experiences/claude_web$`),
];
export function isOfficialUiFileReadPath(pathname: string) { return fileReadPath.test(pathname); }
export function isOfficialUiReadPath(pathname: string) {
  return !!officialOrganizationProjectTarget("GET", pathname) ||
    !!officialPluginOrganizationTarget("GET", pathname) || readable.some((pattern) => pattern.test(pathname));
}
export function isOfficialUiConversationSearch(method: string, pathname: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/conversation/search/v2$`).test(pathname);
}
export function isOfficialUiQuery(method: string, pathname: string, search = "") {
  const design = officialDesignArtifactKind(method, pathname + search);
  if (design === "types" || design === "list") return true;
  if (officialCodeUserSettingsOrganization(pathname)) return method === "GET" && !search;
  if (officialDirectorySubmissionTarget(method, pathname + search)?.write === false) return true;
  if (officialCoworkMemory(method, pathname + search)?.operation === "read") return true;
  if (officialCoworkDevices(method, pathname + search)) return true;
  if (officialCoworkDeviceManagement(method, pathname + search)?.method === "GET") return true;
  if (pathname === officialCodeSettingsPath) return method === "GET" && !search;
  if (sharingReadPaths.some((pattern) => pattern.test(pathname))) {
    if (method !== "GET") return false;
    if (!search) return true;
    if (!latestSharePath.test(pathname)) return false;
    const entries = [...new URLSearchParams(search)];
    return entries.length === 1 && entries[0][0] === "last_message_uuid" &&
      entries[0][1].length > 0 && entries[0][1].length <= 256;
  }
  if (isOfficialCodeTriggerPath(pathname)) {
    const request = officialCodeTriggerRequest(method, pathname, search);
    return !!request && isOfficialCodeTriggerRead(request);
  }
  if (officialCodePreviewControl(method, pathname + search)) return true;
  if (officialCodePrMonitorOperation(method, pathname + search) === "status") return true;
  if (method === "POST" && pathname === "/v1/code/github/compare-refs" && !search) return true;
  if (officialResponseChunk(method, pathname + search)) return true;
  if (!search && isOfficialUiDocumentConversion(method, pathname)) return true;
  if (officialSideQuestionRead(method,pathname,search)) return true;
  const privacy = officialMelangePrivacyRoute(method, pathname, search);
  if (privacy?.operation === "consent-check" || privacy?.operation === "org-consent-read" ||
      privacy?.operation === "cleanup-status") return true;
  if (method === "GET" && (officialMelangeRoute(method, pathname, search) || officialMelangeEditRequest(method, pathname + search))) return true;
  if (!search && officialCodeReceiptPath(method, pathname)) return true;
  if (isOfficialWorkspaceDownloadPath(pathname))
    return !!officialWorkspaceDownload(method, pathname, search);
  if (isOfficialCodeWorkspacePath(pathname))
    return !!officialCodeWorkspace(method, pathname, search);
  if (isOfficialCodeHistoryPath(pathname))
    return !!officialCodeHistoryRequest(method, pathname, search);
  if (fileReadPath.test(pathname) || new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/task/${uuid}/status$`).test(pathname)) return method === "GET" && search === "";
  if (pathname.includes("/claudex_usage_activity/")) {
    try { return method === "GET" && !!officialUsageActivityQuery(pathname,search); } catch { return false; }
  }
  if (usageSummaryPath.test(pathname)) return method === "GET" && isOfficialUiUsageSummarySearch(search);
  return isOfficialUiConversationSearch(method, pathname) || method === "GET" && isOfficialUiReadPath(pathname) || method === "POST" && (pathname === officialUiDefaultsPath || pathname === officialUiTimelinePath || pathname === officialUiRecentsPath);
}

export function isOfficialUiChatBulkDelete(method: string, path: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations/delete_many$`).test(path);
}

export function officialUiIncognitoDiscardTarget(method: string, path: string) {
  return method === "POST"
    ? new RegExp(`^/api/organizations/${uuid}/chat_conversations/(${uuid})/discard_incognito$`).exec(path)?.[1]
    : undefined;
}

export function officialChatElicitationResult(method: string, path: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/mcp_elicitation_result$`).test(path);
}

/** Explicit REST mutations only. No filesystem, sharing or connector grants. */
export function officialUiConversationMutation(method: string, pathname: string): "update" | "delete" | "stop" | "read" | undefined {
  const base = `/api/organizations/${uuid}/chat_conversations/${uuid}`;
  if (method === "PUT" && new RegExp(`^${base}\\?rendering_mode=raw$`).test(pathname)) return "update";
  if (new RegExp(`^${base}$`).test(pathname)) {
    if (method === "PUT" || method === "PATCH") return "update";
    if (method === "DELETE") return "delete";
  }
  if (method === "POST" && new RegExp(`^${base}/stop_response$`).test(pathname)) return "stop";
  if ((method === "POST" || method === "PUT") && new RegExp(`^${base}/read_state$`).test(pathname)) return "read";
  return undefined;
}

export function parseOfficialChatReadState(method: string, body: unknown):
  { format: "original" | "legacy"; unread: boolean } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return;
  const keys = Object.keys(body);
  if (keys.length === 0 || keys.length === 1 && "unread" in body && body.unread === false)
    return { format: "legacy", unread: false };
  if (method === "POST" && keys.length === 1 && "state" in body &&
      (body.state === "read" || body.state === "unread"))
    return { format: "original", unread: body.state === "unread" };
}

export function isOfficialUiCompletionSubmission(method: string, pathname: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/completion$`).test(pathname);
}

export function isOfficialUiRetrySubmission(method: string, pathname: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/retry_completion2?$`).test(pathname);
}

export function officialChatLeafTarget(method: string, pathname: string) {
  return method === "PUT"
    ? new RegExp(`^/api/organizations/${uuid}/chat_conversations/(${uuid})/current_leaf_message_uuid$`).exec(pathname)?.[1]
    : undefined;
}

export function isOfficialUiConversationCreation(method: string, pathname: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations$`).test(pathname);
}

const coworkProjectMovePath = new RegExp(`^/api/organizations/(${uuid})/cowork/sessions/(?:session|cse)_([a-f0-9]{32})/project$`);
const coworkMcpPath = new RegExp(`^/api/organizations/(${uuid})/cowork/sessions/(?:session|cse)_([a-f0-9]{32})/mcp-servers$`);
const coworkCreationPath = new RegExp(`^/api/organizations/(${uuid})/cowork/sessions$`, "i");
const coworkDevicesPath = new RegExp(`^/api/organizations/(${uuid})/cowork/(remote_devices|devices)$`);
const coworkDeviceManagementPath = `/api/organizations/(${uuid})/cowork/remote_devices`;
const coworkDeviceRemovalList = new RegExp(`^${coworkDeviceManagementPath}\\?for_removal=true$`);
const coworkDeviceAction = new RegExp(`^${coworkDeviceManagementPath}/(${uuid})$`);
export const officialCoworkDeviceRenameMaxBytes = 4096;

export function officialCoworkDeviceManagement(method: string, path: string) {
  if (method === "GET") {
    const match = coworkDeviceRemovalList.exec(path);
    if (match) return { method, organizationId: match[1].toLowerCase() };
  }
  if (method === "PATCH" || method === "DELETE") {
    const match = coworkDeviceAction.exec(path);
    if (match) return { method, organizationId: match[1].toLowerCase(), id: match[2].toLowerCase() };
  }
}

export function officialCoworkDevices(method: string, pathname: string) {
  const match = method === "GET" && coworkDevicesPath.exec(pathname);
  if (!match) return;
  return { organizationId: match[1].toLowerCase(), directory: match[2] === "remote_devices" };
}
export function officialCoworkCreation(method: string, pathname: string) {
  return method === "POST" ? coworkCreationPath.exec(pathname)?.[1]?.toLowerCase() : undefined;
}
export function officialCoworkMcpReconciliation(method: string, pathname: string) {
  const match = method === "PUT" && coworkMcpPath.exec(pathname);
  return match ? { organizationId: match[1], key: match[2] } : undefined;
}
export function officialUiCoworkProjectMove(method: string, pathname: string) {
  const match = method === "PATCH" && coworkProjectMovePath.exec(pathname);
  return match ? { organizationId: match[1], key: match[2] } : undefined;
}

export function isOfficialUiProjectMove(method: string, pathname: string) {
  return !!officialUiCoworkProjectMove(method, pathname) ||
    method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations/move_many$`).test(pathname);
}

export function isOfficialUiProjectMetadataUpdate(method: string, pathname: string) {
  return method === "PUT" && new RegExp(`^/api/organizations/${uuid}/projects/${uuid}$`).test(pathname);
}

export function isOfficialUiProjectMemoryUpdate(method: string, pathname: string) {
  return method === "PUT" && new RegExp(`^/api/organizations/${uuid}/projects/${uuid}/settings$`).test(pathname);
}

export function isOfficialUiProjectDeletion(method: string, pathname: string) {
  return method === "DELETE" && new RegExp(`^/api/organizations/${uuid}/projects/${uuid}$`).test(pathname);
}

export function isOfficialUiProjectCreation(method: string, pathname: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/projects$`).test(pathname);
}

export function officialUiProjectKnowledgeMutation(method: string, pathname: string): "upload" | "text" | "delete" | undefined {
  const base = `/api/organizations/${uuid}/projects/${uuid}`;
  if (method === "POST" && new RegExp(`^${base}/upload$`).test(pathname)) return "upload";
  if (method === "POST" && new RegExp(`^${base}/docs$`).test(pathname)) return "text";
  if (method === "POST" && new RegExp(`^${base}/(?:docs|files)/delete_many$`).test(pathname) ||
      method === "DELETE" && new RegExp(`^${base}/docs/${uuid}$`).test(pathname)) return "delete";
}

export function isOfficialUiProjectKnowledgePath(pathname: string) {
  return new RegExp(`^/api/organizations/${uuid}/projects/${uuid}/(?:docs(?:/${uuid}|/delete_many)?|files(?:/delete_many)?|upload|knowledge/${uuid})$`).test(pathname);
}

export function isOfficialUiLargeResponse(method: string, pathname: string) {
  if (method === "GET" && officialCoworkMemory(method, pathname + "?repo=cowork")) return true;
  if (method === "GET") {
    const history = officialCodeHistoryRequest(method, pathname, "")?.kind;
    return history === "events" || history === "stream" || isOfficialCodeTeleportPath(pathname) || skillArchiveDownloadPath.test(pathname) || isOfficialUiProjectKnowledgePath(pathname) || isOfficialUiFileReadPath(pathname);
  }
  return !!officialCodeFollowupPath(method, pathname) ||
    isOfficialUiDocumentConversion(method, pathname) || officialUiProjectKnowledgeMutation(method, pathname) === "text";
}

// A control character can take six bytes when escaped in JSON.
export const officialUiProjectTextRequestMaxBytes = 6 * knowledgeFileLimit + 64 * 1024;
export const officialUiTransferMaxBytes = officialUiProjectTextRequestMaxBytes;
export const officialUiProjectUploadMaxBytes = knowledgeFileLimit + 64 * 1024;

export function officialUiProjectRequestLimit(method: string, pathname: string) {
  if (isOfficialUiDocumentConversion(method, pathname)) return officialUiProjectUploadMaxBytes;
  const knowledge = officialUiProjectKnowledgeMutation(method, pathname);
  if (knowledge === "upload") return officialUiProjectUploadMaxBytes;
  if (knowledge === "text") return officialUiProjectTextRequestMaxBytes;
}

export function officialUiSegmentedRequestLimit(method: string, pathname: string) {
  const skillUpload = officialSkillUploadKind(method, pathname);
  if (skillUpload) {
    const queryStart = pathname.indexOf("?");
    if (skillUpload === "legacy" && queryStart !== -1) {
      const query = new URLSearchParams(pathname.slice(queryStart));
      if (query.get("wrap") === "true" && query.has("check_skill_name")) return MAX_OFFICIAL_SKILL_VERSION_SAVE_BYTES;
    }
    return officialSkillUploadMaxBytes;
  }
  return officialChatUploadOrganization(method, pathname)
    ? officialChatUploadMaxBytes
    : officialUiProjectRequestLimit(method, pathname);
}

/** Project JSON can contain 100,000 UTF-16 instruction units escaped as six bytes each. */
export function officialUiRequestLimit(method: string, pathname: string) {
  if (officialDesignArtifactKind(method, pathname) === "create") return officialDesignCreateMaxBytes;
  const device = officialCoworkDeviceManagement(method, pathname);
  if (device?.method === "PATCH") return officialCoworkDeviceRenameMaxBytes;
  if (device?.method === "DELETE") return 0;
  if (method === "PUT" && officialCodeUserSettingsOrganization(pathname)) return officialCodeUserSettingsMaxBytes;
  if (officialDirectorySubmissionTarget(method, pathname)) return officialDirectorySubmissionMaxBytes;
  if (officialCoworkMemory(method, pathname)?.operation === "patch") return coworkMemoryMaxRequestBytes;
  const melange = officialMelangeRoute(method, pathname);
  if (melange?.operation === "external-import") return officialMelangeImportBodyBytes;
  if (melange || officialMelangeEditRequest(method, pathname)?.kind === "start") return officialMelangeEditBodyBytes;
  if (isOfficialSkillCreation(method, pathname)) return officialSkillCreateMaxBytes;
  if (isOfficialSkillDeletion(method, pathname)) return officialSkillDeleteMaxBytes;
  if (isOfficialSkillToggle(method, pathname)) return officialSkillToggleMaxBytes;
  if (officialSkillCopyRenameMethod(method, pathname)) return officialSkillCopyRenameMaxBytes;
  if (officialChatLeafTarget(method, pathname)) return 4096;
  if (officialReplyFeedbackTarget(method, pathname)) return 32 * 1024;
  if (officialSpendLimitActionOrganization(method, pathname)) return officialSpendLimitBodyBytes;
  if (isOfficialUiChatBulkDelete(method, pathname)) return 256 * 1024;
  const trigger = officialCodeTriggerRequest(method, pathname);
  if (trigger?.kind === "create" || trigger?.kind === "update" || trigger?.kind === "run")
    return 6 * (100_000 + 120) + 8 * 1024;
  const segmented = officialUiSegmentedRequestLimit(method, pathname);
  if (segmented !== undefined) return segmented;
  if (officialSideQuestionAction(method, pathname) || isOfficialUiCompletionSubmission(method, pathname)) return 2 * 1024 * 1024;
  if (method === "POST" && pathname === officialUiActionPath) return officialUiActionMaxBytes;
  if (officialCoworkCreation(method, pathname) || officialCodeFollowupPath(method, pathname)) return officialCodeFollowupMaxBytes;
  if (officialCodeUploadOrganization(method, pathname)) return officialCodeUploadMaxBytes;
  if (officialCodeMarkRead(method, pathname)) return 4096;
  if (officialCodeViewerSession(method, pathname)) return officialCodeViewerMaxBytes;
  if (officialCodeMutation(method, pathname)) return officialCodeMutationMaxBytes;
  if (officialCodePullRequestCreate(method, pathname)) return officialCodePullRequestCreateMaxBytes;
  const monitor = officialCodePrMonitorOperation(method, pathname);
  if (monitor) return monitor === "status" ? officialCodePrMonitorStatusMaxBytes : officialCodePrMonitorActionMaxBytes;
  if (officialCodeTerminalRequest(method, pathname)) return officialCodeTerminalMaxBytes;
  if (isOfficialUiArtifactPublication(method, pathname)) return 12 * 1024 * 1024;
  if (isOfficialUiModelPreference(method, pathname) || isOfficialUiProjectMemoryUpdate(method, pathname) ||
      officialMelangePrivacyRoute(method, pathname)) return 4096;
  return isOfficialUiProjectCreation(method, pathname) || isOfficialUiProjectMetadataUpdate(method, pathname)
    ? 6 * (100_000 + 2_000 + 200) + 1024
    : officialUiRequestMaxBytes;
}

export function isOfficialUiModelPreference(method: string, pathname: string) {
  return (method === "PATCH" || method === "PUT") && new RegExp(`^/api/organizations/${uuid}/model_selector_state/[a-zA-Z0-9_-]{1,64}$`).test(pathname);
}

const researchSharePath = new RegExp(`^/api/organizations/(${uuid})/chat_conversations/(${uuid})/research_reports/share$`);
export function officialResearchShareTarget(pathname: string) {
  const match = researchSharePath.exec(pathname);
  if (match) return { organizationId: match[1], conversationId: match[2] };
}

export function isOfficialUiArtifactPublication(method: string, pathname: string) {
  return method === "POST" && (new RegExp(`^/api/organizations/${uuid}/publish_artifact$`).test(pathname) || !!officialResearchShareTarget(pathname)) ||
    method === "DELETE" && new RegExp(`^/api/organizations/${uuid}/published_artifacts/[A-Za-z0-9_-]{1,64}$`).test(pathname);
}

export function isOfficialResearchStop(method: string, pathname: string) {
  return method === "POST" && new RegExp(`^/api/organizations/${uuid}/chat_conversations/${uuid}/task/${uuid}/stop$`).test(pathname);
}

export function isOfficialUiChatAction(method: string, pathname: string) {
  if (method !== "GET" && officialOrganizationProjectTarget(method, pathname)) return true;
  if (officialOrganizationPluginMutation(method, pathname)) return true;
  const privacy = officialMelangePrivacyRoute(method, pathname);
  if (privacy?.operation === "consent-write" || privacy?.operation === "org-consent-write" ||
      privacy?.operation === "cleanup-start" || isOfficialUiProjectMemoryUpdate(method, pathname)) return true;
  if (method === "POST" && (officialMelangeRoute(method, pathname) || officialMelangeEditRequest(method, pathname)?.kind === "start")) return true;
  if (isOfficialSkillCreation(method, pathname) || officialSkillUploadKind(method, pathname) || isOfficialSkillDeletion(method, pathname) || isOfficialSkillToggle(method, pathname) || officialSkillCopyRenameMethod(method, pathname)) return true;
  if (officialCustomConnectorTarget(method, pathname) || officialConnectorLifecycleTarget(method, pathname)) return true;
  return officialChatElicitationResult(method, pathname) || isOfficialResearchStop(method, pathname) || !!officialReplyFeedbackTarget(method, pathname) || !!officialUiIncognitoDiscardTarget(method, pathname) || isOfficialUiChatBulkDelete(method, pathname) || !!officialChatLeafTarget(method, pathname) || isOfficialUiConversationSharingMutation(method, pathname) || !!officialChatUploadOrganization(method, pathname) || officialSideQuestionAction(method,pathname) || isOfficialUiArtifactPublication(method, pathname) || isOfficialUiModelPreference(method, pathname) || method === "POST" && pathname === officialUiActionPath || isOfficialUiCompletionSubmission(method, pathname) || isOfficialUiRetrySubmission(method, pathname) || isOfficialUiConversationCreation(method, pathname) || isOfficialUiProjectMove(method, pathname) || isOfficialUiProjectMetadataUpdate(method, pathname) || isOfficialUiProjectCreation(method, pathname) || isOfficialUiProjectDeletion(method, pathname) || !!officialUiProjectKnowledgeMutation(method, pathname) || !!officialUiConversationMutation(method, pathname);
}

const connectorLogoutPath = new RegExp(`^/api/organizations/(${uuid})/mcp/logout/(${uuid})$`);
export function officialConnectorAuthTarget(method: string, path: string) {
  if (method === "POST") {
    const logout = connectorLogoutPath.exec(path);
    if (logout?.[0] === path) return { organizationId: logout[1], serverId: logout[2], kind: "logout" as const };
  }
  const url = new URL(path, "http://localhost");
  if (url.origin !== "http://localhost" || url.hash) return undefined;
  const match = new RegExp(`^/api/organizations/(${uuid})/mcp/start-auth/(${uuid})$`).exec(url.pathname);
  if (method === "GET" && match) return { organizationId: match[1]!, serverId: match[2]!, kind: "start" as const };
  const complete = new RegExp(`^/api/organizations/(${uuid})/mcp/complete-auth/(${uuid})$`).exec(url.pathname);
  if (method === "POST" && complete && !url.search) return { organizationId: complete[1]!, serverId: complete[2]!, kind: "complete" as const };
  return undefined;
}

export function isOfficialUiAction(method: string, pathname: string) {
  if (officialCodeViewerSession(method, pathname)) return true;
  if (officialDesignArtifactKind(method, pathname) === "create") return true;
  if (officialCodePullRequestCreate(method, pathname)) return true;
  const monitor = officialCodePrMonitorOperation(method, pathname);
  if (monitor) return monitor !== "status";
  if (officialOrganizationPluginMutation(method, pathname)) return true;
  if (method !== "GET" && officialCoworkDeviceManagement(method, pathname)) return true;
  if (officialCodeUserSettingsOrganization(pathname)) return method === "PUT";
  if (officialDirectorySubmissionTarget(method, pathname)?.write) return true;
  if (officialSpendLimitActionOrganization(method, pathname)) return true;
  const coworkMemory = officialCoworkMemory(method, pathname);
  if (coworkMemory && coworkMemory.operation !== "read") return true;
  if (method !== "GET" && officialMcpAppToolboxTarget(method, pathname)) return true;
  if (officialCoworkCreation(method, pathname)) return true;
  if (officialMelangeEditRequest(method, pathname)?.kind === "stop") return true;
  if (officialCoworkMcpReconciliation(method, pathname)) return true;
  if (isOfficialCodeTriggerPath(pathname)) {
    const request = officialCodeTriggerRequest(method, pathname);
    return !!request && !isOfficialCodeTriggerRead(request);
  }
  if (officialConnectorAuthTarget(method, pathname)) return true;
  if (officialChatConnectorTarget(method, pathname)) return true;
  if (officialSideQuestionAction(method,pathname)) return true;
  return officialCodeSessionCreation(method, pathname) || !!officialCodeFollowupPath(method, pathname) || !!officialCodeUploadOrganization(method, pathname) || !!officialCodeConnectorSelection(method, pathname) || !!officialCodeMarkRead(method, pathname) || !!officialCodeMutation(method, pathname) || !!officialCodeTerminalRequest(method, pathname) || isOfficialAppearanceAction(method, pathname) || !!officialMemoryAction(method, pathname) || isOfficialUiChatAction(method, pathname);
}

/** Account-authenticated descriptor; never a bearer permit or a budget approval. */
export const officialUiCapabilitiesPath = "/api/claudex/official-capabilities/version1";
export interface OfficialTextReadiness {
  state: "ready" | "denied" | "unavailable" | "error";
  reason: "ready" | "strict_mode_disabled" | "executor_unavailable" | "approval_required" | "budget_unavailable" | "tools_unavailable" | "source_error" | "session_changed";
}
export interface OfficialUiCapabilities {
  version: 1;
  accountId: string;
  activationLease: string;
  mode: "read-only" | "strict-text" | "engine-chat";
  textChat: OfficialTextReadiness;
}
export function isOfficialTextReadiness(value: unknown): value is OfficialTextReadiness {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as OfficialTextReadiness;
  const reasons: string[] = ["ready", "strict_mode_disabled", "executor_unavailable", "approval_required", "budget_unavailable", "tools_unavailable", "source_error", "session_changed"];
  return ["ready", "denied", "unavailable", "error"].includes(v.state) && reasons.includes(v.reason) &&
    (v.state === "ready" ? v.reason === "ready" : v.reason !== "ready");
}
