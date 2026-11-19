/**
 * Customize → Skills (official consumers: shared-m-1 list/create/edit/delete/
 * rename/duplicate/enable/disable/upload hooks, RP/YJ parsers; recorded
 * `skills/list-skills` answer of 2026-10-30), on the Claudex skills of the
 * agent ("listSkills", "saveSkill", "setSkillEnabled", "installSkillFiles",
 * "deleteSkill", "renameSkill", "duplicateSkill", "readSkill"). The page
 * addresses skills by id; Claudex by their SKILL.md path, so ids are stable
 * hashes of the path, remembered from the latest list.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { z } from "zod";
import type { PluginCatalog } from "../../../shared/collections-api";
import { installedPluginLibrary } from "./library-plugins";
import { readInstalledOrganizationPlugins } from "./plugin-organization-read";
import {
  readJson,
  reply,
  organizationUuid,
  type AdapterContext,
} from "./context";
import { readBoundedBytes, readBoundedJson, RequestBodyError } from "./request-body";
import { installedSkillSearch } from "./skill-search";
import { skillNameTaken, renameSameName } from "../../../shared/duplicate-name";
import { isSavedSkillName, skillNamePlan } from "../../../shared/skill-name-plan";
import {
  MAX_OFFICIAL_SKILL_VERSION_SAVE_BYTES,
  officialSkillCopyRenameMaxBytes,
  officialSkillCreateMaxBytes,
  officialSkillDeleteMaxBytes,
  officialSkillToggleMaxBytes,
  officialSkillUploadMaxBytes,
} from "../../../shared/official-ui-web";
import { officialSkillAuthoring } from "../../skills/skill-folder";
import { assertSkillsFolderPrivate } from "../../skills/skill-private";
import { skillExistsName } from "../../../shared/skill-upload";
import { skillImportLimits } from "../../../shared/skill-import";

interface ListedSkill {
  name: string;
  description?: string;
  shortDescription?: string;
  path: string;
  scope?: "user" | "repo" | "system" | "admin";
  enabled?: boolean;
  interface?: { displayName?: string | null } | null;
}

const idOf = (skillPath: string) =>
  "skill_" + createHash("sha256").update(skillPath).digest("hex").slice(0, 24);

function isOwnWebSkill(skill: ListedSkill, root: string | undefined) {
  if (
    (skill.scope ?? "user") !== "user" ||
    !root || !path.isAbsolute(root) ||
    path.basename(skill.path) !== "SKILL.md"
  ) return false;
  try {
    assertSkillsFolderPrivate({ store: { root }, window: undefined });
    const folder = path.dirname(skill.path);
    return fs.lstatSync(folder).isDirectory() &&
      fs.lstatSync(skill.path).isFile() &&
      path.dirname(fs.realpathSync(folder)) ===
        fs.realpathSync(path.join(root, "codex-home", "skills"));
  } catch {
    return false;
  }
}

function installedSkillViewer(skill: ListedSkill, ctx: AdapterContext) {
  const readOnly = ctx.readOnly === true;
  const own = (skill.scope ?? "user") === "user";
  const current = readOnly && own && ctx.isCurrent?.() === true;
  return {
    ...(readOnly ? { claudex_read_only: true } : {}),
    enabled: skill.enabled !== false,
    ...(current && ctx.allowSkillVersionSave === true
      ? { claudex_can_edit_contents: true }
      : {}),
    ...(current && ctx.allowSkillCopyRename === true && isOwnWebSkill(skill, ctx.stateDirectory?.())
      ? { claudex_can_rename_duplicate: true }
      : {}),
    can_edit: own && !readOnly,
    can_remove: own && (!readOnly || current && ctx.allowSkillDelete === true && isOwnWebSkill(skill, ctx.stateDirectory?.())),
    can_toggle: !readOnly || current && ctx.allowSkillToggle === true,
    shared_by_you: false,
  };
}

function row(skill: ListedSkill, ctx?: AdapterContext) {
  const stat = (() => {
    try {
      return fs.statSync(skill.path);
    } catch {
      return undefined;
    }
  })();
  const at = new Date(stat?.mtimeMs ?? 0).toISOString();
  const own = (skill.scope ?? "user") === "user";
  return {
    id: idOf(skill.path),
    name: skill.name,
    display_name: skill.interface?.displayName ?? null,
    description: skill.description ?? skill.shortDescription ?? "",
    hooks: null,
    creator_type: own
      ? "user"
      : skill.scope === "admin"
        ? "organization"
        : "anthropic",
    created_at: new Date(stat?.birthtimeMs ?? stat?.mtimeMs ?? 0).toISOString(),
    updated_at: at,
    enabled: skill.enabled !== false,
    // Official RP preserves this verbatim; _W enables the editor only for
    // creator_type=user with partitionBy=account (shared-m-1).
    partition_by: own ? "account" : "organization",
    is_public_provisioned: !own,
    user_invocable: null,
    disable_model_invocation: null,
    source: own ? "user" : "builtin",
    backing_plugin_id: null,
    backing_plugin_head_version: null,
    skill_directory: null,
    is_shared: false,
    has_outgoing_shares: false,
    shared_via: null,
    owner: null,
    enable_count: 0,
    content_scan: null,
    library_metrics: null,
    library_metrics_by_scope: null,
    ...(ctx?.readOnly ? { viewer: { installed: installedSkillViewer(skill, ctx) } } : {}),
  };
}

/**
 * A skill as an item of the account's library (`GET …/library/mine?kind=skill`,
 * official consumer c2e144342 ae/Y: the Customize › Skills "Yours" list).
 */
