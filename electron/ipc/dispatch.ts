import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  readDeliveries,
  writeDeliveries,
} from "../remote-control/dispatch-delivery";
import {
  deviceMethods,
  devicePaths,
  type DeviceInfo,
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
  sessions: z
    .object({
      active: z.number().int().nonnegative(),
      max: z.number().int().positive(),
    })
    .optional(),
});

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
  let flushing = false;
  const readCache = (): {
    devices: DeviceInfo[];
    directories: Record<string, unknown[]>;
  } => {
    try {
      const cached = JSON.parse(
        fs.readFileSync(
          path.join(ctx.store.root, "dispatch-devices.json"),
          "utf8",
        ),
      );
      return {
        devices: z.array(deviceInfo).parse(cached.devices),
        directories: cached.directories ?? {},
      };
    } catch {
      return { devices: [], directories: {} };
    }
  };
  const writeCache = (cached: ReturnType<typeof readCache>) => {
    if (!ctx.store?.root) return;
    const file = path.join(ctx.store.root, "dispatch-devices.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(cached), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  const relay = async (route: string, body?: unknown) => {
    const remote = ctx.remote;
    if (!remote?.ready) throw new Error("Sign in to continue.");
    return remote.session.authorized(async (token) => {
      const response = await fetch(new URL(route, remote.accounts.baseUrl), {
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
      if (!response.ok || answer.ok === false)
        throw Object.assign(
          new Error(answer.error?.message ?? "Couldn’t connect. Try again."),
          { code: answer.error?.code, status: response.status },
        );
      return answer.value ?? answer.data ?? answer;
    });
  };
  handle("dispatchStatus", async (rawRetry?: unknown) => {
    if (z.boolean().optional().parse(rawRetry))
      ctx.services.dispatch?.retry?.();
    const sessions = ctx.remote?.ready
      ? await ctx.remote.session
          .authorized((token) =>
            ctx.remote!.backend.client.nativeSessions(token),
          )
          .catch(() => undefined)
      : undefined;
    let machinesFailed = false;
    const raw = ctx.remote?.ready
      ? await relay(devicePaths.list).catch(() => {
          machinesFailed = true;
          return [];
        })
      : [];
    const online = z
      .array(deviceInfo)
      .parse(Array.isArray(raw) ? raw : (raw.devices ?? []));
    const cached = readCache();
    const devices = [
      ...online,
      ...cached.devices.filter(
        (item) => !online.some((current) => current.id === item.id),
      ),
    ];
    writeCache({ ...cached, devices });
    return {
      signedIn: Boolean(ctx.remote?.ready),
      machinesFailed,
      appLink: ctx.remote?.accounts.baseUrl
        ? new URL("/downloads", ctx.remote.accounts.baseUrl).href
        : "",
      paired: Boolean(sessions?.items.length),
      ...(ctx.services.dispatch
        ? { local: ctx.services.dispatch.status() }
        : {}),
      devices,
      onlineDeviceIds: online.map((item) => item.id),
      pending: ctx.store?.root
        ? readDeliveries(ctx.store.root).map((item) => ({
            id: item.id,
            deviceId: item.deviceId,
            title: (item.args[0] as { text: string }).text,
          }))
        : [],
    };
  });
  const call = async (rawId: unknown, rawMethod: unknown, rawArgs: unknown) => {
    const owner = { root: ctx.store?.root, remote: ctx.remote, generation };
    const current = () =>
      active &&
      generation === owner.generation &&
      ctx.store?.root === owner.root &&
      ctx.remote === owner.remote;
    const assertCurrent = () => {
      if (!current()) throw Error("The signed-in account changed. Try again.");
    };
    assertCurrent();
    const id = deviceId.parse(rawId);
    const method = methodInput.parse(rawMethod);
    const args = z.array(z.unknown()).max(10).parse(rawArgs);
    if (
      method === "newSession" &&
      args[0] &&
      typeof args[0] === "object" &&
      "attachmentIds" in args[0]
    ) {
      const input = args[0] as Record<string, unknown>;
      const ids = z
        .array(z.string().max(500))
        .max(12)
        .parse(input.attachmentIds);
      let total = 0;
      const attachments = ids.map((id) => {
        const file = ctx.selectedAttachments.get(id);
        if (!file) throw new Error("This file can't be attached.");
        const size = fs.statSync(file.path).size;
        total += size;
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
      assertCurrent();
      return result;
    }
    const signedCall = () =>
      deviceTrust.call(
        async (action, values) => {
          assertCurrent();
          const value = await relay(devicePaths.rpc(id, action), {
            args: values,
          });
          assertCurrent();
          return value;
        },
        id,
        method,
        args,
      );
    if (method === "listDirectories") {
      const cached = readCache();
      try {
        const directories = await signedCall();
        assertCurrent();
        if (Array.isArray(directories))
          writeCache({
            ...cached,
            directories: { ...cached.directories, [id]: directories },
          });
        return directories;
      } catch (error) {
        assertCurrent();
        const failure = error as { code?: unknown; status?: unknown };
        // Retain an already authorized offline inventory, but never turn a
        // trust/auth denial into a successful read of the old host's cache.
        if (
          failure.code === "CLAUDEX_DEVICE_OFFLINE" &&
          Array.isArray(cached.directories[id])
        )
          return cached.directories[id];
        throw error;
      }
    }
    return signedCall();
  };
  const flush = async () => {
    if (!active) return;
    if (flushing) {
      timer = setTimeout(() => void flush(), 3000);
      timer.unref();
      return;
    }
    flushing = true;
    const root = ctx.store.root;
    const current = generation;
    try {
      for (const delivery of readDeliveries(root)) {
        if (current !== generation) break;
        try {
          await call(delivery.deviceId, "deliverDispatch", [delivery]);
          writeDeliveries(
            root,
            readDeliveries(root).filter((item) => item.id !== delivery.id),
          );
        } catch {}
      }
    } finally {
      flushing = false;
      if (current === generation && readDeliveries(root).length)
        timer = setTimeout(() => void flush(), 3000);
      timer?.unref();
    }
  };
  handle(
    "dispatchEnqueue",
    async (rawId: unknown, rawMethod: unknown, rawInput: unknown) => {
      const id = deviceId.parse(rawId);
      const method = z.enum(["newSession", "send"]).parse(rawMethod);
      const input = z
        .object({
          text: z.string().trim().min(1).max(200_000),
          cwd: z.string().max(4096).optional(),
          conversationId: z.string().max(128).optional(),
          mode: z.enum(["code", "cowork"]).optional(),
        })
        .parse(rawInput);
      const deliveries = readDeliveries(ctx.store.root);
      if (deliveries.length >= 100)
        throw new Error("Too many requests. Try again later.");
      writeDeliveries(ctx.store.root, [
        ...deliveries,
        { id: randomUUID(), deviceId: id, method, args: [input] },
      ]);
      clearTimeout(timer);
      void flush();
    },
  );
  ctx.onAccountActivated?.(() => {
    generation++;
    active = true;
    void flush();
  });
  ctx.onAccountDeactivating?.(() => {
    generation++;
    active = false;
    clearTimeout(timer);
  });
  handle("dispatchCall", call);
  handle("dispatchTasks", (rawId?: unknown) => {
    const id = rawId ?? ctx.services.dispatch?.status().id;
    return id ? call(id, "listDispatchTasks", []) : [];
  });
}
