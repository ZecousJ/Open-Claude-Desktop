import { z } from "zod";
import {
  remoteAnnouncementsFrom,
  sortServiceAnnouncements,
} from "../../shared/announcements-api";
import type { Announcement, ClientPolicy } from "../../shared/client-policy";
import type { AppContext, IpcHandle } from "../app/app-context";
import {
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
  const list = async (
    account: ReturnType<typeof remote>,
  ): Promise<Announcement[]> => {
    if (!account)
      return localAnnouncements(
        ctx.dataRoot,
        new LocalAnnouncementReads(ctx.store.root),
        Date.now(),
      );
    const answer = await account.session.authorized((token) =>
      account.accounts.client.announcements(token),
    );
    if (!Array.isArray(answer)) return [];
    const now = Date.now();
    return sortServiceAnnouncements(
      remoteAnnouncementsFrom(answer)
        .slice(0, 50)
        .filter(
          ({ startsAt, endsAt }) =>
            (startsAt === null || startsAt <= now) &&
            (endsAt === null || endsAt > now),
        ),
    ).map(({ id, title, content, popup, createdAt, read }) => ({
      id,
      title,
      content: content.slice(0, 20_000),
      popup,
      createdAt,
      read,
    }));
  };
  handle("announcements", () => list(remote()));
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
    return list(account);
  });
}
