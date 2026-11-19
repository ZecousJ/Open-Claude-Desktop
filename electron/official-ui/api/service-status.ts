import type http from "node:http";
import { officialServiceStatusPath, parseOfficialServiceStatusQuery } from "../../../shared/service-status-api";
import { reply, type AdapterContext } from "./context";

export async function serviceStatusRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  if (url.pathname !== officialServiceStatusPath) return false;
  if (req.method !== "GET") return reply(res, { error: "Unsupported request." }, 405, { Allow: "GET" });
  const query = parseOfficialServiceStatusQuery(url.searchParams);
  if (!query) return reply(res, { error: "Invalid service status window." }, 400);
  const read = ctx.serviceStatus;
  const owner = ctx.account()?.id;
  const identity = ctx.sessionIdentity?.();
  if (!read || !owner || identity == null || ctx.isCurrent?.() !== true)
    return reply(res, { error: "Service status is unavailable." }, 404);
  const current = () => !req.aborted && ctx.isCurrent?.() === true && ctx.account()?.id === owner && ctx.sessionIdentity?.() === identity;
  try {
    const answer = await read(query);
    if (current()) return reply(res, answer);
  } catch {
    if (current()) return reply(res, { error: "Service status could not be read." }, 503);
  }
  return reply(res, { error: "The active account changed." }, 409);
}
