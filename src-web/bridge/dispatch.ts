import { z } from "zod";
import {
  dispatchApprovalResponse,
  dispatchDeliveryResponseSchema,
  dispatchDeliveryValueSchema,
  type DispatchTask,
  type DispatchDeliveryStatus,
  type OfficialDispatch,
} from "../../shared/dispatch-api";
import { interruptTargetSchema } from "../../shared/interrupt-target";
import type {
  DeviceConversation,
  DeviceAppEvent,
  DeviceInfo,
  DeviceMethod,
} from "../../shared/remote-devices";
import type { WebEnv } from "../../shared/web-client/env";
import { webErrorCodes } from "../../shared/web-protocol";
import type { CoworkDevices } from "./cowork-devices";

const retryDelayMs = 3000;
const maxQueue = 100;
const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const conversationIdSchema = z.string().min(1).max(500);
const textSchema = z
  .string()
  .max(200_000)
  .refine((text) => !!text.trim());
const startSchema = z.object({
  text: textSchema,
  cwd: z.string().min(1).max(4096),
  mode: z.enum(["cowork", "code"]),
});
const followUpSchema = z.object({
  text: textSchema,
  conversationId: conversationIdSchema,
});
const requestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("newSession"), args: z.tuple([startSchema]) }),
  z.object({ method: z.literal("send"), args: z.tuple([followUpSchema]) }),
]);
const label = { id: z.string(), deviceId: deviceIdSchema, title: z.string() };
const attempt = { attemptId: z.string(), request: requestSchema };
const outboxSchema = z.array(
  z.discriminatedUnion("state", [
    z.object({ ...label, ...attempt, state: z.literal("pending") }),
    z.object({
      ...label,
      ...attempt,
      state: z.literal("failed"),
      error: z.string(),
      rejected: z.boolean(),
    }),
    z.object({ ...label, state: z.literal("unknown"), error: z.string() }),
    z.object({
      ...label,
      state: z.literal("delivered"),
      conversationId: z.string().optional(),
    }),
  ]),
);
type Outbox = z.infer<typeof outboxSchema>;
type Queued = Extract<Outbox[number], { state: "pending" }>;

const directorySchema = z.object({
  path: z.string(),
  name: z.string(),
  sessions: z.number(),
  default: z.boolean(),
});
const directoriesSchema = z.array(directorySchema);
const directoryCacheSchema = z.record(z.string(), directoriesSchema);
const environmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({ kind: z.literal("ssh"), hostId: z.string() }),
  z.object({ kind: z.literal("wsl"), distro: z.string() }),
  z.object({ kind: z.literal("space"), spaceId: z.string() }),
]);
const tasksSchema = z.array(
  z
    .object({
      id: z.string(),
      title: z.string(),
      cwd: z.string().optional(),
      environment: environmentSchema.optional(),
      updatedAt: z.number(),
      running: z.boolean(),
      approvals: z.number(),
      model: z.string(),
      mode: z.enum(["code", "cowork"]).optional(),
      failed: z.boolean().optional(),
      readyReview: z.boolean().optional(),
    })
    .passthrough(),
);
const detailsSchema = z.custom<DeviceConversation>(
  (value) =>
    z
      .object({
        conversation: z.object({
          id: z.string(),
          title: z.string(),
          mode: z.enum(["cowork", "code"]),
          createdAt: z.number(),
          updatedAt: z.number(),
          turns: z.array(
            z.object({
              id: z.string(),
              createdAt: z.number(),
              items: z.array(z.unknown()),
            }),
          ),
        }),
        approvals: z.array(
          z.object({
            id: z.union([z.string(), z.number()]),
            conversationId: z.string(),
            method: z.string(),
          }),
        ),
      })
      .safeParse(value).success,
);

