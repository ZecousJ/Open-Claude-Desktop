import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { NotificationAuthorization } from "../shared/desktop-notifications";

interface NativeAuthorization {
  getAuthorizationStatus(): Promise<NotificationAuthorization>;
  requestAuthorization(): Promise<"granted" | "denied" | "error">;
}

let native: NativeAuthorization | null | undefined;

/**
 * Native macOS permission; other hosts allow banners. The addon is unpacked
 * from the asar archive; without it banners go out as Electron sends them.
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
  return addon.requestAuthorization().catch(() => "error" as const);
}
