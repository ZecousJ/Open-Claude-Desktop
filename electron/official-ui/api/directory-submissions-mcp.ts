import type http from "node:http";
import { z } from "zod";
import type {
  DirectorySubmission,
  DirectorySubmissionInput,
} from "../../../shared/directory-submissions";
import { officialDirectorySubmissionMaxBytes } from "../../../shared/official-directory-submissions";
import { directorySubmissionInput } from "../../../shared/directory-submissions-input";
import {
  connectorConfigurationError,
  templateConnectorUrl,
  type ConnectorUrlConfiguration,
} from "../../../shared/connector-url-configuration";
import { Sub2ApiError } from "../../sub2api/http";
import { connectorUuid } from "./connector-auth";
import { empty, organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

const route =
  /^\/api\/organizations\/([^/]+)\/directory\/mcp-servers(?:\/([^/]+)(?:\/([^/]+))?)?$/;
const identifier = z.string().uuid();
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const boundedSlug = z
  .string()
  .max(100)
  .refine((slug) => !slug || slugPattern.test(slug));
const text = z.string().nullish();
const object = z.record(z.string(), z.unknown());
const remote = z.looseObject({
  url: text,
  url_regex: text,
  url_template: text,
  url_options: z
    .array(z.looseObject({ url: z.string(), label: z.string().optional() }))
    .nullish(),
  user_config: z
    .record(
      z.string(),
      z.looseObject({
        title: z.string(),
        description: z.string(),
        placeholder: z.string().optional(),
        pattern: z.string().optional(),
      }),
    )
    .nullish(),
  is_authless: z.boolean().nullish(),
});
const listing = z.looseObject({
  type: z.literal("remote").optional(),
  name: text,
  description: text,
  documentation: text,
  support: text,
  author: z.looseObject({ name: text }).nullish(),
  remote: remote.nullish(),
});
const questionnaire = z.looseObject({
  primary_contact_email: text,
  use_cases: text,
  additional_info: text,
  test_server_url: text,
  policy_compliance: z.record(z.string(), z.boolean()).nullish(),
  server_snapshot: z
    .looseObject({
      connected_server_uuid: identifier.nullish(),
    })
    .nullish(),
});
const originalShape = z.object({
  data: listing,
  submission_data: questionnaire,
});
type OriginalMcpSubmission = z.infer<typeof originalShape>;
const clientContext = z.strictObject({ surface: text, entry: text }).nullish();
const mutation = {
  slug: boundedSlug.nullish(),
  data: listing.optional(),
  submission_data: questionnaire.optional(),
};
const createBody = z.strictObject({
  ...mutation,
  client_context: clientContext,
});
const editBody = z.strictObject(mutation);
const submitBody = z.strictObject({ client_context: clientContext });
const publishBody = z.strictObject({});
const rowShape = directorySubmissionInput.extend({
  id: identifier,
  status: z.enum(["draft", "submitted", "in_review", "approved", "rejected"]),
  reviewerNote: z.string(),
  createdAt: z.number().optional(),
  updatedAt: z.number(),
  publishedAt: z
    .number()
    .nullish()
    .transform((value) => value ?? undefined),
  tools: directorySubmissionInput.shape.tools
    .nullish()
    .transform((value) => value ?? []),
});
const rowsShape = z.array(
  z.discriminatedUnion("kind", [
    rowShape.extend({ kind: z.literal("mcp") }),
    z.object({ kind: z.literal("plugin") }),
  ]),
);
type McpContext = Pick<
  AdapterContext,
  "allowDirectorySubmissions" | "call" | "isCurrent" | "sessionIdentity"
> & {
  account():
    Pick<NonNullable<ReturnType<AdapterContext["account"]>>, "id"> | undefined;
  settings(): Pick<ReturnType<AdapterContext["settings"]>, "mcpServers">;
};
const policyItems = [
  "readGuidelines",
  "noFinancialTransactions",
  "noAiMediaGeneration",
  "noPromptInjection",
  "noConversationDataCollection",
  "publicDocsByPublishDate",
];
const statuses = {
  draft: "draft",
  submitted: "submitted",
  in_review: "submitted",
  approved: "approved",
  rejected: "changes_requested",
} satisfies Record<DirectorySubmission["status"], string>;

class DirectoryMcpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function reject(status: number, message: string): never {
  throw new DirectoryMcpError(status, message);
}
function validHttps(value: string | null | undefined) {
  if (!value) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.username && !url.password)
    return url.href;
}
function hasUrlCredentials(value: string | null | undefined) {
  const url = value
    ? URL.parse(value.replace(/\$\{user_config\.[a-z][a-z0-9_]*\}/g, "example"))
    : null;
  return Boolean(url?.username || url?.password);
}
function originalDraft(value: unknown): OriginalMcpSubmission {
  const parsed = originalShape.safeParse(value);
  if (!parsed.success)
    reject(503, "The saved connector submission could not be loaded.");
  return parsed.data;
}
function classicDraft(row: DirectorySubmission): OriginalMcpSubmission {
  const template = row.remoteUrlTemplate?.replace(
    /(?<!\$)\{([a-z][a-z0-9_]*)\}/,
    (_, key) => "${user_config." + key + "}",
  );
  const templateKey = template?.match(
    /\$\{user_config\.([a-z][a-z0-9_]*)\}/,
  )?.[1];
  return {
    data: {
      type: "remote",
      name: row.name,
      one_liner: row.description,
      description: row.description,
      author: row.author ? { name: row.author, url: "" } : null,
      tool_names: row.tools,
      documentation: row.documentationUrl,
      support: row.supportUrl,
      remote: {
        url:
          row.serverUrlType && row.serverUrlType !== "universal"
            ? null
            : row.url,
        transport: "streamable-http",
        is_authless: row.isAuthless,
        url_options: row.remoteUrlOptions,
        url_regex: row.remoteUrlRegex,
        url_template: template,
        user_config:
          templateKey && row.remoteUserConfig
            ? { [templateKey]: row.remoteUserConfig }
            : undefined,
      },
    },
    submission_data: {
      primary_contact_email: row.email,
      use_cases: row.examples,
      test_server_url: row.testServerUrl,
      ...(row.serverName && {
        additional_info:
          "<<<wizard-context-v1>>>\n<<<json>>>\n" +
          JSON.stringify({
            connected_server_uuid: connectorUuid(row.serverName),
          }),
      }),
    },
  };
}
function expose(row: DirectorySubmission, organization: string) {
  return {
    id: row.id,
    organization_uuid: organization,
    slug: row.slug || row.id,
    server_name: row.name,
    status: row.publishedAt !== undefined ? "published" : statuses[row.status],
    ...(row.original ? originalDraft(row.original) : classicDraft(row)),
    metrics: null,
    pending_data: null,
    review_notes: row.reviewerNote || null,
    approval_state: row.status === "approved" ? "approved" : null,
    pending_data_submitted_at: null,
    last_edit_approved_at: null,
    created_at: new Date(row.createdAt ?? row.updatedAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
    has_pending_edit: false,
    editable_as_owner: row.publishedAt === undefined,
    viewable_as_owner: true,
    managed_auth: null,
    unpublished_by_owner: false,
    owner_unpublish_available: false,
  };
}

const wizardContextShape = z.object({
  connected_server_uuid: identifier.optional(),
  api_ownership: z.enum(["first_party", "proxied", "third_party"]).optional(),
});
function wizardContext(additionalInfo: string | null | undefined) {
  const start = additionalInfo?.indexOf("<<<wizard-context-v1>>>") ?? -1;
  if (start < 0 || !additionalInfo) return {};
  const json = additionalInfo.indexOf("<<<json>>>", start);
  if (json < 0) return {};
  try {
    return wizardContextShape.parse(
      JSON.parse(additionalInfo.slice(json + "<<<json>>>".length)),
    );
  } catch {
    return {};
  }
}
function urlConfiguration(
  endpoint: OriginalMcpSubmission["data"]["remote"],
  testUrl: string | null | undefined,
): ConnectorUrlConfiguration {
  const testServerUrl = testUrl?.trim() || undefined;
  if (endpoint?.url_template) {
    const key = endpoint.url_template.match(
      /\$\{user_config\.([a-z][a-z0-9_]*)\}/,
    )?.[1];
    const field = key ? endpoint.user_config?.[key] : undefined;
    const remoteUserConfig = field
      ? {
          ...field,
          placeholder: field.placeholder ?? "",
          pattern: field.pattern ?? "",
        }
      : undefined;
    return {
      serverUrlType: "template",
      remoteUrlTemplate: endpoint.url_template,
      remoteUserConfig,
      testServerUrl,
    };
  }
  if (endpoint?.url_regex)
    return {
      serverUrlType: "regex",
      remoteUrlRegex: endpoint.url_regex,
      testServerUrl,
    };
  if (endpoint?.url_options?.length)
    return {
      serverUrlType: "multiple",
      remoteUrlOptions: endpoint.url_options,
      testServerUrl,
    };
  return { serverUrlType: "universal", testServerUrl };
}

const credentialFields = new Set([
  "staticcredential",
  "staticcredentialdraft",
  "clientsecret",
  "headervalues",
  "accesstoken",
  "refreshtoken",
  "bearertoken",
  "authorization",
  "apikey",
  "password",
]);
const linkFields = new Set([
  "url",
  "url_template",
  "test_server_url",
  "remoteUrl",
  "testServerUrl",
]);
function containsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => {
    const field = key.replaceAll("_", "").toLowerCase();
    if (field === "inputschema" || field === "outputschema") return false;
    if (field === "userconfig" && item && typeof item === "object")
      return Object.values(item).some(containsCredential);
    return (
      credentialFields.has(field) ||
      (typeof item === "string" &&
        linkFields.has(key) &&
        hasUrlCredentials(item)) ||
      containsCredential(item)
    );
  });
}