function libraryItem(skill: ListedSkill, ctx: AdapterContext) {
  const r = row(skill);
  const own = (skill.scope ?? "user") === "user";
  return {
    id: r.id,
    name: r.name,
    display_name: r.display_name,
    description: r.description,
    created_at: r.created_at,
    updated_at: r.updated_at,
    skill: {
      skill_id: r.id,
      partition_by: r.partition_by,
      user_invocable: true,
      backing_plugin_id: null,
    },
    components: [{ type: "skill", id: r.id }],
    provenance: {
      source: own ? "personal" : skill.scope === "system" ? "default" : "organization",
      creator_type: r.creator_type,
      author: null,
      marketplace_id: null,
      shared_via: null,
    },
    viewer: {
      added: true,
      installed: installedSkillViewer(skill, ctx),
      usage: null,
      own_usage: null,
    },
    install_count: null,
    content_scan: null,
  };
}

/**
 * Create a skill / Upload skill in this build go through the account's plugin
 * store (cd8e2642e k/w: `POST …/plugins/account-author`, `POST
 * …/marketplaces/<id>/plugins/account-upload`); the answer is the plugin with
 * its skills. Claudex makes the skill itself; the plugin is its wrapper.
 */
function pluginOf(skill: ListedSkill, ctx: AdapterContext) {
  const r = row(skill, ctx);
  return {
    id: skillPluginId(skill),
    name: skill.name,
    display_name: r.display_name,
    enabled: r.enabled,
    updated_at: r.updated_at,
    scan_requested: false,
    skills: [r],
  };
}

const skillPluginId = (skill: ListedSkill) => `plugin_${idOf(skill.path).slice(6)}`;

const description = z.string().trim().min(1).max(1024);
const simpleSkill = z.object({
  name: z.string(),
  description,
  instructions: z.string().refine((instructions) => !!instructions.trim()),
});
const accountAuthor = z.object({
  plugin_name: z.string().refine(isSavedSkillName),
  plugin_description: description,
  display_title: z.string().optional(),
  files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
});

