import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { z } from "zod";
import type { CloudSync } from "../../cloud/cloud-sync";
import type { CloudEnvironmentsAPI } from "../../../shared/cloud-environments-api";
import { officialCodeHistoryRequest, isOfficialCodeHistoryPath, officialCodeMarkRead, officialCodeReadBody } from "../../../shared/official-code-history";
import { officialCodeControlContentType, officialCodeFollowupPath, officialCodeReceiptPath } from "../../../shared/official-code-followup";
import { officialCodeUserSettingsOrganization, officialCodeUserSettingsPath } from "../../../shared/official-code-user-settings";
import { isOfficialUiAction, officialUiRequestLimit, type OfficialUiReadRequest, type OfficialUiReadResponse } from "../../../shared/official-ui-web";
import { officialCodeWorkspace } from "../../../shared/official-code-workspace";
import { officialCodePullRequestCreate, officialCodePullRequestCreatePath } from "../../../shared/official-code-pull-requests";
import { officialCodePrMonitorOperation } from "../../../shared/official-code-pr-monitor";
import { createGitHubMethods } from "../../../shared/web-client/github";
import { statusOf } from "../../../shared/web-client/errors";
import { createOfficialReadFetch } from "../../../src-web/official/read-fetch";
import { openOfficialCodeStream, type CodeControlReply } from "../../../src-web/official/code-stream";
import { negotiatedOfficialAction } from "../../../src-web/official/negotiated-action";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedBytes, RequestBodyError } from "./request-body";
import { codeCloudSideSessionId, type CodeCloudSideSessionTarget } from "../../../shared/official-code-side-session";
import type { SkillReference } from "../../../shared/skill-references";

const decoder = new TextDecoder();
const failure = (status: number, message: string): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify({ error: { message } })),
});

const validMethods = ["GET", "POST", "PUT", "DELETE"] as const;
const validMethod = (value: string): value is (typeof validMethods)[number] =>
  validMethods.some((method) => method === value);

function cloudSessionRequest(method: string, url: URL) {
  const { pathname, search } = url;
  if (
    (method === "GET" || method === "PUT") && officialCodeUserSettingsOrganization(pathname + search) ||
    officialCodePullRequestCreate(method, pathname + search) ||
    officialCodePrMonitorOperation(method, pathname + search) ||
    officialCodeHistoryRequest(method, pathname, search) ||
    officialCodeWorkspace(method, pathname, search) ||
    officialCodeReceiptPath(method, pathname) ||
    method === "GET" && pathname === "/v1/code/sessions/watch"
  ) return true;
  if (search || !pathname.startsWith("/v1/code/sessions")) return false;
  return isOfficialUiAction(method, pathname);
}

