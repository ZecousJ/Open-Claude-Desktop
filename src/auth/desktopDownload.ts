/**
 * "Download desktop app" under the web sign-in card: only when the
 * administrator published an installer for this computer in the release
 * settings (`GET /api/v1/claudex/release?platform=&arch=`, the same answer
 * /desktop-only uses). Phones and tablets get none.
 */

export type DesktopPlatform = "darwin" | "win32" | "linux";

interface NavigatorLike {
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean; platform?: string };
}

/** The desktop platform of this browser's computer, if it is one. */
export function desktopPlatform(
  nav: NavigatorLike,
): DesktopPlatform | undefined {
  const ua = nav.userAgent ?? "";
  if (nav.userAgentData?.mobile) return undefined;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return undefined;
  const hint = (nav.userAgentData?.platform ?? "").toLowerCase();
  if (hint === "macos") return "darwin";
  if (hint === "windows") return "win32";
  if (hint === "linux") return "linux";
  if (/Macintosh|Mac OS X/.test(ua))
    // iPadOS says it is a Mac; a touch screen gives it away.
    return (nav.maxTouchPoints ?? 0) > 1 ? undefined : "darwin";
  if (/Windows/.test(ua)) return "win32";
  if (/Linux|X11/.test(ua)) return "linux";
  return undefined;
}

/** The https installer link in a release answer (Sub2API envelope or bare). */
export function downloadUrlOf(body: unknown): string | undefined {
  const outer = (body ?? {}) as Record<string, unknown>;
  const data = (
    typeof outer.code === "number" && "data" in outer ? outer.data : outer
  ) as Record<string, unknown> | null;
  const url =
    typeof data?.download_url === "string" ? data.download_url.trim() : "";
  return /^https:\/\/[^\s]+$/i.test(url) && url.length <= 2000
    ? url
    : undefined;
}

/** Asks the service for this computer's installer; undefined when there is none. */
export async function findDesktopDownload(
  nav: NavigatorLike = navigator,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  const platform = desktopPlatform(nav);
  if (!platform) return undefined;
  try {
    const response = await fetchImpl(
      `/api/v1/claudex/release?platform=${platform}`,
      { credentials: "omit", headers: { Accept: "application/json" } },
    );
    if (!response.ok) return undefined;
    return downloadUrlOf(await response.json());
  } catch {
    return undefined;
  }
}
