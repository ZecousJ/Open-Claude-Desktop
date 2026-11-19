import { z } from "zod";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";
import { repeatOf } from "../../../shared/routine-labels";
import {
  validRepeat,
  parseTime,
  frequencyFor,
  routineDispatchAt,
  routinesOffMessage,
  type RoutineInput,
} from "../../../shared/routines";
import { taskPermissions } from "../../../shared/settings-extras";
import type { Settings } from "../../../shared/types";

const timestamp = z.number().finite().min(0).max(8.64e15);
const taskId = z.string().min(1).max(256);
const codeDomain = "CCDScheduledTasks";
const sourceBranch = z.string().min(1).max(255);
const storedCodePermission = z.enum(["inherit", "acceptEdits", "plan"]);
const approval = z.object({
  kind: z.enum(["command", "edit", "permission", "tool"]),
  tool: z.string(),
  pattern: z.string().optional(),
  expired: z.boolean().optional(),
});
const missedRun = z.object({
  startedAt: timestamp,
  skipReason: z.enum(["missed", "in_progress", "busy", "sign_in"]).optional(),
});
const scheduleOnly = z.strictObject({ schedule: z.literal(true) });
const routine = z
  .object({
    id: taskId,
    name: z.string().max(4096),
    prompt: z.string().max(262144),
    description: z.string().max(16384).optional(),
    mode: z.enum(["code", "cowork"]),
    model: z.string().max(512),
    cwd: z.string().min(1).max(4096).optional(),
    frequency: z.enum(["hourly", "daily", "weekly"]),
    enabled: z.boolean(),
    nextRunAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp.optional(),
    lastRunAt: timestamp.optional(),
    repeat: z
      .unknown()
      .optional()
      .transform((value) =>
        value === undefined ? undefined : validRepeat(value),
      ),
    executionLocation: z.enum(["local", "remote"]).optional(),
    environment: z.object({ kind: z.string() }).passthrough().optional(),
    triggers: z.unknown().optional(),
    connectionHold: z.unknown().optional(),
    useWorktree: z.boolean().optional(),
    sourceBranch: sourceBranch.optional(),
    codePermissionMode: storedCodePermission.optional(),
    defaultModel: z.boolean().optional(),
    alwaysAllowed: z.array(approval.passthrough()).optional(),
    disableJitter: z.boolean().optional(),
    dispatchJitterSeconds: z.number().nonnegative().optional(),
    endedReason: z.literal("auto_disabled_repo_access").optional(),
    missedScheduleRuns: z.array(missedRun).optional(),
  })
  .passthrough();

type StoredRoutine = z.infer<typeof routine>;
type NativeTask = ReturnType<typeof nativeTask>;
type ScheduleEvent =
  | "scheduled_task_created"
  | "scheduled_task_updated"
  | "scheduled_task_deleted";
const skipReasons = {
  in_progress: "per_task_limit",
  busy: "global_limit",
  sign_in: "sign_in_required",
  missed: undefined,
} as const;

/** Local scheduler repeat rules use the same host-local wall clock as native cron. */
function scheduleRule(value: StoredRoutine) {
  const repeat = repeatOf({
    frequency: value.frequency,
    nextRunAt: value.nextRunAt,
    repeat: value.repeat,
  });
  if (repeat.kind === "manual") return {};
  if (repeat.kind === "once") return { fireAt: repeat.at };
  if (repeat.kind === "cron") return { cronExpression: repeat.expression };
  if (repeat.kind === "hourly")
    return { cronExpression: `${repeat.minute} * * * *` };
  const time = parseTime(repeat.time);
  if (!time) throw Error("Invalid schedule time.");
  const prefix = `${time.minutes} ${time.hours}`;
  const suffix =
    repeat.kind === "weekly"
      ? `* * ${repeat.day}`
      : repeat.kind === "monthly"
        ? `${repeat.dayOfMonth} * *`
        : repeat.kind === "weekdays"
          ? "* * 1-5"
          : repeat.kind === "custom"
            ? `* * ${[...new Set(repeat.days)].sort().join(",")}`
            : "* * *";
  return { cronExpression: `${prefix} ${suffix}` };
}

