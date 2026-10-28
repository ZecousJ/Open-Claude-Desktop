import { decodeWireValue } from "../../shared/web-wire";
import { webErrorCodes } from "../../shared/web-protocol";
import { notAvailableOnWeb } from "../../shared/web-bridge-methods";
import type { IpcHandle } from "../../electron/app/app-context";
import { webCallScope } from "./electron-shim";
import {
  guardCall,
  runnerMethods,
  sanitizeResult,
  webArguments,
} from "./method-guard";
import { hasUploads, readUpload, resolveUploads } from "./attachments";
import { previewDocumentMethod, previewOwner } from "./previews";
import { registerWebHandlers, WebAppContext } from "./web-app-context";
import { stageSession } from "./session-stage";
import {
  routineTriggerIdPattern,
  type RoutineEventFields,
} from "../../shared/routine-triggers";
import { engineStartingMethods } from "./dispatcher-support";
import { CapacityError } from "./dispatcher-support";
import type { Dispatcher } from "./dispatcher";
import type { CallFrame } from "./dispatcher";

// ---- Internals

export async function run(
  this: Dispatcher,
  frame: CallFrame,
): Promise<unknown> {
  const userId = frame.user.id;
  if (frame.method === previewDocumentMethod)
    return this.previewDocument(frame);
  if (frame.method === fireRoutineMethod) return this.fireRoutine(frame);
  if (!runnerMethods.has(frame.method) || !this.methods.includes(frame.method))
    throw Object.assign(new Error(notAvailableOnWeb), {
      code: webErrorCodes.methodUnavailable,
    });
  const ctx = await this.contextFor(frame);
  ctx.reclaimCaches?.();
  ctx.setAccessToken(frame.user.accessToken);
  ctx.signedOut = false;
  ctx.lastActive = this.now();
  let args = (decodeWireValue(frame.args) as unknown[]) ?? [];
  if (hasUploads(args))
    args = await resolveUploads(args, (id, maxBytes) =>
      readUpload(
        {
          request: (op, user, body) =>
            this.options.link.request(op, user, body),
        },
        userId,
        id,
        maxBytes,
      ),
    );
  args = webArguments(frame.method, args, (id) => {
    try {
      return ctx.store.conversation(id).cwd;
    } catch {
      return undefined;
    }
  });
  guardCall(frame.method, args, this.guard);
  const handler = ctx.handlers.get(frame.method);
  if (!handler)
    throw Object.assign(new Error(notAvailableOnWeb), {
      code: webErrorCodes.methodUnavailable,
    });
  const needsSlot =
    engineStartingMethods.has(frame.method) && !ctx.engineRunning();
  if (needsSlot) await this.engineSlot(ctx);
  let session: string | undefined;
  try {
    // A new conversation gets its own space, and a new Code session its
    // folder there (and its repository).
    [args, session] = await this.newSession(ctx, frame.method, args);
    const value = await webCallScope.run(
      {
        userId,
        tabId: frame.user.tabId,
        openUrl: (url) => this.options.openUrl(userId, url, frame.user.tabId),
      },
      () => handler(...args),
    );
    return sanitizeResult(frame.method, value);
  } catch (error) {
    if (session) ctx.discardCodeSession(session);
    throw error;
  } finally {
    if (needsSlot) this.reserved.delete(userId);
    ctx.lastActive = this.now();
  }
}

/**
 * `send` of a new conversation (docs/cloud-sync.md): it runs in an
 * isolated space of its own, one per Chat or Cowork conversation and per
 * GitHub repository (sessions of one repository share it; a Code session
 * without one gets its own). A new Code session's folder, made by the
 * runtime's `prepareWorkspace` hook in that space, replaces the (absent)
 * `cwd`; `repository` and `repositories` (a session with several, the
 * main one first) are for the hook only and do not reach the handler,
 * which gets the clone as a setup hook to run in the session's first turn
 * (shared/session-setup.ts). Returns the arguments and the new folder.
 */
