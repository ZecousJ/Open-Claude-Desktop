import { prepareRoutineInput } from "./routine-input";
import { z } from "zod";
import type { AppContext } from "../app/app-context";
import type {
  EngineExtension,
  DynamicToolResult,
} from "../engine/engine-extensions";
import type { Routine } from "../../shared/routines";

export const scheduledTaskSetupInput = z
  .object({
    returnTo: z.literal("scheduled"),
    projectId: z.string().min(1).max(128).optional(),
    cwd: z.string().min(1).max(8192).optional(),
  })
  .strict();

export function routineSources(ctx: AppContext): ("chat" | "code")[] {
  if (ctx.routineSources) return [...new Set(ctx.routineSources())];
  if (!ctx.window) return [];
  return ctx.store.settings.computerAccess === false
    ? ["code"]
    : ["chat", "code"];
}

const request = z
  .object({
    name: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(100_000),
    source: z.enum(["chat", "code"]),
    cron: z.string().trim().min(1).max(200).optional(),
    runAt: z.number().finite().positive().optional(),
  })
  .strict()
  .refine(
    (value) => (value.cron === undefined) !== (value.runAt === undefined),
    {
      message: "Choose exactly one recurring cron or one-time runAt schedule.",
    },
  );
const result = (success: boolean, value: unknown): DynamicToolResult => ({
  success,
  contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
});
const receipt = (task: Routine, timeZone: string | undefined) => ({
  id: task.id,
  name: task.name,
  nextRunAt: task.nextRunAt,
  timeZone,
  href: `/scheduled-task/${encodeURIComponent(task.id)}`,
});

