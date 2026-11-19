import { z } from "zod";
import {
  appFamily,
  browserFamily,
  osFamily,
  parseSessionId,
} from "./active-sessions";
import type { ActiveSession } from "./settings-api";

export const officialActiveSessionsPath = "/api/auth/sessions/list-active";
export const officialEndActiveSessionPath = "/api/auth/logout/session";

export const officialEndActiveSessionBody = z.object({
  session_uuid: z.string().refine((value) => parseSessionId(value) !== null),
});

/** Match the actual official structured user-agent contract, without inventing OS/version data. */
function userAgentOf(session: ActiveSession) {
  const platform: Record<string, string> = {
    win32: "Windows",
    darwin: "Mac OS X",
    linux: "Linux",
  };
  return {
    browser_family:
      session.kind === "desktop"
        ? "Claudex Desktop"
        : (browserFamily(session.userAgent) ?? appFamily(session.userAgent)),
    os_family:
      session.kind === "desktop"
        ? (platform[session.platform] ?? null)
        : osFamily(session.userAgent),
  };
}
const sessionSchema = z.object({
  id: z
    .string()
    .max(64)
    .refine((value) => !!parseSessionId(value)),
  kind: z.enum(["desktop", "web", "app"]),
  deviceName: z.string().max(4096),
  platform: z.string().max(128),
  userAgent: z.string().max(16384),
  current: z.boolean(),
  createdAt: z.number().finite().min(0).max(8640000000000000).nullable(),
  updatedAt: z.number().finite().min(0).max(8640000000000000).nullable(),
  location: z
    .object({
      city: z.string().max(1024),
      region: z.string().max(1024),
      country: z.string().max(1024),
    })
    .nullable()
    .optional(),
});
export function sessionPage(query: URLSearchParams) {
  for (const key of query.keys())
    if (
      !["page", "per_page", "application_slug"].includes(key) ||
      query.getAll(key).length !== 1
    )
      throw Error("Unsupported active-session query.");
  const number = (key: string, fallback: number, max: number) => {
    const value = query.get(key);
    if (value === null) return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || Number(value) > max)
      throw Error("Invalid active-session pagination.");
    return Number(value);
  };
  if (
    query.has("application_slug") &&
    query.get("application_slug") !== "claude-ai"
  )
    throw Error("Unsupported session application.");
  return {
    page: number("page", 1, 10000),
    perPage: number("per_page", 20, 100),
  };
}

function sessionRow(session: ActiveSession) {
  const iso = (ms: number | null) =>
    ms !== null ? new Date(ms).toISOString() : null;
  return {
    session_uuid: session.id,
    user_agent: userAgentOf(session),
    is_current: session.current,
    created_at: iso(session.createdAt),
    updated_at: iso(session.updatedAt ?? session.createdAt),
    location_info: session.location ?? null,
    ...(session.deviceName ? { device_name: session.deviceName } : {}),
  };
}

export function officialActiveSessionsPage(
  source: unknown,
  { page, perPage }: ReturnType<typeof sessionPage>,
) {
  const parsed = z.array(sessionSchema).max(10000).safeParse(source);
  if (!parsed.success) return null;
  const sessions = parsed.data;
  const start = (page - 1) * perPage;
  return {
    data: sessions.slice(start, start + perPage).map(sessionRow),
    pagination: {
      page,
      per_page: perPage,
      total: sessions.length,
      has_more: start + perPage < sessions.length,
    },
  };
}