function parseSkillCreation(body: unknown, format: "author" | "simple") {
  if (format === "author") {
    const parsed = accountAuthor.parse(body);
    const manifest = parsed.files.find((file) => file.path === "SKILL.md");
    const header = /^---\r?\n[\s\S]*?\r?\n---\r?\n(?:\r?\n)?/.exec(manifest?.content ?? "");
    if (!manifest || !header || !manifest.content.slice(header[0].length).trim())
      throw Error("Write your skill instructions in SKILL.md before saving.");
    return {
      name: parsed.plugin_name,
      displayName: parsed.display_title,
      description: parsed.plugin_description,
      files: parsed.files.map(({ path, content }) => ({ relativePath: path, content })),
    };
  }
  const parsed = simpleSkill.parse(body);
  const { name, displayName } = skillNamePlan(parsed.name);
  return {
    name, displayName, description: parsed.description,
    files: [{ relativePath: "SKILL.md", content: `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(parsed.description)}\n---\n\n${parsed.instructions}` }],
  };
}

async function createSkill(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
  format: "author" | "simple",
) {
  const error = (status: number, message: string) =>
    reply(res, { type: "error", error: { type: "invalid_request_error", message } }, status);
  if (req.method !== "POST") return error(405, "Use POST to create a skill.");
  if (url.search) return error(400, "Unsupported skill creation query.");
  if (ctx.readOnly && !ctx.allowSkillCreation)
    return error(403, "Skill creation is unavailable in this read-only session.");
  const owner = ctx.account()?.id;
  if (!owner) return error(401, "Sign in to continue.");
  if (url.pathname.split("/")[3] !== organizationUuid(owner))
    return error(404, "Organization not found.");
  const identity = ctx.sessionIdentity?.();
  const root = ctx.stateDirectory?.();
  const current = () => {
    if (ctx.isCurrent?.() === false) return false;
    return ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity && ctx.stateDirectory?.() === root;
  };
  const retired = () => error(409, "The account changed. Check your skills before trying again.");
  if (!current()) return retired();
  if (!root) return error(503, "The skill folder is unavailable.");
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] ?? ""))
    return error(400, "Send skill creation as JSON.");
  try {
    const body = await readBoundedJson(req, officialSkillCreateMaxBytes);
    if (!current()) return retired();
    const input = parseSkillCreation(body, format);
    await ctx.call("saveSkill", input, officialSkillAuthoring);
    if (!current()) return retired();
    const created: ListedSkill = {
      name: input.name,
      description: input.description,
      path: fs.realpathSync.native(path.join(root, "codex-home", "skills", input.name, "SKILL.md")),
      interface: input.displayName && input.displayName !== input.name ? { displayName: input.displayName } : null,
    };
    return reply(res, format === "author" ? pluginOf(created, ctx) : row(created, ctx));
  } catch (cause) {
    if (!current()) return retired();
    if (cause instanceof RequestBodyError) return error(cause.status, cause.message);
    if (cause instanceof Error && "syscall" in cause)
      return error(500, "The skill could not be saved. Check your skills before trying again.");
    return refused(res, cause instanceof z.ZodError ? Error("Invalid skill creation request.") : cause);
  }
}

export async function accountPluginRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  if (/^\/api\/organizations\/[^/]+\/plugins\/account-author$/.test(p))
    return createSkill(req, res, url, ctx, "author");
  if (/^\/api\/organizations\/[^/]+\/marketplaces\/own-uploads\/plugins\/account-upload$/.test(p))
    return uploadSkill(req, res, url, ctx, "account");
  return false;
}

export async function libraryRoute(
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  if (!/^\/api\/organizations\/[^/]+\/library\/mine$/.test(p)) return false;
  const kinds = url.searchParams.getAll("kind").flatMap((kind) => kind.split(","));
  return installedSkillSearch(res, url, ctx, async () => {
    const wantSkills = !kinds.length || kinds.includes("skill");
    const wantPlugins = !kinds.length || kinds.includes("plugin");
    const items: Array<
      | ReturnType<typeof libraryItem>
      | ReturnType<typeof installedPluginLibrary>[number]
      | Awaited<ReturnType<typeof readInstalledOrganizationPlugins>>[number]
    > = [];
    if (wantSkills)
      items.push(...(await list(ctx)).map((skill) => libraryItem(skill, ctx)));
    if (wantPlugins) {
      items.push(...installedPluginLibrary((await ctx.call("listPlugins")) as PluginCatalog, !ctx.readOnly && !!ctx.localCall));
      items.push(...await readInstalledOrganizationPlugins(ctx));
    }
    return items;
  });
}

