/**
 * The announcements calls (shared/announcements-api.ts) on the web: plain
 * requests to the service's announcement endpoints with the session's token.
 */
import {
  announcementsFrom,
  type AnnouncementAction,
  type AnnouncementsAPI,
} from "../../shared/announcements-api";
import type { WebTransport } from "../../shared/web-client/transport";

type Method = (...args: any[]) => Promise<unknown>;

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  const wrapped = body as { data?: unknown } | undefined;
  return wrapped && typeof wrapped === "object" && "data" in wrapped
    ? wrapped.data
    : body;
}

export function createAnnouncementMethods(
  transport: Pick<WebTransport, "json">,
): { [K in keyof AnnouncementsAPI]: Method } {
  return {
    pendingAnnouncements: async () => {
      try {
        const answer = data(
          await transport.json("/api/v1/claudex/announcements/pending"),
        ) as { items?: unknown } | undefined;
        return announcementsFrom(answer?.items);
      } catch {
        // The pop-up is a courtesy: a service that can't answer shows none.
        return [];
      }
    },
    closeAnnouncement: async (id: number, action: AnnouncementAction) => {
      await transport.json(`/api/v1/claudex/announcements/${id}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
    },
  };
}
