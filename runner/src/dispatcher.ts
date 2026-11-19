import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { encodeWireValue } from "../../shared/web-wire";
import {
  webErrorCodes,
  webLimits,
} from "../../shared/web-protocol";
import { type GoFrame, type RunnerMessage } from "../../shared/web-runner-frames";
import { officialMemoryAction } from "../../shared/official-memory-capability";
import { officialMelangeEditRequest } from "../../shared/official-melange";
import { closeOfficialMelangeEdits } from "./official-melange-edit";
import {
  officialMcpAppToolboxTarget,
  officialUiReadMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
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
  type WebContextOpenInput,
  type WebRuntime,
} from "./web-app-context";
import type { StrictTextChatExecutor } from "./official-ui-text-authority";
import { CapacityError, callError } from "./dispatcher-support";
export { callError } from "./dispatcher-support";
import * as dispatcherSessions from "./dispatcher-sessions";
import { nativeCodeQueueMethods } from "./official-code-followup";
import { installMethods } from "./install-methods";
import { officialResponseTransfers } from "./official-response-transfer";
import {
  closeOfficialCodeTerminals,
  closeOfficialCodeTerminalsForTab,
} from "./official-code-terminals";

const compressBody = promisify(gzip);

function legacyKnowledgePreview(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("name" in value) ||
    !("bytes" in value) ||
    (value.kind !== "utf16" && value.kind !== "image" && value.kind !== "binary")
  )
    return value;
  return {
    name: value.name,
    bytes: value.bytes,
    kind: "unsupported",
    reason: value.kind === "utf16" ? "encoding" : "type",
  };
}

export type CallFrame = Extract<GoFrame, { t: "call" }> & { signal?: AbortSignal };

function isAbortableCall(frame: CallFrame) {
  if (frame.method === "synthesizeMemory") return true;
  if (frame.method !== "officialUiAction") return false;
  const request = frame.args[0];
  return !!request && typeof request === "object" && "method" in request && "path" in request &&
    typeof request.method === "string" && typeof request.path === "string" &&
    (officialMemoryAction(request.method, request.path) === "synthesize" ||
      officialMelangeEditRequest(request.method, request.path)?.kind === "start" ||
      officialMcpAppToolboxTarget(request.method, request.path) !== undefined);
}

/** How the dispatcher talks to Go (the control link, or a fake in tests). */
export interface DispatcherLink {
  send(frame: RunnerMessage): boolean;
  request(op: string, userId: number, body?: unknown): Promise<unknown>;
}

