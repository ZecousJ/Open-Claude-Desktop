import { z } from "zod";
import {
  announcementsFrom,
  announcementsMethods,
  type Announcement,
} from "../../shared/announcements-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";

/**
 * The announcements a signed-in Claudex account has not closed, and the
 * close. Read with the session's token in the main process; a service without
 * the component (404) or an account that isn't signed in has none.
 */
export function registerAnnouncementHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const service = () => (ctx.remote?.ready ? ctx.remote.backend : undefined);
  handle("pendingAnnouncements", async (): Promise<Announcement[]> => {
    const backend = service();
    if (!backend) return [];
    try {
      const answer = await backend.session.authorized((token) =>
        requestJson(
          fetch,
          `${backend.accounts.baseUrl}/api/v1/claudex/announcements/pending`,
          { token },
        ),
      );
      return announcementsFrom((answer as { items?: unknown })?.items);
    } catch {
      // The pop-up is a courtesy: a service that can't answer shows none.
      return [];
    }
  });
  handle("closeAnnouncement", async (rawId: unknown, rawAction: unknown) => {
    const id = z.number().int().positive().parse(rawId);
    const action = z.enum(["primary", "dismiss", "close"]).parse(rawAction);
    const backend = service();
    if (!backend) return;
    await backend.session.authorized((token) =>
      requestJson(
        fetch,
        `${backend.accounts.baseUrl}/api/v1/claudex/announcements/${id}/read`,
        { method: "POST", body: { action }, token },
      ),
    );
  });
  // Keeps this list and the bridge's in step.
  void announcementsMethods;
}