const errorInfo = z.object({
  message: z.string(),
  code: z.string().optional(),
  status: z.number().optional(),
});
function retryableDeliveryFailure(info: z.infer<typeof errorInfo> | undefined) {
  return (
    info?.code === "CLAUDEX_DEVICE_OFFLINE" ||
    info?.code === "CLAUDEX_DEVICE_BUSY" ||
    info?.code === "CLAUDEX_DISPATCH_RECEIPT_UNAVAILABLE" ||
    info?.code === webErrorCodes.runnerUnavailable ||
    info?.code === webErrorCodes.timeout ||
    info?.status === 408 ||
    info?.status === 429 ||
    info?.message === "Too many verification attempts. Try again shortly." ||
    (info?.status !== undefined && info.status >= 500)
  );
}

function publicStatus(row: Outbox[number]): DispatchDeliveryStatus {
  const { id, deviceId, title } = row;
  if (row.state === "pending") return { id, deviceId, title, state: "pending" };
  if (row.state === "failed")
    return { id, deviceId, title, state: "failed", error: row.error };
  return row;
}

function pendingByDevice(rows: Outbox) {
  const queues = new Map<string, Queued[]>();
  const blocked = new Set<string>();
  for (const row of rows) {
    if (row.state === "unknown") blocked.add(row.deviceId);
    if (row.state !== "pending" || blocked.has(row.deviceId)) continue;
    const queue = queues.get(row.deviceId) ?? [];
    queue.push(row);
    queues.set(row.deviceId, queue);
  }
  return queues;
}

type DispatchNotice = Extract<
  DeviceAppEvent,
  { type: "dispatch-notification" }
>;

