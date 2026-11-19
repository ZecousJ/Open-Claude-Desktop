import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readDeliveries,
  writeDeliveries,
  dispatchReceiptUnavailable,
  DispatchReceiptUnavailable,
  type DispatchDelivery,
} from "../remote-control/dispatch-delivery";
import {
  dispatchApprovalResponse,
  dispatchDeliveryResponseSchema,
  dispatchDeliveryValueSchema,
  type DispatchDeliveryStatus,
} from "../../shared/dispatch-api";
import { interruptTargetSchema } from "../../shared/interrupt-target";
import {
  deviceMethods,
  devicePaths,
  type DeviceConversation,
} from "../../shared/remote-devices";
import type { AppContext, IpcHandle } from "../app/app-context";
import { DesktopDeviceTrustClient } from "../remote-control/device-trust-client";

const deviceId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const methodInput = z.enum(deviceMethods);
const deviceInfo = z.object({
  id: deviceId,
  name: z.string(),
  platform: z.string(),
  version: z.string(),
  connectedAt: z.string(),
  online: z.boolean().optional(),
  computerAccess: z.boolean().optional(),
  lastSeenAt: z.string().optional(),
  addedAt: z.string().optional(),
  sessions: z
    .object({
      active: z.number().int().nonnegative(),
      max: z.number().int().positive(),
    })
    .optional(),
});
const deviceCache = z.object({
  devices: z.array(deviceInfo),
  directories: z.record(z.string(), z.array(z.unknown())).default({}),
});
const targetInput = z.object({
  deviceId,
  conversationId: z.string().min(1).max(500),
});
const textInput = z
  .string()
  .max(200_000)
  .refine((value) => !!value.trim());