export function createDesktopCloudCode(
  cloud: CloudSync["officialCode"],
  owner: string,
  current: () => boolean,
) {
  const organization = organizationUuid(owner);
  const available = () => current() && cloud.available();
  const unavailable = () => failure(503, "Cloud Code is unavailable. Check sync with the web and try again.");
  let cached: { lease: object; organization: Promise<string> } | undefined;
  const controls = new EventTarget();
  const observed = new Map<string, { revision: number; eventId?: string }>();

  function bindings() {
    if (!available()) return;
    const lease = cloud.capture();
    if (!lease) return;
    const isCurrent = () => current() && lease.current();
    const check = () => {
      if (!isCurrent()) throw new DOMException("The account changed during this request.", "AbortError");
    };
    const accountOrganization = () => {
      if (cached?.lease === lease.identity) return cached.organization;
      observed.clear();
      const pending = (async () => {
        const answer = await lease.read({ method: "GET", path: "/api/account" });
        check();
        if (answer?.status !== 200) throw Error("The cloud account is unavailable.");
        const body: unknown = JSON.parse(decoder.decode(answer.body));
        if (!body || typeof body !== "object" || !("uuid" in body) || typeof body.uuid !== "string")
          throw Error("The cloud account is unavailable.");
        return organizationUuid(body.uuid);
      })();
      cached = { lease: lease.identity, organization: pending };
      void pending.catch(() => { if (cached?.organization === pending) cached = undefined; });
      return pending;
    };
    const forward = async (request: OfficialUiReadRequest, action = false) => {
      check();
      if (request.codeOrganizationId && request.codeOrganizationId !== organization)
        return failure(404, "Organization not found.");
      const url = new URL(request.path, "http://localhost");
      const codeUserSettings = officialCodeUserSettingsOrganization(url.pathname + url.search);
      const codePullRequest = officialCodePullRequestCreate(request.method, url.pathname + url.search);
      if (codeUserSettings) {
        if (codeUserSettings !== organization) return failure(404, "Organization not found.");
        url.pathname = officialCodeUserSettingsPath(await accountOrganization());
      }
      if (codePullRequest) {
        if (codePullRequest !== organization) return failure(404, "Organization not found.");
        url.pathname = officialCodePullRequestCreatePath(await accountOrganization());
      }
      if (url.pathname === "/v1/code/sessions" && request.method === "GET" &&
          url.searchParams.get("include_trigger_sessions") === "true")
        url.searchParams.delete("include_trigger_sessions");
      const targetsCode = codePullRequest || officialCodePrMonitorOperation(request.method, url.pathname + url.search) ||
        isOfficialCodeHistoryPath(url.pathname) ||
        (action && url.pathname.startsWith("/v1/code/"));
      const codeOrganizationId = targetsCode ? await accountOrganization() : undefined;
      check();
      const { codeOrganizationId: _localOrganization, body, contentType, ...input } = request;
      const key = action && officialCodeMarkRead(request.method, url.pathname);
      const mark = key ? observed.get(key) : undefined;
      let codeReadRevision: number | undefined;
      if (mark && body) {
        try {
          const read = officialCodeReadBody.safeParse(JSON.parse(decoder.decode(body)));
          if (read.success && (!read.data.event_id || read.data.event_id === mark.eventId))
            codeReadRevision = mark.revision;
        } catch {}
      }
      const answer = await (action ? lease.action : lease.read)({
        ...input, path: url.pathname + url.search, ...(codeOrganizationId ? { codeOrganizationId } : {}),
        ...(codeReadRevision !== undefined ? { codeReadRevision } : {}),
        ...(request.method === "GET" ? {} : { body, contentType }),
      });
      check();
      if (codeUserSettings && (answer?.status === 200 || answer?.status === 412)) {
        const body = JSON.parse(decoder.decode(answer.body));
        return { ...answer, body: Buffer.from(JSON.stringify({ ...body, userId: owner })) };
      }
      const query = !action && officialCodeHistoryRequest(request.method, url.pathname, url.search);
      if (query && (query.kind === "session" || query.kind === "events" || query.kind === "stream") && answer?.status === 200) {
        const { session, claudex_read_event: readEvent } = JSON.parse(decoder.decode(answer.body));
        const eventId = typeof readEvent?.id === "string" &&
          Number.isSafeInteger(readEvent.revision) ? readEvent.id : undefined;
        const revision = eventId ? readEvent.revision : session?.claudex_read_revision;
        const previous = observed.get(query.key);
        if (Number.isSafeInteger(revision) && revision >= (previous?.revision ?? 0))
          observed.set(query.key, { revision,
            eventId: eventId ?? (previous && revision === previous.revision ? previous.eventId : undefined) });
      }
      return answer ?? unavailable();
    };
    const action = negotiatedOfficialAction({
      mode: "engine-chat",
      accountId: String(lease.userId),
      isCurrent,
      read: forward,
      action: (request) => forward(request, true),
    });
    const github = createGitHubMethods({ json: async (path, init) => {
      check();
      const answer = await lease.json(path, init);
      check();
      return answer;
    } });
    const callEnvironment = async <Name extends keyof CloudEnvironmentsAPI>(
      method: Name, ...args: Parameters<CloudEnvironmentsAPI[Name]>
    ): Promise<Awaited<ReturnType<CloudEnvironmentsAPI[Name]>>> => {
      check();
      const value = await lease.environment(method, args);
      check();
      return value;
    };
    return {
      forward, action, github, check,
      connected: lease.connected,
      onEvent: lease.onEvent,
      cloudEnvironments: {
        listCloudEnvironments: () => callEnvironment("listCloudEnvironments"),
        mutations: {
          saveCloudEnvironment: (input: Parameters<CloudEnvironmentsAPI["saveCloudEnvironment"]>[0]) =>
            callEnvironment("saveCloudEnvironment", input),
          archiveCloudEnvironment: (id: string) => callEnvironment("archiveCloudEnvironment", id),
        },
      },
    };
  }

  const request = async (input: OfficialUiReadRequest): Promise<OfficialUiReadResponse | undefined> => {
    const host = bindings();
    if (!host) return undefined;
    const url = new URL(input.path, "http://localhost");
    if (!cloudSessionRequest(input.method, url)) return undefined;
    if (!isOfficialUiAction(input.method, input.path)) return host.forward(input);
    const answer = await host.action(input);
    if (answer.contentType !== officialCodeControlContentType) return answer;
    const session = officialCodeFollowupPath(input.method, url.pathname);
    if (!session || answer.status !== 200) return failure(502, "Invalid Code control response.");
    const control: CodeControlReply = JSON.parse(decoder.decode(answer.body));
    if (control.requestId.startsWith("cancel_async_message-") && typeof control.response?.cancelled === "boolean") {
      return { status: 200, contentType: "application/json",
        body: Buffer.from(JSON.stringify({ events: [], cancelled: control.response.cancelled })) };
    }
    const delivered = !controls.dispatchEvent(new CustomEvent(session.key, { cancelable: true, detail: control }));
    return delivered || control.persisted
      ? { status: 200, contentType: "application/json", body: Buffer.from('{"events":[]}') }
      : failure(409, "Reconnect the Code session.");
  };

  const startSideSession = async (input: {
    target: CodeCloudSideSessionTarget;
    requestId: string;
    parentId: string;
    taskId: string;
    text: string;
    skillReferences?: SkillReference[];
  }) => {
    const host = bindings();
    if (!host) throw Error("Cloud Code is unavailable. Check sync with the web.");
    const { target, requestId, parentId, taskId, text } = input;
    const post = (path: string, body: unknown) => host.action({
      method: "POST", path, contentType: "application/json",
      body: Buffer.from(JSON.stringify(body)),
    });
    const started = await post("/v1/code/sessions", {
      title: text.slice(0, 100),
      environment_id: target.environmentId,
      config: {
        sources: [{ type: "git_repository", url: "https://github.com/" + target.repository }],
        outcomes: [{ type: "git_repository", git_info: {
          type: "github", repo: target.repository, branches: ["claude/side-" + requestId],
        } }],
        model: target.model,
        effort_level: target.effort,
        permission_mode: target.permissionMode,
      },
      events: [],
      side_session: { request_id: requestId, parent_session_id: parentId, task_id: taskId },
    });
    if (started.status !== 200)
      throw Error("The Cloud Code session could not be confirmed. Retry the same cloud target to check it.");
    const { session: { id } } = z.object({ session: z.object({ id: codeCloudSideSessionId }) })
      .parse(JSON.parse(decoder.decode(started.body)));
    const events = "/v1/code/sessions/" + id + "/events";
    const receipt = () => host.forward({ method: "GET", path: events + "/" + requestId + "/receipt" });
    const previous = await receipt();
    if (previous.status === 204) return id;
    if (previous.status !== 404)
      throw Error("The Cloud Code message could not be confirmed. Retry the same cloud target to check it.");
    await post(events, { events: [{ payload: {
      type: "user", uuid: requestId, message: { role: "user", content: text },
      ...(input.skillReferences?.length ? { skill_references: input.skillReferences } : {}),
    } }] });
    if ((await receipt()).status !== 204)
      throw Error("The Cloud Code message could not be confirmed. Retry the same cloud target to check it.");
    return id;
  };

  return {
    available,
    request,
    startSideSession,
    listCloudEnvironments: () => bindings()?.cloudEnvironments.listCloudEnvironments() ?? Promise.resolve([]),
    fetch: (origin: string, signal: AbortSignal) => {
      const host = bindings();
      if (!host) return;
      const read = createOfficialReadFetch(origin, host.forward,
        async () => Response.json({ error: { message: "Cloud Code request unavailable." } }, { status: 501 }),
        host.onEvent, host.action, undefined, undefined, {
          organization, codeStreamConnected: host.connected,
          cloudEnvironments: { accountUuid: owner, api: host.cloudEnvironments },
          githubStatus: host.github.githubStatus,
          githubDisconnect: host.github.githubDisconnect,
          githubBranches: host.github.githubBranches,
          githubRepositories: host.github.githubRepositories,
        }, signal);
      const codeStream = (req: Request, url: URL) => {
        const query = officialCodeHistoryRequest(req.method, url.pathname, url.search);
        if (query?.kind !== "stream") return;
        if (!host.connected())
          return Promise.resolve(Response.json({ error: "The Runner event connection is unavailable." }, { status: 503 }));
        return openOfficialCodeStream(req, url, query, host.forward, host.onEvent, controls);
      };
      return async (req: Request) => {
        host.check();
        const url = new URL(req.url);
        return codeStream(req, url) ?? read(req);
      };
    },
  };
}

