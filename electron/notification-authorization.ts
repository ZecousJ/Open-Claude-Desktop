import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { shell } from "electron";
import type { NotificationAuthorization } from "../shared/desktop-notifications";

interface NativeAuthorization {
  getAuthorizationStatus(): Promise<NotificationAuthorization>;
  requestAuthorization(): Promise<"granted" | "denied" | "error">;
}

let native: NativeAuthorization | null | undefined;

/**
 * Native macOS permission; other hosts allow banners (live claude.ai
 * bundle, 2026-10-14, index.chunk-BWk6pVUt). The addon is unpacked from
 * the asar archive; without it banners go out as Electron sends them.
 */
function authorization() {
  if (native !== undefined) return native;
  try {
    const file = fileURLToPath(
      new URL("./notification-authorization.node", import.meta.url),
    ).replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
    native = createRequire(import.meta.url)(file) as NativeAuthorization;
  } catch {
    native = null;
  }
  return native;
}

export async function notificationAuthorizationStatus(): Promise<NotificationAuthorization> {
  if (process.platform !== "darwin") return "authorized";
  const addon = authorization();
  if (!addon) return "authorized";
  return addon.getAuthorizationStatus().catch(() => "authorized" as const);
}

export async function requestNotificationAuthorization(): Promise<
  "granted" | "denied" | "error"
> {
  if (process.platform !== "darwin") return "granted";
  const addon = authorization();
  if (!addon) return "granted";
  const result = await addon.requestAuthorization().catch(() => "error" as const);
  if (result !== "error") return result;
  const status = await addon.getAuthorizationStatus().catch(() => undefined);
  return status === "denied" ? "denied" : result;
}

export async function openNotificationSettings() {
  if (process.platform === "darwin")
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    );
  else if (process.platform === "win32")
    await shell.openExternal("ms-settings:notifications");
}