export async function newSession(
  this: Dispatcher,
  ctx: WebAppContext,
  method: string,
  args: unknown[],
): Promise<[unknown[], string | undefined]> {
  if (method !== "send") return [args, undefined];
  const input = args[0];
  if (!input || typeof input !== "object" || Array.isArray(input))
    return [args, undefined];
  // Only `input` comes from the browser; the second argument is the
  // runner's own (a session's setup), never the browser's.
  const { repository, repositories, ...rest } = input as Record<
    string,
    unknown
  >;
  if (rest.conversationId)
    return [[rest, ...this.resumedSetup(ctx, rest.conversationId)], undefined];
  return stageSession(ctx, rest, { repository, repositories });
}

/**
 * A later message of a session whose start did not finish: its
 * repository is fetched again first (`pendingSetup`).
 */
export function resumedSetup(
  this: Dispatcher,
  ctx: WebAppContext,
  id: unknown,
): unknown[] {
  if (typeof id !== "string") return [];
  let conversation;
  try {
    conversation = ctx.store.conversation(id);
  } catch {
    return [];
  }
  const repositories = conversation.pendingSetup;
  if (
    conversation.mode !== "code" ||
    !conversation.cwd ||
    (!repositories && !conversation.pendingSetupScript)
  )
    return [];
  const fetch = repositories?.length
    ? ctx.refetchCodeSession(conversation.cwd, repositories)
    : async () => {};
  return fetch
    ? [
        {
          setup: {
            repositories: repositories ?? [],
            fetch,
            setupScript: conversation.pendingSetupScript,
          },
        },
      ]
    : [];
}

/**
 * The runner-internal call Go makes when a task's fire address is called with
 * its token, or a GitHub event it watches arrives (signature checked): the
 * user's context opens on the short-lived token Go passes and the task's
 * trigger starts it.
 */
export const fireRoutineMethod = "fireRoutineTrigger";

export async function fireRoutine(this: Dispatcher, frame: CallFrame) {
  const [triggerId, kind, text, event] =
    (decodeWireValue(frame.args) as unknown[]) ?? [];
  const named = event as { name?: unknown; fields?: unknown } | undefined;
  if (
    typeof triggerId !== "string" ||
    !routineTriggerIdPattern.test(triggerId) ||
    (kind !== "api" && kind !== "github") ||
    (text !== undefined &&
      (typeof text !== "string" || text.length > 65_536)) ||
    (kind === "github" &&
      (typeof named?.name !== "string" ||
        !named.fields ||
        typeof named.fields !== "object"))
  )
    throw new Error("The request was not valid.");
  if (this.draining)
    throw Object.assign(
      new Error("Claudex is restarting. Try again in a moment."),
      { code: webErrorCodes.runnerUnavailable },
    );
  const ctx = await this.contextFor(frame);
  ctx.setAccessToken(frame.user.accessToken);
  ctx.lastActive = this.now();
  if (!ctx.scheduler) throw new Error("Scheduled tasks aren't available.");
  const task = await ctx.scheduler.fireTrigger(
    triggerId,
    kind,
    text as string | undefined,
    kind === "github"
      ? {
          name: named!.name as string,
          fields: named!.fields as RoutineEventFields,
        }
      : undefined,
  );
  return task
    ? { scheduledTaskId: task.id, conversationId: task.conversationId }
    : { skipped: true };
}

export function previewDocument(this: Dispatcher, frame: CallFrame) {
  const [id] = decodeWireValue(frame.args) as unknown[];
  if (typeof id !== "string" || previewOwner(id) !== frame.user.id)
    throw new Error("Preview unavailable");
  const doc = this.contexts.get(frame.user.id)?.artifactPreviews.document(id);
  if (!doc) throw new Error("Preview unavailable");
  return doc;
}

/**
 * A user's scheduled task is due and no page of theirs is calling: asks Go
 * for a short-lived token of the user (routine.token, which only an active
 * user the web app admits gets), opens the context on it and lets its
 * scheduler start what is due. The context then stays while a turn runs.
 */