export interface DispatcherOptions {
  /** Explicit opt-in path for the experimental read-only official Web adapter. */
  officialUiRoot?: string;
  officialUiActions?: boolean;
  /** Independent explicit opt-in: manual memory rule CAS only, no generation/reset/settings. */
  officialUiMemoryControls?: boolean;
  /** Independent opt-in: only validated response font settings. */
  officialUiAppearanceSettings?: boolean;
  /** Source-only explicit strict mode. Missing executor means unavailable; never legacy-send fallback. */
  officialUiStrictTextChat?: { executor?: StrictTextChatExecutor };
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
  openContext?: (runtime: WebRuntime, input: WebContextOpenInput) => Promise<WebAppContext>;
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

export class Dispatcher {
  contexts = new Map<number, WebAppContext>();
  opening = new Map<number, dispatcherSessions.OpeningContext>();
  private connectionGeneration = 0;
  private cancelled = new Set<string>();
  private abortableCalls = new Map<string, AbortController>();
  reserved = new Map<number, number>();
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
    this.methods = [...runnerMethods].filter((name) => set.has(name));
    if (this.guard.modes.includes("code")) this.methods.push(...nativeCodeQueueMethods);
    if (options.officialUiRoot) this.methods.push("officialUiRead");
    if (options.officialUiRoot && (options.officialUiActions || options.officialUiMemoryControls || options.officialUiAppearanceSettings))
      this.methods.push("officialUiAction");
    this.methods.sort();
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
    this.abortRelayedCalls();
    const closingShells: Promise<WebAppContext>[] = [];
    for (const opening of this.opening.values()) {
      if (opening.shellContext) closingShells.push(opening.context);
      opening.retire();
    }
    await Promise.allSettled(
      [...closingShells, ...[...this.contexts.values()].map((ctx) => ctx.close())],
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

  private async readProjectKnowledge(frame: CallFrame) {
    const capability = frame.args?.[2];
    const transfer =
      capability &&
      typeof capability === "object" &&
      "responseTransfer" in capability &&
      capability.responseTransfer === true;
    if (!transfer || !this.options.officialUiRoot) {
      const value = await this.run(frame);
      return transfer ? value : legacyKnowledgePreview(value);
    }

    const ctx = await this.contextFor(frame);
    const identity = ctx.officialSessionIdentity();
    const assertCurrent = () => {
      if (
        ctx.accountRetiring ||
        this.context(ctx.userId) !== ctx ||
        ctx.officialSessionIdentity() !== identity
      )
        throw new Error("The account changed during this request.");
    };
    assertCurrent();
    ctx.setAccessToken(frame.user.accessToken);
    const value = await this.run(frame, { context: ctx, identity });
    assertCurrent();
    const body = Buffer.from(JSON.stringify(value));
    if (body.byteLength <= officialUiReadMaxBytes) return value;

    const compressed = await compressBody(body, { level: 1 });
    assertCurrent();
    const answer: OfficialUiReadResponse = {
      status: 200,
      contentType: "application/json",
      ...(compressed.byteLength < body.byteLength
        ? { body: compressed, bodyEncoding: "gzip" }
        : { body }),
    };
    if (answer.body.byteLength <= officialUiReadMaxBytes) return answer;
    const started = officialResponseTransfers(ctx).start(answer, this.now());
    if (!started)
      throw new CapacityError(
        "Too many official Web responses are being transferred. Try again later.",
      );
    return started;
  }

  /** Runs a relayed call and sends its result. */
  async call(frame: CallFrame) {
    const generation = this.connectionGeneration;
    const resultId = frame.id;
    frame = { ...frame, id: `${generation}:${resultId}` };
    const controller = isAbortableCall(frame) ? new AbortController() : undefined;
    if (controller) {
      if (this.cancelled.delete(frame.id)) return;
      this.abortableCalls.set(frame.id, controller);
      frame = { ...frame, signal: controller.signal };
    }
    let result: RunnerMessage;
    try {
      const value = frame.method === "readProjectKnowledge"
        ? await this.readProjectKnowledge(frame)
        : await this.run(frame);
      result = { t: "result", id: resultId, ok: true };
      if (value !== undefined) result.value = encodeWireValue(value);
      if (Buffer.byteLength(JSON.stringify(result)) > webLimits.linkMessageBytes)
        result = {
          t: "result",
          id: resultId,
          ok: false,
          error: {
            message: "The answer is too large to send.",
            code: webErrorCodes.tooLarge,
          },
        };
    } catch (error) {
      if (controller?.signal.aborted) return;
      result = {
        t: "result",
        id: resultId,
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
    } finally {
      if (controller && this.abortableCalls.get(frame.id) === controller)
        this.abortableCalls.delete(frame.id);
    }
    if (
      controller?.signal.aborted ||
      this.cancelled.delete(frame.id) ||
      generation !== this.connectionGeneration
    ) return;
    this.options.flush?.(frame.user.id);
    this.options.link.send(result);
  }

  cancel(id: string) {
    id = `${this.connectionGeneration}:${id}`;
    const controller = this.abortableCalls.get(id);
    if (controller) {
      controller.abort();
      return;
    }
    this.cancelled.add(id);
    // Forget old ids so the set stays small.
    if (this.cancelled.size > 1000)
      this.cancelled.delete(this.cancelled.values().next().value!);
  }

  abortRelayedCalls() {
    this.connectionGeneration++;
    for (const controller of this.abortableCalls.values()) controller.abort();
    this.abortableCalls.clear();
    for (const ctx of this.contexts.values()) closeOfficialMelangeEdits(ctx);
  }

  isCallCancelled(id: string) {
    return this.cancelled.has(id);
  }

  presence(frame: Extract<GoFrame, { t: "presence" }>) {
    const ctx = this.contexts.get(frame.userId) ?? this.opening.get(frame.userId)?.shellContext;
    if (!ctx) return;
    const gained = frame.focused;
    ctx.tabs = frame.tabs;
    ctx.lastActive = this.now();
    if (frame.detachedTabId) {
      closeOfficialMelangeEdits(ctx, frame.detachedTabId);
      void closeOfficialCodeTerminalsForTab(ctx, frame.detachedTabId);
    } else if (frame.tabs === 0) {
      closeOfficialMelangeEdits(ctx);
      void closeOfficialCodeTerminals(ctx);
    }
    if (gained) ctx.focused();
  }

  async closeBrowserTerminals() {
    await Promise.allSettled([...this.contexts.values()].map(ctx => closeOfficialCodeTerminals(ctx)));
  }

  /** Go signed the user out: no more user-API calls; closes once idle. */
  async signedOut(frame: Extract<GoFrame, { t: "user-signed-out" }>) {
    const opening = this.opening.get(frame.userId);
    const closingShell = opening?.shellContext ? opening.context : undefined;
    opening?.retire();
    const ctx = this.contexts.get(frame.userId);
    if (!ctx) {
      this.options.runtime.wakeCodeArchive?.(frame.userId, undefined);
      await closingShell?.catch(() => {});
      return;
    }
    ctx.signedOut = true;
    ctx.codeAutoArchive?.stop();
    ctx.setAccessToken("");
    closeOfficialMelangeEdits(ctx);
    await closeOfficialCodeTerminals(ctx);
    if (!ctx.busy()) await this.closeContext(ctx);
  }

  /**
   * Finish what runs; `done` runs once nothing is busy. Moving off this
   * runner (Go's drain) takes no new users; a restart (`admitNew`, an
   * update) serves everyone until the last turn ends (owner, 2026-10-03).
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
  shellContextFor(
    ...args: Parameters<typeof dispatcherSessions.shellContextFor>
  ): ReturnType<typeof dispatcherSessions.shellContextFor>;
  isShellContextCurrent(
    ...args: Parameters<typeof dispatcherSessions.isShellContextCurrent>
  ): ReturnType<typeof dispatcherSessions.isShellContextCurrent>;
  accountSettingsFor(
    ...args: Parameters<typeof dispatcherSessions.accountSettingsFor>
  ): ReturnType<typeof dispatcherSessions.accountSettingsFor>;
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