function projectInput(
  original: OriginalMcpSubmission,
  slug: string,
  row: DirectorySubmission | undefined,
  needsVerifiedConnector: boolean,
  ctx: McpContext,
): DirectorySubmissionInput {
  if (Buffer.byteLength(JSON.stringify(original)) > 128 * 1024)
    reject(413, "The connector submission is too large.");
  if (containsCredential(original))
    reject(
      400,
      "Remove credentials from the submission and use the current connector settings.",
    );

  const { data, submission_data: answers } = original;
  const endpoint = data.remote;
  const configuration = urlConfiguration(endpoint, answers.test_server_url);
  const context = wizardContext(answers.additional_info);
  const snapshotId = answers.server_snapshot?.connected_server_uuid;
  const serverId = context.connected_server_uuid ?? snapshotId;
  const policies = answers.policy_compliance;
  const termsAcknowledged = policies
    ? policyItems.every((item) => policies[item] === true) &&
      (context.api_ownership === "third_party" ||
        policies.firstPartyApi === true)
    : (row?.termsAcknowledged ?? false);
  let serverName: string | undefined;
  let url =
    endpoint?.url?.trim() ||
    configuration.testServerUrl ||
    configuration.remoteUrlOptions?.[0]?.url ||
    templateConnectorUrl(configuration);
  if (needsVerifiedConnector) {
    if (!serverId || (snapshotId && snapshotId !== serverId))
      reject(
        400,
        "Select the connected MCP server and capture its tools before submitting.",
      );
    if (
      !slug ||
      !data.name?.trim() ||
      !data.description?.trim() ||
      !z.email().safeParse(answers.primary_contact_email?.trim()).success ||
      !termsAcknowledged
    )
      reject(
        400,
        "Complete the listing, contact details and policy acknowledgements before submitting.",
      );
    const configured = Object.entries(ctx.settings().mcpServers).find(
      ([name]) => connectorUuid(name) === serverId,
    );
    const config = object.safeParse(configured?.[1]);
    const address =
      config.success && typeof config.data.url === "string"
        ? config.data.url
        : undefined;
    if (
      !configured ||
      !config.success ||
      !address ||
      !validHttps(address) ||
      "command" in config.data ||
      config.data.enabled === false ||
      (configuration.serverUrlType === "universal" &&
        validHttps(url) !== validHttps(address))
    )
      reject(
        400,
        "Connect and authorize the MCP server for this listing in Settings → Connectors.",
      );
    const configurationError = connectorConfigurationError(
      configuration,
      address,
    );
    if (configurationError) reject(400, configurationError);
    serverName = configured[0];
    url = address;
  }

  const input = directorySubmissionInput.safeParse({
    id: row?.id,
    kind: "mcp",
    name: data.name ?? "",
    slug,
    url,
    description: data.description ?? "",
    examples: answers.use_cases ?? "",
    email: answers.primary_contact_email?.trim() ?? "",
    license: row?.license ?? "",
    termsAcknowledged,
    toolsVerified: false,
    serverName,
    author: data.author?.name || undefined,
    supportUrl: validHttps(data.support),
    documentationUrl: validHttps(data.documentation),
    isAuthless: endpoint?.is_authless ?? undefined,
    tools: [],
    ...configuration,
    original,
  });
  if (!input.success)
    reject(400, "The connector submission contains an invalid field.");
  return input.data;
}

