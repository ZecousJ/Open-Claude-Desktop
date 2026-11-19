import { createHash } from "node:crypto";
import type http from "node:http";
import { z } from "zod";
import {
  readSkillArchive,
  SkillArchiveLimitError,
} from "../../skills/skill-archive";
import { organizationUuid, reply, type AdapterContext } from "./context";

const archiveQueryKeys = new Set(["skill_id", "include_blocked", "trigger"]);
const archiveTriggers = new Set(["view", "user", "download"]);
const skillGroups = z.array(
  z.object({
    skills: z
      .array(z.object({ path: z.string().min(1), name: z.string().min(1) }))
      .optional(),
  }),
);

const idOf = (path: string) =>
  "skill_" + createHash("sha256").update(path).digest("hex").slice(0, 24);

export async function skillDownloadRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: string,
  url: URL,
  ctx: AdapterContext,
): Promise<boolean> {
  if ((req.method ?? "GET") !== "GET") return false;
  const match =
    /^\/api\/organizations\/([^/]+)\/skills\/download-dot-skill-file$/.exec(p);
  if (!match) return false;
  const error = (status: number, message: string) =>
    reply(res, { error: { type: "invalid_request_error", message } }, status);
  const owner = ctx.account()?.id;
  const identity = ctx.sessionIdentity?.();
  if (!owner) return error(401, "Sign in to continue.");
  if (match[1] !== organizationUuid(owner))
    return error(404, "Organization not found.");

  const params = url.searchParams;
  const id = params.get("skill_id");
  const includeBlocked = params.get("include_blocked");
  const trigger = params.get("trigger");
  if (
    !id ||
    !/^skill_[a-f0-9]{24}$/.test(id) ||
    [...params.keys()].some(
      (key) => !archiveQueryKeys.has(key) || params.getAll(key).length > 1,
    ) ||
    (includeBlocked !== null &&
      includeBlocked !== "true" &&
      includeBlocked !== "false") ||
    (trigger !== null && !archiveTriggers.has(trigger))
  )
    return error(400, "Unsupported skill archive query.");

  const stateRoot = ctx.stateDirectory?.();
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === identity &&
    ctx.stateDirectory?.() === stateRoot;
  const retired = () => error(409, "The account changed. Reopen this skill.");
  try {
    if (!current()) return retired();
    const profileRoot = ctx.readOnly ? stateRoot : undefined;
    if (ctx.readOnly && !profileRoot)
      return error(500, "The skill archive has no account directory.");

    const result = await ctx.call("listSkills");
    if (!current()) return retired();
    const groups = skillGroups.parse(result);
    const skills = groups.flatMap((group) => group.skills ?? []);
    const matches = skills.filter((skill) => idOf(skill.path) === id);
    const skill = matches[0];
    if (!skill) return error(404, "Installed skill not found.");
    if (matches.length !== 1)
      return error(500, "The skill inventory has duplicate identities.");

    const data = await readSkillArchive({
      skillPath: skill.path,
      archiveFolder: ctx.readOnly ? "skill" : skill.name,
      profileRoot,
    });
    if (!current()) return retired();
    const disposition = ctx.readOnly
      ? `attachment; filename="${id}.skill"`
      : `attachment; filename="skill.skill"; filename*=UTF-8''${encodeURIComponent(`${skill.name}.skill`).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    });
    res.end(data);
    return true;
  } catch (cause) {
    if (!current()) return retired();
    if (cause instanceof SkillArchiveLimitError)
      return error(413, cause.message);
    return error(500, "The complete skill archive could not be read.");
  }
}