export function createWebDispatch(
  env: Pick<
    WebEnv,
    | "origin"
    | "randomId"
    | "localValue"
    | "setLocalValue"
    | "withLock"
    | "timers"
  >,
  {
    devices,
    account,
    captureActivation,
    notify,
  }: {
    devices: Pick<CoworkDevices, "list" | "rpc">;
    account: () => string | undefined;
    captureActivation: () => () => void;
    notify?: (deviceId: string, event: DispatchNotice) => void;
  },
): OfficialDispatch & { wake(): void; reset(): void; dispose(): void } {
  const storageKey = (owner: string, kind: "outbox" | "directories") =>
    `claudex.dispatch.${kind}.${owner}`;
  let disposed = false;
  let generation = 0;
  let timer: unknown;
  let flushing: object | undefined;
  let lastDevices: DeviceInfo[] = [];
  const seenTasks = new Map<string, Map<string, DispatchTask>>();
  const newTasks = new Map<string, Set<string>>();

  function capture() {
    const assertActivation = captureActivation();
    const owner = account();
    const started = generation;
    if (!owner) throw new Error("Sign in to continue.");
    const current = () => {
      assertActivation();
      if (disposed || generation !== started)
        throw new DOMException("The active account changed.", "AbortError");
    };
    current();
    return { owner, current };
  }
  type Scope = ReturnType<typeof capture>;

  function read(key: string): unknown {
    try {
      return JSON.parse(env.localValue?.(key) ?? "null");
    } catch {
      return null;
    }
  }

  function outbox(owner: string) {
    return outboxSchema.safeParse(read(storageKey(owner, "outbox"))).data ?? [];
  }

  function update<T>(scope: Scope, change: (rows: Outbox) => T): Promise<T> {
    const key = storageKey(scope.owner, "outbox");
    return env.withLock(key, async () => {
      scope.current();
      const rows = outbox(scope.owner);
      const value = change(rows);
      const written = JSON.stringify(rows);
      env.setLocalValue?.(key, written);
      if (env.localValue?.(key) !== written)
        throw new Error(
          "Dispatch needs browser storage to save tasks for delivery.",
        );
      return value;
    });
  }

  function cachedDirectories(owner: string) {
    return (
      directoryCacheSchema.safeParse(read(storageKey(owner, "directories")))
        .data ?? {}
    );
  }

  function rememberDirectories(
    scope: Scope,
    deviceId: string,
    directories?: z.infer<typeof directoriesSchema>,
  ) {
    scope.current();
    const saved = cachedDirectories(scope.owner);
    if (directories) saved[deviceId] = directories;
    else if (Object.hasOwn(saved, deviceId)) delete saved[deviceId];
    else return;
    env.setLocalValue?.(
      storageKey(scope.owner, "directories"),
      JSON.stringify(saved),
    );
  }

  async function rpc(
    scope: Scope,
    deviceId: string,
    method: DeviceMethod,
    args: unknown[],
  ) {
    scope.current();
    deviceIdSchema.parse(deviceId);
    try {
      const value = await devices.rpc(deviceId, method, args);
      scope.current();
      return value;
    } catch (error) {
      scope.current();
      const failure = errorInfo.safeParse(error).data;
      if (
        failure?.status === 401 ||
        failure?.status === 403 ||
        failure?.code === "UNAUTHORIZED" ||
        /access was revoked|Approve this device|verify this device|verification is unavailable/i.test(
          failure?.message ?? "",
        )
      ) {
        rememberDirectories(scope, deviceId);
        seenTasks.delete(deviceId);
        newTasks.delete(deviceId);
      }
      throw error;
    }
  }

  async function notifyChanges(
    scope: Scope,
    deviceId: string,
    tasks: DispatchTask[],
  ) {
    if (!notify) return;
    const previous = seenTasks.get(deviceId);
    const created = newTasks.get(deviceId);
    const latest = new Map<string, DispatchTask>();
    seenTasks.set(deviceId, latest);
    const notices: DispatchNotice[] = [];
    for (const task of tasks) {
      const before = previous?.get(task.id);
      if (before && task.updatedAt < before.updatedAt) {
        latest.set(task.id, before);
        continue;
      }
      latest.set(task.id, task);
      const justCreated = created?.delete(task.id) ?? false;
      const add = (kind: string, body: string) =>
        notices.push({
          type: "dispatch-notification",
          conversationId: task.id,
          title: task.title || "Claudex",
          body,
          tag: `dispatch-${kind}-${deviceId}-${task.id}-${task.updatedAt}-${task.approvals}`,
        });
      if ((before?.running || justCreated) && !task.running)
        add("finished", "Claudex finished a task");
      if ((before || justCreated) && task.approvals > (before?.approvals ?? 0))
        add("approval", "Claudex is waiting for your input");
    }
    if (!created?.size) newTasks.delete(deviceId);
    if (!notices.length) return;
    try {
      const [enabled, trust] = await Promise.all([
        rpc(scope, deviceId, "dispatchPreferences", []),
        rpc(scope, deviceId, "deviceTrustSummary", []),
      ]);
      scope.current();
      if (
        enabled === true &&
        trust &&
        typeof trust === "object" &&
        "requireTrustedDevices" in trust &&
        trust.requireTrustedDevices === true
      ) {
        for (const notice of notices) notify(deviceId, notice);
      }
    } catch {
      // The task list remains available independently of notifications.
    }
  }

  async function directories(deviceId: string, offlineInventory: boolean) {
    const scope = capture();
    try {
      const entries = directoriesSchema.parse(
        await rpc(scope, deviceId, "listDirectories", []),
      );
      rememberDirectories(scope, deviceId, entries);
      return entries;
    } catch (error) {
      scope.current();
      const failure = errorInfo.safeParse(error).data;
      if (retryableDeliveryFailure(failure)) {
        const saved = cachedDirectories(scope.owner)[deviceId];
        if (
          offlineInventory &&
          saved &&
          (failure?.code === "CLAUDEX_DEVICE_OFFLINE" ||
            failure?.code === webErrorCodes.runnerUnavailable)
        )
          return saved;
      } else {
        rememberDirectories(scope, deviceId);
      }
      throw error;
    }
  }

  async function deliveryStatus(
    scope: Scope,
    row: Queued,
  ): Promise<Outbox[number]> {
    const { id, deviceId, title, attemptId, request } = row;
    const label = { id, deviceId, title };
    try {
      const value = await rpc(scope, deviceId, "deliverDispatch", [
        { id: attemptId, ...request },
      ]);
      const response = dispatchDeliveryResponseSchema.safeParse(value);
      if (response.success) {
        if (response.data.status === "rejected")
          return {
            ...row,
            state: "failed",
            error: response.data.message,
            rejected: true,
          };
        if (response.data.status === "unknown")
          return { ...label, state: "unknown", error: response.data.message };
        return {
          ...label,
          state: "delivered",
          conversationId: response.data.value?.conversationId,
        };
      }
      const legacy = dispatchDeliveryValueSchema.safeParse(value);
      if (legacy.success)
        return {
          ...label,
          state: "delivered",
          conversationId: legacy.data?.conversationId,
        };
      return {
        ...label,
        state: "unknown",
        error: "The computer's delivery status couldn’t be determined.",
      };
    } catch (error) {
      scope.current();
      if (retryableDeliveryFailure(errorInfo.safeParse(error).data)) return row;
      const message =
        error instanceof Error
          ? error.message
          : "The computer couldn't do that.";
      return { ...row, state: "failed", error: message, rejected: false };
    }
  }

  async function flush(scope: Scope) {
    await env.withLock(
      `${storageKey(scope.owner, "outbox")}.flush`,
      async () => {
        scope.current();
        const queues = pendingByDevice(outbox(scope.owner));
        if (!queues.size) return;
        const online = new Set(
          (await devices.list())
            .filter((item) => item.online !== false)
            .map((item) => item.id),
        );
        scope.current();
        await Promise.allSettled(
          [...queues].map(async ([deviceId, queue]) => {
            if (!online.has(deviceId)) return;
            for (const row of queue) {
              const next = await deliveryStatus(scope, row);
              if (next.state === "pending") break;
              await update(scope, (current) => {
                const index = current.findIndex((item) => item.id === row.id);
                if (index >= 0) current[index] = next;
              });
              scope.current();
              if (
                notify &&
                next.state === "delivered" &&
                next.conversationId &&
                row.request.method === "newSession" &&
                !seenTasks.get(deviceId)?.has(next.conversationId)
              ) {
                const ids = newTasks.get(deviceId) ?? new Set<string>();
                ids.add(next.conversationId);
                newTasks.set(deviceId, ids);
              }
              if (next.state === "unknown") break;
            }
          }),
        );
      },
    );
  }

  function wake() {
    env.timers.clearTimeout(timer);
    timer = undefined;
    const owner = account();
    if (disposed || flushing || !owner || !pendingByDevice(outbox(owner)).size)
      return;
    const scope = capture();
    const token = {};
    flushing = token;
    void flush(scope)
      .catch(() => {})
      .finally(() => {
        if (flushing !== token) return;
        flushing = undefined;
        const active = account();
        if (!disposed && active && pendingByDevice(outbox(active)).size)
          timer = env.timers.setTimeout(wake, retryDelayMs);
      });
  }

  async function enqueue(deviceId: string, request: Queued["request"]) {
    const scope = capture();
    const id = env.randomId();
    const row: Queued = {
      id,
      attemptId: id,
      deviceId: deviceIdSchema.parse(deviceId),
      title: request.args[0].text.trim().slice(0, 120),
      state: "pending",
      request,
    };
    await update(scope, (rows) => {
      if (rows.filter((item) => item.state !== "delivered").length >= maxQueue)
        throw new Error(
          "Too many Dispatch tasks. Clear finished or failed tasks and try again.",
        );
      const delivered = rows.filter((item) => item.state === "delivered");
      for (const item of delivered.slice(0, Math.max(delivered.length - 19, 0)))
        rows.splice(
          rows.findIndex((entry) => entry.id === item.id),
          1,
        );
      rows.push(row);
    });
    scope.current();
    wake();
    return publicStatus(row);
  }

  return {
    async status(retry) {
      const appLink = new URL("/downloads", env.origin).href;
      if (!account())
        return {
          appLink,
          signedIn: false,
          paired: false,
          devices: [],
          onlineDeviceIds: [],
          pending: [],
          deliveries: [],
        };
      const scope = capture();
      let machinesFailed = false;
      let inventory: DeviceInfo[];
      try {
        inventory = await devices.list();
        scope.current();
        lastDevices = inventory;
      } catch {
        scope.current();
        machinesFailed = true;
        inventory = lastDevices.map((device) => ({ ...device, online: false }));
      }
      scope.current();
      const paired = cachedDirectories(scope.owner);
      const pairedDeviceIds = inventory
        .map((item) => item.id)
        .filter((id) => Object.hasOwn(paired, id));
      const deliveries = outbox(scope.owner).map(publicStatus);
      if (retry) wake();
      return {
        appLink,
        signedIn: true,
        machinesFailed,
        paired: pairedDeviceIds.length > 0,
        pairedDeviceIds,
        devices: inventory,
        onlineDeviceIds: inventory
          .filter((item) => item.online !== false)
          .map((item) => item.id),
        deliveries,
        pending: deliveries.filter((item) => item.state === "pending"),
      };
    },
    async tasks(deviceId) {
      const scope = capture();
      const tasks = tasksSchema.parse(
        await rpc(scope, deviceId, "listDispatchTasks", []),
      );
      void notifyChanges(scope, deviceId, tasks);
      return tasks;
    },
    directories: (deviceId) => directories(deviceId, true),
    async deliver({ deviceId, ...input }) {
      return enqueue(deviceId, {
        method: "newSession",
        args: [startSchema.parse(input)],
      });
    },
    async details({ deviceId, conversationId }) {
      return detailsSchema.parse(
        await rpc(capture(), deviceId, "openConversation", [
          conversationIdSchema.parse(conversationId),
          "dispatch",
        ]),
      );
    },
    async followUp({ deviceId, ...input }) {
      return enqueue(deviceId, {
        method: "send",
        args: [followUpSchema.parse(input)],
      });
    },
    async approve({ deviceId, conversationId, approvalId, decision }) {
      const scope = capture();
      const details = detailsSchema.parse(
        await rpc(scope, deviceId, "openConversation", [
          conversationIdSchema.parse(conversationId),
          "dispatch",
        ]),
      );
      const selected = details.approvals.find(
        (item) =>
          item.id === approvalId && item.conversationId === conversationId,
      );
      if (!selected) throw new Error("This request was already answered.");
      await rpc(scope, deviceId, "approve", [
        selected.id,
        dispatchApprovalResponse(selected, decision),
        conversationId,
      ]);
    },
    async interrupt({ deviceId, conversationId, expected }) {
      const result = await rpc(capture(), deviceId, "interrupt", [
        conversationIdSchema.parse(conversationId),
        expected ? interruptTargetSchema.parse(expected) : null,
        "dispatch",
      ]);
      if (
        result &&
        typeof result === "object" &&
        "status" in result &&
        result.status === "mismatch"
      )
        throw new Error(
          "The task's running turn changed. Refresh to see its current status.",
        );
    },
    async trust(deviceId) {
      await directories(deviceId, false);
    },
    async retry(id) {
      const scope = capture();
      const next = await update(scope, (rows) => {
        const index = rows.findIndex((item) => item.id === id);
        const row = rows[index];
        if (!row || row.state !== "failed") return row;
        const { error, rejected, ...previous } = row;
        const next: Queued = {
          ...previous,
          attemptId: rejected ? env.randomId() : previous.attemptId,
          state: "pending",
        };
        rows.splice(index, 1);
        rows.push(next);
        return next;
      });
      scope.current();
      wake();
      return next && publicStatus(next);
    },
    async remove(id) {
      const scope = capture();
      await update(scope, (rows) => {
        const index = rows.findIndex((item) => item.id === id);
        if (rows[index]?.state === "pending")
          throw new Error("This task is still awaiting delivery.");
        if (index >= 0) rows.splice(index, 1);
      });
      scope.current();
      wake();
    },
    wake,
    reset() {
      generation++;
      flushing = undefined;
      lastDevices = [];
      seenTasks.clear();
      newTasks.clear();
      wake();
    },
    dispose() {
      disposed = true;
      env.timers.clearTimeout(timer);
    },
  };
}
