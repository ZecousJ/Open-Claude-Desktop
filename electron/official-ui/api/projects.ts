import {beginProjectFileList,rememberProjectUploadFile,type ProjectFileExpectation} from './project-file-aliases';
/**
 * Projects (official consumers: the Projects page and project view in
 * shared-0 / shared-m-2; recorded `projects_v2` answer of 2026-10-30), on
 * Claudex projects (snapshot `projects`, "saveProject", "deleteProject") and
 * their knowledge files ("listProjectKnowledge", "addProjectKnowledgeText",
 * "addProjectKnowledgeFiles", "removeProjectKnowledge", "readProjectKnowledge").
 * Claudex keeps one list of knowledge files; text files are the page's
 * "docs", and raw uploads its "files". Calls go through the app's routing,
 * so a cloud project's are answered by the runner.
 */
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type http from "node:http";
import type { Project } from "../../../shared/types";
import { projectTemplateInput, sameProjectCreation } from "../../../shared/project-creation";
import { projectKnowledgeCapacityCode } from "../../../shared/project-knowledge-errors";
import { builtInAttachmentBytes } from "../../../shared/client-policy";
import { ScopedMap } from "./scope";
import { isOfficialUiProjectMetadataUpdate, isOfficialUiProjectCreation, isOfficialUiProjectDeletion, isOfficialUiProjectMemoryUpdate, officialUiProjectKnowledgeMutation, officialUiProjectTextRequestMaxBytes, officialUiProjectUploadMaxBytes, officialUiRequestLimit } from "../../../shared/official-ui-web";
import { canDeleteOwnedChatProject, isEditablePrivateChatProject, ownedProjectCapabilities, type ProjectMetadataPatch } from "../../../shared/project-access";
import {
  knowledgeFileLimit,
  knowledgeFileLimitMessage,
  type KnowledgeFile,
  type KnowledgePreview,
  type ProjectKnowledge,
} from "../../../shared/collections-api";
import { empty, reply, type AdapterContext, organizationUuid } from "./context";
import { isChat, conversationRow, conversationTimes } from "./conversations";
import { attachmentResponseHeaders, mediaTypeOf } from "./files";
import {
  readBoundedBytes,
  readBoundedJson,
  RequestBodyError,
} from "./request-body";
import {
  checkContents,
  inspectKnowledgeContents,
  knowledgeFileFormat,
  knowledgePath,
  knowledgeTextName,
} from "../../projects/project-knowledge";
import {
  reserveProjectUpload,
  ProjectUploadReceiptError,
} from "./project-upload-receipts";
import { MelangeConflictError } from "../../memory/melange";
import { convertOfficeDocument, OfficeRuntimeUnavailable } from "../../workspace/office-conversion";

const iso = (ms: number | undefined) => new Date(ms ?? 0).toISOString();
const maxProjectInstructionsLength = 100_000;
const nativeProjectOperations = {
  createChat: true,
  deleteProject: true,
  editKnowledge: true,
  editInstructions: true,
};

function personalProjectAccess(project: Project, operations = nativeProjectOperations) {
  const rights = ownedProjectCapabilities(project);
  return {
    permissions: [
      ...(operations.createChat ? ["chat_project:chat:create"] : []),
      "chat_project:chat:view",
      ...(operations.deleteProject && canDeleteOwnedChatProject(project) ? ["chat_project:delete"] : []),
      ...(operations.editKnowledge && rights.canEditKnowledgeBase ? ["chat_project:knowledge:edit"] : []),
      "chat_project:knowledge:view",
    ],
    claudex_can_edit_instructions: operations.editInstructions && rights.canEditInstructions,
  };
}

function rejectPersonalSharingUpdate(body: Record<string, unknown>) {
  if ((Object.hasOwn(body, "is_private") && body.is_private !== true) || Object.hasOwn(body, "organization_role"))
    throw new ProjectPreviewError(403, "Personal projects cannot be shared.");
}

