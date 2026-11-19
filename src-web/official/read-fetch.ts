import { officialOrganizationPluginMutation } from "../../shared/official-plugin-organizations";
import { officialCodeViewerSession } from "../../shared/official-code-viewers";
import { remoteCodeHeartbeatPath } from "../../shared/official-remote-code";
import { officialMelangePrivacyRoute } from "../../shared/official-melange";
import { officialConnectorAuthTarget, officialConnectorLifecycleTarget, officialCustomConnectorTarget, officialMcpAppToolboxHeaders, officialMcpAppToolboxTarget, officialUiConversationMutation } from "../../shared/official-ui-web";
import { officialChatConnectorTarget } from "../../shared/official-connector-preferences";
import { officialSideQuestionPath } from "../../shared/official-side-question";
import { openOfficialSideQuestion } from "./side-question-fetch";
import { officialMelangeRoute } from "../../shared/official-melange";
import { openOfficialMelangeEdit } from "./melange-fetch";
/** Fetch bridge for recovered frontend queries and explicitly enabled actions. */
import { officialSkillUploadKind, isOfficialDesignCreateRetry, isOfficialUiQuery, isOfficialUiFileReadPath, isOfficialUiProjectKnowledgePath, officialChatUploadOrganization, officialUiActionPath, officialUiRequestLimit, officialUiTimelinePath, isOfficialUiAction, type OfficialUiReadRequest, type OfficialUiReadResponse } from "../../shared/official-ui-web";
import { officialCodeControlContentType, officialCodeFollowupPath, officialCodeRewindReply, officialCodeUploadOrganization, officialCodeWorkspaceDiffMaxBytes } from "../../shared/official-code-followup";
import { isOfficialCodeHistoryPath, officialCodeConnectorSelection, officialCodeMarkRead, officialCodeMutation, officialCodeSessionCreation, officialCodeStreamRequest } from "../../shared/official-code-history";
import { isOfficialSessionFilePath } from "../../shared/official-workspace-download";
import { isOfficialCodeWorkspacePath } from "../../shared/official-code-workspace";
import { completionPath, openOfficialCompletion } from "./completion-fetch";
import { openOfficialCodeStream, type CodeControlReply } from "./code-stream";
import { openOfficialCodeListWatch } from "./code-list-watch";
import { openOfficialTimeline, type TimelineEvents } from "./timeline-fetch";
import { officialDocumentTokenOrganization, officialSpendLimitActionOrganization, officialSpendLimitActivationHeader } from "../../shared/official-ui-web";
import { officialCodePullRequestCreate } from "../../shared/official-code-pull-requests";
import { officialCodePrMonitorOperation } from "../../shared/official-code-pr-monitor";
import { officialCodePreviewControl } from "../../shared/official-code-preview";
import { isOfficialCodeTriggerPath } from "../../shared/official-code-triggers";
import { isOfficialCodeUserSettingsChecksum, officialCodeUserSettingsOrganization } from "../../shared/official-code-user-settings";
import type { UploadTransfer } from "../../shared/web-client/codec";
import { isOfficialSharedChatRead, officialSharedChatReadPath } from "./shared-chat";
import { officialMemoryAction } from "../../shared/official-memory-capability";
import { officialAccountRequest, type OfficialFrameAccount } from "./account-fetch";
import { officialCloudEnvironmentRequest, type OfficialCloudEnvironments } from "./cloud-environment-fetch";
import type { GitHubAPI } from "../../shared/github-api";
import { statusOf } from "../../shared/web-client/errors";
import { coworkMemoryIfMatch, coworkMemoryRevision, officialCoworkMemory } from "../../shared/official-cowork-memory";
import { isApiManagementPath, type ApiManagement } from "../../shared/official-api-management";
import { apiManagementFetch } from "./api-management-fetch";
import { officialServiceStatusPath, parseOfficialServiceStatusQuery, type ServiceStatusAPI } from "../../shared/service-status-api";
import type { OfficialAnnouncements } from "../../shared/announcements-api";
import { isOfficialAnnouncementPath, officialAnnouncementBodyLimit, serveOfficialAnnouncement } from "../../shared/official-announcements";
import { isOfficialZecousMigrationPath, serveOfficialZecousMigration } from "../../shared/official-zecous-migration";
import type { OfficialZecousMigration } from "../../shared/zecous-migration-api";
import type { OfficialDispatch } from "../../shared/dispatch-api";
import { isOfficialDispatchPath, officialDispatchBodyLimit, serveOfficialDispatch } from "../../shared/official-dispatch";

