import type http from "node:http";
import { z } from "zod";
import { officialOrganizationProjectTarget } from "../../../shared/official-project-organizations";
import { remoteAccountId } from "../../sub2api/identity-support";
import { claudexClientInfo, Sub2ApiError } from "../../sub2api/http";
import type { Sub2ApiClient } from "../../sub2api/client";
import { claudexHeaders } from "../../../shared/claudex-contract";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";
import { attachmentResponseHeaders, mediaTypeOf } from "./files";
import { knowledgeFileFormat, knowledgeTextName } from "../../projects/project-knowledge";
import { multipartKnowledgeFile } from "./projects";
import { officialUiProjectTextRequestMaxBytes } from "../../../shared/official-ui-web";
import { convertOfficeDocument, OfficeRuntimeUnavailable } from "../../workspace/office-conversion";

const member = z.object({
  userId: z.number().int().positive(), email: z.string(), name: z.string(),
});
const audience = z.enum(["none", "view", "user"]);
const project = z.object({
  id: z.string().uuid(), organizationId: z.string().uuid(),
  ownerId: z.number().int().positive(), creator: member,
  name: z.string(), description: z.string(), instructions: z.string(),
  createdAt: z.number(), updatedAt: z.number(), archivedAt: z.number().nullish(),
  starred: z.boolean(), audienceRole: audience, directRole: audience,
  role: z.enum(["owner", "view", "user"]),
});
const policy = z.object({ sharingEnabled: z.boolean(), publicProjectsEnabled: z.boolean() });
const workspaces = z.array(policy.extend({
  id: z.string().uuid(), name: z.string().min(1), role: z.enum(["member", "admin"]),
}));
const prefix = "/claudex/project-organizations";
const projectInput = z.object({
  client_creation_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  prompt_template: z.string().max(100_000).optional(),
  is_private: z.boolean().optional(),
  organization_role: z.enum(["view", "user"]).optional(),
  is_starred: z.boolean().optional(),
  is_archived: z.boolean().optional(),
});

export interface OrganizationProjectService {
  baseUrl: string;
  shareOrigin?: string;
  call(path: string, method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<unknown>;
  readKnowledge?(route: string): Promise<Uint8Array>;
  uploadKnowledge?(route: string, bytes: Uint8Array, mediaType: string): Promise<unknown>;
}

export function organizationKnowledgeRequest(client: Sub2ApiClient, token: string, route: string): Promise<Uint8Array>;
export function organizationKnowledgeRequest(client: Sub2ApiClient, token: string, route: string,
  upload: { bytes: Uint8Array; mediaType: string }): Promise<unknown>;
export async function organizationKnowledgeRequest(
  client: Sub2ApiClient, token: string, route: string,
  upload?: { bytes: Uint8Array; mediaType: string },
) {
  if (!/^\/claudex\/project-organizations\/[0-9a-f-]{36}\/projects\/[0-9a-f-]{36}\/knowledge(?:\/[0-9a-f-]{36}|\?name=[^&]*)$/i.test(route))
    throw Error("Invalid organization knowledge route.");
  const response = await client.fetchImpl(client.api(route), {
    method: upload ? "POST" : "GET",
    headers: {
      ...claudexHeaders(claudexClientInfo()),
      Authorization: `Bearer ${token}`,
      ...(upload && { "Content-Type": upload.mediaType }),
    },
    ...(upload && { body: new Uint8Array(upload.bytes) }),
    redirect: "error",
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => undefined);
    const details = z.object({ reason: z.string().optional(), message: z.string().optional() }).safeParse(data);
    throw new Sub2ApiError(response.status, details.data?.reason ?? "PROJECT_KNOWLEDGE_UNAVAILABLE",
      details.data?.message ?? "The project knowledge request failed.");
  }
  return upload ? await response.json() : new Uint8Array(await response.arrayBuffer());
}

export async function organizationProjectWorkspaces(ctx: AdapterContext) {
  const service = ctx.organizationProjects;
  if (!service) return [];
  try {
    const rows = workspaces.parse(await service.call(prefix));
    if (ctx.isCurrent?.() === false) return [];
    return rows.map(row => ({
      uuid: row.id, name: row.name, role: row.role,
      project_sharing_enabled: row.sharingEnabled, public_projects_enabled: row.publicProjectsEnabled,
    }));
  } catch {
    return [];
  }
}

function permissions(row: z.infer<typeof project>) {
  return [
    "chat_project:chat:create", "chat_project:chat:view", "chat_project:knowledge:view",
    ...(row.role !== "view" ? ["chat_project:knowledge:edit", "chat_project:members:manage"] : []),
    ...(row.role === "owner" ? ["chat_project:settings:edit", "chat_project:owner:manage", "chat_project:delete"] : []),
  ];
}

const organizationFeatures = (value: z.infer<typeof policy>) => [
  { feature: "project_sharing", status: value.sharingEnabled ? "available" : "blocked_by_org_admin" },
  { feature: "public_projects", status: value.publicProjectsEnabled ? "available" : "blocked_by_org_admin" },
];

function accountRow(person: z.infer<typeof member>, baseUrl: string) {
  return { uuid: remoteAccountId(baseUrl, person.userId), full_name: person.name, email_address: person.email };
}

function projectRow(row: z.infer<typeof project>, baseUrl: string) {
  return {
    uuid: row.id, organization_uuid: row.organizationId, name: row.name,
    description: row.description, prompt_template: row.instructions,
    is_private: row.audienceRole === "none", organization_role: row.audienceRole,
    is_starred: row.starred, is_starter_project: false, is_harmony_project: false,
    creator: accountRow(row.creator, baseUrl),
    archived_at: row.archivedAt ? new Date(row.archivedAt).toISOString() : null,
    created_at: new Date(row.createdAt).toISOString(), updated_at: new Date(row.updatedAt).toISOString(),
    has_sync_sources: false, settings: {}, permissions: permissions(row),
    claudex_can_edit_instructions: row.role !== "view",
    docs_count: null, files_count: null, moved_to: null,
  };
}

async function readInput<T extends z.ZodType>(req: http.IncomingMessage, schema: T, limit = 310_000): Promise<z.infer<T>> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new RequestBodyError(400, "Use a JSON project request.");
  const parsed = schema.safeParse(await readBoundedJson(req, limit));
  if (!parsed.success) throw new RequestBodyError(400, "Enter valid project details or permissions.");
  return parsed.data;
}

