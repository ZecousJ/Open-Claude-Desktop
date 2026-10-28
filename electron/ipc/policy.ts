import { z } from "zod";
import type { Announcement, ClientPolicy } from "../../shared/client-policy";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
  fromRemoteAnnouncements,
  LocalAnnouncementReads,
  localAnnouncements,
} from "../account/client-policy";

/** Policy, links and announcements for the signed-in account. */
export function registerPolicyHandlers(handle: IpcHandle, ctx: AppContext) {
  /** Set for a Sub2API account once it finished opening. */
  const remote = () => (ctx.remote?.ready ? ctx.remote : undefined);
  // Answers at once so a slow or unreachable service never holds the window
  // blank; a newer policy arrives as a "policy" event.
  handle("clientPolicy", (): ClientPolicy => {
    ctx.refreshPolicy();
    return ctx.policy();
  });
  const list = async (): Promise<Announcement[]> => {
    const account = remote();
    if (!account)
      return localAnnouncements(
        ctx.dataRoot,
        new LocalAnnouncementReads(ctx.store.root),
        Date.now(),
      );
    const items = await account.session.authorized((token) =>
      account.accounts.client.announcements(token),
    );
    return fromRemoteAnnouncements(items, Date.now());
  };
  handle("announcements", list);
  handle("markAnnouncementRead", async (raw: unknown) => {
    const id = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .parse(raw);
    const account = remote();
    if (account) {
      if (!/^\d+$/.test(id)) throw Error("Unknown announcement.");
      await account.session.authorized((token) =>
        account.accounts.client.markAnnouncementRead(token, Number(id)),
      );
    } else new LocalAnnouncementReads(ctx.store.root).mark(id);
    return list();
  });
}