async function list(ctx: AdapterContext) {
  const groups = (await ctx.call("listSkills")) as { skills?: ListedSkill[] }[];
  return groups.flatMap((g) => g.skills ?? []);
}

async function find(ctx: AdapterContext, id: string) {
  return (await list(ctx)).find((skill) => idOf(skill.path) === id);
}

const missing = (res: http.ServerResponse) =>
  reply(
    res,
    {
      type: "error",
      error: { type: "not_found_error", message: "Skill not found" },
    },
    404,
  );
const refused = (res: http.ServerResponse, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    message === skillNameTaken
      ? "upload_skill_already_exists"
      : message === renameSameName
        ? "skill_rename_same_name"
        : undefined;
  return reply(
    res,
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message,
        ...(code ? { details: { error_code: code } } : {}),
      },
    },
    400,
  );
};

const skillIdPattern = /^skill_[a-f0-9]{24}$/;
const jsonContent = /^application\/json(?:\s*;.*)?$/i;
const multipartContent = /^multipart\/form-data(?:\s*;.*)?$/i;

function skillError(res: http.ServerResponse, status: number, message: string, details?: Record<string, unknown>) {
  const type = status === 409 ? "conflict" : status === 403 ? "permission_error" : "invalid_request_error";
  return reply(res, { type: "error", error: { type, message, ...(details && { details }) } }, status);
}

function skillTransferScope(ctx: AdapterContext, owner: string) {
  const identity = ctx.sessionIdentity?.(), root = ctx.stateDirectory?.();
  const current = () => identity != null && ctx.isCurrent?.() === true &&
    ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity && ctx.stateDirectory?.() === root;
  const check = () => {
    if (!current()) throw Error("The account changed. Check your skills before trying again.");
  };
  return { root, current, check };
}

async function deleteSkill(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  if (req.method !== "POST") return skillError(res, 405, "Use POST to delete a skill.");
  if (ctx.readOnly && ctx.allowSkillDelete !== true)
    return skillError(res, 403, "Skill deletion is unavailable in this session.");
  const owner = ctx.account()?.id;
  if (!owner) return skillError(res, 401, "Sign in to continue.");
  if (url.pathname.split("/")[3] !== organizationUuid(owner)) return missing(res);
  if (url.search || !jsonContent.test(req.headers["content-type"] ?? ""))
    return skillError(res, 400, "Send a skill ID as JSON.");
  const { root, current, check } = skillTransferScope(ctx, owner);
  try {
    check();
    const body = await readBoundedJson(req, officialSkillDeleteMaxBytes);
    check();
    const id = body.skill_id;
    if (Object.keys(body).length !== 1 || typeof id !== "string" || !skillIdPattern.test(id))
      return skillError(res, 400, "Choose a valid installed skill.");
    const skill = await find(ctx, id);
    check();
    if (!skill || !isOwnWebSkill(skill, root)) return missing(res);
    await ctx.call("deleteSkill", skill.path);
    check();
    return reply(res, { success: true });
  } catch (error) {
    if (!current()) return skillError(res, 409, "The account changed. Check your skills before trying again.");
    if (error instanceof RequestBodyError) return skillError(res, error.status, error.message);
    return refused(res, error);
  }
}

