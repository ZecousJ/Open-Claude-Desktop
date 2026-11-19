import os from "node:os";
import { queryRoutineList, readRoutine } from "../routines/routine-query";
import { id, defaultModelChoice } from "./collections";
import { inspectRoutineWorkspace } from "../routines/routine-workspace";
import {
  routineBrowserPermissions,
  clearRoutineBrowserPermissions,
} from "../routines/routine-browser";
import { routineSources } from "../routines/scheduled-task-setup";
import { routineMigrationBackend } from "../routines/routine-migration-handlers";
import { prepareRoutineInput } from "../routines/routine-input";
import { z } from "zod";
import { validAllowed } from "../../shared/routines";
import {
  cleanRoutineTriggers,
  githubWebhooks,
  routineTriggerIdPattern,
  type RoutineTriggers,
} from "../../shared/routine-triggers";
import { SecurityFindingsStore, runMessages } from "../git/security-findings";
import { validTriage } from "../../shared/security-review";
import { ConversationGroupStore } from "../conversations/conversation-groups";
import type { AppContext, IpcHandle } from "../app/app-context";
import { interruptExpectedTurn } from "../conversations/interrupt-target";
import type { InterruptTargetResult } from "../../shared/interrupt-target";

/** What registerScheduleHandlers needs from collections.ts. */
export interface RegisterScheduleHandlersKit {
  ctx: AppContext;
  handle: IpcHandle;
  setup: { available: () => boolean };
}

