/**
 * Settings → Account → Active sessions: the account's signed-in sessions,
 * merged from the service's three lists (the desktop app's devices, the web
 * app's browser sessions and the phone apps' sign-ins), and how a row names its
 * device.
 *
 * The reference design lists every session of the account with its user agent,
 * location, creation and last update; a row's device reads "<browser> (<OS>)",
 * "Claude Desktop" standing in for Electron, and "Unknown device" when neither
 * is known. Claudex's desktop rows know the computer's name and platform
 * instead of a user agent.
 */
import type {
  ClaudexDeviceList,
  ClaudexWebSessionList,
} from "./claudex-contract";
import type { ActiveSession } from "./settings-api";

/** The desktop app's name in a session row (the original's "Claude Desktop"). */
export const desktopAppName = "Claudex Desktop";

/** Location parts. */
export function sessionLocation(
  session: Pick<ActiveSession, "location">,
): string | null {
  if (!session.location) return null;
  const parts = [
    session.location.city,
    session.location.region,
    session.location.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The operating system families the original's labels use (ua-parser names). */
const platformFamilies: Record<string, string> = {
  darwin: "Mac OS X",
  win32: "Windows",
  linux: "Linux",
};

/** A browser's family from its user agent; null when it is not recognised. */
export function browserFamily(userAgent: string): string | null {
  if (/\bElectron\//.test(userAgent)) return desktopAppName;
  if (/\bEdg(e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/\b(OPR|Opera)\//.test(userAgent)) return "Opera";
  if (/\b(Firefox|FxiOS)\//.test(userAgent)) return "Firefox";
  if (/\b(Chrome|CriOS|Chromium)\//.test(userAgent)) return "Chrome";
  if (/\bVersion\/[\d.]+.*\bSafari\//.test(userAgent)) return "Safari";
  return null;
}

/**
 * A phone app's name from its user agent, as ua-parser reads an app's own
 * "<Name>/<version>" token: the iOS app sends the system's
 * "Claudex/<build> CFNetwork/… Darwin/…", the Android app
 * "Claudex-Android/<version>". Null for anything else.
 */
export function appFamily(userAgent: string): string | null {
  if (/^Claudex(-(Android|iOS))?\/[\w.]+/.test(userAgent)) return "Claudex";
  const app = /^([A-Za-z][\w .-]{0,40}?)\/[\w.]+ CFNetwork\//.exec(userAgent);
  return app ? app[1] : null;
}

/** An operating system's family from a user agent; null when unknown. */
export function osFamily(userAgent: string): string | null {
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) return "iOS";
  if (/^Claudex-iOS\//.test(userAgent)) return "iOS";
  // URLSession's own user agent: an iOS app (the desktop's are its devices).
  if (/\bCFNetwork\/[\d.]+ Darwin\//.test(userAgent)) return "iOS";
  if (/\bAndroid\b/.test(userAgent)) return "Android";
  if (/^(Claudex-Android|okhttp|Dalvik)\//.test(userAgent)) return "Android";
  if (/\bCrOS\b/.test(userAgent)) return "Chrome OS";
  if (/\bWindows\b/.test(userAgent)) return "Windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(userAgent)) return "Mac OS X";
  if (/\bLinux\b|\bX11\b/.test(userAgent)) return "Linux";
  return null;
}

/**
 * How a row names its device: "<app> (<OS>)", either part alone when the
 * other is unknown, null when nothing is (the row then says "Unknown
 * device"). A desktop row's app is the computer's name, or "Claudex
 * Desktop" when it has none.
 */
export function sessionDeviceLabel(session: ActiveSession): string | null {
  const app =
    session.kind === "desktop"
      ? session.deviceName || desktopAppName
      : session.kind === "app"
        ? (appFamily(session.userAgent) ?? browserFamily(session.userAgent))
        : browserFamily(session.userAgent);
  const os =
    session.kind === "desktop"
      ? (platformFamilies[session.platform] ?? null)
      : osFamily(session.userAgent);
  return app && os ? `${app} (${os})` : app || os || null;
}

/**
 * The account's signed-in sessions: every desktop device still signed in
 * every active browser session (`web` is null when the web app is off) and
 * every phone app sign-in (`apps` is null on a service that does not list
 * them), most recently used first.
 */
export function activeSessionsFrom(
  devices: ClaudexDeviceList,
  web: ClaudexWebSessionList | null,
  apps: ClaudexWebSessionList | null = null,
): ActiveSession[] {
  const sessions: ActiveSession[] = [
    ...devices.items
      .filter((device) => !device.revoked)
      .map((device): ActiveSession => ({
        id: `device:${device.id}`,
        kind: "desktop",
        deviceName: device.deviceName,
        platform: device.platform,
        userAgent: "",
        current: device.current,
        createdAt: device.signedInAt,
        updatedAt: device.lastSeenAt ?? device.signedInAt,
        location: device.location ?? null,
      })),
    ...(web?.items ?? []).map((session): ActiveSession => ({
      id: `web:${session.id}`,
      kind: "web",
      deviceName: "",
      platform: "",
      userAgent: session.userAgent,
      current: session.current,
      createdAt: session.createdAt,
      updatedAt: session.lastSeenAt ?? session.createdAt,
      location: session.location ?? null,
    })),
    ...(apps?.items ?? []).map((session): ActiveSession => ({
      id: `app:${session.id}`,
      kind: "app",
      deviceName: "",
      platform: "",
      userAgent: session.userAgent,
      current: session.current,
      createdAt: session.createdAt,
      updatedAt: session.lastSeenAt ?? session.createdAt,
      location: session.location ?? null,
    })),
  ];
  return sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** A session id's parts ("device:51", "web:12", "app:3"); null for anything else. */
export function parseSessionId(
  id: string,
): { kind: ActiveSession["kind"]; id: number } | null {
  const match = /^(device|web|app):([1-9]\d{0,15})$/.exec(id);
  if (!match) return null;
  const n = Number(match[2]);
  if (!Number.isSafeInteger(n)) return null;
  const kind = match[1] === "device" ? "desktop" : (match[1] as "web" | "app");
  return { kind, id: n };
}