async function saveSkillVersion(form: FormData, file: File, res: http.ServerResponse, url: URL, ctx: AdapterContext, check: () => void) {
  const allowed = [
    "file",
    "overwrite",
    "check_skill_name",
    "wrap",
    "replaced_skill_id",
  ];
  form.forEach((_, key) => {
    if (!allowed.includes(key) || form.getAll(key).length !== 1)
      throw Error("Choose a valid skill save request.");
  });
  const id = form.get("replaced_skill_id"),
    name = form.get("check_skill_name");
  if (
    typeof id !== "string" ||
    !skillIdPattern.test(id) ||
    typeof name !== "string" ||
    form.get("overwrite") !== "true" ||
    form.get("wrap") !== "true"
  )
    throw Error("Choose a valid existing skill to save.");
  for (const key of ["overwrite", "check_skill_name", "wrap"]) {
    if (
      url.searchParams.has(key) &&
      (url.searchParams.getAll(key).length !== 1 ||
        url.searchParams.get(key) !== form.get(key))
    )
      throw Error("The skill save parameters disagree.");
  }
  const candidates = (await list(ctx)).filter(
    (skill) => idOf(skill.path) === id,
  );
  check();
  if (candidates.length !== 1) return missing(res);
  const skill = candidates[0];
  if ((skill.scope ?? "user") !== "user" || skill.name !== name)
    throw Error(
      "The edited skill must match the selected personal skill.",
    );
  const data = new Uint8Array(await file.arrayBuffer());
  check();
  const names = await ctx.call(
    "installSkillFiles",
    [{ name: file.name || "skill.zip", data }],
    {
      replace: true,
      expectedTarget: { path: skill.path, name: skill.name },
    },
  );
  check();
  const after = (await list(ctx)).filter(
    (saved) =>
      saved.path === skill.path &&
      saved.name === skill.name &&
      (saved.scope ?? "user") === "user",
  );
  check();
  if (
    !Array.isArray(names) ||
    names.length !== 1 ||
    names[0] !== skill.name ||
    after.length !== 1
  )
    throw Error(
      "The save was sent, but the resulting skill could not be confirmed. Reopen it before trying again.",
    );
  return reply(res, {
    skill: row(after[0], ctx),
    validation_errors: [],
    scan_requested: false,
  });
}