export function registerScheduleHandlers(kit: RegisterScheduleHandlersKit) {
  const { ctx, handle, setup } = kit;
  handle("listSchedules", () => ctx.scheduler!.list());
  handle("officialCodeRoutinePolicy", () => ctx.scheduler!.allowed());
  handle("officialCodeRoutineSnapshot", () => {
    const scheduler = ctx.scheduler!;
    return scheduler.list().map((task) =>
      task.mode === "code"
        ? {
            ...task,
            missedScheduleRuns: scheduler
              .runs(task.id)
              .filter((run) => run.status === "skipped"),
          }
        : task,
    );
  });
  handle("querySchedules", () => queryRoutineList(ctx, "local"));
  handle("readSchedule", (raw: unknown) =>
    readRoutine(ctx, "local", id.parse(raw)),
  );
  handle("routineWorkspace", (raw: unknown) =>
    inspectRoutineWorkspace(ctx, id.parse(raw)),
  );
  handle("routineBrowserPermissions", (raw: unknown) =>
    routineBrowserPermissions(ctx, id.parse(raw)),
  );
  handle("clearRoutineBrowserPermissions", (raw: unknown) =>
    clearRoutineBrowserPermissions(ctx, id.parse(raw)),
  );
  handle("routineCapabilities", async () => ({
    setupWithChat: setup.available(),
    sources: routineSources(ctx),
    migration: routineMigrationBackend(ctx, defaultModelChoice),
    statuses: [
      "active",
      "paused",
      ...(routineSources(ctx).includes("code") ? ["auto-disabled"] : []),
      "on-hold",
    ],
    remote: false,
    computerName: os.hostname().replace(/\.local$/i, ""),
    // E-mail goes through the service (electron/routine-mail.ts); Slack has
    // no integration in Claudex, so it is not offered.
    email: (await ctx.routineEmailAvailable?.().catch(() => false)) ?? false,
    slack: false,
  }));
  handle("saveSchedule", (raw: any) => {
    const scheduler = ctx.scheduler!;
    const store = ctx.store;
    const activation = ctx.accountActivationIdentity ?? ctx.activeAccount;
    const prepared = prepareRoutineInput(ctx, raw);
    const settings = store.settings;
    const input =
      prepared.defaultModel === true
        ? { ...prepared, ...defaultModelChoice(settings) }
        : prepared;
    if (!settings.providers.some((p) => p.id === input?.providerId))
      throw new Error("Choose an existing model provider.");
    const before = input.id
      ? scheduler.list().find((task) => task.id === input.id)?.triggers
      : undefined;
    const commit = () => {
      if (
        ctx.store !== store ||
        ctx.scheduler !== scheduler ||
        ctx.accountRetiring ||
        (ctx.accountActivationIdentity ?? ctx.activeAccount) !== activation
      )
        throw Error("The account changed during this scheduled task update.");
      const saved = scheduler.save(input);
      void forgetTriggers(ctx, before, saved.triggers);
      return saved;
    };
    const github = cleanRoutineTriggers(input.triggers)?.github;
    if (!github || JSON.stringify(github) === JSON.stringify(before?.github))
      return commit();
    // A GitHub trigger's webhook is made first: a task saved without one
    // would never start (shared/routine-triggers.ts).
    const hook = ctx.services.routineGitHubHook;
    if (!hook) throw new Error("GitHub triggers are available on the web.");
    return hook(github.id, "set", {
      repository: github.repository,
      events: githubWebhooks(github.events),
    }).then(commit);
  });
  handle("deleteSchedule", async (raw: unknown) => {
    const taskId = id.parse(raw);
    const task = ctx.scheduler!.list().find((value) => value.id === taskId);
    const sessions = new Set(
      ctx.scheduler!.runs(taskId).map((run) => run.conversationId),
    );
    if (task?.conversationId) sessions.add(task.conversationId);
    ctx.scheduler!.delete(taskId);
    const forgotten = forgetTriggers(ctx, task?.triggers, undefined);
    const archived: string[] = [];
    for (const conversation of ctx.store.conversations) {
      if (
        conversation.scheduledTaskId !== taskId &&
        !sessions.has(conversation.id)
      )
        continue;
      if (
        conversation.archived ||
        (conversation.mode === "code" &&
          conversation.turns.some((turn) => turn.status === "inProgress"))
      )
        continue;
      conversation.archived = true;
      conversation.updatedAt = Date.now();
      ctx.push({ type: "conversation", conversation });
      archived.push(conversation.id);
    }
    ctx.store.flush();
    await Promise.allSettled([
      forgotten,
      ...archived.map((sessionId) =>
        ctx.terminals?.closeConversation(sessionId),
      ),
    ]);
  });
  handle("runSchedule", (raw: unknown) => ctx.scheduler!.runNow(id.parse(raw)));
  handle(
    "officialCodeRoutineRun",
    (raw: unknown, rawMode: unknown, rawText?: unknown) => {
      const taskId = id.parse(raw);
      const mode = z.enum(["code", "cowork"]).parse(rawMode);
      const text = z.string().max(65_536).optional().parse(rawText);
      const task = ctx
        .scheduler!.list()
        .find((entry) => entry.id === taskId && entry.mode === mode);
      const onThisComputer = !ctx.routineSources;
      if (
        !task ||
        ctx.accountRetiring ||
        (onThisComputer &&
          (task.executionLocation === "remote" ||
            (task.environment && task.environment.kind !== "local") ||
            task.triggers?.api ||
            task.triggers?.github))
      )
        throw Error("This scheduled task no longer exists.");
      return ctx.scheduler!.runNow(taskId, text, onThisComputer);
    },
  );
  handle(
    "officialCodeRoutineCancel",
    async (rawTask: unknown, rawConversation: unknown) => {
      const taskId = id.parse(rawTask);
      const conversationId = id.parse(rawConversation);
      const scheduler = ctx.scheduler!;
      if (
        !scheduler.list().some((task) => task.id === taskId) ||
        !scheduler
          .runs(taskId)
          .some((run) => run.conversationId === conversationId)
      )
        throw Error("This scheduled run no longer exists.");
      const conversation = ctx.store.conversation(conversationId);
      const turn = conversation.turns.at(-1);
      if (conversation.scheduledTaskId !== taskId || ctx.accountRetiring)
        throw Error("This scheduled run no longer exists.");
      if (
        conversation.turns.length !== 1 ||
        !turn ||
        turn.status !== "inProgress"
      )
        return { status: "already_finished" };
      if (!conversation.threadId || !turn.id)
        throw Error("Wait for the scheduled run to start.");
      const store = ctx.store;
      const activation = ctx.accountActivationIdentity ?? ctx.activeAccount;
      const current = () =>
        ctx.store === store &&
        !ctx.accountRetiring &&
        (ctx.accountActivationIdentity ?? ctx.activeAccount) === activation &&
        conversation.turns.at(-1) === turn;
      const stopped = await interruptExpectedTurn(
        {
          get store() {
            return ctx.store;
          },
          get engine() {
            return ctx.engineFor(conversationId);
          },
          accountGeneration: () =>
            ctx.accountActivationIdentity ?? ctx.activeAccount,
        },
        conversationId,
        {
          conversationCreatedAt: conversation.createdAt,
          threadId: conversation.threadId,
          turnCreatedAt: turn.createdAt,
          turnId: turn.id,
        },
      );
      if (!current()) return { status: "mismatch" };
      if (stopped.status !== "accepted" || turn.status !== "inProgress")
        return stopped;
      return new Promise<InterruptTargetResult>((resolve) => {
        const settle = (status: InterruptTargetResult["status"]) => {
          clearTimeout(timer);
          off();
          resolve({ status });
        };
        const off = ctx.onEvent((event) => {
          if (!current()) settle("mismatch");
          else if (
            (event.type === "conversation" ||
              event.type === "conversation-turn") &&
            turn.status !== "inProgress"
          )
            settle("accepted");
        });
        const timer = setTimeout(() => settle("mismatch"), 5000);
        if (!current()) settle("mismatch");
        else if (turn.status !== "inProgress") settle("accepted");
      });
    },
  );
  // A task's API token (shared/routine-triggers.ts): the service keeps only
  // its hash and answers the fire address with it, the task keeps its hint.
  // The web's runner supplies the service; the desktop has no fire address.
  handle("routineApiToken", async (rawId: unknown, rawAction: unknown) => {
    const triggerId = z.string().regex(routineTriggerIdPattern).parse(rawId);
    const action = z.enum(["generate", "delete"]).parse(rawAction);
    const service = ctx.services.routineApiToken;
    if (!service) throw new Error("API triggers are available on the web.");
    const scheduler = ctx.scheduler!;
    if (!scheduler.list().some((task) => task.triggers?.api?.id === triggerId))
      throw new Error("Save the scheduled task first.");
    const answer = await service(triggerId, action);
    if (action === "generate" && (!answer.token || !answer.hint))
      throw new Error("Failed to update API token. You can try again.");
    scheduler.setApiTokenHint(
      triggerId,
      action === "generate" ? answer.hint : undefined,
    );
    return action === "generate"
      ? { token: answer.token, hint: answer.hint }
      : {};
  });
  handle("routineRuns", (raw: unknown) => ctx.scheduler!.runs(id.parse(raw)));
  handle("routineRunsPage", (raw: unknown, query: unknown) =>
    ctx.scheduler!.runsPage(
      id.parse(raw),
      z
        .object({
          cursor: z.string().max(8192).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .strict()
        .optional()
        .parse(query),
    ),
  );
  handle("routineSchedulePreview", (repeat: unknown) =>
    ctx.scheduler!.preview(repeat),
  );
  handle("removeRoutineApproval", (raw: unknown, entry: unknown) =>
    ctx.scheduler!.removeAllowed(id.parse(raw), validAllowed([entry])[0]),
  );
  handle("markRoutineRunRead", (raw: unknown, run: unknown) =>
    ctx.scheduler!.markRunRead(id.parse(raw), id.parse(run)),
  );

  // Security-review routines (shared/security-review.ts): their runs' reports
  // kept as a list with a status, one file per account, read on each call.
  const findings = () =>
    new SecurityFindingsStore(ctx.store.root, {
      runs: (routineId) => ctx.scheduler!.runs(routineId),
      messages: (conversationId) => {
        try {
          return runMessages(ctx.store.conversation(conversationId).turns);
        } catch {
          // Its conversation was deleted: nothing to read.
          return undefined;
        }
      },
      routines: () => ctx.scheduler!.list().map((task) => task.id),
    });
  handle("securityFindings", (routine: unknown) =>
    findings().list(id.parse(routine)),
  );
  handle(
    "triageSecurityFinding",
    (routine: unknown, finding: unknown, triage: unknown) =>
      findings().triage(
        id.parse(routine),
        id.parse(finding),
        validTriage(triage),
      ),
  );

  // Custom sidebar groups (R13-D): one file per account, read on each call.
  const groups = () =>
    new ConversationGroupStore(ctx.store.root, () =>
      ctx.store.conversations.map((c) => c.id),
    );
  handle("listConversationGroups", () => groups().list());
  // Without a conversation (New group… on a group's heading) the group
  // starts empty; the web's call carries null in its place.
  handle("createConversationGroup", (name: unknown, conversation: unknown) =>
    groups().create(
      z.string().max(500).parse(name),
      id.nullish().parse(conversation),
    ),
  );
  handle("moveConversationToGroup", (conversation: unknown, group: unknown) =>
    groups().move(id.parse(conversation), id.nullable().parse(group)),
  );
  handle("renameConversationGroup", (group: unknown, name: unknown) =>
    groups().rename(id.parse(group), z.string().max(500).parse(name)),
  );
  handle("deleteConversationGroup", (group: unknown) =>
    groups().remove(id.parse(group)),
  );
}

/**
 * A trigger the task no longer has goes on the service too: its API token
 * stops working and its webhook is removed. Best effort: the task is saved
 * (or deleted) whatever the service answers.
 */
async function forgetTriggers(
  ctx: AppContext,
  before: RoutineTriggers | undefined,
  after: RoutineTriggers | undefined,
) {
  const gone: Promise<unknown>[] = [];
  if (
    before?.api &&
    before.api.id !== after?.api?.id &&
    ctx.services.routineApiToken
  )
    gone.push(ctx.services.routineApiToken(before.api.id, "delete"));
  if (
    before?.github &&
    before.github.id !== after?.github?.id &&
    ctx.services.routineGitHubHook
  )
    gone.push(ctx.services.routineGitHubHook(before.github.id, "delete"));
  await Promise.allSettled(gone);
}