/** A knowledge file's stable id (the page addresses docs and files by uuid). */
export function knowledgeId(projectId: string, name: string) {
  const hex = createHash("sha256")
    .update(`${projectId}\0${name}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const isDoc = (name: string) => {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? "";
  return (
    knowledgeFileFormat(name) === "text" && extension !== "csv"
  );
};

export function projectRow(
  p: Project,
  account: { id: string; name: string } | undefined,
  knowledge?: ProjectKnowledge,
  access = personalProjectAccess(p),
) {
  const files = knowledge?.files ?? [];
  return {
    uuid: p.id,
    name: p.name,
    description: p.description ?? "",
    prompt_template: p.instructions ?? "",
    is_private: true,
    creator: account ? { uuid: account.id, full_name: account.name } : null,
    is_starred: !!p.pinned,
    is_starter_project: !!p.isStarterProject,
    is_harmony_project: false,
    type: p.template?.type ?? null,
    subtype: p.template?.subtype ?? null,
    settings: {},
    archiver:
      p.archivedAt && account
        ? { uuid: account.id, full_name: account.name }
        : null,
    archived_at: p.archivedAt ? iso(p.archivedAt) : null,
    created_at: iso(p.createdAt),
    updated_at: iso(p.createdAt),
    ...access,
    docs_count: knowledge ? files.filter((f) => isDoc(f.name)).length : null,
    files_count: knowledge ? files.filter((f) => !isDoc(f.name)).length : null,
    moved_to: null,
  };
}

const docLengths = new ScopedMap<string, { bytes: number; addedAt: number; length: number }>("project-doc-lengths");
const docLengthKey = (ctx: AdapterContext, projectId: string, file: KnowledgeFile) =>
  JSON.stringify([ctx.stateDirectory?.(), projectId, file.name]);
function docRow(ctx: AdapterContext, projectId: string, file: KnowledgeFile, content?: string, knownLength?: number) {
  let length = knownLength;
  if (content !== undefined) {
    length = 0;
    for (const _character of content) length++;
    const key = docLengthKey(ctx, projectId, file);
    if (docLengths.size >= 4096 && !docLengths.has(key)) docLengths.delete(docLengths.keys().next().value!);
    docLengths.set(key, { bytes: file.bytes, addedAt: file.addedAt, length });
  }
  return {
    uuid: knowledgeId(projectId, file.name),
    file_name: file.displayName ?? file.name,
    content: content ?? "",
    ...(length === undefined ? {} : { content_length: length }),
    created_at: iso(file.addedAt),
    project_uuid: projectId,
    estimated_token_count: Math.ceil(file.bytes / 4),
  };
}

function fileRow(org: string, projectId: string, file: KnowledgeFile) {
  const id = knowledgeId(projectId, file.name);
  const format = knowledgeFileFormat(file.name);
  const raster = format?.startsWith("image/") === true;
  const image = raster && file.imageWidth && file.imageHeight
    ? { image_width: file.imageWidth, image_height: file.imageHeight }
    : undefined;
  const url = `/api/organizations/${org}/projects/${projectId}/knowledge/${id}`;
  return {
    file_uuid: id,
    file_name: file.name,
    file_kind: image
      ? "image"
      : format === "pdf"
        ? "document"
        : "blob",
    created_at: iso(file.addedAt),
    size_bytes: file.bytes,
    thumbnail_url: image ? url : null,
    preview_url: format === "binary" || (raster && !image) ? null : url,
    ...(image
      ? {
          thumbnail_asset: {
            url,
            file_variant: "thumbnail",
            primary_color: "ffffff",
            ...image,
          },
          preview_asset: {
            url,
            file_variant: "preview",
            primary_color: "ffffff",
            ...image,
          },
        }
      : {}),
    ...(format === "pdf"
      ? { document_asset: { url, file_variant: "document", page_count: null } }
      : {}),
  };
}

type KnowledgeRead = { bytes: number } & (
  | { kind: "text"; text: string }
  | { kind: "pdf" | "image" | "binary" | "utf16"; data: Buffer }
);

class ProjectPreviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
/** Never turn source failure or an unsupported preview into a successful empty file. */
async function readKnowledgePreview(
  ctx: AdapterContext,
  projectId: string,
  name: string,
): Promise<KnowledgeRead> {
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  let value: KnowledgePreview;
  try {
    value = (await ctx.call(
      "readProjectKnowledge",
      projectId,
      name,
    )) as KnowledgePreview;
  } catch {
    if (
      ctx.isCurrent?.() === false ||
      !owner ||
      ctx.account()?.id !== owner ||
      ctx.sessionIdentity?.() !== activation
    )
      throw new ProjectPreviewError(
        409,
        "The account changed during this request.",
      );
    throw new ProjectPreviewError(
      503,
      "Project knowledge could not be read. Try again.",
    );
  }
  if (
    ctx.isCurrent?.() === false ||
    !owner ||
    ctx.account()?.id !== owner ||
    ctx.sessionIdentity?.() !== activation
  )
    throw new ProjectPreviewError(
      409,
      "The account changed during this request.",
    );
  if (value?.kind === "unsupported")
    throw new ProjectPreviewError(
      501,
      "This project file has no supported preview.",
    );
  const invalid = () =>
    new ProjectPreviewError(
      503,
      "Project knowledge returned an invalid preview.",
    );
  if (
    !value ||
    value.name !== name ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    value.bytes > knowledgeFileLimit
  )
    throw invalid();
  const format = knowledgeFileFormat(name);
  if (value.kind === "text") {
    if (
      format !== "text" ||
      typeof value.text !== "string" ||
      Buffer.byteLength(value.text) > knowledgeFileLimit
    )
      throw invalid();
    return value;
  }
  if (
    !["pdf", "image", "binary", "utf16"].includes(value.kind) ||
    typeof value.base64 !== "string" ||
    value.base64.length !== Math.ceil(value.bytes / 3) * 4
  )
    throw invalid();
  const data = Buffer.from(value.base64, "base64");
  if (data.length !== value.bytes || data.toString("base64") !== value.base64)
    throw invalid();
  const inspected = inspectKnowledgeContents(name, data);
  if (
    inspected.kind !== value.kind ||
    (value.kind === "image" &&
      (inspected.kind !== "image" || inspected.mime !== value.mime))
  )
    throw invalid();
  return { kind: value.kind, bytes: value.bytes, data };
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

function knowledgeReadBytes(value: KnowledgeRead) {
  if (value.kind !== "text") return value.data;
  const data = Buffer.from(value.text, "utf8");
  // The store's UTF-8 decoder strips a leading BOM.
  return data.length + utf8Bom.length === value.bytes
    ? Buffer.concat([utf8Bom, data])
    : data;
}

async function readProjectJson(req: http.IncomingMessage, ctx: AdapterContext) {
  const owner = ctx.account()?.id,
    activation = ctx.sessionIdentity?.();
  const body = await readBoundedJson(req, officialUiProjectTextRequestMaxBytes);
  if (
    ctx.isCurrent?.() === false ||
    !owner ||
    ctx.account()?.id !== owner ||
    ctx.sessionIdentity?.() !== activation
  )
    throw new ProjectPreviewError(
      409,
      "The account changed during this request.",
    );
  return body;
}

/** Official upload consumers submit one file per request. No runtime path reads. */
export async function multipartKnowledgeFile(
  req: http.IncomingMessage,
  ctx: AdapterContext,
) {
  const body = await readBoundedBytes(req, officialUiProjectUploadMaxBytes);
  let form: FormData;
  try {
    form = await new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": String(req.headers["content-type"] ?? "") },
      body: new Uint8Array(body),
    }).formData();
  } catch {
    throw new RequestBodyError(400, "Choose a valid multipart file upload.");
  }
  const keys = [...form.keys()];
  if (
    keys.some(
      (key) =>
        ![
          "file",
          "relative_dir",
          "client_upload_id",
          "reuse_first_upload",
        ].includes(key),
    ) ||
    new Set(keys).size !== keys.length
  )
    throw new RequestBodyError(
      400,
      "Submit one project file per request, with supported fields only.",
    );
  const clientId = form.get("client_upload_id"),
    reuse = form.get("reuse_first_upload");
  if (
    clientId !== null &&
    (typeof clientId !== "string" ||
      !clientId ||
      clientId.length > 128 ||
      /[\u0000-\u001f]/.test(clientId))
  )
    throw new RequestBodyError(400, "Invalid project upload correlation ID.");
  if (reuse !== null && reuse !== "true" && reuse !== "false")
    throw new RequestBodyError(400, "Invalid project upload reuse option.");
  if (reuse === "true" && !clientId)
    throw new RequestBodyError(
      400,
      "A reusable upload requires a client upload ID.",
    );
  const file = form.get("file"),
    relative = form.get("relative_dir");
  if (
    !file ||
    typeof file === "string" ||
    (relative !== null &&
      (typeof relative !== "string" || !relative || relative.length > 4096))
  )
    throw new RequestBodyError(
      400,
      "Choose one project file and a valid relative folder.",
    );
  if (file.size > knowledgeFileLimit)
    throw new RequestBodyError(413, knowledgeFileLimitMessage);
  let name: string;
  try {
    name = knowledgePath(relative ? `${relative}/${file.name}` : file.name);
  } catch {
    throw new RequestBodyError(
      400,
      "Choose a valid project file name and supported file type.",
    );
  }
  const contents = await file.arrayBuffer();
  const bytes = Buffer.from(contents);
  let inspected: ReturnType<typeof checkContents>;
  try {
    inspected = checkContents(name, bytes);
  } catch (error) {
    throw new RequestBodyError(
      400,
      error instanceof Error ? error.message : "Choose a valid project file.",
    );
  }
  if (
    inspected.kind === "image" &&
    ctx.image &&
    bytes.length <= builtInAttachmentBytes.image &&
    !(await ctx.image.size(bytes))
  )
    throw new RequestBodyError(400, "Choose a readable project image.");
  return {
    name,
    data: new Uint8Array(contents),
    clientId: clientId as string | null,
    reuse: reuse === "true",
  };
}

export async function projectsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
  expectedKnowledge?: ProjectFileExpectation,
): Promise<boolean> {
  try {
    return await projectRoute(req, res, p, url, ctx, expectedKnowledge);
  } catch (error) {
    const capacityCode = projectKnowledgeCapacityCode(error);
    if (capacityCode)
      return reply(res, { type: "error", error: { type: "invalid_request_error", message: error instanceof Error ? error.message : "Remove some project files before adding more.", details: { error_code: capacityCode } } }, 400);
    if (error instanceof ProjectUploadReceiptError)
      return reply(
        res,
        { error: { type: "api_error", message: error.message } },
        error.status,
      );
    if (error instanceof RequestBodyError)
      return reply(
        res,
        { error: { type: "invalid_request_error", message: error.message } },
        error.status,
      );
    if (error instanceof ProjectPreviewError)
      return reply(
        res,
        { error: { type: "api_error", message: error.message } },
        error.status,
      );
    if (/\/projects(?:_v2)?\/[^/]+\/upload$/.test(p))
      return reply(
        res,
        {
          error: {
            type: "api_error",
            message:
              "The project upload could not be confirmed. Check project knowledge before retrying.",
          },
        },
        503,
      );
    const message = error instanceof Error ? error.message : String(error);
    // A project deleted while the page still shows it: gone, as the official answer says.
    if (/no longer exists|not found|unknown project/i.test(message))
      return reply(
        res,
        { type: "error", error: { type: "not_found_error", message } },
        404,
      );
    if (ctx.readOnly)
      return reply(
        res,
        { type: "error", error: { type: "api_error", message } },
        500,
      );
    return reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      400,
    );
  }
}

async function projectRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
  expectedKnowledge?: ProjectFileExpectation,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const m =
    /^\/api\/organizations\/([^/]+)\/(projects_v2|projects)(?:\/([^/]+))?(?:\/(.+))?$/.exec(
      p,
    );
  if (!m) return false;
  const [, org, collection, projectId, rest] = m;
  const account = ctx.account();
  const uploadActivation = ctx.sessionIdentity?.();
  const docRoot = ctx.stateDirectory?.();
  const uploadOwner = account?.id;
  if (!account || org !== organizationUuid(account.id))
    return reply(
      res,
      { error: { type: "not_found_error", message: "Project not found" } },
      404,
    );
  if (ctx.isCurrent?.() === false)
    return reply(
      res,
      {
        error: {
          type: "api_error",
          message: "The account changed during this request.",
        },
      },
      409,
    );
  const updateMetadata = ctx.readOnly && !url.search &&
    isOfficialUiProjectMetadataUpdate(method, p) ? ctx.updateProjectMetadata : undefined;
  const createProject = ctx.readOnly && !url.search &&
    isOfficialUiProjectCreation(method, p) ? ctx.createProject : undefined;
  const deleteProject = ctx.readOnly && !url.search &&
    isOfficialUiProjectDeletion(method, p) ? ctx.deleteProject : undefined;
  const updateMemory = !url.search && isOfficialUiProjectMemoryUpdate(method, p);
  const originalDelete = method === "DELETE" && collection === "projects" && !!projectId && !rest && !url.search;
  const knowledgeMutation = ctx.allowProjectKnowledgeChanges && !url.search && officialUiProjectKnowledgeMutation(method, p);
  if (ctx.readOnly && method !== "GET" && !updateMetadata && !createProject && !deleteProject && !knowledgeMutation &&
      !(updateMemory && ctx.authorizeProjectMemoryUpdate))
    return reply(
      res,
      {
        error: {
          type: "not_supported_error",
          message: "Project changes are unavailable in this read-only host.",
        },
      },
      501,
    );
  if (
    (rest === "docs/delete_many" || rest === "files/delete_many") &&
    method !== "POST"
  )
    return reply(
      res,
      {
        error: {
          type: "invalid_request_error",
          message: "Use POST to remove project knowledge.",
        },
      },
      405,
    );
  const owner = { id: account.id, name: account.name || account.email };
  const access = (project: Project) => personalProjectAccess(project, ctx.readOnly ? {
    createChat: false,
    deleteProject: !!ctx.deleteProject &&
      isOfficialUiProjectDeletion("DELETE", `/api/organizations/${org}/projects/${project.id}`),
    editKnowledge: ctx.allowProjectKnowledgeChanges === true,
    editInstructions: !!ctx.updateProjectMetadata && isEditablePrivateChatProject(project),
  } : undefined);
  const visibleProjectRow = (project: Project, details?: ProjectKnowledge) =>
    projectRow(project, owner, details, access(project));
  const projects = async (fresh = false) =>
    ((await ctx.snapshot(fresh)).projects ?? []).filter(
      (x) => (x.kind ?? "chat") === "chat",
    );
  // A project made or changed a moment ago may be newer than the cached read.
  const find = async (id: string) =>
    (await projects()).find((x) => x.id === id) ??
    (await projects(true)).find((x) => x.id === id);
  const knowledge = (id: string) =>
    ctx.call("listProjectKnowledge", id) as Promise<ProjectKnowledge>;
  const notFound = () =>
    reply(
      res,
      {
        type: "error",
        error: { type: "not_found_error", message: "Project not found" },
      },
      404,
    );
  if (updateMetadata && projectId) {
    if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
      throw new RequestBodyError(400, "Project metadata requires JSON.");
    // JSON may escape one UTF-16 code unit into six bytes.
    const body = await readBoundedJson(req, 6 * maxProjectInstructionsLength + 128);
    rejectPersonalSharingUpdate(body);
    const fields = Object.keys(body);
    let patch: ProjectMetadataPatch | undefined;
    if (fields.length && fields.every(field => field === "name" || field === "description")) {
      if ((body.name !== undefined && (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200)) ||
          (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000)))
        throw new RequestBodyError(400, "Enter a valid project name and description.");
      patch = {
        ...(typeof body.name === "string" && { name: body.name.trim() }),
        ...(typeof body.description === "string" && { description: body.description }),
      };
    } else if (fields.length === 1) {
      if (typeof body.is_starred === "boolean") patch = { pinned: body.is_starred };
      if (typeof body.prompt_template === "string" && body.prompt_template.length <= maxProjectInstructionsLength)
        patch = { instructions: body.prompt_template };
    }
    if (!patch) throw new RequestBodyError(400, "Choose a valid project name, description, starred value, or instructions.");
    let updated: Project | undefined;
    try {
      updated = await updateMetadata(projectId, patch);
    } catch {
      if (ctx.isCurrent?.() === false || ctx.account()?.id !== uploadOwner || ctx.sessionIdentity?.() !== uploadActivation)
        throw new ProjectPreviewError(409, "The account changed. Reopen this project.");
      throw new ProjectPreviewError(503, "The project update could not be confirmed. Reopen the project before retrying.");
    }
    if (!updated) return notFound();
    const details = await knowledge(projectId).catch(() => undefined);
    return reply(res, visibleProjectRow(updated, details));
  }

  // The list (Projects page, sidebar, project pickers).
  if (!projectId && method === "GET") {
    const archived = url.searchParams.get("is_archived") === "true";
    const starred = url.searchParams.get("starred") === "true";
    const query = (
      url.searchParams.get("query") ??
      url.searchParams.get("search") ??
      url.searchParams.get("searchQuery") ??
      ""
    ).toLowerCase();
    const limit = Math.min(
      Number(url.searchParams.get("limit") ?? 30) || 30,
      500,
    );
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const filter = url.searchParams.get("filter");
    const excludesPersonal = collection === "projects_v2" && (
      filter === "is_shared_with_org" || filter === "is_shared_with_me" || filter === "is_not_creator" ||
      url.searchParams.get("creator_filter") === "is_not_creator"
    );
    const all = excludesPersonal ? [] : await projects();
    const rows = all
      .filter((x) => !!x.archivedAt === archived)
      .filter((x) => !starred || x.pinned)
      .filter((x) => !query || x.name.toLowerCase().includes(query))
      .sort(
        (a, b) =>
          Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt,
      )
      .map((x) => {
        const row = visibleProjectRow(x);
        return ctx.readOnly
          ? {
              ...row,
              ...(ctx.allowConversationProjectMove && isEditablePrivateChatProject(x) ? { claudex_can_move_conversation: true } : {}),
            }
          : row;
      });
    const page = rows.slice(offset, offset + limit);
    if (collection === "projects") return reply(res, page);
    return reply(res, {
      data: page,
      pagination: {
        total: rows.length,
        limit,
        offset,
        has_more: rows.length > offset + limit,
      },
      has_archived: all.some((x) => !!x.archivedAt),
    });
  }
  if (projectId === "count" && method === "GET")
    return reply(res, {
      count: (await projects()).filter((x) => !x.archivedAt).length,
    });
  if (projectId === "request_haystack") return reply(res, {});
  // Create.
  if (!projectId && method === "POST") {
    if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
      throw new RequestBodyError(400, "Project creation requires JSON.");
    const body = await readBoundedJson(req, officialUiRequestLimit(method, p));
    if (ctx.isCurrent?.() === false || ctx.account()?.id !== uploadOwner || ctx.sessionIdentity?.() !== uploadActivation)
      throw new ProjectPreviewError(409, "The account changed during this request.");
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200 ||
        (body.description !== undefined && (typeof body.description !== "string" || body.description.length > 2000)) ||
        (body.prompt_template !== undefined && (typeof body.prompt_template !== "string" || body.prompt_template.length > maxProjectInstructionsLength)) ||
        (body.is_starred !== undefined && typeof body.is_starred !== "boolean") ||
        (body.is_private !== undefined && typeof body.is_private !== "boolean") ||
        (body.client_creation_id !== undefined && (typeof body.client_creation_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.client_creation_id))))
      throw new RequestBodyError(400, "Enter a valid project name, description and instructions.");
    if (body.is_private === false)
      throw new ProjectPreviewError(403, "Only private projects are available.");
    const template = projectTemplateInput.optional().safeParse(
      body.type == null && body.subtype == null ? undefined : body,
    );
    if (!template.success)
      throw new RequestBodyError(400, "Choose a valid project template.");
    let project: Project = {
      id: body.client_creation_id ?? randomUUID(),
      kind: "chat",
      name: body.name.trim(),
      description: body.description ?? "",
      instructions: body.prompt_template ?? "",
      ...(template.data && { template: template.data }),
      pinned: body.is_starred ?? false,
      visibility: "private",
      createdAt: Date.now(),
    };
    if (body.client_creation_id) {
      const existing = (await projects()).find(row => row.id === project.id);
      if (existing) {
        if (!sameProjectCreation(existing, project))
          throw new ProjectPreviewError(409, "This project was already created with different details. Open it from the project list.");
        project = existing;
      }
    }
    let saved: Project;
    try { saved = createProject ? await createProject(project) : await ctx.call("saveProject", project) as Project; }
    catch {
      if (ctx.isCurrent?.() === false || ctx.account()?.id !== uploadOwner || ctx.sessionIdentity?.() !== uploadActivation)
        throw new ProjectPreviewError(409, "The account changed during this request.");
      throw new ProjectPreviewError(503, "Project creation could not be confirmed. Check the project list, then try again.");
    }
    // Creation is already committed; a list refresh must not turn it into a failed create.
    await ctx.snapshot(true).catch(() => undefined);
    if (ctx.isCurrent?.() === false || ctx.account()?.id !== uploadOwner || ctx.sessionIdentity?.() !== uploadActivation)
      throw new ProjectPreviewError(409, "The account changed during this request.");
    return reply(res, visibleProjectRow(saved ?? project), 201);
  }
  if (!projectId) return false;
  if (originalDelete && (await readBoundedBytes(req, 1)).byteLength)
    throw new RequestBodyError(400, "Project deletion does not accept a request body.");
  // Hold the request's original owner across lookup, mutation, and readback.
  const currentDoc = () => {
    try {
      if (expectedKnowledge?.isCurrent() === false || ctx.isCurrent?.() === false || (!fileListRequest && (uploadActivation === undefined ||
          uploadActivation === null || uploadActivation === "")) ||
          ctx.stateDirectory?.() !== docRoot || ctx.account()?.id !== uploadOwner ||
          ctx.sessionIdentity?.() !== uploadActivation)
        throw new Error("Retired request.");
    } catch {
      throw new ProjectPreviewError(409, "The account changed. Reopen this project.");
    }
  };
  const knowledgeDeleteRequest = (method === "DELETE" && /^docs\/(?!delete_many$)[^/]+$/.test(rest ?? "")) ||
    (method === "POST" && (rest === "docs/delete_many" || rest === "files/delete_many"));
  const rawKnowledgeRequest = method === "GET" && /^knowledge\/[^/]+$/.test(rest ?? "");
  const fileListRequest = rest === "files" && method === "GET";
  let commitFileList: ReturnType<typeof beginProjectFileList> | undefined;
  if(fileListRequest){currentDoc();try{commitFileList=beginProjectFileList(ctx,projectId);}catch{currentDoc();throw new ProjectPreviewError(503,"Project file identities are unavailable.");}}
  const textDocRequest = rawKnowledgeRequest || fileListRequest || knowledgeDeleteRequest || (rest === "docs" && method === "POST") ||
    (method === "GET" && /^docs\/(?!delete_many$)[^/]+$/.test(rest ?? ""));
  const scopedProjectLookup = textDocRequest || originalDelete || updateMemory;
  let project: Project | undefined;
  try {
    if (scopedProjectLookup) currentDoc();
    project = await find(projectId);
    if (scopedProjectLookup) currentDoc();
  } catch (error) {
    if (!scopedProjectLookup) throw error;
    currentDoc();
    throw new ProjectPreviewError(503, originalDelete || updateMemory
      ? "The project could not be read. Try again."
      : "Project knowledge could not be read. Try again.");
  }
  if (!project) return notFound();
  if (method === "GET") {
    if (rest === "permissions") return reply(res, { permissions: access(project).permissions });
    if (rest === "roles") return reply(res, { group_assignments: [] });
    if (rest === "pending_shares") return reply(res, []);
    if (rest === "accounts") return reply(res, [{
      account: { uuid: owner.id, full_name: owner.name, email_address: account.email },
      role: "view",
    }]);
  } else if (/^(?:accounts(?:\/[^/]+)?|accounts_bulk|groups\/[^/]+|groups_bulk|roles|pending_shares)$/.test(rest ?? "")) {
    throw new ProjectPreviewError(403, "Personal projects cannot be shared.");
  }
  const projectMemorySettings = async () => {
    const memory = await ctx.melange?.();
    const enabled = await memory?.projectUsesAccountMemory(projectId);
    return enabled === undefined ? {} : { memory_general_enabled: enabled };
  };
  if (rest === "settings") {
    if (method === "GET") {
      let settings;
      try {
        settings = await projectMemorySettings();
      } catch {
        if (ctx.isCurrent?.() === false || ctx.account()?.id !== uploadOwner ||
            ctx.sessionIdentity?.() !== uploadActivation)
          throw new ProjectPreviewError(409, "The account changed. Reopen this project.");
        throw new ProjectPreviewError(503, "The project memory setting could not be loaded.");
      }
      if (ctx.isCurrent?.() === false || ctx.account()?.id !== uploadOwner ||
          ctx.sessionIdentity?.() !== uploadActivation)
        throw new ProjectPreviewError(409, "The account changed. Reopen this project.");
      return reply(res, settings);
    }
    if (!updateMemory)
      throw new ProjectPreviewError(405, "Unsupported project settings operation.");
    currentDoc();
    if (!isEditablePrivateChatProject(project))
      throw new ProjectPreviewError(403, "You do not have permission to change this project's memory settings.");
    if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
      throw new RequestBodyError(400, "Project memory settings require JSON.");
    const body = await readBoundedJson(req, officialUiRequestLimit(method, p));
    const enabled = body.memory_general_enabled;
    if (Object.keys(body).length !== 1 || typeof enabled !== "boolean")
      throw new RequestBodyError(400, "Choose a boolean project memory setting.");
    currentDoc();
    const memory = await ctx.melange?.();
    currentDoc();
    if (ctx.readOnly && !ctx.authorizeProjectMemoryUpdate?.(projectId))
      throw new ProjectPreviewError(409, "The account changed. Reopen this project.");
    let saved: boolean | undefined;
    try {
      saved = await memory?.setProjectUsesAccountMemory(projectId, enabled);
    } catch (error) {
      currentDoc();
      if (error instanceof MelangeConflictError)
        throw new ProjectPreviewError(409, "The project memory setting changed. Reopen this project.");
      throw new ProjectPreviewError(503, "The project memory setting could not be saved.");
    }
    currentDoc();
    if (!saved)
      throw new ProjectPreviewError(501, "Project memory settings are unavailable.");
    return reply(res, { memory_general_enabled: enabled });
  }
  if (officialUiProjectKnowledgeMutation(method, p) && !ownedProjectCapabilities(project).canEditKnowledgeBase)
    throw new ProjectPreviewError(403, "You do not have permission to edit this project's context.");

  if (!rest) {
    if (method === "GET") {
      // A failed source is not an empty/unknown successful inventory. Preserve
      // the current project detail until its real knowledge can be loaded.
      const current = () => ctx.isCurrent?.() !== false &&
        ctx.account()?.id === uploadOwner &&
        ctx.sessionIdentity?.() === uploadActivation;
      const changed = () => new ProjectPreviewError(
        409, "The account changed. Reopen this project.",
      );
      if (!current()) throw changed();
      let details: ProjectKnowledge;
      try {
        details = await knowledge(projectId);
        if (!details || !Array.isArray(details.files) ||
            details.files.some(file => !file || typeof file.name !== "string"))
          throw new Error("Invalid knowledge inventory");
      } catch {
        if (!current()) throw changed();
        throw new ProjectPreviewError(
          503, "Project knowledge is temporarily unavailable. Retry loading this project.",
        );
      }
      const memorySettings = await projectMemorySettings().catch(() => ({}));
      if (!current()) throw changed();
      return reply(res, { ...visibleProjectRow(project, details), ...memorySettings });
    }
    if (originalDelete) {
      if (!canDeleteOwnedChatProject(project))
        throw new ProjectPreviewError(403, "You do not have permission to delete this project.");
      try {
        if (deleteProject) await deleteProject(projectId);
        else await ctx.call("deleteProject", { id: projectId, mode: "cascade" });
      } catch {
        currentDoc();
        throw new ProjectPreviewError(503, "Project deletion could not be confirmed. Check the project list before retrying.");
      }
      await ctx.snapshot(true).catch(() => undefined);
      currentDoc();
      return empty(res);
    }
    if (method === "PUT" || method === "PATCH") {
      // Keep the identity captured before project lookup. Capturing a new
      // identity only when reading the body could save account A's project
      // through account B after an asynchronous snapshot switches accounts.
      const current = () => {
        if (uploadActivation === undefined || uploadActivation === null ||
            ctx.isCurrent?.() === false ||
            ctx.account()?.id !== uploadOwner ||
            ctx.sessionIdentity?.() !== uploadActivation)
          throw new ProjectPreviewError(409, "The account changed. Reopen this project.");
      };
      current();
      const body = await readProjectJson(req, ctx);
      current();
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          (Object.hasOwn(body, "name") &&
            (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 200)) ||
          (Object.hasOwn(body, "is_starred") && typeof body.is_starred !== "boolean"))
        throw new RequestBodyError(400, "Use a non-empty project name of at most 200 characters and a boolean starred value.");
      if (Object.hasOwn(body, "prompt_template") &&
          (typeof body.prompt_template !== "string" || body.prompt_template.length > maxProjectInstructionsLength))
        throw new RequestBodyError(400, "Project instructions must be text of at most 100,000 characters.");
      rejectPersonalSharingUpdate(body);
      const next: Project = { ...project };
      if (typeof body.name === "string" && body.name.trim())
        next.name = body.name.trim();
      if (typeof body.description === "string")
        next.description = body.description;
      if (typeof body.prompt_template === "string")
        next.instructions = body.prompt_template;
      if (typeof body.is_starred === "boolean") next.pinned = body.is_starred;
      if (typeof body.is_archived === "boolean")
        next.archivedAt = body.is_archived ? Date.now() : undefined;
      if (typeof body.archived === "boolean")
        next.archivedAt = body.archived ? Date.now() : undefined;
      const { capabilities: _c, creationReceipt: _r, ...saved } = next;
      await ctx.call("saveProject", saved);
      current();
      await ctx.snapshot(true);
      current();
      const details = await knowledge(projectId).catch(() => undefined);
      current();
      return reply(res, visibleProjectRow(next, details));
    }
  }
  // Text knowledge ("docs").
  const doc = /^docs\/([^/]+)$/.exec(rest ?? "");
  if (doc && doc[1] !== "delete_many" && method === "GET") {
    currentDoc();
    try {
      const inventory = await knowledge(projectId);
      currentDoc();
      if (!Array.isArray(inventory?.files) || inventory.files.some((f) =>
          !f || typeof f.name !== "string" || !Number.isSafeInteger(f.bytes) ||
          f.bytes < 0 || !Number.isFinite(f.addedAt)))
        throw new Error("Invalid knowledge inventory.");
      const matches = inventory.files.filter((f) => isDoc(f.name) && knowledgeId(projectId, f.name) === doc[1]);
      if (!matches.length) return notFound();
      if (matches.length !== 1) throw new Error("Ambiguous document identity.");
      const file = matches[0];
      const preview = await readKnowledgePreview(ctx, projectId, file.name);
      currentDoc();
      if (preview.kind !== "text")
        throw new ProjectPreviewError(501, "This project document has no text preview.");
      return reply(res, docRow(ctx, projectId, file, preview.text));
    } catch (error) {
      currentDoc();
      if (error instanceof ProjectPreviewError) throw error;
      throw new ProjectPreviewError(503, "Project knowledge could not be read. Try again.");
    }
  }
  if (rest === "docs" && method === "GET") {
    const files = (await knowledge(projectId)).files.filter((f) =>
      isDoc(f.name),
    );
    const compact = url.searchParams.get("compact") === "true";
    const rows = [];
    for (const file of files) {
      const cached = compact ? docLengths.get(docLengthKey(ctx, projectId, file)) : undefined;
      if (cached && cached.bytes === file.bytes && cached.addedAt === file.addedAt) {
        rows.push(docRow(ctx, projectId, file, undefined, cached.length));
        continue;
      }
      const preview = await readKnowledgePreview(ctx, projectId, file.name);
      if (preview.kind !== "text")
        throw new ProjectPreviewError(
          501,
          "This project document has no text preview.",
        );
      const row = docRow(ctx, projectId, file, preview.text);
      rows.push(compact ? { ...row, content: "" } : row);
    }
    return reply(res, rows);
  }
  if (rest === "docs" && method === "POST") {
    currentDoc();
    const body = await readProjectJson(req, ctx);
    currentDoc();
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.file_name !== "string" || body.file_name.length > 200 ||
        typeof body.content !== "string" || !body.content.length)
      throw new RequestBodyError(400, "Use a text title and non-empty document content within the project file limit.");
    if (Buffer.byteLength(body.content) > knowledgeFileLimit)
      throw new RequestBodyError(413, knowledgeFileLimitMessage);
    let name: string;
    try { name = knowledgeTextName(body.file_name); }
    catch (error) { throw new RequestBodyError(400, error instanceof Error ? error.message : "Choose a valid project filename."); }
    try {
      const after = (await ctx.call("addProjectKnowledgeText", projectId, {
        name: body.file_name,
        text: body.content,
        ...(/\.(?:docx?|pptx|rtf|epub|odt|xlsx?|csv)$/i.test(body.file_name.trim()) ? { displayName: body.file_name.trim() } : {}),
      })) as ProjectKnowledge;
      currentDoc();
      const matches = after?.files?.filter((f) => f.name === name);
      if (matches?.length !== 1) throw new Error("No unique saved document.");
      const file = matches[0];
      const preview = await readKnowledgePreview(ctx, projectId, file.name);
      currentDoc();
      const savedBytes = Buffer.from(body.content, "utf8");
      const expectedText = new TextDecoder("utf-8", { fatal: true }).decode(savedBytes);
      if (preview.kind !== "text" || preview.text !== expectedText ||
          preview.bytes !== savedBytes.length || file.bytes !== savedBytes.length)
        throw new Error("Saved document could not be confirmed.");
      return reply(res, docRow(ctx, projectId, file, preview.text));
    } catch (error) {
      currentDoc();
      if (projectKnowledgeCapacityCode(error)) throw error;
      throw new ProjectPreviewError(503,
        "The document save could not be confirmed. Check project knowledge before retrying.");
    }
  }
  const removeByIds = async (ids: string[], docs: boolean) => {
    currentDoc();
    if (!ownedProjectCapabilities(project).canEditKnowledgeBase)
      throw new ProjectPreviewError(403, "You do not have permission to edit this project's context.");
    const validInventory = (value: ProjectKnowledge) => {
      if (!Array.isArray(value?.files) || value.files.some((f) =>
          !f || typeof f.name !== "string" || !f.name || f.name.length > 4096 ||
          path.isAbsolute(f.name) || f.name.replace(/\\/g, "/").split("/").some((part) => !part || part === "." || part === "..")))
        throw new Error("Invalid knowledge inventory.");
      if (new Set(value.files.map((f) => f.name)).size !== value.files.length)
        throw new Error("Ambiguous knowledge inventory.");
      return value.files;
    };
    try {
      const files = validInventory(await knowledge(projectId));
      currentDoc();
      const wanted = new Set(ids);
      const matched = files.filter((f) => isDoc(f.name) === docs && wanted.has(knowledgeId(projectId, f.name)));
      // The existing native removeProjectKnowledge array schema permits 200 names.
      // Keep the original 1000-ID wire bound; unmatched/duplicate IDs never become native names.
      if (matched.length > 200)
        throw new RequestBodyError(400, "Choose at most 200 existing project knowledge files.");
      if (!matched.length) return [];
      const names = matched.map((f) => f.name);
      const after = validInventory(await ctx.call("removeProjectKnowledge", projectId, names) as ProjectKnowledge);
      currentDoc();
      if (after.some((f) => names.includes(f.name)))
        throw new Error("Removal could not be confirmed.");
      return matched.map((f) => knowledgeId(projectId, f.name));
    } catch (error) {
      currentDoc();
      if (error instanceof RequestBodyError) throw error;
      if (error instanceof Error && error.message === "You do not have permission to edit this project's context.")
        throw new ProjectPreviewError(403, error.message);
      throw new ProjectPreviewError(503,
        "The removal could not be confirmed. Refresh project knowledge before retrying.");
    }
  };
  if (doc && doc[1] !== "delete_many" && method === "DELETE") {
    await removeByIds([doc[1]], true);
    return empty(res);
  }
  if (rest === "docs/delete_many" || rest === "files/delete_many") {
    currentDoc();
    const body = await readProjectJson(req, ctx);
    currentDoc();
    const rawIds = rest === "docs/delete_many" ? body?.doc_uuids : body?.file_uuids;
    if (!Array.isArray(rawIds) || rawIds.length > 1000 ||
        rawIds.some((id) => typeof id !== "string" || !id || id.length > 128))
      throw new RequestBodyError(400, "Choose valid project knowledge identifiers.");
    const deleted = await removeByIds(rawIds as string[], rest === "docs/delete_many");
    return reply(res, { deleted });
  }
  // Binary knowledge ("files") and uploads.
  if (rest === "files" && method === "GET") {
    let inventory:ProjectKnowledge;
    try{inventory=await knowledge(projectId);}catch{currentDoc();throw new ProjectPreviewError(503,"Project knowledge is unavailable.");}
    currentDoc();if(!inventory||!Array.isArray(inventory.files)||inventory.files.some(f=>!f||typeof f.name!=="string"))throw new ProjectPreviewError(503,"Project knowledge is unavailable.");
    const files=inventory.files.filter(f=>!isDoc(f.name));
    currentDoc();
    try{commitFileList!(files.map(f=>({id:knowledgeId(projectId,f.name),name:f.name,bytes:f.bytes,addedAt:f.addedAt})));}
    catch{currentDoc();throw new ProjectPreviewError(503,"Project file identities could not be confirmed.");}
    return reply(res,files.map((f) => fileRow(org, projectId, f)));
  }
  if (rest === "upload") {
    if (method !== "POST")
      throw new ProjectPreviewError(
        405,
        "Use POST to upload project knowledge.",
      );
    if (url.search)
      throw new RequestBodyError(400, "Unsupported project upload parameters.");
    const currentUpload = () => {
      if (
        ctx.isCurrent?.() === false ||
        ctx.account()?.id !== uploadOwner ||
        ctx.sessionIdentity?.() !== uploadActivation
      )
        throw new ProjectPreviewError(
          409,
          "The account changed. The upload outcome is not confirmed.",
        );
      if (req.aborted)
        throw new ProjectPreviewError(
          409,
          "The upload was cancelled. Check project knowledge before retrying.",
        );
    };
    currentUpload();
    const uploaded = await multipartKnowledgeFile(req, ctx);
    currentUpload();
    const digest = (bytes: Uint8Array) =>
      createHash("sha256").update(bytes).digest("hex");
    const payloadHash = uploaded.clientId ? createHash("sha256")
      .update(
        JSON.stringify([
          projectId,
          uploaded.name,
          uploaded.data.byteLength,
          digest(uploaded.data),
        ]),
      )
      .digest("hex") : "";
    const receipt = uploaded.clientId
      ? await reserveProjectUpload(
          {
            account: () => ctx.account(),
            stateDirectory: () => ctx.stateDirectory?.() ?? "",
            sessionIdentity: () => ctx.sessionIdentity?.(),
            isCurrent: () => ctx.isCurrent?.() !== false && !req.aborted,
          },
          uploaded.clientId,
          payloadHash,
          uploaded.reuse,
        )
      : undefined;
    if (receipt && !receipt.fresh && !uploaded.reuse)
      throw new ProjectPreviewError(
        409,
        "This upload ID was already used. Choose a new ID to replace a file.",
      );
    currentUpload();
    const after =
      receipt && !receipt.fresh
        ? await knowledge(projectId)
        : ((await ctx.call("addProjectKnowledgeFiles", projectId, [
            { name: uploaded.name, data: uploaded.data },
          ])) as ProjectKnowledge);
    currentUpload();
    if (!after || !Array.isArray(after.files) || after.files.length > 200)
      throw new ProjectPreviewError(
        503,
        "The project upload result could not be verified. Check project knowledge before retrying.",
      );
    const matches = after.files.filter((file) => file?.name === uploaded.name);
    const file = matches[0];
    if (receipt && !receipt.fresh && matches.length === 0)
      throw new ProjectPreviewError(409, "The previous upload cannot be confirmed. Select the file again to retry.");
    if (
      matches.length !== 1 ||
      !file ||
      file.bytes !== uploaded.data.byteLength ||
      !Number.isSafeInteger(file.bytes) ||
      !Number.isFinite(file.addedAt) ||
      file.addedAt < 0 ||
      file.addedAt > 8.64e15
    )
      throw new ProjectPreviewError(
        503,
        "The project upload result could not be verified. Check project knowledge before retrying.",
      );
    if (receipt) {
      const preview = await readKnowledgePreview(ctx, projectId, uploaded.name);
      currentUpload();
      const actual = knowledgeReadBytes(preview);
      if (
        actual.length !== preview.bytes ||
        actual.length !== uploaded.data.byteLength ||
        !actual.equals(uploaded.data)
      )
        throw new ProjectPreviewError(
          409,
          "The project file changed or its uploaded bytes could not be confirmed. It was not uploaded again.",
        );
      currentUpload();
      if (!receipt.fresh && !receipt.confirmed) {
        try {
          await ctx.call("confirmProjectKnowledgeUpload", projectId, {
            name: file.name, bytes: file.bytes, addedAt: file.addedAt,
          });
        } catch (error) {
          currentUpload();
          throw error;
        }
        currentUpload();
      }
      await receipt.confirm();
    }
    currentUpload();
    rememberProjectUploadFile(ctx,projectId,{id:knowledgeId(projectId,file.name),name:file.name,bytes:file.bytes,addedAt:file.addedAt});
    return reply(res, {
      success: true,
      ...fileRow(org, projectId, file),
      sanitized_name: file.name,
    });
  }
  const content = /^knowledge\/([^/]+)$/.exec(rest ?? "");
  if (content && method === "GET") {
    currentDoc();
    const readFile=async()=>{let inventory:ProjectKnowledge;try{inventory=await knowledge(projectId);}catch{currentDoc();throw new ProjectPreviewError(503,"Project knowledge is unavailable.");}currentDoc();
      if(!inventory||!Array.isArray(inventory.files))throw new ProjectPreviewError(503,"Project knowledge is unavailable.");
      const matches=inventory.files.filter(f=>f&&typeof f.name==='string'&&knowledgeId(projectId,f.name)===content[1]);
      if(matches.length>1)throw new ProjectPreviewError(503,"Project file identity is ambiguous.");
      return matches[0];};
    const file=await readFile();if(!file)return notFound();
    const same=(f:KnowledgeFile)=>f.name===file.name&&f.bytes===file.bytes&&f.addedAt===file.addedAt;
    if(expectedKnowledge&&!same(expectedKnowledge))throw new ProjectPreviewError(409,"The project file changed. Reload project files.");
    const preview=await readKnowledgePreview(ctx,projectId,file.name);currentDoc();
    const xlsPreview = expectedKnowledge?.variant === "xls-preview";
    let data = knowledgeReadBytes(preview);
    if (xlsPreview) {
      if (!ctx.documentRuntime)
        throw new ProjectPreviewError(503, "Document conversion is unavailable on this host.");
      if (req.aborted || res.destroyed) return true;
      const abort = new AbortController();
      const cancel = () => abort.abort();
      res.once("close", cancel);
      try {
        data = await convertOfficeDocument({
          runtime: ctx.documentRuntime,
          data,
          extension: "xls",
          output: "xlsx",
          signal: abort.signal,
        });
      } catch (error) {
        if (abort.signal.aborted) return true;
        currentDoc();
        if (error instanceof OfficeRuntimeUnavailable)
          throw new ProjectPreviewError(503, error.message);
        throw new ProjectPreviewError(422, "The spreadsheet could not be previewed. It may be damaged or password protected.");
      } finally {
        res.off("close", cancel);
      }
    }
    const after=await readFile();if(!after)return notFound();if(!same(after))throw new ProjectPreviewError(409,"The project file changed. Reload project files.");
    if(!(await projects(true)).some(p=>p.id===projectId))return notFound();currentDoc();
    currentDoc();if(req.aborted||res.destroyed||res.writableEnded)return true;
    res.writeHead(
      200,
      preview.kind === "binary" && !xlsPreview
        ? attachmentResponseHeaders(file, "application/octet-stream")
        : {
            "Content-Type": mediaTypeOf(xlsPreview ? "preview.xlsx" : file.name),
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
          },
    );
    res.end(data);
    return true;
  }
  // Knowledge size and search (the project view's capacity bar).
  if (rest === "kb/stats") {
    const k = await knowledge(projectId);
    return reply(res, {
      use_project_knowledge_search: false,
      knowledge_size: k.bytes,
      max_knowledge_size: k.limit,
      percentage_used: k.limit ? Math.round((k.bytes / k.limit) * 100) : 0,
    });
  }
  // Knowledge re-sync (shared-m-2 AV): Claudex knowledge is always current.
  if (rest === "sync")
    return reply(res, {
      kb_resync_status: "done",
      gdrive_resource_backfill_triggered: false,
    });
  if (rest === "syncs") return reply(res, []);
  // The project's conversations.
  if (rest === "conversations" || rest === "conversations_v2") {
    const rows = (await ctx.listConversations())
      .filter(isChat)
      .filter((c) => c.projectId === projectId && !c.incognito)
      .sort(
        (a, b) => conversationTimes(b).updated - conversationTimes(a).updated,
      )
      .map((conversation) => conversationRow(conversation, ctx));
    return reply(
      res,
      rest === "conversations"
        ? rows
        : { data: rows, pagination: { has_more: false } },
    );
  }
  if (rest === "activity_v2")
    return reply(res, { data: [], pagination: { has_more: false } });
  return false;
}