export type DesktopCloudCode = ReturnType<typeof createDesktopCloudCode>;

export async function desktopCloudCodeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: AdapterContext,
) {
  const cloud = ctx.officialDesktopCloudCode;
  const owner = ctx.account()?.id;
  const method = req.method ?? "GET";
  if (!cloud || !owner || !validMethod(method)) return false;
  const organization = organizationUuid(owner);
  const environment = `/v1/environment_providers/private/organizations/${organization}`;
  const github = `/api/organizations/${organization}`;
  const githubAuth = github + "/sync/github/auth";
  if (!cloudSessionRequest(method, url) &&
      !url.pathname.startsWith(environment + "/environments") &&
      url.pathname !== environment + "/cloud/create" &&
      url.pathname !== environment + "/cloud/ensure_default" &&
      url.pathname !== githubAuth && url.pathname !== githubAuth + "/start" &&
      !url.pathname.startsWith(github + "/code/repos") &&
      !url.pathname.startsWith(`/api/github/organizations/${organization}/github/`))
    return false;
  const stop = new AbortController();
  const fetch = cloud.fetch(url.origin, stop.signal);
  if (!fetch) return false;
  res.once("close", () => stop.abort());
  const off = ctx.onAccountDeactivating?.(() => stop.abort());
  if (off) res.once("close", off);
  const headers = new Headers();
  for (const key of ["content-type", "x-organization-uuid", "last-event-id"] as const) {
    const value = req.headers[key];
    if (typeof value === "string") headers.set(key, value);
  }
  if (officialCodeUserSettingsOrganization(url.pathname + url.search)) {
    const key = method === "GET" ? "if-none-match" : "if-match";
    const value = req.headers[key];
    if (typeof value === "string") headers.set(key, value);
  }
  try {
    const request = new Request(url, {
      method, headers, signal: stop.signal,
      body: method === "GET" ? undefined : new Uint8Array(
        await readBoundedBytes(req, officialUiRequestLimit(method, url.pathname + url.search)),
      ),
    });
    const response = await fetch(request);
    if (stop.signal.aborted || res.destroyed) {
      await response.body?.cancel();
      return true;
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      const reader = response.body.getReader();
      const stream = Readable.from((async function* () {
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            yield item.value;
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      })());
      res.once("close", () => stream.destroy());
      stream.once("error", () => res.end());
      stream.pipe(res);
    } else res.end();
    return true;
  } catch (error) {
    if (stop.signal.aborted || res.destroyed) return true;
    if (error instanceof RequestBodyError)
      return reply(res, { error: { message: error.message } }, error.status);
    return reply(res, { error: { message: "Cloud Code request could not be completed." } }, statusOf(error) ?? 503);
  }
}