function wholeNumber(value: string | null, fallback: number, limit: number) {
  const n = value === null ? fallback : Number(value);
  return Number.isSafeInteger(n) ? Math.min(limit, Math.max(0, n)) : fallback;
}

const accountAccess = z.array(member.extend({ role: z.enum(["owner", "view", "user"]) }));
const memberSearch = z.object({ members: z.array(member), nextOffset: z.number().int().optional() });
const knowledgeFile = z.object({
  id: z.string().uuid(), name: z.string(), mime: z.string(), size: z.number().int().nonnegative(),
  createdAt: z.string(), updatedAt: z.string(),
});
const knowledgeInventory = z.object({
  files: z.array(knowledgeFile), limitBytes: z.number().int().positive(),
});
type OrganizationKnowledgeFile = z.infer<typeof knowledgeFile>;
const isDocument = (file: OrganizationKnowledgeFile) =>
  knowledgeFileFormat(file.name) === "text" && !file.name.toLowerCase().endsWith(".csv");
const isLegacySpreadsheet = (file: OrganizationKnowledgeFile) => /\.xls$/i.test(file.name);

async function organizationKnowledgeRoute(
  req: http.IncomingMessage, res: http.ServerResponse, ctx: AdapterContext, url: URL,
  target: Extract<NonNullable<ReturnType<typeof officialOrganizationProjectTarget>>, { kind: "knowledge" }>,
  service: OrganizationProjectService, item: string,
) {
  const { readKnowledge, uploadKnowledge, call } = service;
  if (!readKnowledge || !uploadKnowledge) return reply(res, { error: { message: "Project knowledge is unavailable." } }, 503);
  const base = `${item}/knowledge`;
  const current = () => {
    if (req.aborted || ctx.isCurrent?.() === false)
      throw new Sub2ApiError(409, "PROJECT_SCOPE_CHANGED", "Reopen this project before retrying.");
  };
  const read = async (id: string) => {
    const bytes = await readKnowledge(`${base}/${id}`);
    current();
    return bytes;
  };
  const document = async (row: OrganizationKnowledgeFile, compact = false) => {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await read(row.id));
    return { uuid: row.id, file_name: row.name, content: compact ? "" : text, content_length: Array.from(text).length,
      created_at: row.createdAt, project_uuid: target.project, estimated_token_count: Math.ceil(row.size / 4) };
  };
  const fileRow = (row: OrganizationKnowledgeFile) => ({
    file_uuid: row.id, file_name: row.name, file_kind: "blob",
    created_at: row.createdAt, size_bytes: row.size, thumbnail_url: null,
    preview_url: `/api/organizations/${target.organization}/projects/${target.project}/knowledge/${row.id}${isLegacySpreadsheet(row) ? "?preview=xlsx" : ""}`,
  });
  if (req.method === "POST" && (target.action === "docs" || target.action === "upload")) {
    let payload: { name: string; bytes: Uint8Array; mediaType: string };
    if (target.action === "docs") {
      const body = await readInput(req, z.object({
        file_name: z.string().min(1).max(200), content: z.string().min(1),
      }), officialUiProjectTextRequestMaxBytes);
      payload = { name: knowledgeTextName(body.file_name), bytes: Buffer.from(body.content), mediaType: "text/plain; charset=utf-8" };
    } else {
      const file = await multipartKnowledgeFile(req, ctx);
      payload = { name: file.name, bytes: file.data, mediaType: mediaTypeOf(file.name) };
    }
    current();
    const { file } = z.object({ file: knowledgeFile }).parse(await uploadKnowledge(
      `${base}?name=${encodeURIComponent(payload.name)}`, payload.bytes, payload.mediaType,
    ));
    current();
    return reply(res, target.action === "docs" ? await document(file) : {
      success: true, ...fileRow(file), sanitized_name: file.name,
    });
  }
  const inventory = knowledgeInventory.parse(await call(base));
  current();
  const docs = inventory.files.filter(isDocument);
  if (target.action === "stats") {
    const bytes = inventory.files.reduce((total, row) => total + row.size, 0);
    return reply(res, { use_project_knowledge_search: false, knowledge_size: bytes,
      max_knowledge_size: inventory.limitBytes, percentage_used: Math.round(100 * bytes / inventory.limitBytes) });
  }
  if (target.action === "files") return reply(res, inventory.files.filter(row => !isDocument(row)).map(fileRow));
  if (target.action === "docs") {
    const result = [];
    for (const file of docs) result.push(await document(file, url.searchParams.get("compact") === "true"));
    return reply(res, result);
  }
  if (target.action === "delete-docs" || target.action === "delete-files") {
    const name = target.action === "delete-docs" ? "doc_uuids" : "file_uuids";
    const body = await readInput(req, z.object({ [name]: z.array(z.string().uuid()).min(1).max(200) }));
    const ids = body[name] ?? [];
    if (ids.some(id => !inventory.files.some(file => file.id === id && isDocument(file) === (name === "doc_uuids"))))
      return reply(res, { error: { message: "Project knowledge not found." } }, 404);
    for (const id of new Set(ids)) await call(`${base}/${id}`, "DELETE");
    current();
    return reply(res, { deleted: [...new Set(ids)] });
  }
  const file = inventory.files.find(row => row.id === target.file);
  if (!file || (target.action === "doc" && !isDocument(file)))
    return reply(res, { error: { message: "Project knowledge not found." } }, 404);
  if (req.method === "DELETE") {
    await call(`${base}/${file.id}`, "DELETE");
    current();
    return empty(res);
  }
  if (target.action === "doc") return reply(res, await document(file));
  let bytes = await read(file.id);
  const spreadsheetPreview = isLegacySpreadsheet(file) && url.searchParams.get("preview") === "xlsx";
  if (spreadsheetPreview) {
    if (!ctx.documentRuntime)
      throw new Sub2ApiError(503, "DOCUMENT_RUNTIME_UNAVAILABLE", "Document conversion is unavailable on this host.");
    if (res.destroyed) return true;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    res.once("close", cancel);
    try {
      bytes = await convertOfficeDocument({
        runtime: ctx.documentRuntime,
        data: Buffer.from(bytes),
        extension: "xls",
        output: "xlsx",
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) return true;
      current();
      if (error instanceof OfficeRuntimeUnavailable)
        throw new Sub2ApiError(503, "DOCUMENT_RUNTIME_UNAVAILABLE", error.message);
      throw new Sub2ApiError(422, "INVALID_SPREADSHEET", "The spreadsheet could not be previewed. It may be damaged or password protected.");
    } finally {
      res.off("close", cancel);
    }
    if (abort.signal.aborted) return true;
    current();
  }
  res.writeHead(200, attachmentResponseHeaders(file, mediaTypeOf(spreadsheetPreview ? "preview.xlsx" : file.name)));
  res.end(bytes);
  return true;
}

