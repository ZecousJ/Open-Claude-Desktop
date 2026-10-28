/**
 * Mobile simulators in Code (shared/simulators-api.ts): the pane's calls
 * (devices, boot, shut down, screen, input, Claude's access) and, for the
 * signed-in account, the engine extension that offers Claude the device
 * tools (electron/simulators/tools.ts).
 *
 * The Electron parts (dialog, browser, image scaling) load on first use, so
 * this file works without Electron: tests pass a stand-in platform, and
 * claudex-runner (no devices on the web, these calls are "absent") only
 * registers the names.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PreviewStream } from "../artifacts/preview-stream";
import {
  requestPreviewFramePort,
  sendPreviewFrame,
} from "../artifacts/preview-frame-port";
import {
  androidButtons,
  iosButtons,
  keyNames,
  simulatorKinds,
  simulatorEditActions,
  simulatorTextLimit,
  type SimulatorKind,
} from "../../shared/simulators";
import type { AppContext, IpcHandle } from "../app/app-context";
import { storeAttachment } from "../engine/composer-files";
import type { SimulatorMedia } from "../simulators/media";
import {
  createSimulatorMedia,
  createSimulatorService,
  openSimulatorTarget,
  type SimulatorPlatform,
} from "../simulators/platform";
import type { SimulatorService } from "../simulators/service";
import { simulatorExtension, simulatorExtensionId } from "../simulators/tools";
import { SimulatorBuilds } from "../simulators/builds";
import { AppLogs } from "../simulators/app-logs";
import { systemRunner } from "../simulators/runner";
import os from "node:os";

const kind = z.enum(simulatorKinds as [SimulatorKind, ...SimulatorKind[]]);
const deviceId = z.string().min(1).max(200);
const fraction = z.number().min(0).max(1);
const inputSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("rotate") }).strict(),
  z
    .object({ type: z.literal("edit"), action: z.enum(simulatorEditActions) })
    .strict(),
  z
    .object({
      type: z.literal("tap"),
      x: fraction,
      y: fraction,
      duration: z.number().min(0).max(30).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("swipe"),
      x: fraction,
      y: fraction,
      x2: fraction,
      y2: fraction,
      duration: z.number().min(0).max(30).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      value: z.string().max(simulatorTextLimit),
    })
    .strict(),
  z.object({ type: z.literal("key"), name: z.enum(keyNames) }).strict(),
  z
    .object({
      type: z.literal("button"),
      name: z.enum([...iosButtons, ...androidButtons] as [string, ...string[]]),
    })
    .strict(),
]);
/** A saved capture's full path (only files this app saved are acted on). */
const capturePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), "Not a full path.");
const target = z.enum([
  "xcode",
  "app-store",
  "android-studio",
  "download-android-studio",
]);

/** Where the devices the person allowed are kept (the account's profile folder). */
const grantsFile = "simulator-access.json";

function readGrants(file: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed)
      ? parsed
          .filter((key): key is string => typeof key === "string")
          .slice(0, 500)
      : [];
  } catch {
    return [];
  }
}

const electronPlatform = async (ctx: AppContext) =>
  (await import("../simulators/electron-platform")).electronPlatform(ctx);

