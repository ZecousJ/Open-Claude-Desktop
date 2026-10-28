/**
 * Claudex's own updates. The updater lives in
 * electron/updates/.
 */
import type { AppContext, IpcHandle } from "../app/app-context";
import type { AppUpdateStatus } from "../../shared/app-update-api";
import { z } from "zod";
import os from "node:os";
import {
  appUpdater,
  appUpdateEndpoints,
  relaunchToUpdate,
} from "../updates/launch";

const relaunchOptions = z
  .object({ interrupt: z.boolean().optional() })
  .strict();

function idle(ctx: AppContext): AppUpdateStatus {
  return { phase: "idle", supported: false, currentVersion: ctx.appVersion };
}

export function registerAppUpdateHandlers(handle: IpcHandle, ctx: AppContext) {
  handle("appUpdateStatus", () => appUpdater()?.status() ?? idle(ctx));
  handle("appEnvironment", () => ({
    updateEndpoints: appUpdateEndpoints(),
    version: ctx.appVersion,
    platform: process.platform,
    osVersion:
      typeof process.getSystemVersion === "function"
        ? process.getSystemVersion()
        : os.release(),
    arch: process.arch,
    home: os.homedir(),
  }));
  handle("checkForAppUpdate", async () => {
    const updater = appUpdater();
    if (!updater) return idle(ctx);
    return (await updater.check({ manual: true })).status;
  });
  handle("relaunchToUpdate", (options: unknown) =>
    relaunchToUpdate(relaunchOptions.parse(options ?? {})),
  );
}
