import {
  isStorageFullError,
  storageFullMessage,
} from "../../shared/turn-errors";
import { ZodError } from "zod";
import { encodeWireValue } from "../../shared/web-wire";
import {
  webErrorCodes,
  webLimits,
  type WebRpcError,
} from "../../shared/web-protocol";
import { type GoFrame, type RunnerFrame } from "../../shared/web-runner-frames";
import type { IpcHandle } from "../../electron/app/app-context";
import {
  defaultGuardOptions,
  runnerMethods,
  type GuardOptions,
} from "./method-guard";
import { registerIpc } from "../../electron/ipc/index";
import {
  coreHandlerNames,
  WebAppContext,
  type WebRuntime,
} from "./web-app-context";
import { CapacityError } from "./dispatcher-support";
import * as dispatcherSessions from "./dispatcher-sessions";
import { installMethods } from "./install-methods";

export type CallFrame = Extract<GoFrame, { t: "call" }>;

/** How the dispatcher talks to Go (the control link, or a fake in tests). */
export interface DispatcherLink {
  send(frame: RunnerFrame): boolean;
  request(op: string, userId: number, body?: unknown): Promise<unknown>;
}

export interface DispatcherOptions {
  runtime: Omit<WebRuntime, "transport" | "publish" | "closed">;
  link: DispatcherLink;
  /** Where user events go (the event hub). */
  publish(userId: number, event: import("../../shared/types").AppEvent): void;
  /** Sends a page to open to the user's tabs. */
  openUrl(userId: number, url: string, tabId?: string): void;
  /** Forget a user's waiting events (context closed). */
  forget?(userId: number): void;
  /** Sends the user's waiting events now (before a result). */
  flush?(userId: number): void;
  maxEngines?: number;
  maxUsers?: number;
  guard?: GuardOptions;
  engineIdleMs?: number;
  contextIdleMs?: number;
  /** Opens a context (tests replace it). */
  openContext?: (
    runtime: WebRuntime,
    input: {
      userId: number;
      accessToken: string;
      register: (ctx: WebAppContext) => void;
    },
  ) => Promise<WebAppContext>;
  now?: () => number;
  log?: (message: string) => void;
}

/** A stand-in object for registration probes: every member is harmless. */
function inert(): any {
  const target = function () {} as unknown as object;
  return new Proxy(target, {
    get(_target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toPrimitive) return () => "";
      if (typeof prop === "symbol") return undefined;
      return inert();
    },
    apply: () => inert(),
    construct: () => inert(),
  });
}

/**
 * The names `register` gives the handle, registered against an inert
 * context (nothing runs; only `handle` calls are recorded).
 */
export function probeRegisteredNames(
  register: (handle: IpcHandle, ctx: any) => void,
): string[] {
  const names = new Set<string>();
  // Some handlers start timers when they register (diagnostics flushes once
  // a minute). With the inert context those timers would later run against
  // it and crash the runner, so none may start during the probe.
  const timers = { setInterval, setTimeout };
  const noTimer = (() => ({
    unref() {},
    ref() {},
    hasRef: () => false,
    refresh() {},
    [Symbol.toPrimitive]: () => 0,
  })) as unknown as typeof setInterval;
  globalThis.setInterval = noTimer;
  globalThis.setTimeout = noTimer as unknown as typeof setTimeout;
  try {
    register((name) => {
      names.add(name);
    }, inert());
  } finally {
    globalThis.setInterval = timers.setInterval;
    globalThis.setTimeout = timers.setTimeout;
  }
  return [...names].sort();
}

/** The desktop's handlers the web registers, probed once. */
export function webRegisteredNames(): string[] {
  return [
    ...new Set([
      ...coreHandlerNames,
      ...probeRegisteredNames((handle, ctx) => registerIpc(handle, ctx)),
    ]),
  ].sort();
}

