import type http from "node:http";
import { z } from "zod";
import {
  maxSessionRepositories,
  repositoryKey,
} from "../../../runner/src/code-workspace";
import { cloudEnvironmentId } from "../../../shared/cloud-environments-input";
import { codeEffortLevels } from "../../../shared/code-effort";
import type { RepositoryRef } from "../../../shared/host";
import {
  isOfficialCodeTriggerPath,
  isOfficialCodeTriggerRead,
  officialCodeTriggerId,
  officialCodeTriggerRequest,
  officialCoworkTriggerTag,
  routineIdFromOfficialCodeTrigger,
} from "../../../shared/official-code-triggers";
import {
  officialUiRequestLimit,
  type OfficialUiReadRequest,
} from "../../../shared/official-ui-web";
import { repeatOf, type RoutineRun } from "../../../shared/routine-labels";
import {
  newRoutineTriggerId,
  routineFilterFields,
  routineFilterOps,
  routineGitHubEvents,
  type RoutineGitHubTrigger,
  type RoutineFilterOp,
  type RoutineFilterType,
} from "../../../shared/routine-triggers";
import {
  frequencyFor,
  parseTime,
  scheduleOff,
  validRepeat,
  type Routine,
  type RoutineInput,
} from "../../../shared/routines";
import type { PublicAccount, Schedule, Settings } from "../../../shared/types";
import { CloudEnvironments } from "../../cloud/environments";
import { cloudCodeConnectorInventory } from "./cloud-code-connectors";
import { cloudCodeSessionKey } from "./cloud-code-history";
import { connectorUuid } from "./connectors";
import {
  empty,
  organizationUuid,
  readBody,
  reply,
  type AdapterContext,
} from "./context";

const date = (at: number) => new Date(at).toISOString();
const jsonContent = /^application\/json(?:\s*;|$)/i;
const prompt = z.string().trim().min(1).max(100_000);
const name = z.string().trim().min(1).max(120);
const standardTools = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];
const repositorySource = z.strictObject({
  git_repository: z.strictObject({ url: z.string().max(500) }),
});
const repositoryOutcome = z.strictObject({
  git_repository: z.strictObject({
    git_info: z.strictObject({
      repo: z.string().max(201),
      branches: z.tuple([z.string().min(1).max(255)]),
    }),
  }),
});
const model = z.string().min(1).max(200).nullable().optional();
const mcpConnection = z.strictObject({
  connector_uuid: z.uuid(),
  name: z.string().min(1).max(4096),
  url: z
    .string()
    .max(4000)
    .refine((value) => {
      const url = URL.parse(value);
      return url?.protocol === "https:" && !url.username && !url.password;
    }),
});
const triggerEdit = z.strictObject({
  name: name.optional(),
  model,
  enabled: z.boolean().optional(),
  cron_expression: z.string().trim().max(512).nullish(),
  run_once_at: z
    .union([z.literal(""), z.iso.datetime({ offset: true })])
    .nullish(),
  persist_session: z.literal(false).optional(),
  clear_mcp_connections: z.boolean().optional(),
  mcp_connections: z.array(mcpConnection).max(100).optional(),
  notifications: z
    .strictObject({
      channel: z.strictObject({
        push: z.boolean().optional(),
        email: z.boolean().optional(),
        slack: z.literal(false).optional(),
      }),
    })
    .optional(),
  job_config: z
    .strictObject({
      ccr: z.strictObject({
        environment_id: cloudEnvironmentId.optional(),
        session_context: z.strictObject({
          allowed_tools: z
            .array(z.string())
            .refine(
              (tools) =>
                tools.length === standardTools.length &&
                standardTools.every((tool) => tools.includes(tool)),
            )
            .optional(),
          sources: z
            .array(repositorySource)
            .max(maxSessionRepositories)
            .optional(),
          outcomes: z
            .array(repositoryOutcome)
            .max(maxSessionRepositories)
            .optional(),
          model,
          effort_level: z.enum(codeEffortLevels).optional(),
          autofix_on_pr_create: z.boolean().optional(),
        }),
        events: z.tuple([
          z.strictObject({
            data: z.strictObject({
              uuid: z.string().min(1).max(128),
              session_id: z.literal(""),
              type: z.literal("user"),
              parent_tool_use_id: z.null(),
              message: z.strictObject({
                role: z.literal("user"),
                content: prompt,
              }),
            }),
          }),
        ]),
      }),
    })
    .optional(),
});
const fork = z.strictObject({ name: name.optional() });
const manualRun = z.strictObject({ text: z.string().max(65_536).optional() });
const emptyInput = z.strictObject({});
const githubFilterOp = {
  FILTER_OP_IN: "in",
  FILTER_OP_NOT_IN: "not_in",
  FILTER_OP_STARTS_WITH: "starts_with",
  FILTER_OP_CONTAINS: "contains",
  FILTER_OP_MATCHES: "matches",
  FILTER_OP_EQ: "eq",
} as const satisfies Record<string, RoutineFilterOp>;
const githubFilterNames = Object.keys(
  githubFilterOp,
) as (keyof typeof githubFilterOp)[];
const githubEventNames = new Set<string>(
  routineGitHubEvents.flatMap(({ value, actions }) =>
    actions.map((action) => value + "." + action),
  ),
);
const createWebhook = z.strictObject({
  source: z.literal("github"),
  hook_type: z.literal("app"),
  routine_trigger_id: z
    .string()
    .transform(routineIdFromOfficialCodeTrigger)
    .pipe(z.string()),
  scope_id: z.string().max(300),
  events: z
    .array(z.string().refine((event) => githubEventNames.has(event)))
    .min(1)
    .max(githubEventNames.size),
  filter: z
    .strictObject({
      clauses: z
        .array(
          z.strictObject({
            field: z.string(),
            op: z.enum(githubFilterNames),
            values: z.array(z.string().min(1).max(1000)).min(1),
          }),
        )
        .max(10),
    })
    .optional(),
});

