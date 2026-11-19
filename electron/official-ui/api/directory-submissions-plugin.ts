import type http from "node:http";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { directorySubmissionInput } from "../../../shared/directory-submissions-input";
import {
  directorySubmissionReady,
  type DirectorySubmissionInput,
} from "../../../shared/directory-submissions";
import { Sub2ApiError } from "../../sub2api/http";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

const pluginPath =
  /^\/api\/console\/organizations\/([^/]+)\/directory\/plugin-submissions(?:\/([^/]+))?$/;
const step = z.enum(["introduction", "pluginInfo", "pluginDetails"]);
const link = z.string().max(2000);
const originalForm = z.object({
  anthropic_contact: z.string().max(254).optional(),
  plugin_sha: z.string().max(100).optional(),
  plugin_homepage: link.optional(),
  plugin_tagline: z.string().max(200).optional(),
  supported_platforms: z
    .array(z.enum(["claude_code", "claude_cowork"]))
    .max(2)
    .optional(),
  collects_user_data: z.boolean().optional(),
  terms_of_service_url: link.optional(),
  privacy_policy_url: link.optional(),
  current_step: step.optional(),
  touched_steps: z.array(step).max(3).optional(),
});
const pluginForm = originalForm.extend({
  plugin_name: directorySubmissionInput.shape.name.trim().optional(),
  plugin_url: link.trim().optional(),
  plugin_description: directorySubmissionInput.shape.description.optional(),
  plugin_examples: directorySubmissionInput.shape.examples.optional(),
  submitter_email: directorySubmissionInput.shape.email.trim().optional(),
  license_type: directorySubmissionInput.shape.license.optional(),
  terms_acknowledged: z.boolean().optional(),
});
const writeRequest = pluginForm.extend({
  status: z.enum(["draft", "pending"]).optional(),
});
const pluginRecord = directorySubmissionInput
  .pick({
    name: true,
    slug: true,
    url: true,
    description: true,
    examples: true,
    email: true,
    license: true,
    termsAcknowledged: true,
    documentationUrl: true,
  })
  .extend({
    id: z.uuid(),
    kind: z.literal("plugin"),
    status: z.enum(["draft", "submitted", "in_review", "approved", "rejected"]),
    reviewerNote: z.string(),
    updatedAt: z.number(),
    createdAt: z.number().optional(),
    publishedAt: z.number().nullish(),
    original: originalForm.optional(),
  });
const directoryRows = z.array(
  z.discriminatedUnion("kind", [
    pluginRecord,
    z.object({ kind: z.literal("mcp") }),
  ]),
);
type PluginRecord = z.infer<typeof pluginRecord>;
type PluginForm = z.infer<typeof pluginForm>;
type PluginContext = Pick<
  AdapterContext,
  | "account"
  | "allowDirectorySubmissions"
  | "call"
  | "isCurrent"
  | "sessionIdentity"
>;

function formFromRow(row: PluginRecord): PluginForm {
  return {
    plugin_name: row.name,
    plugin_url: row.url,
    plugin_description: row.description,
    plugin_examples: row.examples,
    submitter_email: row.email,
    license_type: row.license,
    terms_acknowledged: row.termsAcknowledged,
    ...(row.documentationUrl && { plugin_homepage: row.documentationUrl }),
    ...row.original,
  };
}

function project(row: PluginRecord) {
  return {
    ...formFromRow(row),
    id: row.id,
    uuid: row.id,
    status:
      row.status === "submitted"
        ? "pending"
        : row.status === "approved" && row.publishedAt != null
          ? "published"
          : row.status,
    created_at: new Date(row.createdAt ?? row.updatedAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
    ...(row.publishedAt != null && {
      published_at: new Date(row.publishedAt).toISOString(),
    }),
    ...(row.reviewerNote && { external_notes: row.reviewerNote }),
  };
}

function httpsLink(value: string) {
  const url = URL.parse(value);
  return !!url && url.protocol === "https:" && !url.username && !url.password;
}

function toSubmission(
  form: PluginForm,
  existing: PluginRecord | undefined,
  submit: boolean,
): DirectorySubmissionInput | undefined {
  const name = form.plugin_name?.trim() ?? "";
  const url = form.plugin_url?.trim() ?? "";
  const homepage = form.plugin_homepage?.trim() ?? "";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 100)
    .replace(/^-|-$/g, "");
  const fallbackSlug = () =>
    `plugin-${Array.from(name, (character) => character.codePointAt(0)?.toString(36)).join("-")}`
      .slice(0, 100)
      .replace(/-$/, "");
  const input: DirectorySubmissionInput = {
    id: existing?.id,
    kind: "plugin",
    name,
    slug: submit ? slug || fallbackSlug() : (existing?.slug ?? ""),
    url,
    description: form.plugin_description ?? "",
    examples: form.plugin_examples ?? "",
    email: form.submitter_email?.trim() ?? "",
    license: form.license_type ?? "",
    termsAcknowledged: form.terms_acknowledged ?? false,
    toolsVerified: false,
    tools: [],
    ...(httpsLink(homepage) && { documentationUrl: homepage }),
    original: originalForm.parse(form),
  };
  for (const address of [
    url,
    homepage,
    form.privacy_policy_url,
    form.terms_of_service_url,
  ]) {
    if (!address?.trim()) continue;
    const parsed = URL.parse(address);
    if (parsed?.username || parsed?.password || (submit && !httpsLink(address)))
      return;
  }
  if (
    submit &&
    (!directorySubmissionReady(input) ||
      !input.examples.trim() ||
      !form.supported_platforms?.length ||
      !z.email().safeParse(input.email).success)
  )
    return;
  return input;
}

export async function pluginDirectorySubmissionsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: PluginContext,
): Promise<boolean> {
  const match = pluginPath.exec(url.pathname);
  if (!match) return false;
  const [, org, id] = match;
  const method = req.method ?? "GET";
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation;
  const fail = (status: number, message: string) =>
    reply(
      res,
      { type: "error", error: { type: "invalid_request_error", message } },
      status,
    );
  const accountChanged = () =>
    fail(409, "The account changed. Reopen directory submissions.");
  const notFound = () => fail(404, "Plugin submission not found.");
  if (!owner) return fail(401, "Sign in to continue.");
  if (organizationUuid(owner) !== org)
    return fail(404, "Organization not found.");
  if (!current()) return accountChanged();
  if (!ctx.allowDirectorySubmissions)
    return fail(403, "Directory submissions are unavailable.");
  if (url.search) return fail(400, "Unsupported plugin submission query.");
  if (!(id ? ["GET", "PATCH", "DELETE"] : ["GET", "POST"]).includes(method))
    return fail(405, "Unsupported plugin submission method.");
  if (id && !z.uuid().safeParse(id).success) return notFound();

  try {
    let existing: PluginRecord | undefined;
    if (id || method === "GET") {
      const raw = await ctx.call("listDirectorySubmissions");
      if (!current()) return accountChanged();
      const rows = directoryRows
        .parse(raw)
        .filter((row) => row.kind === "plugin");
      if (!id) return reply(res, { submissions: rows.map(project) });
      existing = rows.find((row) => row.id === id);
      if (!existing) return notFound();
      if (method === "GET") return reply(res, project(existing));
    }
    if (method === "DELETE") {
      await ctx.call("deleteDirectorySubmission", id);
      return current() ? empty(res) : accountChanged();
    }
    const raw = await readBoundedJson(req, 128 * 1024);
    if (!current()) return accountChanged();
    const parsed = writeRequest.safeParse(raw);
    if (!parsed.success) return fail(400, "Invalid plugin submission fields.");
    const { status, ...fields } = parsed.data;
    const submit = status === "pending" || (status === undefined && !existing);
    const previous = existing && formFromRow(existing);
    const form = { ...previous, ...fields };
    if (
      existing &&
      existing.status !== "draft" &&
      existing.status !== "rejected"
    ) {
      if (submit && isDeepStrictEqual(form, previous))
        return reply(res, project(existing));
      return fail(409, "This submission can no longer be edited.");
    }
    const input = toSubmission(form, existing, submit);
    if (!input)
      return fail(
        400,
        "Check the plugin links and required submission fields.",
      );
    const saved = await ctx.call("saveDirectorySubmission", input, submit);
    if (!current()) return accountChanged();
    const row = pluginRecord.parse(saved);
    if (id && id !== row.id)
      throw new Error("Plugin submission identity changed.");
    return reply(res, project(row));
  } catch (error) {
    if (!current()) return accountChanged();
    if (error instanceof RequestBodyError)
      return fail(error.status, error.message);
    if (error instanceof Sub2ApiError) {
      if (error.status === 404) return notFound();
      if (error.status === 400 || error.status === 409)
        return fail(
          error.status,
          "The plugin submission could not be saved. Check its status and plugin name.",
        );
    }
    return fail(502, "The directory service could not complete the request.");
  }
}