const newInput = z.object({
  deviceId,
  text: textInput,
  cwd: z.string().min(1).max(4096),
  mode: z.enum(["code", "cowork"]),
});
const followUpInput = targetInput.extend({ text: textInput });
const approvalInput = targetInput.extend({
  approvalId: z.union([z.string(), z.number()]),
  decision: z.union([
    z.object({ choice: z.enum(["once", "always", "deny"]) }).strict(),
    z
      .object({
        answers: z.record(
          z.string(),
          z.object({ answers: z.array(z.string()) }).strict(),
        ),
      })
      .strict(),
    z
      .object({
        action: z.enum(["accept", "decline", "cancel"]),
        content: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  ]),
});
const stopInput = targetInput.extend({
  expected: interruptTargetSchema.optional(),
});

function label(delivery: DispatchDelivery) {
  return {
    id: delivery.id,
    deviceId: delivery.deviceId,
    title: delivery.args[0].text,
  };
}

function deviceHeads(deliveries: DispatchDelivery[]) {
  const heads = new Map<string, DispatchDelivery>();
  for (const delivery of deliveries)
    if (delivery.failure?.state !== "failed" && !heads.has(delivery.deviceId))
      heads.set(delivery.deviceId, delivery);
  return heads;
}

function statusOf(delivery: DispatchDelivery): DispatchDeliveryStatus {
  return delivery.failure
    ? {
        ...label(delivery),
        state: delivery.failure.state,
        error: delivery.failure.message,
      }
    : { ...label(delivery), state: "pending" };
}

function definiteRelayRefusal(error: Error) {
  const code = "code" in error ? error.code : undefined;
  const status = "status" in error ? error.status : undefined;
  return (
    code !== "CLAUDEX_DEVICE_OFFLINE" &&
    code !== dispatchReceiptUnavailable &&
    error.message !== "Too many verification attempts. Try again shortly." &&
    (status === 200 ||
      (typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429) ||
      error.message.startsWith("Approve this device in Settings") ||
      error.message === "This device’s access was revoked.")
  );
}

/** Reuses the authenticated device relay on desktop and the web runner. */
export function registerDispatchHandlers(handle: IpcHandle, ctx: AppContext) {
  const deviceTrust = new DesktopDeviceTrustClient(
    () => ctx.store.root,
    () =>
      ctx.remote?.ready
        ? `${new URL(ctx.remote.accounts.baseUrl).origin}:${ctx.remote.session.userId}`
        : undefined,
    () => "Claudex desktop",
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let active = true;
  const flushing = new Map<
    string,
    { owner: ReturnType<typeof capture>; promise: Promise<void> }
  >();
  const pairs = new Set<string>();
  const completed = new Map<string, DispatchDeliveryStatus>();
  const enabled = () => active && ctx.accountRetiring !== true;
  const capture = () => {
    const store = ctx.store;
    const host = ctx.remote;
    const session = host?.session;
    const account = ctx.activeAccount?.id;
    const identity = ctx.accountActivationIdentity;
    const capturedGeneration = generation;
    const current = () =>
      generation === capturedGeneration &&
      ctx.store === store &&
      ctx.remote === host &&
      ctx.remote?.session === session &&
      ctx.activeAccount?.id === account &&
      ctx.accountActivationIdentity === identity;
    const check = () => {
      if (!current()) throw Error("The signed-in account changed. Try again.");
    };
    const checkActive = () => {
      check();
      if (!active || ctx.accountRetiring === true)
        throw Error("Sign in to continue.");
    };
    return { root: store?.root, host, session, current, check, checkActive };
  };
  const readCache = (root: string | undefined): z.infer<typeof deviceCache> => {
    if (root) {
      try {
        return deviceCache.parse(
          JSON.parse(
            fs.readFileSync(path.join(root, "dispatch-devices.json"), "utf8"),
          ),
        );
      } catch {}
    }
    return { devices: [], directories: {} };
  };
  const writeCache = (
    root: string | undefined,
    cached: z.infer<typeof deviceCache>,
  ) => {
    if (!root) return;
    const file = path.join(root, "dispatch-devices.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(cached), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const relay = async (
    owner: ReturnType<typeof capture>,
    route: string,
    body?: unknown,
  ) => {
    owner.checkActive();
    if (!owner.host?.ready || !owner.session)
      throw new Error("Sign in to continue.");
    const base = owner.host.accounts.baseUrl;
    return owner.session.authorized(async (token) => {
      owner.checkActive();
      const response = await fetch(new URL(route, base), {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-Claudex-Web": "1",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000),
      });
      const answer = await response.json();
      owner.checkActive();
      if (!response.ok || answer.ok === false)
        throw Object.assign(
          new Error(answer.error?.message ?? "Couldn’t connect. Try again."),
          { code: answer.error?.code, status: response.status },
        );
      return Object.hasOwn(answer, "value")
        ? answer.value
        : (answer.data ?? answer);
    });
  };
  handle("dispatchStatus", async (rawRetry?: unknown) => {
    const owner = capture();
    const ready = enabled() && !!owner.host?.ready;
    if (z.boolean().optional().parse(rawRetry) && enabled()) {
      ctx.services.dispatch?.retry?.();
      void flushInBackground();
    }
    const host = ready ? owner.host : undefined;
    const [sessions, inventory] = await Promise.all([
      host &&
        owner.session
          ?.authorized((token) => {
            owner.checkActive();
            return host.backend.client.nativeSessions(token);
          })
          .catch(() => undefined),
      ready
        ? relay(owner, `${devicePaths.list}?includeOffline=1`).then(
            (raw) => ({ failed: false, raw }),
            () => ({ failed: true, raw: [] }),
          )
        : { failed: false, raw: [] },
    ]);
    owner.check();
    const listed = z
      .array(deviceInfo)
      .parse(
        Array.isArray(inventory.raw)
          ? inventory.raw
          : (inventory.raw.devices ?? []),
      );
    const online = listed.filter((device) => device.online !== false);
    const cached = ready ? readCache(owner.root) : readCache(undefined);
    const devices = [
      ...listed,
      ...cached.devices
        .filter((item) => !listed.some((entry) => entry.id === item.id))
        .map((item) => ({ ...item, online: false })),
    ];
    if (ready) writeCache(owner.root, { ...cached, devices });
    const deliveries =
      enabled() && owner.root ? readDeliveries(owner.root) : [];
    return {
      signedIn: ready,
      machinesFailed: inventory.failed,
      appLink: new URL(
        "/downloads",
        host?.accounts.baseUrl ?? "https://claudex.zecous.cn",
      ).href,
      paired: Boolean(sessions?.items.length || pairs.size),
      pairedDeviceIds: ready ? [...pairs] : [],
      ...(ctx.services.dispatch
        ? { local: ctx.services.dispatch.status() }
        : {}),
      devices,
      onlineDeviceIds: online.map((item) => item.id),
      pending: deliveries.filter((item) => !item.failure).map(label),
      deliveries: [...deliveries.map(statusOf), ...completed.values()],
    };
  });

  const call = async (
    rawId: unknown,
    rawMethod: unknown,
    rawArgs: unknown,
    owner = capture(),
  ) => {
    owner.checkActive();
    const id = deviceId.parse(rawId);
    const method = methodInput.parse(rawMethod);
    const args = z.array(z.unknown()).max(10).parse(rawArgs);
    if (
      method === "newSession" &&
      args[0] &&
      typeof args[0] === "object" &&
      "attachmentIds" in args[0]
    ) {
      const input = args[0];
      const ids = z
        .array(z.string().max(500))
        .max(12)
        .parse(input.attachmentIds);
      let total = 0;
      const attachments = ids.map((id) => {
        const file = ctx.selectedAttachments.get(id);
        if (!file) throw new Error("This file can't be attached.");
        total += fs.statSync(file.path).size;
        if (total > 64 * 1024 * 1024)
          throw new Error("This file can't be attached.");
        return {
          name: file.name,
          data: fs.readFileSync(file.path).toString("base64"),
        };
      });
      const { attachmentIds: _, ...rest } = input;
      args[0] = { ...rest, attachments };
    }
    if (ctx.services.dispatch?.status().id === id) {
      const result = await ctx.services.dispatch.call(method, args);
      owner.checkActive();
      return result;
    }
    try {
      const value = await deviceTrust.call(
        (action, values) =>
          relay(owner, devicePaths.rpc(id, action), { args: values }),
        id,
        method,
        args,
      );
      owner.checkActive();
      pairs.add(id);
      if (method === "listDirectories" && Array.isArray(value)) {
        const cached = readCache(owner.root);
        writeCache(owner.root, {
          ...cached,
          directories: { ...cached.directories, [id]: value },
        });
      }
      return value;
    } catch (error) {
      owner.checkActive();
      if (error instanceof Error && definiteRelayRefusal(error))
        pairs.delete(id);
      if (
        method === "listDirectories" &&
        error instanceof Error &&
        "code" in error &&
        error.code === "CLAUDEX_DEVICE_OFFLINE"
      ) {
        const cached = readCache(owner.root).directories[id];
        if (cached) return cached;
      }
      throw error;
    }
  };

  const change = (
    root: string,
    id: string,
    update: (item: DispatchDelivery) => DispatchDelivery | undefined,
  ) => {
    const queue = readDeliveries(root);
    const index = queue.findIndex((item) => item.id === id);
    if (index < 0) return;
    const entry = update(queue[index]);
    queue.splice(index, 1, ...(entry ? [entry] : []));
    writeDeliveries(root, queue);
  };
  const settleDevice = async (
    owner: ReturnType<typeof capture>,
    root: string,
    id: string,
  ) => {
    while (owner.current() && enabled()) {
      const delivery = deviceHeads(readDeliveries(root)).get(id);
      if (!delivery || delivery.failure) return;
      let raw: unknown;
      try {
        const { id, attemptId, method, args } = delivery;
        raw = await call(
          delivery.deviceId,
          "deliverDispatch",
          [{ id: attemptId ?? id, method, args }],
          owner,
        );
      } catch (error) {
        if (!owner.current() || !enabled()) return;
        if (
          error instanceof DispatchReceiptUnavailable ||
          !(error instanceof Error) ||
          !definiteRelayRefusal(error)
        )
          return;
        change(root, delivery.id, (item) => ({
          ...item,
          failure: { state: "failed", message: error.message },
        }));
        continue;
      }
      const parsed = dispatchDeliveryResponseSchema.safeParse(raw);
      const legacy = dispatchDeliveryValueSchema.safeParse(raw);
      const response = parsed.success
        ? parsed.data
        : legacy.success
          ? { status: "accepted" as const, value: legacy.data }
          : undefined;
      if (!response) {
        change(root, delivery.id, (item) => ({
          ...item,
          failure: {
            state: "unknown",
            message:
              "The computer returned an invalid delivery acknowledgement.",
          },
        }));
        continue;
      }
      switch (response.status) {
        case "accepted":
          change(root, delivery.id, () => undefined);
          completed.set(delivery.id, {
            ...label(delivery),
            state: "delivered",
            ...(response.value
              ? { conversationId: response.value.conversationId }
              : {}),
          });
          if (completed.size > 100) {
            const oldest = completed.keys().next().value;
            if (oldest !== undefined) completed.delete(oldest);
          }
          break;
        case "rejected":
        case "unknown":
          change(root, delivery.id, (item) => ({
            ...item,
            failure: {
              state: response.status === "rejected" ? "failed" : "unknown",
              message: response.message,
              ...(response.status === "rejected" ? { rejected: true } : {}),
            },
          }));
      }
    }
  };
  const flushDevice = (
    owner: ReturnType<typeof capture>,
    root: string,
    id: string,
  ) => {
    const running = flushing.get(id);
    if (running?.owner.current()) return running.promise;
    const promise = settleDevice(owner, root, id).finally(() => {
      if (flushing.get(id)?.owner !== owner) return;
      flushing.delete(id);
      if (
        owner.current() &&
        enabled() &&
        [...deviceHeads(readDeliveries(root)).values()].some(
          (item) => !item.failure,
        ) &&
        !timer
      ) {
        timer = setTimeout(() => {
          timer = undefined;
          void flushInBackground();
        }, 3000);
        timer.unref();
      }
    });
    flushing.set(id, { owner, promise });
    return promise;
  };
  async function flushInBackground() {
    const owner = capture();
    const root = owner.root;
    if (!enabled() || !root) return;
    try {
      const heads = [...deviceHeads(readDeliveries(root)).values()];
      await Promise.all(
        heads
          .filter((item) => !item.failure)
          .map((item) => flushDevice(owner, root, item.deviceId)),
      );
    } catch (error) {
      console.warn("Dispatch delivery:", error);
    }
  }

  const enqueue = (
    id: string,
    method: DispatchDelivery["method"],
    input: DispatchDelivery["args"][0],
  ) => {
    const owner = capture();
    owner.checkActive();
    if (!owner.root) throw Error("Sign in to continue.");
    const deliveries = readDeliveries(owner.root);
    if (deliveries.length >= 100)
      throw new Error("Too many requests. Try again later.");
    const delivery: DispatchDelivery = {
      id: randomUUID(),
      deviceId: id,
      method,
      args: [input],
    };
    writeDeliveries(owner.root, [...deliveries, delivery]);
    return { root: owner.root, owner, delivery };
  };
  const runDelivery = async ({
    root,
    owner,
    delivery,
  }: ReturnType<typeof enqueue>) => {
    await flushDevice(owner, root, delivery.deviceId);
    owner.checkActive();
    const after = readDeliveries(root).find((item) => item.id === delivery.id);
    return after
      ? statusOf(after)
      : (completed.get(delivery.id) ?? statusOf(delivery));
  };
  handle(
    "dispatchEnqueue",
    async (rawId: unknown, rawMethod: unknown, rawInput: unknown) => {
      const id = deviceId.parse(rawId);
      const method = z.enum(["newSession", "send"]).parse(rawMethod);
      const input = z
        .object({
          text: textInput,
          cwd: z.string().max(4096).optional(),
          conversationId: z.string().max(500).optional(),
          mode: z.enum(["code", "cowork"]).optional(),
        })
        .parse(rawInput);
      enqueue(id, method, input);
      void flushInBackground();
    },
  );
  handle("dispatchDeliver", (raw: unknown) => {
    const { deviceId, ...input } = newInput.parse(raw);
    return runDelivery(enqueue(deviceId, "newSession", input));
  });
  handle("dispatchFollowUp", (raw: unknown) => {
    const { deviceId, ...input } = followUpInput.parse(raw);
    return runDelivery(enqueue(deviceId, "send", input));
  });
  handle("dispatchRetry", async (raw: unknown) => {
    const id = z.uuid().parse(raw);
    const owner = capture();
    owner.checkActive();
    const root = owner.root;
    if (!root) return;
    const found = readDeliveries(root).find((item) => item.id === id);
    if (!found || found.failure?.state === "unknown")
      return found ? statusOf(found) : completed.get(id);
    let delivery = found;
    if (found.failure) {
      const { failure, ...rest } = found;
      delivery = {
        ...rest,
        ...(failure.rejected ? { attemptId: randomUUID() } : {}),
      };
      change(root, id, () => delivery);
    }
    return runDelivery({ root, owner, delivery });
  });
  handle("dispatchRemove", (raw: unknown) => {
    const id = z.uuid().parse(raw);
    const owner = capture();
    owner.checkActive();
    if (owner.root)
      change(owner.root, id, (item) => (item.failure ? undefined : item));
    completed.delete(id);
    void flushInBackground();
  });
  handle("dispatchDirectories", (rawId: unknown) =>
    call(rawId, "listDirectories", []),
  );
  handle("dispatchDetails", (raw: unknown) => {
    const { deviceId, conversationId } = targetInput.parse(raw);
    return call(deviceId, "openConversation", [conversationId, "dispatch"]);
  });
  handle("dispatchApprove", async (raw: unknown) => {
    const { deviceId, conversationId, approvalId, decision } =
      approvalInput.parse(raw);
    const owner = capture();
    const detail = (await call(
      deviceId,
      "openConversation",
      [conversationId, "dispatch"],
      owner,
    )) as DeviceConversation;
    const approval = detail.approvals.find(
      (item) =>
        item.id === approvalId && item.conversationId === conversationId,
    );
    if (!approval) throw Error("This request was already answered.");
    await call(
      deviceId,
      "approve",
      [
        approvalId,
        dispatchApprovalResponse(approval, decision),
        conversationId,
      ],
      owner,
    );
  });
  handle("dispatchInterrupt", async (raw: unknown) => {
    const { deviceId, conversationId, expected } = stopInput.parse(raw);
    const outcome = await call(deviceId, "interrupt", [
      conversationId,
      expected ?? null,
      "dispatch",
    ]);
    if (
      expected &&
      (!outcome ||
        typeof outcome !== "object" ||
        !("status" in outcome) ||
        (outcome.status !== "accepted" &&
          outcome.status !== "already_finished"))
    )
      throw Error(
        "The running turn changed. Refresh the task before stopping it.",
      );
  });
  handle("dispatchTrust", async (rawId: unknown) => {
    await call(rawId, "listDispatchTasks", []);
  });
  ctx.onAccountActivated?.(() => {
    generation++;
    active = true;
    pairs.clear();
    completed.clear();
    void flushInBackground();
  });
  ctx.onAccountDeactivating?.(() => {
    generation++;
    active = false;
    pairs.clear();
    completed.clear();
    clearTimeout(timer);
    timer = undefined;
  });
  handle(
    "dispatchCall",
    (rawId: unknown, rawMethod: unknown, rawArgs: unknown) =>
      call(rawId, rawMethod, rawArgs),
  );
  handle("dispatchTasks", (rawId?: unknown) => {
    const id = rawId ?? ctx.services.dispatch?.status().id;
    return id ? call(id, "listDispatchTasks", []) : [];
  });
}
