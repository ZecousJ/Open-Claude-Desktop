import type http from "node:http";
import {
  isOfficialAnnouncementPath,
  officialAnnouncementBodyLimit,
  serveOfficialAnnouncement,
} from "../../../shared/official-announcements";
import { reply, type AdapterContext } from "./context";
import { readBoundedJson } from "./request-body";

export async function announcementsRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  if (!isOfficialAnnouncementPath(url.pathname)) return false;
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const api = ctx.announcements;
  const current = () => !req.aborted && !!owner && activation != null &&
    ctx.isCurrent?.() === true && ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation;
  const result = await serveOfficialAnnouncement({
    method: req.method ?? "GET", url, body: () => readBoundedJson(req, officialAnnouncementBodyLimit),
  }, api, current);
  return reply(res, result.body, result.status, result.allow ? { Allow: result.allow } : {});
}
