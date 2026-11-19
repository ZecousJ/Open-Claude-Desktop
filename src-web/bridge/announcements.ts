/**
 * The announcements calls (shared/announcements-api.ts) on the web: plain
 * requests to the service's announcement endpoints with the session's token.
 */
import {
  pendingAnnouncementsFrom,
  popupAnnouncementsPath,
  serviceAnnouncementsFrom,
  serviceAnnouncementsPath,
  type AnnouncementsAPI,
  type OfficialAnnouncements,
} from "../../shared/announcements-api";
import { apiValue } from "../../shared/web-client/errors";
import type { WebTransport } from "../../shared/web-client/transport";

const servicePath = `/api/v1${serviceAnnouncementsPath}`;
const popupPath = `/api/v1${popupAnnouncementsPath}`;
type AnnouncementTransport = Pick<WebTransport, "json">;

export function createAnnouncementMethods(
  transport: AnnouncementTransport,
): AnnouncementsAPI {
  const { pending, close } = createOfficialAnnouncements(transport);
  return {
    pendingAnnouncements: () => pending().catch(() => []),
    closeAnnouncement: close,
  };
}

export function createOfficialAnnouncements(
  transport: AnnouncementTransport,
): OfficialAnnouncements {
  return {
    notices: async () => {
      const body = apiValue(200, await transport.json(servicePath));
      return serviceAnnouncementsFrom(body);
    },
    pending: async () => {
      const body = apiValue(200, await transport.json(`${popupPath}/pending`));
      return pendingAnnouncementsFrom(body);
    },
    markRead: async (id) => {
      apiValue(
        200,
        await transport.json(`${servicePath}/${encodeURIComponent(id)}/read`, {
          method: "POST",
        }),
      );
    },
    close: async (id, action) => {
      apiValue(
        200,
        await transport.json(`${popupPath}/${id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      );
    },
  };
}