function storedRoutines(input: unknown, mode: StoredRoutine["mode"]) {
  const all = z
    .array(routine)
    .max(mode === "code" ? 1000 : 500)
    .parse(input);
  if (new Set(all.map((row) => row.id)).size !== all.length)
    throw Error("Duplicate schedule identifiers.");
  return all.filter((row) => {
    if (row.mode !== mode) return false;
    const onThisComputer =
      row.executionLocation !== "remote" &&
      (!row.environment || row.environment.kind === "local") &&
      row.place === undefined;
    const localScheduleOnly =
      !row.triggers || scheduleOnly.safeParse(row.triggers).success;
    if (mode === "code") return onThisComputer && localScheduleOnly;
    if (!onThisComputer || row.connectionHold)
      throw Error(
        "This schedule execution location or connection hold is not supported by the official local task list.",
      );
    if (!localScheduleOnly)
      throw Error(
        "External schedule triggers are not supported by the official local task list.",
      );
    if (row.repeat?.kind === "manual")
      throw Error(
        "Manual-only schedules are not supported by the official local task list.",
      );
    return true;
  });
}

function nativePermission(row: StoredRoutine) {
  if (row.codePermissionMode === "inherit") return undefined;
  if (row.codePermissionMode) return row.codePermissionMode;
  const permission = z.enum(taskPermissions).optional().parse(row.permission);
  return permission === "bypass" ? "bypassPermissions" : permission;
}

function nativeTask(row: StoredRoutine) {
  const code = row.mode === "code";
  const rule = scheduleRule(row);
  return {
    id: row.id,
    displayName: row.name,
    prompt: row.prompt,
    description: row.description ?? "",
    model: code && row.defaultModel ? undefined : row.model,
    ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
    enabled: row.enabled,
    ...rule,
    createdAt: row.createdAt,
    nextRunAt:
      row.enabled && (rule.cronExpression || rule.fireAt !== undefined)
        ? new Date(code ? routineDispatchAt(row) : row.nextRunAt).toISOString()
        : undefined,
    ...(row.lastRunAt === undefined
      ? {}
      : { lastRunAt: new Date(row.lastRunAt).toISOString() }),
    ...(code
      ? {
          permissionMode: nativePermission(row),
          useWorktree: row.useWorktree,
          sourceBranch: row.sourceBranch,
          disableJitter: row.disableJitter,
          jitterSeconds: row.dispatchJitterSeconds,
          endedReason: row.endedReason,
          ...(row.connectionHold
            ? {
                waiting: {
                  reason: "sign_in_required",
                  since: row.lastRunAt ?? row.updatedAt ?? row.createdAt,
                },
              }
            : {}),
          approvedPermissions: row.alwaysAllowed?.map((entry) => ({
            toolName: entry.tool,
            ruleContent: entry.pattern,
            expired: entry.expired,
          })),
          missedRuns: row.missedScheduleRuns?.map((run) => ({
            time: new Date(run.startedAt).toISOString(),
            reason: run.skipReason && skipReasons[run.skipReason],
          })),
        }
      : {}),
    filePath: "",
  };
}

export function localScheduledTaskRows(
  input: unknown,
  mode: StoredRoutine["mode"],
) {
  const rows = storedRoutines(input, mode).map(nativeTask);
  if (
    mode === "cowork" &&
    Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024
  )
    throw Error("Schedule response is too large.");
  return rows;
}