/** A real scheduler tool, restricted to the explicit Scheduled → Chat setup flow. */
export function registerScheduledTaskSetup(ctx: AppContext) {
  let owner: AppContext["store"] | undefined;
  let remove: (() => void) | undefined;
  const available = () =>
    !!owner &&
    owner === ctx.store &&
    !!ctx.scheduler &&
    routineSources(ctx).length > 0 &&
    (!ctx.window || ctx.store.settings.computerAccess !== false) &&
    ctx.policy().scheduledTasks?.enabled !== false;
  const extension: EngineExtension = {
    id: "scheduled-task-setup",
    beforeSend(context) {
      if (context.conversation.scheduledTaskSetup && !available())
        throw new Error(
          "Scheduled task setup is unavailable for this account.",
        );
    },
    developerInstructions(context) {
      if (
        context.mode === "code" ||
        !context.conversation.scheduledTaskSetup ||
        !available()
      )
        return;
      return "This Chat was explicitly opened to set up one scheduled task. Ask the user for missing instructions, timing and task type. Once the user has supplied these and asked you to create the task, use create_scheduled_task. Do not claim creation without its successful receipt. Never use shell cron or invent a schedule. Existing task receipts are idempotent; use the receipt's Scheduled link to return to the task.";
    },
    turnContext(context) {
      if (
        context.mode === "code" ||
        !context.conversation.scheduledTaskSetup ||
        !available()
      )
        return;
      return {
        scheduler: JSON.stringify({
          now: Date.now(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          sources: routineSources(ctx),
        }),
      };
    },
    dynamicTools(context) {
      if (
        context.mode === "code" ||
        !context.conversation.scheduledTaskSetup ||
        !available()
      )
        return;
      return [
        {
          type: "function",
          name: "create_scheduled_task",
          description:
            "Create the one scheduled task requested in this setup Chat. Recurring cron uses the executing scheduler's time zone; runAt is a future Unix timestamp in milliseconds. Use only user-confirmed instructions and timing.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              instructions: { type: "string" },
              source: { type: "string", enum: ["chat", "code"] },
              cron: { type: "string" },
              runAt: { type: "number" },
            },
            required: ["name", "instructions", "source"],
            additionalProperties: false,
          },
        },
      ];
    },
    handleDynamicTool(call) {
      if (call.tool !== "create_scheduled_task" || call.namespace) return;
      try {
        if (!available())
          throw new Error(
            "Scheduled task setup is unavailable for this account.",
          );
        const store = ctx.store,
          scheduler = ctx.scheduler!;
        const conversation = store.conversations.find(
          (value) => value.id === call.conversation.id,
        );
        if (
          !conversation ||
          conversation.archived ||
          conversation.incognito ||
          conversation.mode === "code" ||
          !conversation.scheduledTaskSetup
        )
          throw new Error("This Chat does not own a scheduled task setup.");
        const input = request.parse(call.arguments);
        if (!routineSources(ctx).includes(input.source))
          throw new Error(
            "This task type is unavailable on the executing host.",
          );
        const intent = scheduledTaskSetupInput.parse({
          returnTo: conversation.scheduledTaskSetup.returnTo,
          ...(conversation.scheduledTaskSetup.projectId
            ? { projectId: conversation.scheduledTaskSetup.projectId }
            : {}),
          ...(conversation.scheduledTaskSetup.cwd
            ? { cwd: conversation.scheduledTaskSetup.cwd }
            : {}),
        });
        if (
          intent.projectId &&
          !store.projects.some(
            (project) => project.id === intent.projectId && !project.archivedAt,
          )
        )
          throw new Error(
            "This project is no longer available. Start a new setup in an existing project.",
          );
        ctx.allowedFolder(intent.cwd, conversation.environment);
        const existing = scheduler
          .list()
          .find((task) => task.setupConversationId === conversation.id);
        if (conversation.scheduledTaskSetup.createdTaskId && !existing)
          throw new Error(
            "The created task no longer exists. Start a new setup to create another.",
          );
        if (existing) {
          conversation.scheduledTaskSetup = {
            ...intent,
            createdTaskId: existing.id,
          };
          store.flush();
          call.changed();
          return result(
            true,
            receipt(existing, Intl.DateTimeFormat().resolvedOptions().timeZone),
          );
        }
        const repeat = input.cron
          ? { kind: "cron" as const, expression: input.cron }
          : { kind: "once" as const, at: input.runAt! };
        const preview = scheduler.preview(repeat);
        if (!preview.nextRunAt || preview.nextRunAt <= Date.now())
          throw new Error("Choose a time in the future.");
        const provider = store.settings.providers.find(
          (value) => value.id === store.settings.activeProviderId,
        );
        if (!provider?.model)
          throw new Error("Choose an available default model.");
        const task = scheduler.save(
          prepareRoutineInput(ctx, {
            name: input.name,
            prompt: input.instructions,
            mode: input.source === "code" ? "code" : "cowork",
            projectId: intent.projectId,
            cwd: intent.cwd,
            providerId: provider.id,
            model: provider.model,
            defaultModel: true,
            frequency: "daily",
            repeat,
            nextRunAt: preview.nextRunAt,
            enabled: true,
          }),
          { setupConversationId: conversation.id },
        );
        conversation.scheduledTaskSetup = { ...intent, createdTaskId: task.id };
        store.flush();
        call.changed();
        return result(true, receipt(task, preview.timeZone));
      } catch (error) {
        return result(false, {
          error:
            error instanceof Error
              ? error.message
              : "The scheduled task could not be created.",
        });
      }
    },
  };
  ctx.onAccountActivated?.(() => {
    remove?.();
    if (!ctx.engine?.extensions?.add) {
      owner = undefined;
      return;
    }
    owner = ctx.store;
    const engine = ctx.engine;
    const removers = (ctx.engines?.all() ?? [engine]).map((peer) =>
      peer.extensions.add(extension),
    );
    engine.peerExtensions.push(extension);
    remove = () => {
      for (const dispose of removers) dispose();
      engine.peerExtensions = engine.peerExtensions.filter(
        (value) => value !== extension,
      );
    };
  });
  ctx.onAccountDeactivating?.(() => {
    owner = undefined;
    remove?.();
    remove = undefined;
  });
  return { available };
}