export async function organizationProjectRoute(
  req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const target = officialOrganizationProjectTarget(method, url.pathname);
  const account = ctx.account();
  if (!target || !account || ("organization" in target && target.organization === organizationUuid(account.id)))
    return false;
  const service = ctx.organizationProjects;
  const fail = (status: number, message: string, code?: string) => reply(res, {
    type: "error",
    error: { type: status === 404 ? "not_found_error" : status === 403 ? "permission_error" : "api_error",
             message, ...(code && { details: { error_code: code } }) },
  }, status);
  if (!service) return fail(404, "Project not found.");
  const { baseUrl, call } = service;
  const accountWire = (row: z.infer<typeof member>) => accountRow(row, baseUrl);
  const projectWire = (row: z.infer<typeof project>) => projectRow(row, baseUrl);
  try {
    if (target.kind === "resolve") {
      const row = project.parse(await call(`${prefix}/resolve/${target.project}`));
      return reply(res, { organization_uuid: row.organizationId });
    }
    const base = `${prefix}/${target.organization}`;
    const collection = `${base}/projects`;
    const item = "project" in target ? `${collection}/${target.project}` : collection;
    const load = async () => project.parse(await call(item));
    if (target.kind === "knowledge") return await organizationKnowledgeRoute(req, res, ctx, url, target, service, item);
    if (target.kind === "access" || target.kind === "features" || target.kind === "policy") {
      if (target.kind === "policy" && method === "PUT") {
        const body = await readInput(req, z.strictObject({
          claude_ai_project_sharing_enabled: z.boolean().optional(),
          public_projects_enabled: z.boolean().optional(),
        }).refine(v => Object.keys(v).length > 0));
        await call(`${base}/policy`, "PUT", {
          sharingEnabled: body.claude_ai_project_sharing_enabled,
          publicProjectsEnabled: body.public_projects_enabled,
        });
      }
      const state = policy.parse(await call(`${base}/policy`));
      const features = organizationFeatures(state);
      const setting = {
        claude_ai_project_sharing_enabled: state.sharingEnabled,
        public_projects_enabled: state.publicProjectsEnabled,
      };
      if (target.kind === "policy") return reply(res, setting);
      const roster = workspaces.parse(await call(prefix));
      const admin = roster.some(row => row.id === target.organization && row.role === "admin");
      return reply(res, {
        ...setting, features, organization_permissions: admin ? ["org:privacy-settings:update"] : [],
      });
    }
    if (target.kind === "members") {
      const query = new URLSearchParams({
        q: url.searchParams.get("search") ?? "",
        limit: String(wholeNumber(url.searchParams.get("limit"), 10, 200)),
        offset: String(wholeNumber(url.searchParams.get("offset"), 0, 1_000_000)),
      });
      for (const email of url.searchParams.getAll("emails[]")) query.append("emails", email);
      const result = memberSearch.parse(await call(`${base}/members?${query}`));
      return reply(res, {
        data: result.members.map(row => ({ type: "member", member: { account: accountWire(row) } })),
        pagination: { has_more: result.nextOffset !== undefined },
      });
    }
    if (target.kind === "count") {
      const rows = z.array(project).parse(await call(collection));
      return reply(res, { count: rows.filter(row => !row.archivedAt).length });
    }
    if (target.kind === "list") {
      const all = z.array(project).parse(await call(collection));
      const filter = url.searchParams.get("filter") ?? url.searchParams.get("creator_filter");
      if (filter === "is_shared_with_org" && !policy.parse(await call(`${base}/policy`)).publicProjectsEnabled)
        return fail(403, "Public projects are off.", "public_projects_disabled");
      const archived = url.searchParams.get("is_archived") === "true";
      const query = (url.searchParams.get("searchQuery") ?? "").trim().toLowerCase();
      const selected = all.filter(row =>
        (filter === "is_creator" ? row.role === "owner" :
          filter === "is_not_creator" ? row.role !== "owner" :
          filter === "is_shared_with_org" ? row.audienceRole !== "none" :
          filter === "is_shared_with_me" ? row.role !== "owner" && row.directRole !== "none" : true) &&
        (!query || row.name.toLowerCase().includes(query)) &&
        (url.searchParams.get("starred") !== "true" || row.starred),
      );
      const rows = selected.filter(row => Boolean(row.archivedAt) === archived)
        .sort((a, b) => Boolean(a.starred) === Boolean(b.starred)
          ? b.updatedAt - a.updatedAt : Number(b.starred) - Number(a.starred)).map(projectWire);
      if (!target.paginated) return reply(res, rows);
      const limit = wholeNumber(url.searchParams.get("limit"), 30, 500) || 30;
      const offset = wholeNumber(url.searchParams.get("offset"), 0, 1_000_000);
      return reply(res, {
        data: rows.slice(offset, offset + limit),
        pagination: { limit, offset, total: rows.length, has_more: offset + limit < rows.length },
        ...(url.searchParams.get("include_has_archived") === "true" && {
          has_archived: selected.some(row => Boolean(row.archivedAt)),
        }),
      });
    }
    if (target.kind === "create" || target.kind === "update") {
      const input = await readInput(req, projectInput, 615_000);
      const creating = target.kind === "create";
      if (creating && !input.name) return fail(400, "Enter a project name.");
      const patch = {
        name: input.name, description: input.description, instructions: input.prompt_template,
        ...(creating && { clientCreationId: input.client_creation_id }),
        ...(input.is_private === true && { audienceRole: "none" }),
        ...(input.is_private !== true && (input.organization_role || input.is_private === false) && {
          audienceRole: input.organization_role ?? "view",
        }),
        ...(input.is_starred !== undefined && { starred: input.is_starred }),
        ...(input.is_archived !== undefined && { archived: input.is_archived }),
      };
      const updated = await call(creating ? collection : item, creating ? "POST" : "PATCH", patch);
      return updated == null ? empty(res) : reply(res, projectWire(project.parse(updated)), creating ? 201 : 200);
    }
    if (target.kind === "delete") {
      await call(item, "DELETE");
      return empty(res);
    }
    if (target.kind === "detail") return reply(res, projectWire(await load()));
    if (target.kind === "permissions") return reply(res, { permissions: permissions(await load()) });
    if (target.kind === "roles") {
      await load();
      return reply(res, { group_assignments: [] });
    }
    if (target.kind === "syncs") {
      await load();
      return reply(res, []);
    }
    if (target.kind === "conversations") {
      await load();
      const { conversationRow, conversationTimes } = await import("./conversations");
      const rows = (await ctx.listConversations())
        .filter(c => c.projectId === target.project && c.projectOrganizationId === target.organization && !c.incognito)
        .sort((a, b) => conversationTimes(b).updated - conversationTimes(a).updated);
      return reply(res, { data: rows.map(c => conversationRow(c, ctx)), pagination: { has_more: false } });
    }
    if (target.kind === "accounts" || target.kind === "grant") {
      const accounts = accountAccess.parse(await call(`${item}/accounts`));
      if (!("account" in target))
        return reply(res, accounts.map(row => ({ account: accountWire(row), role: row.role === "owner" ? "user" : row.role })));
      const account = accounts.find(row => accountWire(row).uuid === target.account);
      if (!account) return fail(404, "Project member not found.");
      const { role } = await readInput(req, z.strictObject({ role: audience }));
      await call(`${item}/accounts/${account.userId}`, "PUT", { role });
      return empty(res);
    }
    if (target.kind === "bulk") {
      const { accounts, role } = await readInput(req, z.object({
        accounts: z.array(z.object({ email_address: z.string().email(), account_uuid: z.string().uuid() })).min(1).max(200),
        role: z.enum(["view", "user"]),
      }));
      const search = new URLSearchParams({ limit: String(accounts.length) });
      for (const target of accounts) search.append("emails", target.email_address);
      const results = memberSearch.parse(await call(`${base}/members?${search}`));
      const targets = accounts.map(target => results.members.find(row =>
        row.email.toLowerCase() === target.email_address.toLowerCase() && accountWire(row).uuid === target.account_uuid,
      )?.userId);
      if (targets.some(target => target === undefined)) return fail(404, "Organization member not found.");
      await call(`${item}/accounts_bulk`, "POST", { targets, role });
      return empty(res);
    }
    return false;
  } catch (error) {
    if (ctx.isCurrent?.() === false) return fail(409, "The account changed. Reopen this project.");
    if (error instanceof RequestBodyError || error instanceof Sub2ApiError)
      return fail(error.status, error.message);
    return fail(503, "Organization projects are unavailable.");
  }
}
