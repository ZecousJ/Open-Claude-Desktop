import type { AppEvent } from "./types";
import {
  webLimits,
  isWebMethodName,
  object,
  string,
  integer,
  boolean,
  oneOf,
  parseJson,
  parseError,
  isWebTabId,
  openTargets,
  isOpenableUrl,
} from "./web-protocol";
import { fail } from "./web-wire";
import type { Json, WebRpcError, LinkUser } from "./web-protocol";

export interface LinkCapacity {
  /** Engines this runner may run at once. */
  engines: number;
  /** User contexts it may hold. */
  users: number;
}

/** claudex-runner → Go. */
export type RunnerFrame =
  | {
      t: "hello";
      v: number;
      /** Runner build version. */
      version: string;
      /** The remote-runner methods it registered (webRemoteRunnerMethods). */
      methods: string[];
      capacity: LinkCapacity;
      labels?: Record<string, string>;
    }
  /** Answer to a `call`. */
  | {
      t: "result";
      id: string;
      ok: boolean;
      value?: unknown;
      error?: WebRpcError;
    }
  /**
   * An AppEvent for all of the user's tabs; Go assigns the seq. Like
   * open-url, Go drops it unless the user is currently routed to this runner.
   */
  | { t: "event"; userId: number; event: AppEvent }
  /** A page to open in the user's tabs (see ServerFrame open-url). */
  | {
      t: "open-url";
      userId: number;
      url: string;
      target: "same-tab" | "new-tab";
      tabId?: string;
    }
  /**
   * A service request of the runner (webstore reads and writes, the user's
   * web key…). `op` is dotted, e.g. "store.turns.put"; see webRunnerOps.
   * store.* and key.* ops must carry userId (isUserOp), and Go answers them
   * only for users it currently routes to this runner.
   */
  | { t: "request"; id: string; op: string; userId?: number; body?: unknown }
  | {
      t: "load";
      engines: number;
      users: number;
      /** Resident memory of the runner and its sandboxes, MiB. */
      rssMb: number;
    }
  | { t: "ping" }
  | { t: "pong" };

/** Go → claudex-runner. */
export type GoFrame =
  | {
      t: "welcome";
      v: number;
      runnerId: string;
      heartbeatMs: number;
    }
  /** Run one remote-runner bridge method for a user. */
  | {
      t: "call";
      id: string;
      user: LinkUser;
      method: string;
      /** Wire-encoded arguments (as in WebRpcRequest). */
      args: unknown[];
      /** Milliseconds Go waits before answering CLAUDEX_WEB_TIMEOUT. */
      deadlineMs: number;
    }
  /** The caller went away; the runner may stop the call. */
  | { t: "cancel"; id: string }
  /** Answer to a `request`. */
  | {
      t: "response";
      id: string;
      ok: boolean;
      value?: unknown;
      error?: WebRpcError;
    }
  /** The user's tabs: count and whether one is focused. */
  | { t: "presence"; userId: number; tabs: number; focused: boolean }
  /**
   * The user signed out everywhere (revoke-all, password change) or was
   * removed from the allow-list: drop the context and its credentials.
   * Running turns are not stopped (web plan Q7).
   */
  | {
      t: "user-signed-out";
      userId: number;
      reason: "revoked" | "session-expired" | "password-changed" | "removed";
    }
  /** Finish current calls, accept no new users (deploys). */
  | { t: "drain" }
  | { t: "ping" }
  | { t: "pong" };

/**
 * Service requests of v1. W-STORE and W-KEY own their semantics; the ids
 * here are the names both sides agree on. Unknown ops are answered with
 * CLAUDEX_WEB_METHOD_UNAVAILABLE.
 */
export const webRunnerOps = [
  "store.settings.get",
  "store.settings.put",
  "store.projects.list",
  "store.projects.put",
  "store.projects.delete",
  "store.conversations.list",
  "store.conversations.get",
  "store.conversations.put",
  "store.conversations.delete",
  "store.turns.list",
  "store.turns.put",
  "store.turns.delete",
  "store.artifacts.list",
  "store.artifacts.put",
  "store.artifacts.delete",
  "store.files.get",
  "store.files.put",
  "store.files.delete",
  "store.search",
  "key.get",
  "location.get",
  "github.clone",
  "github.push",
  "github.api",
  "github.hook",
  "routine.token",
  "routine.api-token",
  "device.list",
  "device.call",
] as const;

export type WebRunnerOp = (typeof webRunnerOps)[number];

const opPattern = /^[a-z]+(?:\.[a-z][a-z-]*)+$/;

const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;

const signedOutReasons = [
  "revoked",
  "session-expired",
  "password-changed",
  "removed",
] as const;

/**
 * Ops that read or write one user's data (every op of v1). Go serves them
 * only for a user it has routed to this runner, so they must name the user.
 */
export function isUserOp(op: string) {
  return (
    op.startsWith("store.") ||
    op.startsWith("key.") ||
    op.startsWith("location.") ||
    op.startsWith("routine.") ||
    op.startsWith("device.")
  );
}