export async function directoryMcpSubmissionsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: McpContext,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match) return false;
  const [, organization, id, action] = match;
  const method = req.method ?? "GET";
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const fail = (status: number, message: string) =>
    reply(
      res,
      {
        type: "error",
        error: {
          type:
            status === 401
              ? "authentication_error"
              : status === 403
                ? "permission_error"
                : status === 404
                  ? "not_found_error"
                  : status >= 500
                    ? "api_error"
                    : "invalid_request_error",
          message,
        },
      },
      status,
    );
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner &&
    ctx.sessionIdentity?.() === activation;
  if (!owner) return fail(401, "Sign in to continue.");
  if (organization !== organizationUuid(owner))
    return fail(404, "Organization not found.");
  if (ctx.allowDirectorySubmissions !== true)
    return fail(501, "Connector submissions are unavailable on this host.");
  if (url.search)
    return fail(
      400,
      "This connector submission route takes no query parameters.",
    );

  const ensureCurrent = () => {
    if (!current()) reject(409, "The account changed. Reopen the submission.");
  };
  const call = async (name: string, ...args: unknown[]) => {
    ensureCurrent();
    const value = await ctx.call(name, ...args);
    ensureCurrent();
    return value;
  };
  const load = async () => {
    const rows = rowsShape.safeParse(await call("listDirectorySubmissions"));
    if (!rows.success)
      reject(503, "The connector submissions could not be loaded.");
    return rows.data.filter((row) => row.kind === "mcp");
  };
  const saved = (value: unknown, id?: string) => {
    const row = rowShape.safeParse(value);
    if (!row.success || row.data.kind !== "mcp" || (id && row.data.id !== id))
      reject(503, "The saved connector submission could not be loaded.");
    return row.data;
  };
  const save = async (input: DirectorySubmissionInput, submit: boolean) =>
    reply(
      res,
      expose(
        saved(await call("saveDirectorySubmission", input, submit), input.id),
        organization,
      ),
    );
  const read = async () => {
    const body = await readBoundedJson(
      req,
      officialDirectorySubmissionMaxBytes,
    );
    if (body.static_credential != null)
      reject(501, "Managed credentials are unavailable here.");
    return body;
  };
  try {
    ensureCurrent();
    if (!id && method === "GET")
      return reply(res, {
        servers: (await load()).map((row) => expose(row, organization)),
      });

    if (!id && method === "POST") {
      const body = createBody.safeParse(await read());
      if (!body.success) reject(400, "Invalid connector submission.");
      const original = {
        data: body.data.data ?? {},
        submission_data: body.data.submission_data ?? {},
      };
      return await save(
        projectInput(original, body.data.slug ?? "", undefined, false, ctx),
        false,
      );
    }

    if (id === "by-slug" && action && method === "GET") {
      const row = (await load()).find(
        (saved) => (saved.slug || saved.id) === action,
      );
      if (!row)
        reject(404, "That submission wasn’t found in this organization.");
      return reply(res, expose(row, organization));
    }

    const editing = method === "PATCH" && !action;
    const deleting = method === "DELETE" && !action;
    const submitting = method === "POST" && action === "submit";
    const publishing = method === "POST" && action === "publish";
    if (
      !id ||
      !identifier.safeParse(id).success ||
      !(editing || deleting || submitting || publishing)
    )
      reject(501, "This connector submission operation is unavailable.");
    const raw = await read();
    const row = (await load()).find((saved) => saved.id === id);
    if (!row) reject(404, "That submission wasn’t found in this organization.");

    if (publishing) {
      if (!publishBody.safeParse(raw).success)
        reject(400, "Invalid publish request.");
      if (row.status !== "approved")
        reject(409, "The listing needs approval before it can be published.");
      const published = saved(await call("publishDirectorySubmission", id), id);
      if (
        published.status !== "approved" ||
        published.publishedAt === undefined
      )
        reject(503, "Publication could not be confirmed.");
      return reply(res, expose(published, organization));
    }

    if (row.publishedAt !== undefined)
      reject(409, "The published listing cannot be changed here.");
    if (deleting) {
      if (!publishBody.safeParse(raw).success)
        reject(400, "Invalid delete request.");
      if (row.status === "approved")
        reject(409, "An approved listing cannot be deleted here.");
      await call("deleteDirectorySubmission", id);
      return empty(res);
    }

    const original = row.original
      ? originalDraft(row.original)
      : classicDraft(row);
    const inReview = row.status === "submitted" || row.status === "in_review";
    if (editing) {
      const body = editBody.safeParse(raw);
      if (!body.success) reject(400, "Invalid connector submission edit.");
      const updated = {
        data: body.data.data ?? original.data,
        submission_data: body.data.submission_data ?? original.submission_data,
      };
      const input = projectInput(
        updated,
        body.data.slug ?? row.slug,
        row,
        inReview,
        ctx,
      );
      return await save(input, false);
    }

    if (!submitBody.safeParse(raw).success)
      reject(400, "Invalid submit request.");
    if (inReview) return reply(res, expose(row, organization));
    if (row.status === "approved")
      reject(409, "The listing is already approved.");
    return await save(projectInput(original, row.slug, row, true, ctx), true);
  } catch (error) {
    if (!current())
      return fail(409, "The account changed. Reopen the submission.");
    if (error instanceof DirectoryMcpError || error instanceof RequestBodyError)
      return fail(error.status, error.message);
    if (error instanceof Sub2ApiError) {
      if ([400, 401, 403, 404, 409, 413, 429].includes(error.status))
        return fail(error.status, error.message);
    }
    return fail(
      503,
      "The connector submission service is unavailable. Try again.",
    );
  }
}