async function uploadSkill(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext, kind: "account" | "legacy") {
  if (req.method !== "POST") return skillError(res, 405, "Use POST to upload a skill.");
  const canUpload = !ctx.readOnly || ctx.allowSkillUpload === true;
  const canSaveVersion = kind === "legacy" && (!ctx.readOnly || ctx.allowSkillVersionSave === true);
  if (!canUpload && !canSaveVersion) return skillError(res, 403, "Skill upload is unavailable in this session.");
  const owner = ctx.account()?.id;
  if (!owner) return skillError(res, 401, "Sign in to continue.");
  if (url.pathname.split("/")[3] !== organizationUuid(owner)) return missing(res);
  const contentType = req.headers["content-type"] ?? "";
  if (!multipartContent.test(contentType)) return skillError(res, 400, "Send the skill as a multipart file.");
  const { root, current, check } = skillTransferScope(ctx, owner);
  try {
    check();
    const body = await readBoundedBytes(req, canUpload ? officialSkillUploadMaxBytes : MAX_OFFICIAL_SKILL_VERSION_SAVE_BYTES);
    check();
    const form = await new Request("http://localhost/", {
      method: "POST", headers: { "content-type": contentType }, body: new Uint8Array(body),
    }).formData();
    check();
    const file = form.get("file");
    if (!file || typeof file === "string") throw Error("No skill file in the upload.");
    if (kind === "legacy" && (form.has("wrap") || url.searchParams.has("wrap"))) {
      if (!canSaveVersion) return skillError(res, 403, "Saving skill versions is unavailable in this session.");
      if (body.length > MAX_OFFICIAL_SKILL_VERSION_SAVE_BYTES)
        return skillError(res, 413, "Request body is too large.");
      return await saveSkillVersion(form, file, res, url, ctx, check);
    }
    if (!canUpload) return skillError(res, 403, "Skill upload is unavailable in this session.");
    if (file.size > skillImportLimits.bytes)
      return skillError(res, 413, "Skill file is too large. Maximum size is 30 MB.", { error_code: "zip_compressed_too_large" });
    const options = parseSkillUpload(form, url.searchParams, kind);
    const targetRows = options.targetId || options.targetName ? (await list(ctx)).filter((skill) => {
      if (!isOwnWebSkill(skill, root)) return false;
      return (!options.targetId || options.targetId === (kind === "account" ? skillPluginId(skill) : idOf(skill.path))) &&
        (!options.targetName || skill.name === options.targetName);
    }) : [];
    check();
    if ((options.targetId || options.targetName) && targetRows.length !== 1)
      return options.carryForward
        ? skillError(res, 404, "The skill to replace no longer exists.", { error_code: "upload_skill_carry_forward_target_missing" })
        : missing(res);
    const target = targetRows[0];
    if (options.onlyIfContained || options.autoEnable)
      return skillError(res, 400, "This skill may run code.", { error_code: "plugin_upload_not_contained" });
    const data = new Uint8Array(await file.arrayBuffer());
    check();
    const names = await ctx.call("installSkillFiles", [{ name: file.name, data }], {
      replace: options.replace,
      upload: {
        ...(target && { target: { path: target.path, name: target.name } }),
        ...(options.newName && { newName: options.newName }),
        ...(options.carryForward && { carryForward: true }),
        ...(options.enableOnReplace && { enableOnReplace: true }),
      },
    });
    check();
    const after = await list(ctx);
    check();
    const installed = Array.isArray(names) && names.length === 1 ? after.filter((skill) =>
      skill.name === names[0] && (!target || skill.path === target.path) &&
      path.basename(path.dirname(skill.path)) === skill.name && isOwnWebSkill(skill, root),
    ) : [];
    if (installed.length !== 1)
      return skillError(res, 500, "The upload could not be confirmed. Check your skills before trying again.");
    const skill = installed[0];
    return reply(res, kind === "account"
      ? { ...pluginOf(skill, ctx), auto_enable: null }
      : { skill: row(skill, ctx), validation_errors: [], scan_requested: false });
  } catch (error) {
    if (!current()) return skillError(res, 409, "The account changed. Check your skills before trying again.");
    if (error instanceof RequestBodyError) return skillError(res, error.status, error.message);
    const name = error instanceof Error ? skillExistsName(error.message) : undefined;
    if (name) return skillError(res, 409, `Skill '${name}' already exists`, { error_code: "upload_skill_already_exists", skill_name: name });
    return refused(res, error);
  }
}

function parseSkillUpload(form: FormData, query: URLSearchParams, kind: "account" | "legacy") {
  const common = ["overwrite", "upload_source", "carry_forward", "enable_on_replace", "auto_enable", "only_if_contained"];
  const legacy = ["check_skill_name", "replaced_skill_id", "new_name"];
  query.forEach((_, key) => {
    if (query.getAll(key).length !== 1 ||
      !(common.includes(key) || (kind === "account" ? key === "expected_plugin_id" : key === "check_skill_name")))
      throw Error("Choose a valid skill upload request.");
  });
  form.forEach((_, key) => {
    if (form.getAll(key).length !== 1 ||
      !(key === "file" || kind === "legacy" && (common.includes(key) || legacy.includes(key))))
      throw Error("Choose a valid skill upload request.");
  });
  const read = (key: string) => {
    const field = form.get(key), param = query.get(key);
    if (field !== null && typeof field !== "string" || field !== null && param !== null && field !== param)
      throw Error("The skill upload parameters disagree.");
    return field ?? param;
  };
  const flag = (key: string) => {
    const value = read(key);
    if (value !== null && value !== "true" && value !== "false")
      throw Error("Choose a valid skill upload request.");
    return value === "true";
  };
  const replace = flag("overwrite"), carryForward = flag("carry_forward"), enableOnReplace = flag("enable_on_replace");
  const onlyIfContained = flag("only_if_contained"), autoEnable = read("auto_enable");
  const targetId = read(kind === "account" ? "expected_plugin_id" : "replaced_skill_id");
  const targetName = read("check_skill_name"), newName = read("new_name");
  if (targetId !== null && !(kind === "account" ? /^plugin_[a-f0-9]{24}$/ : skillIdPattern).test(targetId) ||
    targetName !== null && (!targetName || targetName.length > 128) ||
    newName !== null && (!newName || newName.length > 128) ||
    autoEnable !== null && (autoEnable !== "if_contained" || replace) ||
    !replace && (targetId || targetName || enableOnReplace || onlyIfContained || carryForward) ||
    replace && kind === "account" && !targetId)
    throw Error("Choose a valid skill upload request.");
  return { replace, targetId, targetName, newName, carryForward, enableOnReplace, onlyIfContained, autoEnable };
}

