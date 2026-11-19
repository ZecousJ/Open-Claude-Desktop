import { z } from "zod";
import { announcementAction, type OfficialAnnouncements } from "./announcements-api";

const root = "/api/claudex/service-announcements";
const readPath = /^\/(pending\/)?([1-9]\d*)\/read$/;
const actionBody = z.object({ action: announcementAction });
export const officialAnnouncementBodyLimit = 1024;

export function isOfficialAnnouncementPath(path: string) {
  return path === root || path.startsWith(`${root}/`);
}

export async function serveOfficialAnnouncement(
  request: { method: string; url: URL; body(): Promise<unknown> },
  api: OfficialAnnouncements | undefined,
  current: () => boolean,
): Promise<{ body: unknown; status: number; allow?: string }> {
  const failed = (status: number, error: string, allow?: string) => ({ body: { error }, status, allow });
  const path = request.url.pathname.slice(root.length);
  const listing = path === "" || path === "/pending";
  const match = listing ? null : readPath.exec(path);
  if (!listing && !match) return failed(404, "Announcement route not found.");
  const method = listing ? "GET" : "POST";
  if (request.method !== method) return failed(405, "Unsupported request.", method);
  if (request.url.search) return failed(400, "Unsupported announcement query.");
  if (!api) return failed(404, "Service announcements are unavailable.");
  if (!current()) return failed(409, "The active account changed.");
  try {
    if (listing) {
      const body = await (path ? api.pending() : api.notices());
      return current() ? { body, status: 200 } : failed(409, "The active account changed.");
    }
    if (!match) return failed(404, "Announcement route not found.");
    const [, pending, id] = match;
    const number = Number(id);
    if (!Number.isSafeInteger(number)) return failed(400, "Invalid announcement ID.");
    if (pending) {
      const action = actionBody.safeParse(await request.body());
      if (!action.success) return failed(400, "Invalid announcement action.");
      if (!current()) return failed(409, "The active account changed.");
      await api.close(number, action.data.action);
    } else {
      await api.markRead(id);
    }
    return current() ? { body: { read: true }, status: 200 } : failed(409, "The active account changed.");
  } catch (error) {
    if (!current()) return failed(409, "The active account changed.");
    if (error instanceof Error && "status" in error && (error.status === 400 || error.status === 413))
      return failed(error.status, "Invalid announcement request.");
    return failed(503, "Service announcements could not be loaded or saved.");
  }
}
