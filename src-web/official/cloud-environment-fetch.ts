import { z } from "zod";
import type {
  CloudEnvironmentConfig,
  CloudEnvironmentsAPI,
} from "../../shared/cloud-environments-api";
import {
  cloudEnvironmentId,
  cloudEnvironmentInput,
} from "../../shared/cloud-environments-input";
import {
  envNameProblem,
  formatEnvFile,
  parseEnvFile,
} from "../../shared/env-file";
import { webLimits } from "../../shared/web-protocol";
import { remoteCodeEnvironmentTarget, type RemoteCodeEnvironment } from "../../shared/official-remote-code";

export type OfficialCloudEnvironments = Pick<
  CloudEnvironmentsAPI,
  "listCloudEnvironments"
> & {
  listRemoteCodeEnvironments?(): Promise<RemoteCodeEnvironment[]>;
  mutations?: Pick<
    CloudEnvironmentsAPI,
    "saveCloudEnvironment" | "archiveCloudEnvironment"
  >;
};

const path =
  /^\/v1\/environment_providers\/private\/organizations\/([^/]+)\/(environments(?:\/([^/]+)(\/archive)?)?|cloud\/(create|ensure_default))$/;
const networkConfig = z.strictObject({
  allowed_hosts: z.array(z.string()),
  allow_default_hosts: z.boolean(),
});
const languages = [
  { name: "python", version: "3.11" },
  { name: "node", version: "20" },
];
const environment = z.unknown().transform((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    ctx.addIssue({
      code: "custom",
      message: "Environment variables must be a map.",
    });
    return z.NEVER;
  }
  const entries: [string, string][] = [];
  for (const [name, entry] of Object.entries(value)) {
    const problem = envNameProblem(name);
    if (problem || typeof entry !== "string") {
      ctx.addIssue({
        code: "custom",
        message:
          problem?.message.replace("{name}", () => name) ??
          "Environment variable values must be text.",
      });
      return z.NEVER;
    }
    entries.push([name, entry]);
  }
  return Object.fromEntries(entries);
});
const officialInput = z.strictObject({
  name: z.string(),
  kind: z.literal("anthropic_cloud").optional(),
  scope: z.literal("account").optional(),
  description: z.string().optional(),
  config: z.strictObject({
    environment_type: z.literal("anthropic"),
    cwd: z.literal("/home/user"),
    init_script: z.string().nullable(),
    environment,
    languages: z.union([
      z.tuple([]),
      z.tuple([
        z.strictObject({
          name: z.literal("python"),
          version: z.literal("3.11"),
        }),
        z.strictObject({ name: z.literal("node"), version: z.literal("20") }),
      ]),
    ]),
    network_config: networkConfig,
  }),
});
const emptyBody = z.strictObject({});

function summary(profile: CloudEnvironmentConfig, accountUuid: string) {
  return {
    environment_id: profile.id,
    name: profile.name,
    state: "active",
    kind: "anthropic_cloud",
    scope: "account",
    owner_account_uuid: accountUuid,
    is_ccr_default: profile.id === "default",
    updated_at: new Date(profile.updatedAt).toISOString(),
    config: { environment_type: "anthropic" },
  };
}

function detail(profile: CloudEnvironmentConfig, accountUuid: string) {
  return {
    ...summary(profile, accountUuid),
    config: {
      environment_type: "anthropic",
      cwd: "/home/user",
      languages,
      init_script: profile.setupScript || null,
      environment: parseEnvFile(profile.variables),
      network_config: {
        allowed_hosts:
          profile.network === "full"
            ? ["*"]
            : profile.network === "custom"
              ? profile.allowedDomains
              : [],
        allow_default_hosts:
          profile.network === "none"
            ? false
            : profile.network !== "custom" || profile.includeDefaultDomains,
      },
    },
  };
}

function refusal(status: number, message: string) {
  const type =
    status === 404
      ? "not_found_error"
      : status === 503
        ? "api_error"
        : "invalid_request_error";
  return Response.json({ type: "error", error: { type, message } }, { status });
}

const notFound = () => refusal(404, "Cloud environment not found.");