const runStatus = {
  starting: "ROUTINE_RUN_STATUS_RUNNING",
  running: "ROUTINE_RUN_STATUS_RUNNING",
  completed: "ROUTINE_RUN_STATUS_SUCCEEDED",
  failed: "ROUTINE_RUN_STATUS_FAILED",
  interrupted: "ROUTINE_RUN_STATUS_ABANDONED",
} satisfies Record<NonNullable<Schedule["lastRunStatus"]>, string>;

const officialSessionId = (id: string, account: string) =>
  "session_" + cloudCodeSessionKey({ id }, account);

function githubTrigger(task: Routine, hook: RoutineGitHubTrigger) {
  return {
    trigger_id: hook.id,
    routine_trigger_id: officialCodeTriggerId(task.id),
    source: "github",
    hook_type: "app",
    scope_id: "https://github.com/" + hook.repository,
    events: hook.events,
    ...(hook.filters.length > 0 && {
      filter: {
        clauses: hook.filters.map(({ field, op, value }) => ({
          field,
          op: githubFilterNames.find((name) => githubFilterOp[name] === op),
          values:
            op === "in" || op === "not_in"
              ? value.split(",").map((part) => part.trim())
              : [value],
        })),
      },
    }),
  };
}

function githubRepository(value: string) {
  return /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/i.exec(
    value,
  )?.[1];
}

function triggerCron(task: Routine) {
  const repeat = repeatOf(task);
  if (scheduleOff(task) || repeat.kind === "once") return;
  const zone = "CRON_TZ=" + Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (repeat.kind === "manual") return;
  if (repeat.kind === "cron") {
    if (/^(?:CRON_TZ|TZ)=/.test(repeat.expression)) return repeat.expression;
    return `${zone} ${repeat.expression}`;
  }
  if (repeat.kind === "hourly") return `${zone} ${repeat.minute} * * * *`;
  const time = parseTime(repeat.time);
  if (!time) throw Error("Invalid saved schedule time.");
  const tail =
    repeat.kind === "weekly"
      ? `* * ${repeat.day}`
      : repeat.kind === "weekdays"
        ? "* * 1-5"
        : repeat.kind === "monthly"
          ? `${repeat.dayOfMonth} * *`
          : repeat.kind === "custom"
            ? `* * ${repeat.days.join(",")}`
            : "* * *";
  return `${zone} ${time.minutes} ${time.hours} ${tail}`;
}

