import type http from "node:http";
import { z } from "zod";
import { Sub2ApiError } from "../../sub2api/http";
import { organizationUuid, reply, type AdapterContext } from "./context";
import { readBoundedJson, RequestBodyError } from "./request-body";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const registryPath = new RegExp(`^/api/organizations/(${uuid})/cowork/remote_devices(?:/(${uuid}))?$`);

export const deviceDirectory = z.object({
  devices: z.array(z.object({
    id: z.uuid(),
    device_id: z.uuid(),
    public_key: z.string().nullish(),
    revoked_at: z.string().nullish(),
  })),
});

export type DeviceRegistryRequest =
  | { method: "GET"; forRemoval?: boolean }
  | { method: "POST"; body: unknown }
  | { method: "PATCH"; id: string; body: unknown }
  | { method: "DELETE"; id: string };

function registryError(res: http.ServerResponse, status: number, errorCode?: string) {
  return reply(res, {
    type: "error",
    error: {
      type: status === 404 ? "not_found_error" : status === 403 ? "permission_error" : "invalid_request_error",
      ...(errorCode ? { details: { error_code: errorCode } } : {}),
    },
  }, status);
}

export async function deviceRegistryRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, ctx: AdapterContext) {
  const match = registryPath.exec(url.pathname);
  if (!match) return false;
  const account = ctx.account()?.id;
  if (!ctx.deviceRegistryRequest || !account || organizationUuid(account) !== match[1])
    return registryError(res, 404);
  const activation = ctx.sessionIdentity?.();
  const current = () => !req.aborted && ctx.isCurrent?.() === true &&
    ctx.account()?.id === account && ctx.sessionIdentity?.() === activation;
  if (!current()) return registryError(res, 401);
  const id = match[2];
  const method = req.method ?? "GET";
  try {
    let request: DeviceRegistryRequest;
    if (method === "GET" && !id)
      request = { method, forRemoval: url.searchParams.get("for_removal") === "true" };
    else if (method === "POST" && !id)
      request = { method, body: await readBoundedJson(req, 8192) };
    else if (method === "PATCH" && id)
      request = { method, id, body: await readBoundedJson(req, 8192) };
    else if (method === "DELETE" && id)
      request = { method, id };
    else
      return registryError(res, 405);
    if (!current()) return registryError(res, 401);
    const answer = await ctx.deviceRegistryRequest(request);
    if (!current()) return registryError(res, 401);
    return reply(res, answer ?? {});
  } catch (error) {
    if (!current()) return registryError(res, 401);
    if (error instanceof RequestBodyError) return registryError(res, error.status);
    if (error instanceof Sub2ApiError) return registryError(res, error.status, error.code);
    throw error;
  }
}
