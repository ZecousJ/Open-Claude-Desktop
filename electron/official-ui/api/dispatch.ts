import type http from "node:http";
import { isOfficialDispatchPath, officialDispatchBodyLimit, serveOfficialDispatch } from "../../../shared/official-dispatch";
import { reply, type AdapterContext } from "./context";
import { readBoundedJson } from "./request-body";

export async function dispatchRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  if (!isOfficialDispatchPath(url.pathname)) return false;
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const current = () => !req.aborted && !!owner && activation != null &&
    ctx.isCurrent?.() === true && ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation;
  const result = await serveOfficialDispatch({
    method: req.method ?? "GET",
    url,
    body: () => readBoundedJson(req, officialDispatchBodyLimit),
  }, ctx.dispatch, current, ctx.dispatchReceiver);
  return reply(res, result.body, result.status, result.allow ? { Allow: result.allow } : {});
}
