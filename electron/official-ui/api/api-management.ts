import type http from "node:http";
import { apiManagementBodyLimit, apiManagementFailure, executeApiManagement, isApiManagementPath } from "../../../shared/official-api-management";
import { empty, reply, type AdapterContext } from "./context";
import { readBoundedJson } from "./request-body";

export async function apiManagementRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  if (!isApiManagementPath(url.pathname)) return false;
  const api = ctx.apiManagement;
  if (!api) return false;
  const identity = ctx.sessionIdentity?.();
  const owner = ctx.account()?.id;
  const check = () => {
    if (!owner || identity == null || ctx.isCurrent?.() !== true || ctx.account()?.id !== owner || ctx.sessionIdentity?.() !== identity || req.aborted)
      throw new DOMException("The active account changed.", "AbortError");
  };
  const { status, data } = await executeApiManagement(
    req.method ?? "GET", url, () => readBoundedJson(req, apiManagementBodyLimit), api, check,
  ).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError")
      return apiManagementFailure(error.message, 409, { code: "account_operation_stale" });
    throw error;
  });
  return status === 204 ? empty(res) : reply(res, data, status);
}
