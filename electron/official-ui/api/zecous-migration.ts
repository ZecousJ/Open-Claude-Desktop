import type http from "node:http";
import { isOfficialZecousMigrationPath, serveOfficialZecousMigration } from "../../../shared/official-zecous-migration";
import { reply, type AdapterContext } from "./context";

export async function zecousMigrationRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  if (!isOfficialZecousMigrationPath(url.pathname)) return false;
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const current = () => !req.aborted && !!owner && activation != null &&
    ctx.isCurrent?.() === true && ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation;
  const result = await serveOfficialZecousMigration({ method: req.method ?? "GET", url }, ctx.zecousMigration, current);
  return reply(res, result.body, result.status, result.allow ? { Allow: result.allow } : {});
}