function trigger(
  task: Routine,
  owner: PublicAccount,
  settings: Settings,
  apiFireUrl?: (id: string) => string,
) {
  const repeat = repeatOf(task);
  const hasSchedule = !scheduleOff(task);
  const runOnceAt =
    hasSchedule && repeat.kind === "once" ? repeat.at : undefined;
  const firedOnce =
    runOnceAt !== undefined &&
    task.lastRunAt !== undefined &&
    task.lastRunAt >= runOnceAt;
  return {
    id: officialCodeTriggerId(task.id),
    name: task.name,
    enabled: task.enabled,
    cron_expression: triggerCron(task),
    run_once_at: runOnceAt === undefined ? undefined : date(runOnceAt),
    created_at: date(task.createdAt),
    updated_at: date(task.updatedAt),
    next_run_at:
      task.enabled && hasSchedule && !task.connectionHold
        ? date(task.nextRunAt)
        : undefined,
    last_fired_at:
      task.lastRunAt === undefined ? undefined : date(task.lastRunAt),
    ended_reason: firedOnce ? "run_once_fired" : task.endedReason,
    suspension_reason: task.connectionHold ? "needs_reauth" : undefined,
    last_run:
      task.lastRunAt !== undefined && task.lastRunStatus
        ? {
            fired_at: date(task.lastRunAt),
            status: runStatus[task.lastRunStatus],
            session_id:
              task.conversationId &&
              officialSessionId(task.conversationId, owner.id),
          }
        : undefined,
    creator: { account_uuid: owner.id, display_name: owner.name },
    api_trigger_id: task.triggers?.api?.id,
    api_fire_url: task.triggers?.api?.id && apiFireUrl?.(task.triggers.api.id),
    api_token_hint: task.triggers?.api?.tokenHint,
    persist_session: false,
    mcp_connections: projectConnectors(task.codeConnectorSelections, settings),
    notifications: task.notifyOnCompletion
      ? { channel: task.notifyOnCompletion }
      : undefined,
    derived_state: {
      prompt: task.prompt,
      model: task.model,
      ...(task.mode === "cowork" &&
        !task.cwd && { folders_state: "FOLDERS_STATE_NONE" }),
    },
    job_config: {
      ccr: {
        ...(task.mode === "cowork" ? { tags: [officialCoworkTriggerTag] } : {}),
        environment_id: task.cloudEnvironmentId ?? "default",
        session_context: {
          sources: routineRepositories(task).map(({ url }) => ({
            git_repository: { url },
          })),
          model: task.defaultModel ? null : task.model,
          effort_level: task.effort,
          autofix_on_pr_create: task.autoFixPullRequests ?? false,
        },
        events: [
          {
            data: {
              uuid: task.id,
              session_id: "",
              type: "user",
              parent_tool_use_id: null,
              message: { role: "user", content: task.prompt },
            },
          },
        ],
      },
    },
  };
}

const listFields = new Set([
  "limit",
  "cursor",
  "offset",
  "tags",
  "exclude_tags",
  "enabled",
  "agent_id",
  "persistent_session_id",
  "exclude_session_bound_one_shots",
  "include_completed_run_once",
]);
const cloudRoutine = (task: Routine) =>
  !task.cwd &&
  task.executionLocation !== "local" &&
  (!task.environment || task.environment.kind === "local");

function triggerPage(
  query: URLSearchParams,
  rows: Routine[],
  project: (task: Routine) => object,
) {
  for (const key of query.keys()) {
    if (
      !listFields.has(key) ||
      (key !== "tags" &&
        key !== "exclude_tags" &&
        query.getAll(key).length !== 1)
    )
      throw new TriggerError(400, "Invalid scheduled task query.");
  }
  const number = (
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ) => {
    const value = query.get(key);
    if (value === null) return fallback;
    if (
      !/^\d+$/.test(value) ||
      Number(value) < minimum ||
      Number(value) > maximum
    )
      throw new TriggerError(400, "Invalid scheduled task pagination.");
    return Number(value);
  };
  const flag = (key: string) => {
    const value = query.get(key);
    if (value === null || value === "true" || value === "false") return value;
    throw new TriggerError(400, "Invalid scheduled task query.");
  };
  const limit = number("limit", 100, 1, 100);
  const offset = number("offset", 0, 0, 1000);
  const rawCursor = query.get("cursor");
  const cursor =
    rawCursor === null
      ? undefined
      : routineIdFromOfficialCodeTrigger(rawCursor);
  if (rawCursor !== null && (!cursor || query.has("offset")))
    throw new TriggerError(400, "Invalid scheduled task cursor.");
  const enabled = flag("enabled");
  const completed = flag("include_completed_run_once");
  flag("exclude_session_bound_one_shots");
  const tags = query.getAll("tags");
  const excluded = query.getAll("exclude_tags");
  const available =
    query.has("agent_id") || query.has("persistent_session_id")
      ? []
      : rows
          .filter((task) => {
            const actualTags =
              task.mode === "cowork" ? [officialCoworkTriggerTag] : [];
            if (
              tags.some((tag) => !actualTags.includes(tag)) ||
              excluded.some((tag) => actualTags.includes(tag))
            )
              return false;
            if (enabled !== null && task.enabled !== (enabled === "true"))
              return false;
            const repeat = repeatOf(task);
            return (
              completed !== "false" ||
              repeat.kind !== "once" ||
              task.lastRunAt === undefined ||
              task.lastRunAt < repeat.at
            );
          })
          .sort(
            (a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id),
          );
  const index =
    cursor === undefined
      ? offset
      : available.findIndex((task) => task.id === cursor) + 1;
  if (cursor !== undefined && index === 0)
    throw new TriggerError(400, "Invalid scheduled task cursor.");
  const page = available.slice(index, index + limit);
  const hasMore = index + page.length < available.length;
  return {
    data: page.map(project),
    has_more: hasMore,
    next_cursor: hasMore ? officialCodeTriggerId(page.at(-1)!.id) : undefined,
  };
}

class TriggerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function modelChoice(
  settings: Settings,
  existing: Routine | undefined,
  requested: string | null | undefined,
) {
  const { providers, activeProviderId } = settings;
  if (requested === undefined && existing)
    return {
      providerId: existing.providerId,
      model: existing.model,
      defaultModel: existing.defaultModel,
    };
  const provider = providers.find(
    ({ id }) =>
      id ===
      (requested === null
        ? activeProviderId
        : (existing?.providerId ?? activeProviderId)),
  );
  if (!provider?.model)
    throw new TriggerError(503, "No Code model service is configured.");
  if (
    requested &&
    requested !== provider.model &&
    !provider.models.includes(requested)
  )
    throw new TriggerError(400, "The requested Code model is unavailable.");
  return {
    providerId: provider.id,
    model: requested ?? provider.model,
    defaultModel: requested == null,
  };
}

const routineRepositories = (task?: Routine) =>
  task?.repositories ?? (task?.repository ? [task.repository] : []);

function repositoriesOf(
  config: NonNullable<
    z.infer<typeof triggerEdit>["job_config"]
  >["ccr"]["session_context"],
  task?: Routine,
): RepositoryRef[] | undefined {
  const existing = routineRepositories(task);
  const selected = new Set<string>();
  const repositories = config.sources?.map(({ git_repository: { url } }) => {
    const repository = githubRepository(url);
    if (!repository) throw new TriggerError(400, "Choose a GitHub repository.");
    const key = repository.toLowerCase();
    if (selected.has(key))
      throw new TriggerError(400, "Choose each GitHub repository once.");
    selected.add(key);
    return (
      existing.find(
        (item) => repositoryKey(item.url) === repositoryKey(url),
      ) ?? { url: `https://github.com/${repository}` }
    );
  });
  if (!repositories) {
    for (const { url } of existing) {
      const repository = githubRepository(url);
      if (repository) selected.add(repository.toLowerCase());
    }
  }
  const outcomes = new Set<string>();
  for (const {
    git_repository: {
      git_info: { repo },
    },
  } of config.outcomes ?? []) {
    const key = repo.toLowerCase();
    if (!selected.has(key) || outcomes.has(key))
      throw new TriggerError(
        400,
        "Choose a matching GitHub repository for each Git outcome.",
      );
    outcomes.add(key);
  }
  return repositories ?? task?.repositories;
}

function selectedConnectors(
  patch: z.infer<typeof triggerEdit>,
  existing: Routine["codeConnectorSelections"],
  settings: Settings,
): Routine["codeConnectorSelections"] {
  const connections = patch.mcp_connections;
  if (patch.clear_mcp_connections) {
    if (connections?.length)
      throw new TriggerError(400, "Choose connectors or clear the selection.");
    return [];
  }
  if (!connections) return existing;
  const inventory = new Map(
    cloudCodeConnectorInventory(settings.mcpServers).map((entry) => [
      connectorUuid(entry.key),
      entry,
    ]),
  );
  return connections.map(({ connector_uuid, url }) => {
    const connector = inventory.get(connector_uuid);
    if (!connector || connector.url !== url)
      throw new TriggerError(400, "Choose an available cloud connector.");
    inventory.delete(connector_uuid);
    return { key: connector.key, url: connector.url };
  });
}

function projectConnectors(
  selections: Routine["codeConnectorSelections"],
  settings: Settings,
) {
  if (!selections) return;
  const inventory = new Map(
    cloudCodeConnectorInventory(settings.mcpServers).map((entry) => [
      entry.key,
      entry,
    ]),
  );
  return selections.map(({ key, url }) => {
    const connector = inventory.get(key);
    const name = connector?.url === url ? connector.name : key;
    return {
      connector_uuid: connectorUuid(key),
      name: name.replace(/[^a-zA-Z0-9_-]/g, "-"),
      url,
    };
  });
}

