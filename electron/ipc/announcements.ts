import { z } from "zod";
import {
  announcementAction,
  pendingAnnouncementsFrom,
  popupAnnouncementsPath,
  serviceAnnouncementsFrom,
} from "../../shared/announcements-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import type { Sub2ApiClient } from "../sub2api/client";

export function registerAnnouncementHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  const authorized = async <T>(
    call: (client: Sub2ApiClient, token: string) => Promise<T>,
  ) => {
    const remote = ctx.remote;
    if (!remote?.ready || ctx.accountRetiring)
      throw Error("Sign in to a Claudex service first.");
    const { session } = remote;
    const activation = ctx.accountActivationIdentity;
    const current = () =>
      !ctx.accountRetiring &&
      ctx.accountActivationIdentity === activation &&
      ctx.remote === remote &&
      remote.ready &&
      remote.session === session;
    return session.authorized(
      (token) => call(remote.accounts.client, token),
      current,
    );
  };

  const pending = async () =>
    pendingAnnouncementsFrom(
      await authorized((client, token) =>
        client.call(`${popupAnnouncementsPath}/pending`, {
          token,
          // Up to 20 pop-ups with 200,000-byte bodies, before JSON escaping.
          responseChars: 24 * 1024 * 1024,
        }),
      ),
    );
  const close =
    (strict: boolean) => async (rawId: unknown, rawAction: unknown) => {
      const id = z.number().int().positive().parse(rawId);
      const action = announcementAction.parse(rawAction);
      if (!strict && !ctx.remote?.ready) return;
      await authorized((client, token) =>
        client.call(`${popupAnnouncementsPath}/${id}/read`, {
          method: "POST",
          body: { action },
          token,
        }),
      );
    };

  handle("pendingAnnouncements", () => pending().catch(() => []));
  handle("closeAnnouncement", close(false));
  handle("officialPendingAnnouncements", pending);
  handle("officialCloseAnnouncement", close(true));
  handle("officialAnnouncements", async () => {
    const answer = await authorized((client, token) =>
      client.announcements(token, Number.POSITIVE_INFINITY),
    );
    return serviceAnnouncementsFrom(answer);
  });
  handle("officialMarkAnnouncementRead", async (rawId: unknown) => {
    const id = z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number)
      .pipe(z.number().int())
      .parse(rawId);
    await authorized((client, token) => client.markAnnouncementRead(token, id));
  });
}