export async function wakeUser(this: Dispatcher, userId: number) {
  if (this.draining) return;
  const grant = (await this.options.link.request(
    "routine.token",
    userId,
    {},
  )) as { accessToken?: unknown } | undefined;
  const accessToken = grant?.accessToken;
  if (typeof accessToken !== "string" || !accessToken)
    throw new Error("The service gave no token for the scheduled task.");
  const ctx = await this.contextFor({ user: { id: userId, accessToken } });
  ctx.setAccessToken(accessToken);
  ctx.lastActive = this.now();
  await ctx.scheduler?.tick();
}

/** The user's context, opened once (concurrent first calls share it). */
export async function contextFor(
  this: Dispatcher,
  frame: {
    user: { id: number; accessToken: string };
  },
): Promise<WebAppContext> {
  const userId = frame.user.id;
  const existing = this.contexts.get(userId);
  if (existing && !existing.closed) return existing;
  const opening = this.opening.get(userId);
  if (opening) return opening;
  if (this.draining && !this.admitWhileDraining)
    throw Object.assign(
      new Error("Claudex is restarting. Try again in a moment."),
      { code: webErrorCodes.runnerUnavailable },
    );
  const promise = (async () => {
    await this.userSlot(userId);
    const open = this.options.openContext ?? WebAppContext.open;
    const ctx = await open(
      {
        ...this.options.runtime,
        transport: {
          request: (op, user, body) =>
            this.options.link.request(op, user, body),
        },
        publish: (user, event) => {
          const owner = this.contexts.get(user);
          if (owner) owner.lastActive = this.now();
          this.options.publish(user, event);
        },
        closed: (ctx) => {
          if (this.contexts.get(ctx.userId) === ctx) {
            this.contexts.delete(ctx.userId);
            this.options.forget?.(ctx.userId);
          }
        },
      },
      {
        userId,
        accessToken: frame.user.accessToken,
        register: (ctx) => {
          const handle: IpcHandle = (name, fn) => {
            if (runnerMethods.has(name)) ctx.handlers.set(name, fn);
          };
          registerWebHandlers(ctx, handle);
        },
      },
    );
    this.contexts.set(userId, ctx);
    return ctx;
  })().finally(() => {
    this.opening.delete(userId);
  });
  this.opening.set(userId, promise);
  return promise;
}

/** Room for one more context: closes the longest-idle one without tabs or turns. */
export async function userSlot(this: Dispatcher, userId: number) {
  // The opening context is not counted yet (this runs before it is listed).
  if (this.contexts.size + this.opening.size < this.maxUsers) return;
  const idle = [...this.contexts.values()]
    .filter((ctx) => ctx.userId !== userId && !ctx.busy() && ctx.tabs === 0)
    .sort((a, b) => a.lastActive - b.lastActive)[0];
  if (!idle)
    throw new CapacityError(
      "Claudex is at capacity right now. Try again in a few minutes.",
    );
  await this.closeContext(idle);
}

/** Room for one more running engine: stops the longest-idle other one. */
export function engineSlot(this: Dispatcher, ctx: WebAppContext) {
  const run = this.slotLock.then(async () => {
    const running = [...this.contexts.values()].filter(
      (other) =>
        other !== ctx &&
        (other.engineRunning() || this.reserved.has(other.userId)),
    );
    if (running.length >= this.maxEngines) {
      const idle = running
        .filter((other) => !other.busy() && !this.reserved.has(other.userId))
        .sort((a, b) => a.lastActive - b.lastActive)[0];
      if (!idle || running.length - 1 >= this.maxEngines)
        throw new CapacityError(
          "Claudex is busy right now. Try again in a few minutes.",
        );
      await idle.stopEngine();
    }
    this.reserved.add(ctx.userId);
  });
  this.slotLock = run.catch(() => {});
  return run;
}

export async function closeContext(this: Dispatcher, ctx: WebAppContext) {
  if (this.contexts.get(ctx.userId) === ctx) this.contexts.delete(ctx.userId);
  this.options.forget?.(ctx.userId);
  await ctx
    .close()
    .catch((error) =>
      this.log(
        `claudex-runner: closing user ${ctx.userId}'s context failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}