function prepareEdit(
  patch: z.infer<typeof triggerEdit>,
  task: Routine | undefined,
  settings: Settings,
  root: string,
): RoutineInput {
  const job = patch.job_config?.ccr;
  if (!task && (!patch.name || !job))
    throw new TriggerError(400, "A name and Code instructions are required.");
  const configuredEnvironment =
    job?.environment_id ?? task?.cloudEnvironmentId ?? "default";
  if (
    (!task || job?.environment_id !== undefined) &&
    !new CloudEnvironments(root)
      .list()
      .some((row) => row.id === configuredEnvironment)
  )
    throw new TriggerError(404, "Cloud environment not found.");

  if (patch.cron_expression && patch.run_once_at)
    throw new TriggerError(400, "Choose one schedule rule.");
  const changingRule =
    patch.cron_expression !== undefined || patch.run_once_at !== undefined;
  let repeat = task ? repeatOf(task) : { kind: "manual" as const };
  if (changingRule) {
    try {
      if (patch.run_once_at) {
        repeat = validRepeat({
          kind: "once",
          at: Date.parse(patch.run_once_at),
        });
      } else if (patch.cron_expression) {
        if (!task || patch.cron_expression !== triggerCron(task)) {
          const expression = /^(?:CRON_TZ|TZ)=/.test(patch.cron_expression)
            ? patch.cron_expression
            : "CRON_TZ=UTC " + patch.cron_expression;
          repeat = validRepeat({ kind: "cron", expression });
        }
      } else if (
        patch.cron_expression !== undefined ||
        patch.run_once_at === null
      ) {
        repeat = { kind: "manual" };
      }
    } catch (error) {
      throw new TriggerError(
        400,
        error instanceof Error ? error.message : "Choose a valid schedule.",
      );
    }
  }
  const currentTriggers = task?.triggers;
  const triggers =
    currentTriggers && changingRule
      ? {
          ...currentTriggers,
          schedule:
            repeat.kind !== "manual" ||
            (!currentTriggers.api && !currentTriggers.github),
        }
      : currentTriggers;
  const channel = patch.notifications?.channel;
  const repositories = job
    ? repositoriesOf(job.session_context, task)
    : task?.repositories;
  const contextModel = job?.session_context.model;
  if (
    patch.model !== undefined &&
    contextModel !== undefined &&
    patch.model !== contextModel
  )
    throw new TriggerError(400, "Choose one Code model.");
  return {
    ...task,
    name: patch.name ?? task!.name,
    prompt: job?.events[0].data.message.content ?? task!.prompt,
    mode: "code",
    executionLocation: "remote",
    enabled: patch.enabled ?? task?.enabled ?? true,
    repeat,
    frequency: frequencyFor(repeat),
    nextRunAt: task?.nextRunAt ?? Date.now(),
    ...modelChoice(
      settings,
      task,
      patch.model === undefined ? contextModel : patch.model,
    ),
    cloudEnvironmentId: configuredEnvironment,
    repositories,
    repository: repositories ? repositories[0] : task?.repository,
    codeConnectorSelections: selectedConnectors(
      patch,
      task?.codeConnectorSelections,
      settings,
    ),
    effort: job?.session_context.effort_level ?? task?.effort,
    autoFixPullRequests:
      job?.session_context.autofix_on_pr_create ?? task?.autoFixPullRequests,
    triggers,
    ...(channel && {
      notifyOnCompletion: {
        push: channel.push ?? task?.notifyOnCompletion?.push ?? false,
        email: channel.email ?? task?.notifyOnCompletion?.email ?? false,
        slack: false,
      },
    }),
  };
}

const json = (body: Uint8Array): unknown => {
  try {
    return body.length
      ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
      : {};
  } catch {
    throw new TriggerError(400, "Invalid scheduled task request body.");
  }
};

