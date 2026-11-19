import { z } from "zod";

const viewerPath =
  /^\/v1\/code\/sessions\/cse_([a-f0-9]{32})\/client\/presence$/;

export function officialCodeViewerSession(
  method: string,
  pathname: string,
  search = "",
): string | undefined {
  if (method !== "POST" || search) return;
  return viewerPath.exec(pathname)?.[1];
}

export const officialCodeViewerBody = z.strictObject({
  client_id: z.uuid(),
  clear: z.literal(true).optional(),
});

export const officialCodeViewerMaxBytes = 4096;
export const officialCodeViewerRefreshSeconds = 20;
export const officialCodeViewerLeaseMs = 60_000;

export function applyOfficialCodeViewerLease(
  sessions: Map<string, Map<string, number>>,
  sessionKey: string,
  command: z.infer<typeof officialCodeViewerBody>,
  now = Date.now(),
): void {
  for (const [key, viewers] of sessions) {
    for (const [clientId, expiresAt] of viewers) {
      if (expiresAt <= now) viewers.delete(clientId);
    }
    if (viewers.size === 0) sessions.delete(key);
  }

  const viewers = sessions.get(sessionKey) ?? new Map<string, number>();
  if (command.clear) viewers.delete(command.client_id);
  else viewers.set(command.client_id, now + officialCodeViewerLeaseMs);
  if (viewers.size === 0) sessions.delete(sessionKey);
  else sessions.set(sessionKey, viewers);
}