const permissionMode = z.enum([
  "default",
  "auto",
  "bypassPermissions",
  "acceptEdits",
  "plan",
]);
const editFields = {
  displayName: z.string().max(120).trim().min(1),
  prompt: z.string().max(100_000).trim().min(1),
  description: z.string().max(1000).trim(),
  cronExpression: z.string().min(1).max(512),
  fireAt: timestamp,
  model: z.string().max(200),
  cwd: z.string().min(1).max(4096),
  useWorktree: z.boolean(),
  sourceBranch,
  permissionMode,
  disableJitter: z.boolean(),
};
const oneRule = (value: { cronExpression?: string; fireAt?: number }) =>
  value.cronExpression === undefined || value.fireAt === undefined;

const edit = z
  .strictObject(editFields)
  .partial()
  .extend({
    scheduledTaskId: taskId,
  })
  .refine(oneRule, "Choose one schedule rule.");

const createLocal = z
  .strictObject(editFields)
  .partial()
  .extend({
    name: z.string().max(120).trim().min(1),
    prompt: editFields.prompt,
    description: editFields.description,
    cwd: editFields.cwd,
  })
  .refine(oneRule, "Choose one schedule rule.");

function codePermissionPatch(mode: z.infer<typeof permissionMode> | undefined) {
  return {
    permission:
      mode === "auto"
        ? "auto"
        : mode === "bypassPermissions"
          ? "bypass"
          : "default",
    codePermissionMode:
      mode === "acceptEdits" || mode === "plan"
        ? mode
        : mode === undefined
          ? "inherit"
          : undefined,
  } satisfies Pick<RoutineInput, "permission" | "codePermissionMode">;
}

function modelChoice(settings: Settings, model: string | undefined) {
  const followsDefault = !model;
  const providers = followsDefault
    ? [
        settings.providers.find(
          (provider) => provider.id === settings.activeProviderId,
        ) ?? settings.providers[0],
      ]
    : settings.providers.filter((provider) =>
        [provider.model, ...(provider.models ?? [])].includes(model),
      );
  if (providers.length !== 1 || !providers[0]?.model)
    throw Error(
      "Choose a model with one configured provider for this local task.",
    );
  return {
    providerId: providers[0].id,
    model: model || providers[0].model,
    defaultModel: followsDefault || undefined,
  };
}