export async function cloudCodeTriggerRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: AdapterContext,
) {
  if (!isOfficialCodeTriggerPath(url.pathname)) return false;
  const fail = (status: number, message: string) =>
    reply(
      res,
      {
        type: "error",
        error: {
          type:
            status === 404
              ? "not_found_error"
              : status === 400
                ? "invalid_request_error"
                : status === 403
                  ? "permission_error"
                  : "api_error",
          message,
          ...(status === 404 && { resource: "trigger" }),
        },
      },
      status,
      { "Cache-Control": "private, no-store" },
    );
  const method = req.method ?? "";
  const route = officialCodeTriggerRequest(method, url.pathname, url.search);
  if (!route)
    return fail(501, "This cloud scheduled task operation is unavailable.");
  const owner = ctx.account();
  if (!owner) return fail(401, "Sign in to continue.");
  const headerOrg = req.headers["x-organization-uuid"];
  const pathOrg =
    route.kind === "environments" ? route.organization : undefined;
  const organization = headerOrg ?? pathOrg;
  const activeOrg = organizationUuid(owner.id);
  if (
    typeof organization !== "string" ||
    organization.toLowerCase() !== activeOrg ||
    (pathOrg && pathOrg.toLowerCase() !== activeOrg)
  )
    return fail(404, "Organization not found.");

  const writing = !isOfficialCodeTriggerRead(route);
  const project = (task: Routine) =>
    trigger(task, owner, ctx.settings(), ctx.officialCodeRoutineFireUrl);
  const mode =
    route.kind === "list" &&
    route.query.getAll("tags").includes(officialCoworkTriggerTag)
      ? "cowork"
      : "code";
  if (
    !ctx.forwardOfficialCodeTrigger &&
    !ctx.officialCodeTriggerModes?.includes(mode)
  )
    return fail(501, "Cloud scheduled tasks are unavailable on this host.");
  if (
    writing &&
    !ctx.forwardOfficialCodeTrigger &&
    !ctx.officialCodeTriggerWrites
  )
    return fail(
      403,
      "Cloud scheduled task changes are unavailable on this host.",
    );
  const activation = ctx.sessionIdentity?.();
  const current = () =>
    ctx.isCurrent?.() !== false &&
    ctx.account()?.id === owner.id &&
    ctx.sessionIdentity?.() === activation;
  try {
    const body = writing ? await readBody(req) : undefined;
    const contentType = req.headers["content-type"];
    if (body && body.byteLength > officialUiRequestLimit(method, url.pathname))
      return fail(413, "The scheduled task request is too large.");
    if (
      body?.byteLength &&
      (typeof contentType !== "string" || !jsonContent.test(contentType))
    )
      return fail(400, "Expected a JSON scheduled task request.");
    if (!current())
      return fail(409, "The account changed during this request.");
    if (ctx.forwardOfficialCodeTrigger) {
      const answer = await ctx.forwardOfficialCodeTrigger({
        method: method as OfficialUiReadRequest["method"],
        path: url.pathname + url.search,
        codeOrganizationId: organization,
        ...(body &&
          (body.byteLength > 0 || method === "POST") && {
            body,
            contentType: "application/json",
          }),
      });
      if (!current())
        return fail(409, "The account changed during this request.");
      if (!answer)
        return fail(503, "Connect to the cloud to open scheduled tasks.");
      res.writeHead(answer.status, {
        "Content-Type": answer.contentType,
        "Cache-Control": "private, no-store",
      });
      res.end(answer.body);
      return true;
    }
    if (route.kind === "environments") {
      const { query } = route;
      if (
        [...query.keys()].some(
          (key) =>
            ![
              "limit",
              "include_archived",
              "page",
              "included_worker_types",
            ].includes(key),
        )
      )
        return fail(400, "Invalid cloud environment query.");
      const limit = query.get("limit") ?? "100";
      const archived = query.get("include_archived");
      if (
        !/^\d+$/.test(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 1000 ||
        (archived !== null && archived !== "true" && archived !== "false")
      )
        return fail(400, "Invalid cloud environment query.");
      const root = ctx.stateDirectory?.();
      if (!root) return fail(503, "Cloud environments are unavailable.");
      const rows = new CloudEnvironments(root).list();
      const cursor = query.get("page");
      const start =
        cursor === null ? 0 : rows.findIndex((row) => row.id === cursor) + 1;
      if (cursor !== null && start === 0)
        return fail(400, "Invalid cloud environment page.");
      const page = rows.slice(start, start + Number(limit));
      const hasMore = start + page.length < rows.length;
      return reply(res, {
        environments: page.map((row) => ({
          environment_id: row.id,
          name: row.name,
          state: "active",
          kind: "anthropic_cloud",
          scope: "account",
          owner_account_uuid: owner.id,
          ...(row.id === "default" && { created_at: date(row.updatedAt) }),
          updated_at: date(row.updatedAt),
        })),
        has_more: hasMore,
        next_page: hasMore ? page.at(-1)?.id : undefined,
      });
    }
    const rows = (await ctx.call("listSchedules")) as Routine[];
    if (!current())
      return fail(409, "The account changed during this request.");
    const owned = rows.filter(
      (task) => task.mode === mode && cloudRoutine(task),
    );
    if (route.kind === "list")
      return reply(res, triggerPage(route.query, owned, project));
    if (route.kind === "webhooks") {
      const filters = [...route.query];
      const selected = route.query.get("routine_trigger_id");
      const selectedId = selected && routineIdFromOfficialCodeTrigger(selected);
      if (filters.length > 1 || (filters.length === 1 && !selectedId))
        return fail(400, "Invalid scheduled task webhook query.");
      const tasks = selectedId
        ? owned.filter((row) => row.id === selectedId)
        : owned;
      if (selectedId && !tasks.length)
        return fail(404, "Scheduled task not found.");
      return reply(res, {
        data: tasks.flatMap((row) =>
          row.triggers?.github ? [githubTrigger(row, row.triggers.github)] : [],
        ),
        has_more: false,
      });
    }
    const task =
      "id" in route ? owned.find((row) => row.id === route.id) : undefined;
    if ("id" in route && !task) return fail(404, "Scheduled task not found.");
    if (route.kind === "detail") return reply(res, { trigger: project(task!) });

    const input = json(body!);
    const call = async (operation: string, ...args: unknown[]) => {
      if (!current())
        throw new TriggerError(409, "The account changed during this request.");
      const answer = await ctx.call(operation, ...args);
      if (!current())
        throw new TriggerError(409, "The account changed during this request.");
      return answer;
    };
    const save = async (draft: RoutineInput) => {
      const saved = (await call("saveSchedule", draft)) as Routine;
      if (
        !saved?.id ||
        saved.mode !== "code" ||
        !cloudRoutine(saved) ||
        (draft.id && saved.id !== draft.id)
      )
        throw new TriggerError(
          503,
          "The scheduled task save could not be confirmed.",
        );
      return saved;
    };
    const root = ctx.stateDirectory?.();
    switch (route.kind) {
      case "create-webhook": {
        const webhook = createWebhook.parse(input);
        const row = owned.find(
          (item) => item.id === webhook.routine_trigger_id,
        );
        if (!row) return fail(404, "Scheduled task not found.");
        const repository = githubRepository(webhook.scope_id);
        if (
          !repository ||
          !routineRepositories(row).some(
            ({ url }) =>
              githubRepository(url)?.toLowerCase() === repository.toLowerCase(),
          )
        )
          return fail(400, "Choose the GitHub repository saved on this task.");
        const fields = Object.entries(routineFilterFields)
          .filter(([event]) =>
            webhook.events.every((name) => name.startsWith(event + ".")),
          )
          .flatMap<{ value: string; type: RoutineFilterType }>(
            ([, values]) => values,
          );
        const filters = (webhook.filter?.clauses ?? []).map(
          ({ field, op, values }) => {
            const setting = fields.find((item) => item.value === field);
            const operation = githubFilterOp[op];
            const multiple = operation === "in" || operation === "not_in";
            const value = values.join(",");
            if (
              !setting ||
              !routineFilterOps[setting.type].includes(operation) ||
              (multiple
                ? values.some((item) => item.includes(","))
                : values.length !== 1) ||
              (setting.type === "bool" &&
                value !== "true" &&
                value !== "false") ||
              value.length > 1000
            )
              throw new TriggerError(
                400,
                "Invalid scheduled task webhook filter.",
              );
            if (operation === "matches") {
              try {
                new RegExp(value);
              } catch {
                throw new TriggerError(
                  400,
                  "Invalid scheduled task webhook filter.",
                );
              }
            }
            return { field, op: operation, value };
          },
        );
        const existing = row.triggers?.github;
        const events = [...new Set(webhook.events)];
        if (
          existing &&
          existing.repository.toLowerCase() === repository.toLowerCase() &&
          events.length === existing.events.length &&
          events.every((event) => existing.events.includes(event)) &&
          JSON.stringify(existing.filters) === JSON.stringify(filters)
        )
          return reply(res, { trigger: githubTrigger(row, existing) });
        const github = {
          id: newRoutineTriggerId(),
          repository,
          events,
          filters,
        };
        const saved = await save({
          ...row,
          triggers: {
            schedule: !scheduleOff(row),
            ...row.triggers,
            github,
          },
        });
        if (saved.triggers?.github?.id !== github.id)
          return fail(
            503,
            "The scheduled task webhook could not be confirmed.",
          );
        return reply(res, {
          trigger: githubTrigger(saved, saved.triggers.github),
        });
      }
      case "delete-webhook": {
        emptyInput.parse(input);
        const row = owned.find(
          (item) => item.triggers?.github?.id === route.webhookId,
        );
        if (!row) return empty(res);
        const triggers = row.triggers!;
        const saved = await save({
          ...row,
          triggers: {
            schedule: triggers.api ? triggers.schedule : true,
            api: triggers.api,
          },
        });
        if (saved.triggers?.github)
          return fail(
            503,
            "The scheduled task webhook removal could not be confirmed.",
          );
        return empty(res);
      }
      case "create":
      case "update": {
        const patch = triggerEdit.parse(input);
        if (!root) return fail(503, "The cloud scheduler is unavailable.");
        const saved = await save(
          prepareEdit(patch, task, ctx.settings(), root),
        );
        return reply(res, { trigger: project(saved) });
      }
      case "fork": {
        const value = fork.parse(input);
        if (!root) return fail(503, "The cloud scheduler is unavailable.");
        const draft = prepareEdit(
          { name: value.name ?? `Copy of ${task!.name}`.slice(0, 120) },
          task,
          ctx.settings(),
          root,
        );
        const saved = await save({
          ...draft,
          id: undefined,
          enabled: false,
          alwaysAllowed: undefined,
          triggers: undefined,
          repeat: scheduleOff(task!) ? { kind: "manual" } : draft.repeat,
        });
        return reply(res, { trigger: project(saved) });
      }
      case "delete":
        emptyInput.parse(input);
        await call("deleteSchedule", task!.id);
        return empty(res);
      case "run": {
        const { text } = manualRun.parse(input);
        const saved = (await call(
          "officialCodeRoutineRun",
          task!.id,
          mode,
          text,
        )) as Routine;
        if (!saved?.conversationId || saved.id !== task!.id)
          return fail(503, "The scheduled run could not be confirmed.");
        return reply(res, {
          trigger: project(saved),
          session_id: officialSessionId(saved.conversationId, owner.id),
          conversation_id: saved.conversationId,
        });
      }
      case "cancel": {
        emptyInput.parse(input);
        const history = (await call("routineRuns", task!.id)) as RoutineRun[];
        const requested = route.sessionId.replace(/^cse_/, "session_");
        const run = history.find(
          ({ conversationId }) =>
            conversationId &&
            officialSessionId(conversationId, owner.id) === requested,
        );
        if (!run?.conversationId) return fail(404, "Scheduled run not found.");
        const result = (await call(
          "officialCodeRoutineCancel",
          task!.id,
          run.conversationId,
        )) as { status?: string };
        if (
          result?.status !== "accepted" &&
          result?.status !== "already_finished"
        )
          return fail(
            409,
            "The scheduled run changed. Open the run and try again.",
          );
        return empty(res);
      }
      case "generate-token":
      case "delete-token": {
        emptyInput.parse(input);
        const apiFireUrl = ctx.officialCodeRoutineFireUrl;
        if (!apiFireUrl)
          return fail(
            501,
            "Scheduled task API tokens are unavailable on this host.",
          );
        let apiId = task!.triggers?.api?.id;
        if (!apiId && route.kind === "delete-token")
          return fail(404, "Scheduled task API token not found.");
        if (!apiId) {
          apiId = newRoutineTriggerId();
          const saved = await save({
            ...task!,
            triggers: { schedule: true, ...task!.triggers, api: { id: apiId } },
          });
          if (saved.triggers?.api?.id !== apiId)
            return fail(
              503,
              "The scheduled task API trigger could not be confirmed.",
            );
        }
        const answer = (await call(
          "routineApiToken",
          apiId,
          route.kind === "generate-token" ? "generate" : "delete",
        )) as { token?: string; hint?: string };
        if (route.kind === "delete-token") return empty(res);
        if (!answer?.token || !answer.hint)
          return fail(
            503,
            "The scheduled task API token could not be confirmed.",
          );
        return reply(res, {
          token: answer.token,
          api_token_hint: answer.hint,
          api_fire_url: apiFireUrl(apiId),
        });
      }
    }
  } catch (error) {
    if (!current())
      return fail(409, "The account changed during this request.");
    if (error instanceof TriggerError) return fail(error.status, error.message);
    if (error instanceof z.ZodError)
      return fail(
        400,
        "This scheduled task has unsupported fields or invalid values.",
      );
    ctx.log("[official-ui] cloud scheduled task", route.kind, error);
    return fail(503, "The cloud scheduler could not complete this request.");
  }
}