function frameId(value: unknown) {
  const id = string(value, "id");
  if (!idPattern.test(id)) fail("id has the wrong shape");
  return id;
}

function userId(value: unknown, what = "userId") {
  return integer(value, what, 1);
}

function outcome(json: Json) {
  const ok = boolean(json.ok, "ok");
  if (ok) {
    if (json.error !== undefined) fail("an ok answer has no error");
    return json.value === undefined ? { ok } : { ok, value: json.value };
  }
  return { ok, error: parseError(json.error) };
}

function methodList(value: unknown) {
  if (!Array.isArray(value)) fail("methods must be an array");
  if (value.length > webLimits.runnerMethods) fail("too many methods");
  const seen = new Set<string>();
  for (const name of value) {
    if (!isWebMethodName(name)) fail(`bad method name ${JSON.stringify(name)}`);
    if (seen.has(name)) fail(`method ${name} is listed twice`);
    seen.add(name);
  }
  return value as string[];
}

function labels(value: unknown) {
  const json = object(value, "labels");
  for (const [key, item] of Object.entries(json)) string(item, `labels.${key}`);
  return json as Record<string, string>;
}

export function parseRunnerFrame(text: string | Json): RunnerFrame {
  const json = parseJson(text);
  switch (json.t) {
    case "hello": {
      const capacity = object(json.capacity, "capacity");
      const frame: RunnerFrame = {
        t: "hello",
        v: integer(json.v, "v", 1),
        version: string(json.version, "version"),
        methods: methodList(json.methods),
        capacity: {
          engines: integer(capacity.engines, "capacity.engines"),
          users: integer(capacity.users, "capacity.users"),
        },
      };
      if (json.labels !== undefined) frame.labels = labels(json.labels);
      return frame;
    }
    case "result":
      return { t: "result", id: frameId(json.id), ...outcome(json) };
    case "event": {
      const event = object(json.event, "event");
      string(event.type, "event.type");
      return {
        t: "event",
        userId: userId(json.userId),
        event: event as unknown as AppEvent,
      };
    }
    case "open-url": {
      const url = string(json.url, "url");
      if (!isOpenableUrl(url)) fail("url must be https or same-origin");
      const frame: RunnerFrame = {
        t: "open-url",
        userId: userId(json.userId),
        url,
        target: oneOf(json.target, openTargets, "target"),
      };
      if (json.tabId !== undefined) {
        if (!isWebTabId(json.tabId)) fail("tabId has the wrong shape");
        frame.tabId = json.tabId;
      }
      return frame;
    }
    case "request": {
      const op = string(json.op, "op");
      if (!opPattern.test(op)) fail("op has the wrong shape");
      const frame: RunnerFrame = { t: "request", id: frameId(json.id), op };
      if (json.userId !== undefined) frame.userId = userId(json.userId);
      else if (isUserOp(op)) fail(`request ${op} needs userId`);
      if (json.body !== undefined) frame.body = json.body;
      return frame;
    }
    case "load":
      return {
        t: "load",
        engines: integer(json.engines, "engines"),
        users: integer(json.users, "users"),
        rssMb: integer(json.rssMb, "rssMb"),
      };
    case "ping":
    case "pong":
      return { t: json.t };
    default:
      fail(`unknown runner frame ${JSON.stringify(json.t)}`);
  }
}

export function parseGoFrame(text: string | Json): GoFrame {
  const json = parseJson(text);
  switch (json.t) {
    case "welcome":
      return {
        t: "welcome",
        v: integer(json.v, "v", 1),
        runnerId: string(json.runnerId, "runnerId"),
        heartbeatMs: integer(json.heartbeatMs, "heartbeatMs", 1000),
      };
    case "call": {
      const user = object(json.user, "user");
      const method = string(json.method, "method");
      if (!isWebMethodName(method)) fail("method has the wrong shape");
      if (!Array.isArray(json.args)) fail("args must be an array");
      const linkUser: LinkUser = {
        id: userId(user.id, "user.id"),
        accessToken: string(user.accessToken, "user.accessToken"),
      };
      if (user.tabId !== undefined) {
        if (!isWebTabId(user.tabId)) fail("user.tabId has the wrong shape");
        linkUser.tabId = user.tabId;
      }
      return {
        t: "call",
        id: frameId(json.id),
        user: linkUser,
        method,
        args: json.args,
        deadlineMs: integer(json.deadlineMs, "deadlineMs", 1),
      };
    }
    case "cancel":
      return { t: "cancel", id: frameId(json.id) };
    case "response":
      return { t: "response", id: frameId(json.id), ...outcome(json) };
    case "presence":
      return {
        t: "presence",
        userId: userId(json.userId),
        tabs: integer(json.tabs, "tabs"),
        focused: boolean(json.focused, "focused"),
      };
    case "user-signed-out":
      return {
        t: "user-signed-out",
        userId: userId(json.userId),
        reason: oneOf(json.reason, signedOutReasons, "reason"),
      };
    case "drain":
    case "ping":
    case "pong":
      return { t: json.t };
    default:
      fail(`unknown Go frame ${JSON.stringify(json.t)}`);
  }
}