function taskFile(row: StoredRoutine) {
  const name = row.id.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
  const description = (row.description ?? "")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .trim();
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${row.prompt}`;
}

export function registerLocalScheduleReads(host: NativeHost) {
  const { ctx } = host;
  const inFlight = new Map<string | symbol, symbol>();
  const createKey = Symbol("create-local");
  const visibleCode = new Map<string, NativeTask>();
  const account = sessionAccountScope(ctx, () => {
    inFlight.clear();
    visibleCode.clear();
  });
  const emit = (
    domain: string,
    type: ScheduleEvent,
    scheduledTask: NativeTask,
  ) => host.emit(domain, "onScheduledTaskEvent", { type, scheduledTask });
  const check = () => {
    account.sync();
    if (!ctx.account()?.id) throw Error("Sign in to read scheduled tasks.");
    if (!ctx.localCall || ctx.readOnly)
      throw Error("The local scheduler is unavailable on this host.");
    if (ctx.isCurrent?.() === false)
      throw Error("The account changed during this request.");
  };
  const call = async (method: string, ...args: unknown[]) => {
    check();
    const value = await account.guard(() => ctx.localCall!(method, ...args));
    check();
    return value;
  };
  const assertCodeSchedulingAllowed = async () => {
    if ((await call("officialCodeRoutinePolicy")) !== true)
      throw Error(routinesOffMessage);
  };
  for (const [domain, mode] of [
    ["CoworkScheduledTasks", "cowork"],
    [codeDomain, "code"],
  ] as const) {
    const find = async (id: string) =>
      storedRoutines(await call("listSchedules"), mode).find(
        (row) => row.id === id,
      );
    const existing = async (id: string) => {
      const row = await find(id);
      if (!row) throw Error("This scheduled task no longer exists.");
      return row;
    };
    const publish = (type: ScheduleEvent, row: NativeTask) => {
      check();
      if (mode === "code") {
        if (type === "scheduled_task_deleted") visibleCode.delete(row.id);
        else visibleCode.set(row.id, row);
      }
      emit(domain, type, row);
    };
    const mutate = (id: string | symbol, operation: () => Promise<unknown>) =>
      account.run(async () => {
        check();
        const key = typeof id === "string" ? `${mode}:${id}` : id;
        if (inFlight.has(key))
          throw Error("A scheduled task change is already in progress.");
        const lease = Symbol("schedule-mutation");
        inFlight.set(key, lease);
        try {
          return await operation();
        } finally {
          if (inFlight.get(key) === lease) inFlight.delete(key);
        }
      });
    if (mode === "code") {
      for (const [method, accepted] of [
        ["markListenerReady", true],
        ["setEventAckSupported", true],
        ["setHostRunsSupported", false],
      ] as const) {
        host.on(`${domain}.${method}`, (...args: unknown[]) => {
          z.tuple([]).parse(args);
          return accepted;
        });
      }
      host.on(`${domain}.createScheduledTask`, (...args: unknown[]) => {
        if (args.length !== 1)
          throw Error("Invalid local scheduled task creation.");
        const input = createLocal.parse(args[0]);
        return mutate(createKey, async () => {
          const previous = storedRoutines(await call("listSchedules"), mode);
          await assertCodeSchedulingAllowed();
          const repeat = validRepeat(
            input.cronExpression !== undefined
              ? { kind: "cron", expression: input.cronExpression }
              : input.fireAt !== undefined
                ? { kind: "once", at: input.fireAt }
                : { kind: "manual" },
          );
          const fields = {
            name: input.displayName ?? input.name,
            prompt: input.prompt,
            description: input.description,
            cwd: input.cwd,
            ...modelChoice(ctx.settings(), input.model),
            ...codePermissionPatch(input.permissionMode),
            useWorktree: input.useWorktree || undefined,
            sourceBranch: input.sourceBranch,
            disableJitter: input.disableJitter ?? false,
            enabled: true,
          } satisfies Partial<RoutineInput>;
          const saved = routine.parse(
            await call("saveSchedule", {
              ...fields,
              mode: "code",
              repeat,
              frequency: frequencyFor(repeat),
              nextRunAt: Date.now(),
            }),
          );
          if (
            previous.some((row) => row.id === saved.id) ||
            saved.mode !== "code" ||
            Object.entries({ ...fields, repeat }).some(
              ([key, value]) =>
                JSON.stringify(saved[key]) !== JSON.stringify(value),
            )
          )
            throw Error(
              "Local scheduled task creation could not be confirmed; refresh before trying again.",
            );
          const row = nativeTask(saved);
          publish("scheduled_task_created", row);
          return row;
        });
      });
      host.on(`${domain}.getScheduledTaskFileContent`, (...args: unknown[]) =>
        account.run(async () => {
          const [id] = z.tuple([taskId]).parse(args);
          const row = await find(id);
          return row ? taskFile(row) : null;
        }),
      );
      host.on(`${domain}.getWatcherHistory`, (...args: unknown[]) =>
        account.run(() => {
          z.tuple([taskId]).parse(args);
          check();
          // This endpoint records watcher script activity. Runs use the Code session roster.
          return [];
        }),
      );
      host.on(`${domain}.removeApprovedPermission`, (...args: unknown[]) => {
        const [id, tool, rule] = z
          .tuple([
            taskId,
            z.string().min(1).max(200),
            z.string().max(2000).optional(),
          ])
          .parse(args);
        return mutate(id, async () => {
          const before = await find(id);
          const entry = before?.alwaysAllowed?.find(
            (entry) =>
              entry.tool === tool &&
              (rule === undefined || entry.pattern === rule),
          );
          if (!entry) return false;
          if (
            (await call("removeRoutineApproval", id, {
              ...entry,
              pattern: rule,
            })) !== true
          )
            return false;
          publish("scheduled_task_updated", nativeTask(await existing(id)));
          return true;
        });
      });
    }
    host.on(`${domain}.getAllScheduledTasks`, (...args: unknown[]) =>
      account.run(async () => {
        if (args.length) throw Error("This schedule read takes no arguments.");
        const rows = localScheduledTaskRows(
          await call(
            mode === "code" ? "officialCodeRoutineSnapshot" : "listSchedules",
          ),
          mode,
        );
        if (mode === "code") {
          visibleCode.clear();
          for (const row of rows) visibleCode.set(row.id, row);
        }
        return rows;
      }),
    );
    host.on(`${domain}.updateScheduledTaskStatus`, (...args: unknown[]) => {
      const [id, status, removeFiles] = z
        .tuple([
          taskId,
          z.enum(["enabled", "disabled", "deleted"]),
          z.boolean().optional(),
        ])
        .parse(args);
      if (mode === "cowork" && removeFiles !== undefined)
        throw Error("File removal is not supported for a status change.");
      if (mode === "cowork" && status === "deleted")
        throw Error("Deletion is unavailable for Cowork scheduled tasks.");
      return mutate(id, async () => {
        if (mode === "code" && status === "deleted") {
          const before = await find(id);
          if (!before) return false;
          await call("deleteSchedule", id);
          publish("scheduled_task_deleted", nativeTask(before));
          return true;
        }
        const before = await existing(id);
        const enabled = status === "enabled";
        if (mode === "code" && enabled) await assertCodeSchedulingAllowed();
        if (mode === "code" && enabled === before.enabled) return true;
        const saved = routine.parse(
          await call("saveSchedule", { ...before, enabled }),
        );
        if (saved.id !== id || saved.mode !== mode || saved.enabled !== enabled)
          throw Error("The schedule status change was not confirmed.");
        publish("scheduled_task_updated", nativeTask(saved));
        return true;
      });
    });
    host.on(`${domain}.updateScheduledTask`, (...args: unknown[]) => {
      if (args.length !== 1) throw Error("Invalid scheduled task edit.");
      const input = edit.parse(args[0]);
      if (Object.keys(input).length === 1)
        throw Error("Choose a scheduled task change.");
      return mutate(input.scheduledTaskId, async () => {
        const before = await existing(input.scheduledTaskId);
        if (
          mode === "cowork" &&
          (input.useWorktree === true ||
            input.sourceBranch !== undefined ||
            input.permissionMode !== undefined ||
            input.disableJitter !== undefined)
        )
          throw Error(
            "Worktree, branch, permission and remote-place edits are not supported by this scheduler adapter.",
          );
        const patch: Partial<RoutineInput> = {};
        const currentModel =
          mode === "code" && before.defaultModel ? undefined : before.model;
        const model = input.model || undefined;
        if (mode === "code" && Object.hasOwn(input, "model") && !model) {
          if (!before.defaultModel)
            Object.assign(patch, modelChoice(ctx.settings(), undefined));
        } else if (model !== undefined && model !== currentModel) {
          const provider = ctx
            .settings()
            .providers.find((value) => value.id === before.providerId);
          if (mode === "cowork" && before.defaultModel)
            throw Error(
              "Changing a task that follows the default model is not supported by this editor.",
            );
          if (
            provider &&
            [provider.model, ...(provider.models ?? [])].includes(model)
          ) {
            patch.model = model;
            patch.defaultModel = undefined;
          } else if (mode === "code" && before.defaultModel) {
            Object.assign(patch, modelChoice(ctx.settings(), model));
          } else {
            throw Error(
              "Choose a model configured for this task's existing provider.",
            );
          }
        }
        if (input.cwd !== undefined && input.cwd !== before.cwd) {
          if (mode !== "code")
            throw Error("Folder edits are only supported for Code tasks.");
          patch.cwd = input.cwd;
        }
        if (input.displayName !== undefined) patch.name = input.displayName;
        if (input.prompt !== undefined) patch.prompt = input.prompt;
        if (input.description !== undefined)
          patch.description = input.description;
        const beforeRule = scheduleRule(before);
        if (
          input.cronExpression !== undefined &&
          (mode === "cowork" ||
            input.cronExpression.trim() !== beforeRule.cronExpression)
        )
          patch.repeat = validRepeat({
            kind: "cron",
            expression: input.cronExpression,
          });
        if (input.fireAt !== undefined)
          patch.repeat = validRepeat({ kind: "once", at: input.fireAt });
        if (mode === "code") {
          if (
            Object.hasOwn(input, "permissionMode") &&
            input.permissionMode !== nativePermission(before)
          )
            Object.assign(patch, codePermissionPatch(input.permissionMode));
          if (Object.hasOwn(input, "sourceBranch"))
            patch.sourceBranch = input.sourceBranch;
          if (input.useWorktree !== undefined) {
            if (input.useWorktree !== Boolean(before.useWorktree))
              patch.useWorktree = input.useWorktree || undefined;
            if (!input.useWorktree && input.sourceBranch === undefined)
              patch.sourceBranch = undefined;
          }
          if (input.disableJitter !== undefined)
            patch.disableJitter = input.disableJitter;
          if (
            !patch.repeat &&
            ((Object.hasOwn(input, "cronExpression") &&
              input.cronExpression === undefined &&
              beforeRule.cronExpression !== undefined) ||
              (Object.hasOwn(input, "fireAt") &&
                input.fireAt === undefined &&
                beforeRule.fireAt !== undefined))
          )
            patch.repeat = { kind: "manual" };
          if (
            patch.repeat &&
            JSON.stringify(patch.repeat) !== JSON.stringify(before.repeat)
          )
            patch.enabled = patch.repeat.kind !== "manual";
        }
        for (const key of Object.keys(patch) as (keyof RoutineInput)[])
          if (JSON.stringify(patch[key]) === JSON.stringify(before[key]))
            delete patch[key];
        if (Object.keys(patch).length === 0) return nativeTask(before);
        if (mode === "code") await assertCodeSchedulingAllowed();
        const saved = routine.parse(
          await call("saveSchedule", { ...before, ...patch }),
        );
        if (
          saved.id !== before.id ||
          saved.mode !== mode ||
          Object.entries(patch).some(
            ([key, value]) =>
              JSON.stringify(saved[key]) !== JSON.stringify(value),
          )
        )
          throw Error("The schedule edit was not confirmed.");
        const row = nativeTask(saved);
        publish("scheduled_task_updated", row);
        return row;
      });
    });
  }
  return (
    ctx.onEvent?.((event) => {
      if (event.type !== "schedules") return;
      // Refresh the renderer without sending its session-dispatch command.
      account.sync();
      if (!ctx.account()?.id || ctx.readOnly || ctx.isCurrent?.() === false)
        return;
      const rows = new Map(
        storedRoutines(event.schedules, "code").map((row) => [
          row.id,
          nativeTask(row),
        ]),
      );
      for (const [id, before] of visibleCode) {
        if (inFlight.has(`code:${id}`)) continue;
        const row = rows.get(id);
        if (!row) {
          visibleCode.delete(id);
          emit(codeDomain, "scheduled_task_deleted", before);
        } else if (
          JSON.stringify({ ...before, missedRuns: undefined }) !==
          JSON.stringify(row)
        ) {
          visibleCode.set(id, row);
          emit(codeDomain, "scheduled_task_updated", row);
        }
      }
      for (const [id, row] of rows) {
        if (
          visibleCode.has(id) ||
          inFlight.has(`code:${id}`) ||
          inFlight.has(createKey)
        )
          continue;
        visibleCode.set(id, row);
        emit(codeDomain, "scheduled_task_created", row);
      }
    }) ?? (() => {})
  );
}