import type { OfficialNotificationPreferences } from "./notification-preferences";
import { officialNotificationPreferencesOrganization } from "../../shared/official-notification-preferences";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;
type Action = (request: OfficialUiReadRequest, transfer?: UploadTransfer) => Promise<OfficialUiReadResponse>;

async function boundedBody(request: Request, maxBytes?: number): Promise<Uint8Array | null> {
  const url = new URL(request.url);
  const path = url.pathname + url.search;
  const limit = maxBytes ?? officialUiRequestLimit(request.method,
    officialCodeUploadOrganization(request.method, path) || officialSkillUploadKind(request.method, path) ||
    officialCoworkMemory(request.method, path) ? path : url.pathname);
  const stream = request.clone().body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => { void reader.cancel().catch(() => {}); reject(new DOMException("The request was aborted.", "AbortError")); };
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), cancelled]);
      if (done) break;
      size += value.byteLength;
      if (size > limit) { void reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { if (abort) request.signal.removeEventListener("abort", abort); reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function createOfficialReadFetch(origin: string, read: Read, nativeFetch: typeof fetch, timelineEvents?: TimelineEvents, action?: Action, account?: OfficialFrameAccount, rememberCodeDraft?: (path: string, bytes: Uint8Array) => void, codeContext?: { organization: string; githubStatus?: GitHubAPI["githubStatus"]; githubConnect?: GitHubAPI["githubConnect"]; githubDisconnect?: GitHubAPI["githubDisconnect"]; githubBranches?: GitHubAPI["githubBranches"]; githubRepositories?: GitHubAPI["githubRepositories"]; cloudEnvironments?: { accountUuid: string; api: OfficialCloudEnvironments }; codeStreamConnected?: (key: string) => boolean; sharedChatSnapshotId?: string }, frameSignal?: AbortSignal, service?: { api?: ApiManagement; serviceStatus?: ServiceStatusAPI["serviceStatus"]; announcements?: OfficialAnnouncements; zecousMigration?: OfficialZecousMigration; dispatch?: OfficialDispatch; notificationPreferences?: OfficialNotificationPreferences; current: () => boolean }): typeof fetch {
  const controls = new EventTarget();
  let coworkMemoryEpoch: string | undefined;
  return async (input, init) => {
    const request = input instanceof Request ? new Request(input, init) : new Request(new URL(String(input), origin), init);
    if (request.signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
    const url = new URL(request.url);
    if (url.origin !== origin || /^\/api\/v1\//.test(url.pathname)) return nativeFetch(request);
    const notificationOrganization = officialNotificationPreferencesOrganization(url.pathname);
    if (notificationOrganization && service?.notificationPreferences) {
      const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
      if (notificationOrganization !== codeContext?.organization)
        return reply({ error: "Organization not found." }, 404);
      if (url.search) return reply({ error: "Invalid notification preferences request." }, 400);
      const check = () => {
        request.signal.throwIfAborted();
        frameSignal?.throwIfAborted();
        if (!service.current()) throw new DOMException("The active account changed.", "AbortError");
      };
      check();
      if (request.method === "GET") {
        const result = await read({ method: "GET", path: url.pathname });
        check();
        return new Response(new Uint8Array(result.body), { status: result.status,
          headers: { "Content-Type": result.contentType, "Cache-Control": "no-store" } });
      }
      if (request.method !== "PATCH")
        return reply({ error: "Unsupported notification preferences method." }, 405);
      const bytes = await boundedBody(request, 4096);
      if (!bytes) return reply({ error: "Notification preferences request is too large." }, 413);
      let body: unknown;
      try { body = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { return reply({ error: "Invalid notification preferences." }, 400); }
      check();
      const result = await service.notificationPreferences.save(body);
      check();
      return result;
    }
    if (isOfficialDispatchPath(url.pathname)) {
      const result = await serveOfficialDispatch({
        method: request.method,
        url,
        body: async () => {
          const bytes = await boundedBody(request, officialDispatchBodyLimit);
          if (!bytes) throw Object.assign(Error("Request body is too large."), { status: 413 });
          try { return JSON.parse(new TextDecoder().decode(bytes)); }
          catch { throw Object.assign(Error("Invalid Dispatch request."), { status: 400 }); }
        },
      }, service?.dispatch, () => !request.signal.aborted && !frameSignal?.aborted && service?.current() === true);
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store", ...(result.allow ? { Allow: result.allow } : {}) },
      });
    }
    if (isApiManagementPath(url.pathname))
      return apiManagementFetch(request, url, service?.api, service?.current ?? (() => false), boundedBody);
    if (isOfficialZecousMigrationPath(url.pathname)) {
      const result = await serveOfficialZecousMigration(
        { method: request.method, url }, service?.zecousMigration,
        () => !request.signal.aborted && !frameSignal?.aborted && service?.current() === true,
      );
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store", ...(result.allow ? { Allow: result.allow } : {}) },
      });
    }
    if (isOfficialAnnouncementPath(url.pathname)) {
      const result = await serveOfficialAnnouncement({
        method: request.method, url,
        body: async () => {
          const bytes = await boundedBody(request, officialAnnouncementBodyLimit);
          if (!bytes) throw Object.assign(Error("Request body is too large."), { status: 413 });
          try { return JSON.parse(new TextDecoder().decode(bytes)); }
          catch { throw Object.assign(Error("Invalid announcement action."), { status: 400 }); }
        },
      }, service?.announcements, () => !request.signal.aborted && !frameSignal?.aborted && service?.current() === true);
      return Response.json(result.body, {
        status: result.status,
        headers: { "Cache-Control": "no-store", ...(result.allow ? { Allow: result.allow } : {}) },
      });
    }
    if (url.pathname === officialServiceStatusPath) {
      const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...(status === 405 ? { Allow: "GET" } : {}) } });
      if (request.method !== "GET") return reply({ error: "Unsupported request." }, 405);
      const query = parseOfficialServiceStatusQuery(url.searchParams);
      if (!query) return reply({ error: "Invalid service status window." }, 400);
      if (!service?.serviceStatus) return reply({ error: "Service status is unavailable." }, 404);
      const check = () => {
        request.signal.throwIfAborted();
        frameSignal?.throwIfAborted();
        if (!service.current()) throw new DOMException("The active account changed.", "AbortError");
      };
      check();
      try {
        const answer = await service.serviceStatus(query);
        check();
        return reply(answer);
      } catch {
        check();
        return reply({ error: "Service status could not be read." }, 503);
      }
    }
    const coworkMemory = officialCoworkMemory(request.method, url.pathname + url.search);
    if (coworkMemory && coworkMemory.organization !== codeContext?.organization)
      return Response.json({ error: "Organization not found." }, { status: 404 });
    const memoryMatch = coworkMemory?.operation === "patch" ? request.headers.get("If-Match") : null;
    if (memoryMatch !== null && !coworkMemoryIfMatch.test(memoryMatch))
      return Response.json({ error: "Invalid Cowork memory checksum." }, { status: 400 });
    if (coworkMemory && coworkMemory.operation !== "read" && !coworkMemoryEpoch)
      return Response.json({ error: "Read Cowork memory before changing it." }, { status: 409 });
    const codeUserSettings = officialCodeUserSettingsOrganization(url.pathname + url.search);
    const codeUserSettingsChecksum = codeUserSettings && (request.method === "GET" || request.method === "PUT")
      ? request.headers.get(request.method === "GET" ? "If-None-Match" : "If-Match") : null;
    if (codeUserSettingsChecksum !== null && !isOfficialCodeUserSettingsChecksum(codeUserSettingsChecksum))
      return Response.json({ error: "Invalid Code user settings checksum." }, { status: 400 });
    if (codeContext?.cloudEnvironments) {
      const cloudEnvironment = officialCloudEnvironmentRequest(request, url,
        { organization: codeContext.organization, ...codeContext.cloudEnvironments }, boundedBody,
        frameSignal ? AbortSignal.any([frameSignal, request.signal]) : request.signal);
      if (cloudEnvironment) return cloudEnvironment;
    }
    const repositoryPath = codeContext && `/api/organizations/${codeContext.organization}/code/repos`;
    if (request.method === "GET" && repositoryPath && codeContext.githubRepositories &&
        (url.pathname === repositoryPath || url.pathname === repositoryPath + "/all" || url.pathname === repositoryPath + "/search")) {
      const params = url.searchParams;
      if (params.has("ghe_configuration_id")) return Response.json({ error: "GitHub Enterprise is unavailable." }, { status: 400 });
      const page = Number(params.get("page") ?? "1");
      const perPage = Number(params.get("per_page") ?? "100");
      if (!Number.isInteger(page) || page < 1 || !Number.isInteger(perPage) || perPage < 1 || perPage > 100)
        return Response.json({ error: "Invalid repository page." }, { status: 400 });
      try {
        const result = await codeContext.githubRepositories({
          page, perPage, query: params.get("q") || undefined,
        });
        if (request.signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
        const items = [...result.items];
        let nextPage = result.nextPage;
        while (url.pathname.endsWith("/all") && nextPage !== null) {
          const next = await codeContext.githubRepositories({ page: nextPage, perPage, query: params.get("q") || undefined });
          if (request.signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
          items.push(...next.items);
          nextPage = next.nextPage;
        }
        const repos = items.map((repo) => ({ repo: {
          name: repo.name, full_name: repo.fullName, owner: { login: repo.owner },
          private: repo.private, description: repo.description, default_branch: repo.defaultBranch,
          clone_url: repo.cloneUrl, html_url: repo.cloneUrl.replace(/\.git\/?$/, ""),
        } }));
        return Response.json(url.pathname.endsWith("/search") ? repos : {
          repos, next_page: nextPage, has_more: nextPage !== null,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof Error && "code" in error &&
            (error.code === "CLAUDEX_GITHUB_NOT_CONFIGURED" || error.code === "CLAUDEX_GITHUB_NOT_CONNECTED"))
          return Response.json(url.pathname.endsWith("/search") ? [] :
            { repos: [], next_page: null, has_more: false });
        return Response.json({ error: { message: "Could not load repositories." } }, { status: 503 });
      }
    }
    const branchPrefix = codeContext && `/api/github/organizations/${codeContext.organization}/github/`;
    if (request.method === "GET" && branchPrefix && url.pathname.startsWith(branchPrefix) && codeContext.githubBranches) {
      const match = /^([^/]+)\/([^/]+)\/branches$/.exec(url.pathname.slice(branchPrefix.length));
      const params = url.searchParams;
      if (!match || [...params.keys()].some((key) => key !== "query") || params.getAll("query").length > 1)
        return Response.json({ error: "Invalid branch query." }, { status: 400 });
      let repository: string;
      try {
        const owner = decodeURIComponent(match[1]);
        const repo = decodeURIComponent(match[2]);
        if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) throw Error();
        repository = `${owner}/${repo}`;
      } catch { return Response.json({ error: "Invalid repository." }, { status: 400 }); }
      try {
        const data: { name: string; protected: boolean }[] = [];
        let page: number | undefined;
        do {
          const result = await codeContext.githubBranches({ repository, query: params.get("query") || undefined, page });
          if (request.signal.aborted) throw new DOMException("The request was aborted.", "AbortError");
          data.push(...result.items);
          page = result.nextPage ?? undefined;
        } while (page !== undefined);
        return Response.json({ data });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return Response.json({ error: { message: "Could not load branches." } }, { status: 503 });
      }
    }
    const githubAuthPath = codeContext && `/api/organizations/${codeContext.organization}/sync/github/auth`;
    if (codeContext && !url.search &&
        (url.pathname === githubAuthPath || url.pathname === githubAuthPath + "/start")) {
      const check = () => {
        request.signal.throwIfAborted();
        frameSignal?.throwIfAborted();
      };
      const reply = (body: object, status = 200) =>
        Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
      const refuse = (status: number, message: string) => reply({ error: { message } }, status);
      const organizationHeader = request.headers.get("x-organization-uuid");
      if (organizationHeader && organizationHeader !== codeContext.organization)
        return refuse(404, "Organization not found.");

      try {
        check();
        if (request.method === "POST" && url.pathname.endsWith("/start") && codeContext.githubConnect) {
          const bytes = await boundedBody(request, 4096);
          if (!bytes) return refuse(413, "The GitHub connection request is too large.");
          let body: unknown;
          try { body = JSON.parse(new TextDecoder().decode(bytes)); }
          catch { return refuse(400, "Invalid GitHub connection request."); }
          if (!body || typeof body !== "object" || Array.isArray(body))
            return refuse(400, "Invalid GitHub connection request.");
          if ("ghe_config_id" in body && body.ghe_config_id != null)
            return refuse(400, "GitHub Enterprise is unavailable.");
          const state = "pre_auth_state" in body ? body.pre_auth_state : undefined;
          if (state && typeof state === "object" && "intent" in state && state.intent === "install")
            return refuse(400, "App installation is managed by your Claudex administrator.");
          check();
          const { authorizeUrl } = await codeContext.githubConnect();
          check();
          return reply({ redirect_url: authorizeUrl });
        }
        const operation = url.pathname === githubAuthPath && (
          request.method === "GET" ? codeContext.githubStatus :
          request.method === "DELETE" ? codeContext.githubDisconnect : undefined
        );
        if (operation) {
          const status = await operation();
          check();
          return reply({ is_authenticated: status.configured && status.connected,
            ...(status.login ? { user_login: status.login } : {}) });
        }
      } catch (error) {
        check();
        if (error instanceof Error && error.name === "AbortError") throw error;
        return refuse(statusOf(error) ?? 503, error instanceof Error ? error.message :
          "Something went wrong. Please try again.");
      }
    }
    const accountRequest = officialAccountRequest(request, url, account, boundedBody);
    if (accountRequest) return accountRequest;
    // The self-hosted client intentionally does not forward vendor telemetry.
    if (request.method === "POST" && (url.pathname === "/api/v2/rum" || url.pathname.startsWith("/api/event_logging/")))
      return new Response(null, { status: 204 });
    const officialApi = /^\/(?:api|edge-api|claudeai-rpc|v1)(?:\/|$)/.test(url.pathname);
    if (!officialApi) return nativeFetch(request);
    const mcpAppToolbox = officialMcpAppToolboxTarget(request.method, url.pathname + url.search);
    if (mcpAppToolbox && request.method === "GET")
      return new Response(null, { status: 405, headers: { Allow: "POST, DELETE" } });
    if (officialSideQuestionPath.test(url.pathname) && !url.search && request.method === "POST") {
      if (!action) return Response.json({error:"Side questions are unavailable."},{status:501});
      const body=await boundedBody(request);
      if(body===null)return Response.json({error:"Side question is too large."},{status:413});
      return openOfficialSideQuestion({method:"POST",path:url.pathname,body,contentType:request.headers.get("content-type")??""},request.signal,read,action);
    }
    const melange = officialMelangeRoute(request.method, url.pathname, url.search);
    if (melange?.operation === "edit") {
      if (!action) return Response.json({ error: { message: "Memory editing is unavailable." } }, { status: 501 });
      const body = await boundedBody(request);
      if (body === null) return Response.json({ error: { message: "Memory edit is too large." } }, { status: 413 });
      const signal = frameSignal ? AbortSignal.any([frameSignal, request.signal]) : request.signal;
      return openOfficialMelangeEdit(melange.organization, {
        method: "POST", path: url.pathname, body, contentType: request.headers.get("content-type") ?? "",
      }, signal, read, action);
    }
    if (completionPath.test(url.pathname) && !url.search && request.method === "POST") {
      if (!action || !timelineEvents)
        return new Response('{"error":"Official Web completion streaming is not connected yet."}', { status: 501, headers: { "Content-Type": "application/json" } });
      const body = await boundedBody(request);
      if (body === null) return new Response("Completion query is too large.", { status: 413 });
      return openOfficialCompletion({ method: "POST", path: url.pathname, body,
        contentType: request.headers.get("content-type") ?? "" }, request.signal, read, action, timelineEvents);
    }
    const codeStream = officialCodeStreamRequest(request.method, url.pathname, url.search);
    if (codeStream) {
      if (!timelineEvents) return Response.json({ error: "Code streaming is unavailable." }, { status: 501 });
      if (codeContext?.codeStreamConnected?.(codeStream.key) === false)
        return Response.json({ error: "The Runner event connection is unavailable." }, { status: 503 });
      return openOfficialCodeStream(request, url, codeStream, read, timelineEvents, controls);
    }
    if (url.pathname === officialUiTimelinePath) {
      if (!timelineEvents || request.method !== "POST")
        return new Response('{"error":"Official Web streaming is not connected yet."}', { status: 501, headers: { "Content-Type": "application/json" } });
      const body = await boundedBody(request);
      if (body === null) return new Response("Timeline query is too large.", { status: 413 });
      return openOfficialTimeline({ method: "POST", path: `${url.pathname}${url.search}`, body,
        contentType: request.headers.get("content-type") ?? "" }, request.signal, read, timelineEvents);
    }
    const skillUpload = officialSkillUploadKind(request.method, url.pathname + url.search);
    const isAction = !!action && (
      skillUpload ||
      isOfficialUiAction(request.method, url.pathname + url.search) ||
      !!officialCodeUploadOrganization(request.method, url.pathname + url.search) ||
      !!officialChatConnectorTarget(request.method, url.pathname + url.search)
    );
    const documentToken = !!officialDocumentTokenOrganization(request.method, url.pathname + url.search);
    // Runner history already includes scheduled sessions by default.
    // The original Cowork list explicitly requests the same inclusive view.
    let search = url.search;
    const authTarget = officialConnectorAuthTarget(request.method, url.pathname + search);
    if (authTarget?.kind === "start") {
      const params = new URLSearchParams(search);
      params.set("claudex_return_url", new URL("/mcp/oauth/callback", origin).href);
      search = `?${params}`;
    }
    if (request.method === "GET" && url.pathname === "/v1/code/sessions") {
      const params = new URLSearchParams(search);
      const include = params.getAll("include_trigger_sessions");
      if (include.length === 1 && include[0] === "true") {
        params.delete("include_trigger_sessions");
        const value = params.toString();
        search = value ? `?${value}` : "";
      }
    }
    if (request.method === "GET" && url.pathname === "/v1/code/sessions/watch" && search === "?exclude_tags=-" && timelineEvents)
      return openOfficialCodeListWatch(request, read, timelineEvents);
    const sharedChat = request.method === "GET" && codeContext?.sharedChatSnapshotId &&
      isOfficialSharedChatRead(url, codeContext.sharedChatSnapshotId, codeContext.organization);
    const remoteHeartbeat = request.method === "POST" && url.pathname === remoteCodeHeartbeatPath &&
      !search && !codeContext?.sharedChatSnapshotId;
    if (!documentToken && !sharedChat && !remoteHeartbeat && !isOfficialUiQuery(request.method, url.pathname, search) && !isAction)
      return new Response('{"error":"This official Web request is not supported yet."}', { status: 501, headers: { "Content-Type": "application/json" } });
    const singleChatDelete = officialUiConversationMutation(request.method, url.pathname + search) === "delete";
    const body = request.method === "GET" || singleChatDelete ? undefined : await boundedBody(request);
    if (body === null)
      return new Response('{"error":"This official Web query is too large."}', { status: 413, headers: { "Content-Type": "application/json" } });
    if (documentToken && body?.byteLength)
      return Response.json({ error: "Invalid document preview token request." }, { status: 400 });
    let abort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException("The request was aborted.", "AbortError"));
      request.signal.addEventListener("abort", abort, { once: true });
      // The signal can change while a POST body is being read, before this
      // listener is installed. Do not start an already-cancelled query.
      if (request.signal.aborted) abort();
    });
    try {
      if (request.signal.aborted) return await cancelled;
      const execute = isAction ? action! : read;
      if (isAction && body && officialCodeFollowupPath(request.method, url.pathname))
        rememberCodeDraft?.(url.pathname, body);
      const codeOrg = remoteHeartbeat || officialCodeViewerSession(request.method, url.pathname, search) ||
        url.pathname === "/v1/code/github/compare-refs" ||
        officialCodeSessionCreation(request.method, url.pathname) ||
        isOfficialCodeHistoryPath(url.pathname) ||
        isOfficialCodeTriggerPath(url.pathname) ||
        isOfficialSessionFilePath(url.pathname) ||
        isOfficialCodeWorkspacePath(url.pathname) ||
        officialCodeFollowupPath(request.method, url.pathname) ||
        officialCodeConnectorSelection(request.method, url.pathname) ||
        officialCodeMarkRead(request.method, url.pathname) ||
        officialCodeMutation(request.method, url.pathname) ||
        officialCodePullRequestCreate(request.method, url.pathname + search) ||
        officialCodePrMonitorOperation(request.method, url.pathname + search) ||
        officialCodePreviewControl(request.method, url.pathname + search)
        ? request.headers.get("x-organization-uuid") : null;
      const privacyOrg = url.pathname.startsWith("/v1/privacy-consents") &&
        officialMelangePrivacyRoute(request.method, url.pathname, search)
        ? request.headers.get("x-organization-uuid") : null;
      const connectorLifecycle = officialConnectorLifecycleTarget(request.method, url.pathname + search);
      const organizationPluginRemoval = request.method === "DELETE" && officialOrganizationPluginMutation(request.method, url.pathname + search);
      const spendLimitWrite = officialSpendLimitActionOrganization(request.method, url.pathname + search);
      const spendLimitActivation = spendLimitWrite && request.headers.get(officialSpendLimitActivationHeader);
      const transfer = isAction && (spendLimitWrite || coworkMemory || codeUserSettings || mcpAppToolbox || connectorLifecycle || skillUpload || url.pathname === officialUiActionPath || officialChatUploadOrganization(request.method, url.pathname + search) || officialCustomConnectorTarget(request.method, url.pathname + search) || officialMemoryAction(request.method, url.pathname + search) === "synthesize")
        ? { signal: (coworkMemory || codeUserSettings || mcpAppToolbox) && frameSignal ? AbortSignal.any([request.signal, frameSignal]) : request.signal } : undefined;
      const answer = await Promise.race([execute({ method: request.method as OfficialUiReadRequest["method"], path: sharedChat ? officialSharedChatReadPath : `${url.pathname}${search}`,
        ...(mcpAppToolbox ? { mcpAppToolbox: officialMcpAppToolboxHeaders((name) => request.headers.get(name)) } : {}),
        ...(codeOrg !== null ? { codeOrganizationId: codeOrg } : {}),
        ...(spendLimitActivation ? { capabilityLease: spendLimitActivation } : {}),
        ...(privacyOrg !== null ? { privacyOrganizationId: privacyOrg } : {}),
        ...(coworkMemory && coworkMemory.operation !== "read" && { coworkMemoryEpoch }),
        ...(memoryMatch !== null && { coworkMemoryIfMatch: memoryMatch }),
        ...(codeUserSettingsChecksum !== null && { codeUserSettingsChecksum }),
        ...(isOfficialUiProjectKnowledgePath(url.pathname) || isOfficialUiFileReadPath(url.pathname) ? { acceptEncoding: "gzip" as const } : {}),
        ...(body && !documentToken && (!(connectorLifecycle || organizationPluginRemoval || authTarget?.kind === "logout") || body.byteLength) && (!mcpAppToolbox || request.method === "POST") ? { body, contentType: request.headers.get("content-type") ?? "" } : {}) }, transfer), cancelled]);
      if (coworkMemory?.operation === "read" && answer.status === 200 && !coworkMemoryEpoch) {
        const value: unknown = JSON.parse(new TextDecoder().decode(answer.body));
        if (value && typeof value === "object" && "claudex_epoch" in value &&
            typeof value.claudex_epoch === "string" && coworkMemoryRevision.test(value.claudex_epoch))
          coworkMemoryEpoch = value.claudex_epoch;
      }
      if (codeUserSettings && answer.status === 304) return new Response(null, { status: 304, headers: { "Cache-Control": "no-store" } });
      if (answer.contentType === officialCodeControlContentType) {
        const session = isAction && officialCodeFollowupPath(request.method, url.pathname);
        let control: CodeControlReply;
        try {
          if (!session || answer.status !== 200 || answer.body.byteLength > officialCodeWorkspaceDiffMaxBytes) throw Error();
          control = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(answer.body));
          if (typeof control.requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(control.requestId)) throw Error();
          if (control.error !== undefined) {
            if (typeof control.error !== "string" || control.error.length > 256 || control.response !== undefined || control.persisted !== undefined) throw Error();
          } else {
            if (!control.response || typeof control.response !== "object" || Array.isArray(control.response)) throw Error();
            if (control.persisted !== undefined && control.persisted !== true) throw Error();
            if (answer.body.byteLength > 8192 && !(
              control.requestId.startsWith("get_workspace_diff-") && Object.hasOwn(control.response, "diff") ||
              control.requestId.startsWith("list_directory-") && Array.isArray(control.response.entries) ||
              control.requestId.startsWith("file_suggestions-") && Array.isArray(control.response.suggestions) ||
              control.requestId.startsWith("get_task_output-") && typeof control.response.output === "string" ||
              control.requestId.startsWith("initialize-") && Array.isArray(control.response.commands) ||
              control.requestId.startsWith("read_file-") && typeof control.response.contents === "string" ||
              officialCodeRewindReply.safeParse(control.response).success
            )) throw Error();
          }
        } catch {
          return Response.json({ error: "Invalid Code control reply." }, { status: 502 });
        }
        const delivered = !controls.dispatchEvent(new CustomEvent(session.key, { cancelable: true, detail: control }));
        if (control.requestId.startsWith("cancel_async_message-") && typeof control.response?.cancelled === "boolean")
          return Response.json({ events: [], cancelled: control.response.cancelled });
        return delivered || control.persisted === true ? Response.json({ events: [] })
          : Response.json({ error: "Reconnect the Code session." }, { status: 409 });
      }
      const responseBody = answer.bodyEncoding === "gzip"
        ? new Blob([new Uint8Array(answer.body)]).stream().pipeThrough(new DecompressionStream("gzip"), { signal: request.signal })
        : new Uint8Array(answer.body);
      const designRetry = isOfficialDesignCreateRetry(request.method, url.pathname + search, answer.status);
      return new Response([204, 205, 304].includes(answer.status) || mcpAppToolbox && answer.status === 202 ? null : responseBody, {
        status: answer.status,
        headers: {
          "Content-Type": answer.contentType,
          "Cache-Control": "no-store",
          ...(answer.bodyEncoding ? {} : { "Content-Length": String(answer.body.byteLength) }),
          "X-Content-Type-Options": "nosniff",
          ...(answer.contentDisposition ? { "Content-Disposition": answer.contentDisposition } : {}),
          ...(mcpAppToolbox && answer.mcpSessionId ? { "Mcp-Session-Id": answer.mcpSessionId } : {}),
          ...(designRetry && answer.retryAfter ? { "Retry-After": answer.retryAfter } : {}),
          ...(designRetry && answer.status === 409 && answer.frameRefusal ? { "X-Frame-Refusal": answer.frameRefusal } : {}),
        },
      });
    } finally { if (abort) request.signal.removeEventListener("abort", abort); }
  };
}
