import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Settings } from "../../shared/types";
import type { RoutineInput } from "../../shared/routines";
import type { RoutineMigrationBackendCapabilities } from "../../shared/routine-migration";
import { prepareRoutineInput } from "./routine-input";
import { routineSources } from "./scheduled-task-setup";

type ModelChoice = (
  settings: Settings,
) => { providerId: string; model: string } | undefined;
const key = z.string().regex(/^rm1-[a-f0-9]{64}$/);
const id = z.string().min(1).max(500);

export function routineMigrationBackend(
  ctx: AppContext,
  choice: ModelChoice,
): RoutineMigrationBackendCapabilities | undefined {
  const methods = [
    "beginMigration",
    "restoreMigration",
    "importMigration",
    "deleteMigration",
  ] as const;
  if (
    !ctx.scheduler ||
    !methods.every((name) => typeof ctx.scheduler![name] === "function")
  )
    return;
  return {
    import: true,
    deleteHistory: true,
    originLock: true,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    models: ctx.store.settings.providers.flatMap((provider) =>
      [...new Set([provider.model, ...(provider.models ?? [])])]
        .filter(
          (model): model is string =>
            typeof model === "string" && Boolean(model),
        )
        .map((model) => ({ providerId: provider.id, model })),
    ),
    defaultModel: choice(ctx.store.settings),
  };
}

/** Local origin RPCs are absent on web. Only explicit import/delete enter
 * the owned remote scheduler; the desktop coordinator owns the transaction. */
export function registerRoutineMigrationHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  choice: ModelChoice,
) {
  const scheduler = () => {
    if (!ctx.scheduler) throw Error("Scheduled tasks aren’t available here.");
    return ctx.scheduler;
  };
  const prepare = (task: RoutineInput) => {
    const input = prepareRoutineInput(ctx, task);
    if (!routineSources(ctx).includes(input.mode === "code" ? "code" : "chat"))
      throw Error("This task source is not available on this execution host.");
    const prepared = input.defaultModel
      ? { ...input, ...choice(ctx.store.settings) }
      : input;
    if (
      !ctx.store.settings.providers.some(
        (provider) => provider.id === prepared.providerId,
      )
    )
      throw Error("Choose an existing model provider.");
    return prepared;
  };
  handle("beginRoutineMigration", (raw: unknown) =>
    scheduler().beginMigration(
      z
        .object({ key, id, expectedUpdatedAt: z.number().finite() })
        .strict()
        .parse(raw),
    ),
  );
  handle("restoreRoutineMigration", (raw: unknown) =>
    scheduler().restoreMigration(
      z
        .object({ key, id, prompt: z.string().min(1).max(100000) })
        .strict()
        .parse(raw),
    ),
  );
  handle("importRoutineMigration", (raw: unknown) => {
    const parsed = z
      .object({
        key,
        task: z.custom<RoutineInput>((value) =>
          Boolean(value && typeof value === "object" && !Array.isArray(value)),
        ),
      })
      .strict()
      .parse(raw);
    return scheduler().importMigration(parsed, prepare);
  });
  handle("deleteRoutineMigration", (raw: unknown) =>
    scheduler().deleteMigration(z.object({ key, id }).strict().parse(raw)),
  );
  handle("routineMigration", (rawId: unknown, source: unknown) => {
    id.parse(rawId);
    return {
      source: z.enum(["local", "remote"]).optional().parse(source) ?? "local",
      toCloud: { ok: false, reasons: ["unavailable"] },
      toLocal: { ok: false, reasons: ["unavailable"] },
    };
  });
  handle("migrateRoutine", (_raw: unknown) => {
    throw Error(
      "Task migration requires this computer’s connected cloud service.",
    );
  });
}