export async function skillsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  const m = /^\/api\/organizations\/[^/]+\/skills\/(.+)$/.exec(p);
  if (!m) return false;
  const action = m[1];
  const method = req.method ?? "GET";
  try {
    switch (action) {
      case "list-skills":
      case "list-org-skills":
        return reply(res, {
          skills: action === "list-skills" ? (await list(ctx)).map((skill) => row(skill, ctx)) : [],
        });
      case "create-simple-skill": {
        return createSkill(req, res, url, ctx, "simple");
      }
      case "edit-simple-skill": {
        const body = await readJson(req);
        const skill = await find(ctx, String(body.skill_id));
        if (!skill) return missing(res);
        // A user's skill is its SKILL.md: rewritten with the new description and instructions.
        const text = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(String(body.description ?? skill.description ?? ""))}\n---\n\n${String(body.instructions ?? "")}\n`;
        if ((skill.scope ?? "user") !== "user")
          return refused(res, new Error("Only your own skills can be edited."));
        await ctx.call("editSkill", skill.path, text);
        const after =
          (await list(ctx)).find((s) => s.path === skill.path) ?? skill;
        return reply(res, row(after, ctx));
      }
      case "delete-skill":
        return deleteSkill(req, res, url, ctx);
      case "enable-skill":
      case "disable-skill": {
        if (method !== "POST")
          return reply(
            res,
            { error: { message: "Use POST to change a skill." } },
            405,
          );
        if (ctx.readOnly && !ctx.allowSkillToggle)
          return reply(
            res,
            {
              error: {
                message:
                  "Skill changes are unavailable in this read-only session.",
              },
            },
            403,
          );
        const owner = ctx.account()?.id,
          identity = ctx.sessionIdentity?.(),
          root = ctx.stateDirectory?.();
        const check = () => {
          if (
            !owner ||
            identity == null ||
            ctx.isCurrent?.() === false ||
            ctx.account()?.id !== owner ||
            ctx.sessionIdentity?.() !== identity ||
            ctx.stateDirectory?.() !== root
          )
            throw Error(
              "The account changed. The skill update outcome is not confirmed.",
            );
        };
        check();
        const org = /^\/api\/organizations\/([^/]+)\//.exec(p)?.[1];
        if (org !== organizationUuid(owner!)) return missing(res);
        const body = await readBoundedJson(req, officialSkillToggleMaxBytes);
        check();
        if (
          Object.keys(body).some((key) => key !== "skill_id") ||
          typeof body.skill_id !== "string" ||
          !/^skill_[a-f0-9]{24}$/.test(body.skill_id)
        )
          throw Error("Choose a valid installed skill.");
        const skill = await find(ctx, body.skill_id);
        check();
        if (!skill || ctx.readOnly && (skill.scope ?? "user") !== "user") return missing(res);
        const enabled = action === "enable-skill";
        await ctx.call("setSkillEnabled", skill.path, enabled);
        check();
        const after = await find(ctx, body.skill_id);
        check();
        if (!after || after.path !== skill.path || after.enabled !== enabled)
          throw Error(
            "The skill update could not be confirmed. Reopen the skill to check its current state.",
          );
        return reply(res, row(after, ctx));
      }
      case "rename-skill":
      case "duplicate-skill": {
        if (method !== "POST")
          return reply(
            res,
            { error: { message: "Use POST to change a skill." } },
            405,
          );
        if (ctx.readOnly && ctx.allowSkillCopyRename !== true)
          return reply(
            res,
            {
              error: {
                message:
                  "Skill changes are unavailable in this read-only session.",
              },
            },
            403,
          );
        const owner = ctx.account()?.id,
          identity = ctx.sessionIdentity?.(),
          root = ctx.stateDirectory?.();
        const check = () => {
          if (
            !owner ||
            identity == null ||
            ctx.isCurrent?.() === false ||
            ctx.account()?.id !== owner ||
            ctx.sessionIdentity?.() !== identity ||
            ctx.stateDirectory?.() !== root
          )
            throw Error(
              "The account changed. The skill update outcome is not confirmed.",
            );
        };
        check();
        if (
          /^\/api\/organizations\/([^/]+)\//.exec(p)?.[1] !==
          organizationUuid(owner!)
        )
          return missing(res);
        if (ctx.readOnly && url.search)
          return refused(res, Error("Unsupported skill change query."));
        const body = await readBoundedJson(req, officialSkillCopyRenameMaxBytes);
        check();
        if (
          Object.keys(body).some(
            (key) => key !== "skill_id" && key !== "new_name",
          ) ||
          typeof body.skill_id !== "string" ||
          !/^skill_[a-f0-9]{24}$/.test(body.skill_id) ||
          typeof body.new_name !== "string" ||
          !body.new_name ||
          body.new_name.length > 1024
        )
          throw Error("Choose a valid installed skill.");
        const plan = skillNamePlan(body.new_name);
        if (typeof root !== "string" || !path.isAbsolute(root))
          throw Error(
            "The skill update could not be confirmed. Reopen the skill to check its current state.",
          );
        const skill = await find(ctx, body.skill_id);
        check();
        if (!skill || ctx.readOnly && !isOwnWebSkill(skill, root)) return missing(res);
        const name = await ctx.call(
          action === "rename-skill" ? "renameSkill" : "duplicateSkill",
          skill.path,
          body.new_name,
        );
        check();
        const afterRows = await list(ctx);
        check();
        if (name !== plan.name)
          throw Error(
            "The skill update could not be confirmed. Reopen the skill to check its current state.",
          );
        let expectedPath: string;
        try {
          expectedPath = fs.realpathSync.native(
            path.join(root, "codex-home", "skills", plan.name, "SKILL.md"),
          );
        } catch {
          throw Error(
            "The skill update could not be confirmed. Reopen the skill to check its current state.",
          );
        }
        const matches = afterRows.filter((s) => {
          if (
            s.name !== plan.name ||
            (s.scope ?? "user") !== "user" ||
            s.interface?.displayName !== plan.displayName
          )
            return false;
          try {
            return fs.realpathSync.native(s.path) === expectedPath;
          } catch {
            return false;
          }
        });
        if (matches.length !== 1)
          throw Error(
            "The skill update could not be confirmed. Reopen the skill to check its current state.",
          );
        const after = matches[0];
        return reply(res, { skill: row(after, ctx), validation_errors: [] });
      }
      case "upload-skill":
        return uploadSkill(req, res, url, ctx, "legacy");
      default: {
        // One skill (GET skills/<id>), its scan status (none here) and org access.
        const one =
          /^([^/]+)(?:\/(scan-status|refresh-scan|org_access))?$/.exec(action);
        if (!one) return false;
        const skill = await find(ctx, one[1]);
        if (!skill) return missing(res);
        if (one[2] === "scan-status" || one[2] === "refresh-scan")
          return reply(res, { status: "not_scanned" });
        if (one[2] === "org_access") return reply(res, { access: "private" });
        return reply(res, row(skill, ctx));
      }
    }
  } catch (error) {
    return refused(res, error);
  }
}