export function officialCloudEnvironmentRequest(
  request: Request,
  url: URL,
  context: {
    organization: string;
    accountUuid: string;
    api: OfficialCloudEnvironments;
  },
  readBody: (request: Request, limit: number) => Promise<Uint8Array | null>,
  signal: AbortSignal,
): Promise<Response> | undefined {
  const route = path.exec(url.pathname);
  if (!route) return;
  const [, organization, target, id, archive, cloud] = route;
  const { method } = request;
  const list = method === "GET" && target === "environments";
  const read = method === "GET" && id && !archive;
  const write = method === "POST" && (id || cloud);
  if (!list && !read && !write) return;
  const headerOrganization = request.headers.get("x-organization-uuid");
  const { accountUuid, api } = context;

  return (async () => {
    if (
      organization !== context.organization ||
      (headerOrganization && headerOrganization !== organization)
    )
      return notFound();
    if (id && read && id.startsWith("env_bridge_")) {
      const target = remoteCodeEnvironmentTarget(id);
      if (!target || url.search) return notFound();
      const rows = await api.listRemoteCodeEnvironments?.();
      signal.throwIfAborted();
      const row = rows?.find((environment) => environment.environment_id === id);
      return row ? Response.json(row) : notFound();
    }
    if (id && !cloudEnvironmentId.safeParse(id).success) return notFound();
    if (!list && url.search)
      return refusal(400, "Invalid cloud environment query.");
    signal.throwIfAborted();

    try {
      if (list) {
        const query = url.searchParams;
        const limit = query.get("limit") ?? "1000";
        const archived = query.get("include_archived");
        if (
          [...query.keys()].some(
            (key) =>
              ![
                "limit",
                "page",
                "include_archived",
                "included_worker_types",
              ].includes(key),
          ) ||
          !/^\d+$/.test(limit) ||
          Number(limit) < 1 ||
          Number(limit) > 1000 ||
          (archived !== null && archived !== "true" && archived !== "false")
        )
          return refusal(400, "Invalid cloud environment query.");
        const [profiles, remote] = await Promise.all([
          api.listCloudEnvironments(),
          api.listRemoteCodeEnvironments?.() ?? [],
        ]);
        signal.throwIfAborted();
        const environments = [...profiles.map((profile) => summary(profile, accountUuid)), ...remote];
        const cursor = query.get("page");
        const start =
          cursor === null
            ? 0
            : environments.findIndex((profile) => profile.environment_id === cursor) + 1;
        if (cursor !== null && start === 0)
          return refusal(400, "Invalid cloud environment page.");
        const page = environments.slice(start, start + Number(limit));
        const hasMore = start + page.length < environments.length;
        return Response.json({
          environments: page,
          has_more: hasMore,
          next_page: hasMore ? page.at(-1)?.environment_id : undefined,
        });
      }
      if (read) {
        const profiles = await api.listCloudEnvironments();
        signal.throwIfAborted();
        const profile = profiles.find((row) => row.id === id);
        return profile
          ? Response.json(detail(profile, accountUuid))
          : notFound();
      }
      if (!api.mutations)
        return refusal(501, "Cloud environment changes are unavailable.");
      const raw = await readBody(request, webLimits.rpcBodyBytes);
      signal.throwIfAborted();
      if (raw === null)
        return refusal(413, "Cloud environment request is too large.");
      let body: unknown;
      try {
        body = raw.length ? JSON.parse(new TextDecoder().decode(raw)) : {};
      } catch {
        return refusal(400, "Invalid cloud environment JSON.");
      }
      if (cloud === "ensure_default") {
        if (!emptyBody.safeParse(body).success)
          return refusal(400, "Invalid default cloud environment request.");
        const profiles = await api.listCloudEnvironments();
        signal.throwIfAborted();
        const profile = profiles.find((row) => row.id === "default");
        return profile
          ? Response.json(detail(profile, accountUuid))
          : notFound();
      }
      if (archive && id) {
        if (!emptyBody.safeParse(body).success)
          return refusal(400, "Invalid cloud environment archive request.");
        if (id === "default")
          return refusal(
            400,
            "The default cloud environment cannot be archived.",
          );
        await api.mutations.archiveCloudEnvironment(id);
        signal.throwIfAborted();
        return new Response(null, { status: 204 });
      }

      const wire = officialInput.safeParse(body);
      if (!wire.success) {
        const issue = wire.error.issues[0];
        return refusal(
          400,
          issue?.code === "custom"
            ? issue.message
            : "Invalid or unsupported cloud environment configuration.",
        );
      }
      const { config } = wire.data;
      const { allowed_hosts, allow_default_hosts } = config.network_config;
      const full =
        allow_default_hosts &&
        allowed_hosts.length === 1 &&
        allowed_hosts[0] === "*";
      const network = full
        ? "full"
        : allowed_hosts.length
          ? "custom"
          : allow_default_hosts
            ? "trusted"
            : "none";
      if (id === "default" && wire.data.name.trim() !== "Default")
        return refusal(400, "The default cloud environment cannot be renamed.");
      const input = cloudEnvironmentInput.safeParse({
        ...(id && { id }),
        name: wire.data.name,
        network,
        allowedDomains: full ? [] : allowed_hosts,
        includeDefaultDomains: allow_default_hosts,
        variables: formatEnvFile(config.environment),
        setupScript: config.init_script ?? "",
      });
      if (!input.success)
        return refusal(
          400,
          input.error.issues[0]?.message ?? "Invalid cloud environment.",
        );
      const profile = await api.mutations.saveCloudEnvironment(input.data);
      signal.throwIfAborted();
      return Response.json(detail(profile, accountUuid));
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (
        error instanceof Error &&
        error.message === "Unavailable cloud environment"
      )
        return notFound();
      return refusal(
        503,
        write
          ? "Could not save cloud environment changes."
          : "Could not load cloud environments.",
      );
    }
  })();
}