/** The answer a failed call gives the browser. */
export function callError(error: unknown): WebRpcError {
  if (isStorageFullError(error)) return { message: storageFullMessage };
  if (error instanceof ZodError)
    return {
      message: "The request was not valid.",
      code: webErrorCodes.badRequest,
    };
  const raw = error as {
    message?: unknown;
    code?: unknown;
    details?: unknown;
    syscall?: unknown;
    errno?: unknown;
  };
  // A Node system error names the runner's own files (ENOENT, EACCES, …).
  const system =
    typeof raw?.syscall === "string" || typeof raw?.errno === "number";
  const message =
    !system && typeof raw?.message === "string" && raw.message
      ? raw.message
      : "Something went wrong. Try again.";
  const out: WebRpcError = { message };
  if (typeof raw?.code === "string" && /^CLAUDEX_[A-Z0-9_]+$/.test(raw.code))
    out.code = raw.code;
  if (raw?.details !== undefined)
    try {
      out.details = JSON.parse(JSON.stringify(raw.details));
    } catch {
      // Not serialisable: left out.
    }
  return out;
}

export class Dispatcher {
  contexts = new Map<number, WebAppContext>();
  opening = new Map<number, Promise<WebAppContext>>();
  private cancelled = new Set<string>();
  reserved = new Set<number>();
  slotLock: Promise<unknown> = Promise.resolve();
  private sweeper?: NodeJS.Timeout;
  draining = false;
  admitWhileDraining = false;
  private drained?: () => void;
  readonly maxEngines: number;
  readonly maxUsers: number;
  readonly guard: GuardOptions;
  private readonly engineIdleMs: number;
  private readonly contextIdleMs: number;
  readonly now: () => number;
  readonly log: (message: string) => void;
  /** The names this runner serves (its hello list). */
  readonly methods: string[];
  /** Names of the web table no desktop domain registers (logged at start). */
  readonly missing: string[];
  /** Names the domains register that the web does not serve. */
  readonly dropped: string[];
  constructor(public options: DispatcherOptions) {
    this.maxEngines = options.maxEngines ?? 1;
    this.maxUsers = options.maxUsers ?? 20;
    this.guard = options.guard ?? defaultGuardOptions;
    this.engineIdleMs = options.engineIdleMs ?? 10 * 60_000;
    this.contextIdleMs = options.contextIdleMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((message) => console.error(message));
    const registered = webRegisteredNames();
    const set = new Set(registered);
    this.methods = [...runnerMethods].filter((name) => set.has(name)).sort();
    this.missing = [...runnerMethods].filter((name) => !set.has(name)).sort();
    this.dropped = registered.filter((name) => !runnerMethods.has(name));
    if (this.missing.length)
      this.log(
        `claudex-runner: web methods no handler registers: ${this.missing.join(", ")}`,
      );
  }

  /** Starts idle reclaim (every minute). */
  start() {
    clearInterval(this.sweeper);
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }
  async stop() {
    clearInterval(this.sweeper);
    this.sweeper = undefined;
    await Promise.allSettled(
      [...this.contexts.values()].map((ctx) => ctx.close()),
    );
    this.contexts.clear();
  }

  get users() {
    return this.contexts.size;
  }
  get engines() {
    return [...this.contexts.values()].filter((ctx) => ctx.engineRunning())
      .length;
  }
  context(userId: number) {
    return this.contexts.get(userId);
  }

  // ---- Frames from Go

  /** Runs a relayed call and sends its result. */
  async call(frame: CallFrame) {
    let result: RunnerFrame;
    try {
      const value = await this.run(frame);
      result = { t: "result", id: frame.id, ok: true };
      if (value !== undefined) result.value = encodeWireValue(value);
      if (Buffer.byteLength(JSON.stringify(result)) > webLimits.linkFrameBytes)
        result = {
          t: "result",
          id: frame.id,
          ok: false,
          error: {
            message: "The answer is too large to send.",
            code: webErrorCodes.tooLarge,
          },
        };
    } catch (error) {
      result = {
        t: "result",
        id: frame.id,
        ok: false,
        error: callError(error),
      };
      if (
        !(error instanceof CapacityError) &&
        !(error as { code?: string })?.code
      )
        this.log(
          `claudex-runner: ${frame.method} failed for user ${frame.user.id}: ${error instanceof Error ? error.message : result.error!.message}`,
        );
    }
    if (this.cancelled.delete(frame.id)) return;
    this.options.flush?.(frame.user.id);
    this.options.link.send(result);
  }