export function registerSimulatorHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  loadPlatform: (
    ctx: AppContext,
  ) => Promise<SimulatorPlatform> = electronPlatform,
) {
  /** The account's service, built on first use and dropped at sign-out. */
  let current:
    | {
        platform: SimulatorPlatform;
        service: SimulatorService;
        media: SimulatorMedia;
      }
    | undefined;
  // Claude's headless builds and app log captures (this account's).
  let builds: SimulatorBuilds | undefined;
  let appLogs: AppLogs | undefined;
  let building: Promise<NonNullable<typeof current>> | undefined;
  const settings = (): Record<string, unknown> => {
    try {
      return ctx.store.settings as unknown as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const open = () =>
    (building ??= (async () => {
      const platform = await loadPlatform(ctx);
      const file = path.join(ctx.store.root, grantsFile);
      const service = createSimulatorService(platform, {
        onLaunch: (kind, deviceId, appId) => {
          if (kind === "ios")
            void appLogs?.start(deviceId, appId).catch(() => undefined);
        },
        switches: () => ({
          ios: settings().iosSimulatorAccess !== false,
          android: settings().androidEmulatorAccess !== false,
        }),
        loadGrants: () => readGrants(file),
        saveGrants: (keys) => {
          try {
            fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
          } catch (error) {
            console.error(
              "Simulator access:",
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      });
      const media = createSimulatorMedia(platform, service);
      platform.onQuit?.(() => media.dispose());
      return (current = { platform, service, media });
    })());
  const service = async () => (await open()).service;
  const media = async () => (await open()).media;
  const streams = new Map<
    string,
    PreviewStream<Awaited<ReturnType<SimulatorService["screen"]>>>
  >();
  ctx.onAccountDeactivating?.(() => {
    for (const stream of streams.values()) stream.dispose();
    streams.clear();
  });
  handle(
    "simulatorSetSubscribed",
    async (
      rawKind: unknown,
      rawId: unknown,
      rawOn: unknown,
      rawFps: unknown,
    ) => {
      const name = kind.parse(rawKind);
      const id = deviceId.parse(rawId);
      const on = z.boolean().parse(rawOn);
      const fps = z.number().finite().min(1).max(30).default(4).parse(rawFps);
      const window = ctx.callerWindow();
      if (!window) return;
      const key = `${window.id}:${name}:${id}`;
      let stream = streams.get(key);
      if (!on) {
        stream?.dispose();
        streams.delete(key);
        return;
      }
      if (!stream) {
        const close = () => {
          streams.get(key)?.dispose();
          streams.delete(key);
        };
        stream = new PreviewStream(
          async () => (await service()).screen(name, id),
          (frame) => {
            if (!window.isDestroyed())
              sendPreviewFrame(ctx, window, {
                type: "simulator-frame",
                kind: name,
                id,
                frame,
              });
          },
          () => {
            window.removeListener("closed", close);
            window.webContents.removeListener("did-start-loading", close);
            window.webContents.removeListener("render-process-gone", close);
          },
        );
        streams.set(key, stream);
        window.once("closed", close);
        window.webContents.once("did-start-loading", close);
        window.webContents.once("render-process-gone", close);
      }
      stream.setFps(fps);
      stream.setSubscribed(true);
      await requestPreviewFramePort(ctx, window);
    },
  );

  handle("simulatorsState", async () => (await service()).state());
  handle("simulatorSetup", async (raw: unknown) =>
    (await service()).setup(kind.parse(raw)),
  );
  handle("simulatorDevices", async (raw: unknown) =>
    (await service()).devices(kind.parse(raw)),
  );
  handle("simulatorBoot", async (rawKind: unknown, rawId: unknown) =>
    (await service()).boot(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle("simulatorShutdown", async (rawKind: unknown, rawId: unknown) =>
    (await service()).shutdown(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle("simulatorInspect", async (rawKind: unknown, rawId: unknown) =>
    (await service()).inspect(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle("simulatorRestart", async (rawKind: unknown, rawId: unknown) =>
    (await service()).restart(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle(
    "simulatorRename",
    async (rawKind: unknown, rawId: unknown, rawName: unknown) =>
      (await service()).rename(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z.string().max(400).parse(rawName),
      ),
  );
  handle("simulatorScreen", async (rawKind: unknown, rawId: unknown) =>
    (await service()).screen(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle(
    "simulatorInput",
    async (rawKind: unknown, rawId: unknown, rawInput: unknown) =>
      (await service()).input(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        inputSchema.parse(rawInput) as Parameters<SimulatorService["input"]>[2],
      ),
  );
  handle("simulatorAccess", async (rawKind: unknown, rawId: unknown) =>
    (await service()).hasAccess(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle(
    "simulatorAllow",
    async (rawKind: unknown, rawId: unknown, rawAllow: unknown) =>
      (await service()).allow(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z.boolean().parse(rawAllow),
      ),
  );
  handle("simulatorOpen", async (raw: unknown) => {
    const { platform } = await open();
    return openSimulatorTarget(platform, target.parse(raw));
  });

  // The control bar, the Device and Edit menus and Show logs.
  handle("simulatorSaveScreenshot", async (rawKind: unknown, rawId: unknown) =>
    (await media()).saveScreenshot(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle(
    "simulatorCaptureScreenshot",
    async (rawKind: unknown, rawId: unknown) =>
      (await media()).captureScreenshot(
        kind.parse(rawKind),
        deviceId.parse(rawId),
      ),
  );
  handle("simulatorStartRecording", async (rawKind: unknown, rawId: unknown) =>
    (await media()).startRecording(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle("simulatorStopRecording", async (rawKind: unknown, rawId: unknown) =>
    (await media()).stopRecording(kind.parse(rawKind), deviceId.parse(rawId)),
  );
  handle(
    "simulatorCaptureAction",
    async (rawPath: unknown, rawAction: unknown) =>
      (await media()).captureAction(
        capturePath.parse(rawPath),
        z.enum(["reveal", "delete"]).parse(rawAction),
      ),
  );
  handle("simulatorAttachCapture", async (rawPath: unknown) => {
    const file = capturePath.parse(rawPath);
    const saved = await (await media()).savedCapture(file);
    if (saved.kind !== "screenshot")
      throw new Error("Only screenshots can be attached.");
    const attachment = storeAttachment(
      path.join(ctx.store.root, "attachments"),
      path.basename(file),
      await fs.promises.readFile(file),
      ctx.policy(),
    );
    ctx.selectedAttachments.set(attachment.id, attachment);
    return attachment;
  });
  handle(
    "simulatorAppearance",
    async (rawKind: unknown, rawId: unknown, rawSet: unknown) =>
      (await media()).appearance(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z
          .enum(["light", "dark"])
          .optional()
          .parse(rawSet ?? undefined),
      ),
  );
  handle(
    "simulatorHinge",
    async (rawKind: unknown, rawId: unknown, rawDegrees: unknown) =>
      (await media()).hinge(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z
          .number()
          .min(0)
          .max(180)
          .optional()
          .parse(rawDegrees ?? undefined),
      ),
  );
  handle(
    "simulatorSlowAnimations",
    async (rawKind: unknown, rawId: unknown, rawOn: unknown) =>
      (await media()).slowAnimations(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z
          .boolean()
          .optional()
          .parse(rawOn ?? undefined),
      ),
  );
  handle(
    "simulatorSoftwareKeyboard",
    async (rawKind: unknown, rawId: unknown, rawShow: unknown) =>
      (await media()).softwareKeyboard(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z
          .boolean()
          .optional()
          .parse(rawShow ?? undefined),
      ),
  );
  handle(
    "simulatorClipboard",
    async (rawKind: unknown, rawId: unknown, rawDirection: unknown) =>
      (await media()).clipboard(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z.enum(["get", "send"]).parse(rawDirection),
      ),
  );
  handle(
    "simulatorLogs",
    async (rawKind: unknown, rawId: unknown, rawSince: unknown) =>
      (await media()).readLogs(
        kind.parse(rawKind),
        deviceId.parse(rawId),
        z.number().int().min(0).parse(rawSince),
      ),
  );
  handle("simulatorLogsStop", async (rawKind: unknown, rawId: unknown) =>
    (await media()).stopLogs(kind.parse(rawKind), deviceId.parse(rawId)),
  );

  // Claude's device tools: only in the real app (the runner has no devices).
  if (loadPlatform !== electronPlatform || !process.versions.electron) return;
  let remove: (() => void) | undefined;
  ctx.onAccountActivated(() => {
    void (async () => {
      remove?.();
      remove = undefined;
      current?.media.dispose();
      builds?.dispose();
      builds = new SimulatorBuilds({
        runner: systemRunner,
        root: () => os.tmpdir(),
      });
      appLogs?.dispose();
      appLogs = new AppLogs({ runner: systemRunner });
      building = undefined;
      current = undefined;
      try {
        const ready = await service();
        const extension = simulatorExtension({
          service: () => current?.service,
          builds: () => builds,
          appLogs: () => appLogs,
          ask: (conversationId, params) =>
            ctx.engine.requestAppApproval(conversationId, params),
          unattended: (id) => ctx.scheduler?.isUnattended(id) ?? false,
        });
        if (!ctx.engine.extensions.has(simulatorExtensionId))
          remove = ctx.engine.extensions.add(extension);
        // The tools are offered only once a check found the setup complete.
        const state = ready.state();
        for (const name of simulatorKinds)
          if (state[name].supported && state[name].enabled)
            void ready.setup(name).catch(() => undefined);
      } catch (error) {
        console.error(
          "Simulator tools:",
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  });
  ctx.onAccountDeactivating(() => {
    remove?.();
    remove = undefined;
    builds?.dispose();
    builds = undefined;
    appLogs?.dispose();
    appLogs = undefined;
    current?.media.dispose();
    building = undefined;
    current = undefined;
  });
}
