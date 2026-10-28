/**
 * GET /api/v1/claudex/apps (backend internal/claudex/release/apps.go): the
 * latest desktop installers and the phone apps. Anything that is not an
 * https address is dropped.
 */
export interface AppDownloads {
  desktop?: { version: string; downloads: Record<string, string> };
  android?: { version: string; url: string };
  ios?: { version: string; url: string };
}

const httpsUrl = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 2000 &&
  /^https:\/\/[^\s]+$/i.test(value)
    ? value
    : undefined;

const text = (value: unknown) => (typeof value === "string" ? value : "");

function phoneApp(value: unknown) {
  const app = (value ?? {}) as Record<string, unknown>;
  const url = httpsUrl(app.url);
  return url ? { version: text(app.version), url } : undefined;
}

/** The answer, in the Sub2API envelope or bare; null when it is not one. */
export function parseApps(body: unknown): AppDownloads | null {
  if (!body || typeof body !== "object") return null;
  const outer = body as Record<string, unknown>;
  const data = (
    typeof outer.code === "number" && "data" in outer ? outer.data : outer
  ) as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  const apps: AppDownloads = {};
  const desktop = data.desktop as Record<string, unknown> | null | undefined;
  if (desktop && typeof desktop === "object") {
    const downloads: Record<string, string> = {};
    const listed = (desktop.downloads ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(listed)) {
      const url = httpsUrl(value);
      if (url && /^[a-z0-9]+-[a-z0-9]+$/.test(key)) downloads[key] = url;
    }
    apps.desktop = { version: text(desktop.version), downloads };
  }
  apps.android = phoneApp(data.android);
  apps.ios = phoneApp(data.ios);
  return apps;
}