  cancel(id: string) {
    this.cancelled.add(id);
    // Forget old ids so the set stays small.
    if (this.cancelled.size > 1000)
      this.cancelled.delete(this.cancelled.values().next().value!);
  }

  presence(frame: Extract<GoFrame, { t: "presence" }>) {
    const ctx = this.contexts.get(frame.userId);
    if (!ctx) return;
    const gained = frame.focused;
    ctx.tabs = frame.tabs;
    ctx.lastActive = this.now();
    if (gained) ctx.focused();
  }

  /** Go signed the user out: no more user-API calls; closes once idle. */
  async signedOut(frame: Extract<GoFrame, { t: "user-signed-out" }>) {
    const ctx = this.contexts.get(frame.userId);
    if (!ctx) return;
    ctx.signedOut = true;
    ctx.setAccessToken("");
    if (!ctx.busy()) await this.closeContext(ctx);
  }

  /**
   * Finish what runs; `done` runs once nothing is busy. Moving off this runner
   * (Go's drain) takes no new users; a restart (`admitNew`, an update) serves
   * everyone until the last turn ends.
   */
  drain(done?: () => void, { admitNew = false } = {}) {
    this.draining = true;
    this.admitWhileDraining = admitNew;
    this.drained = done;
    void this.sweep();
  }

  /** Idle reclaim; also finishes a drain. */
  async sweep() {
    const now = this.now();
    for (const ctx of [...this.contexts.values()]) {
      ctx.reclaimCaches?.();
      if (ctx.busy()) continue;
      if (ctx.signedOut) {
        await this.closeContext(ctx);
        continue;
      }
      const idle = now - ctx.lastActive;
      if (ctx.tabs === 0 && idle >= this.contextIdleMs) {
        await this.closeContext(ctx);
        continue;
      }
      if (ctx.engineRunning() && idle >= this.engineIdleMs)
        await ctx.stopEngine().catch(() => {});
    }
    if (
      this.draining &&
      ![...this.contexts.values()].some((ctx) => ctx.busy())
    ) {
      await this.stop();
      const done = this.drained;
      this.drained = undefined;
      done?.();
    }
  }

  /** Load report for the link. */
  load() {
    return {
      engines: this.engines,
      users: this.users,
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
  }
}

export interface Dispatcher {
  run(
    ...args: Parameters<typeof dispatcherSessions.run>
  ): ReturnType<typeof dispatcherSessions.run>;
  newSession(
    ...args: Parameters<typeof dispatcherSessions.newSession>
  ): ReturnType<typeof dispatcherSessions.newSession>;
  resumedSetup(
    ...args: Parameters<typeof dispatcherSessions.resumedSetup>
  ): ReturnType<typeof dispatcherSessions.resumedSetup>;
  previewDocument(
    ...args: Parameters<typeof dispatcherSessions.previewDocument>
  ): ReturnType<typeof dispatcherSessions.previewDocument>;
  fireRoutine(
    ...args: Parameters<typeof dispatcherSessions.fireRoutine>
  ): ReturnType<typeof dispatcherSessions.fireRoutine>;
  wakeUser(
    ...args: Parameters<typeof dispatcherSessions.wakeUser>
  ): ReturnType<typeof dispatcherSessions.wakeUser>;
  contextFor(
    ...args: Parameters<typeof dispatcherSessions.contextFor>
  ): ReturnType<typeof dispatcherSessions.contextFor>;
  userSlot(
    ...args: Parameters<typeof dispatcherSessions.userSlot>
  ): ReturnType<typeof dispatcherSessions.userSlot>;
  engineSlot(
    ...args: Parameters<typeof dispatcherSessions.engineSlot>
  ): ReturnType<typeof dispatcherSessions.engineSlot>;
  closeContext(
    ...args: Parameters<typeof dispatcherSessions.closeContext>
  ): ReturnType<typeof dispatcherSessions.closeContext>;
}
installMethods(Dispatcher.prototype, dispatcherSessions);
