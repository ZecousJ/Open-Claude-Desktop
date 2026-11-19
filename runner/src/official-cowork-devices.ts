import { z } from "zod";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialCoworkDeviceId } from "../../electron/official-ui/api/cowork-device-id";
import { Sub2ApiError } from "../../electron/sub2api/http";
import type { ChatDeviceDirectory } from "../../shared/chat-devices-api";
import {
  officialCoworkDeviceRenameMaxBytes,
  type officialCoworkDeviceManagement,
  type officialCoworkDevices,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";
import { isWebTabId } from "../../shared/web-protocol";
import type { WebAppContext } from "./web-app-context";

const availableCoworkDevice = z.object({
  id: z.custom<string>(isWebTabId),
  name: z.string().trim().min(1).max(256),
  online: z.literal(true),
  computerAccess: z.literal(true),
  chatBindingVersion: z.literal(1),
  chatModes: z
    .array(z.enum(["chat", "cowork"]))
    .refine((modes) => modes.includes("cowork")),
  chatPermissionModes: z.array(z.enum(["default", "auto"])).min(1),
  addedAt: z.iso.datetime({ offset: true }).optional(),
  lastSeenAt: z.iso.datetime({ offset: true }).optional(),
});

function eligibleDevices(devices: readonly unknown[]) {
  return devices.flatMap((device) => {
    const parsed = availableCoworkDevice.safeParse(device);
    return parsed.success ? [parsed.data] : [];
  });
}

export function findOfficialCoworkDevice(
  devices: readonly unknown[],
  owner: string,
  targetId: string,
) {
  return eligibleDevices(devices).find(
    (device) => officialCoworkDeviceId(owner, device.id) === targetId,
  );
}

const json = (status: number, value: unknown): OfficialUiReadResponse => ({
  status,
  contentType: "application/json",
  body: Buffer.from(JSON.stringify(value)),
});

const signingDevice = z.object({
  id: z.guid(),
  device_id: z.guid(),
  display_name: z.string(),
  platform: z.string(),
  public_key: z.string().nullish(),
  is_hardware_backed: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  revoked_at: z.iso.datetime({ offset: true }).nullish(),
  last_seen_at: z.iso.datetime({ offset: true }).nullish(),
});
const signingDirectory = z.object({ devices: z.array(signingDevice) });
const deviceRename = z.strictObject({ display_name: z.string() });

function deviceError(status: number, message: string, code?: string) {
  const type = status === 404 ? "not_found_error" :
    status === 401 ? "authentication_error" : status === 403 ? "permission_error" :
    status === 429 ? "rate_limit_error" : status >= 500 ? "api_error" : "invalid_request_error";
  return json(status, { type: "error", error: {
    type, message, ...(code && { details: { error_code: code } }),
  } });
}

export async function manageOfficialCoworkDevices(
  route: NonNullable<ReturnType<typeof officialCoworkDeviceManagement>>,
  request: Record<string, unknown>,
  ctx: WebAppContext,
  active: () => boolean,
): Promise<OfficialUiReadResponse> {
  const owner = ctx.activeAccount?.id;
  const activation = ctx.officialSessionIdentity();
  const session = ctx.session;
  const client = ctx.remote?.backend.client;
  const current = () => active() && ctx.activeAccount?.id === owner &&
    ctx.officialSessionIdentity() === activation && ctx.session === session;
  const accountChanged = () => deviceError(409, "The account activation changed.");
  if (!owner || !current()) return accountChanged();
  if (route.organizationId !== organizationUuid(owner)) return deviceError(404, "Organization not found.");
  if (!client || !session) return deviceError(503, "The signing-device registry is unavailable.");
  const invalid = () => deviceError(400, "Invalid Cowork device request.");
  const { body, contentType, capabilityLease } = request;
  if (capabilityLease !== undefined) return invalid();
  let rename: z.infer<typeof deviceRename> | undefined;
  if (route.method === "GET" && (body !== undefined || contentType !== undefined)) return invalid();
  if (route.method === "DELETE" && body !== undefined &&
      (!(body instanceof Uint8Array) || body.byteLength !== 0)) return invalid();
  if (route.method === "PATCH") {
    if (!(body instanceof Uint8Array) || typeof contentType !== "string" ||
        !/^application\/json(?:\s*;|$)/i.test(contentType)) return invalid();
    if (body.byteLength > officialCoworkDeviceRenameMaxBytes)
      return deviceError(413, "The Cowork device rename is too large.");
    try {
      rename = deviceRename.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    } catch {
      return invalid();
    }
  }
  const path = "/claudex/signing-devices" + (route.method === "GET" ? "?for_removal=true" : `/${route.id}`);
  try {
    const answer = await session.authorized((token) => client.call(path, { token, method: route.method, body: rename }), current);
    if (!current()) return accountChanged();
    if (route.method === "DELETE") return json(200, {});
    const parsed = (route.method === "GET" ? signingDirectory : signingDevice).safeParse(answer);
    return parsed.success ? json(200, parsed.data) : deviceError(502, "The signing-device registry returned an invalid response.");
  } catch (error) {
    if (!current()) return accountChanged();
    if (error instanceof Sub2ApiError && error.status >= 400 && error.status < 500)
      return deviceError(error.status, error.message, error.code);
    return deviceError(503, "The signing-device registry is unavailable.");
  }
}

export async function readOfficialCoworkDevices(
  route: NonNullable<ReturnType<typeof officialCoworkDevices>>,
  owner: string,
  directory: () => Promise<ChatDeviceDirectory>,
  current: () => boolean,
): Promise<OfficialUiReadResponse> {
  if (!current())
    return json(409, { error: "The account activation changed." });
  if (route.organizationId !== organizationUuid(owner))
    return json(404, { error: "Organization not found." });
  try {
    const data = await directory();
    if (!current())
      return json(409, { error: "The account activation changed." });
    const devices = eligibleDevices(data.devices).map((device) => {
      const id = officialCoworkDeviceId(owner, device.id);
      return route.directory
        ? {
            id,
            display_name: device.name,
            ...(device.addedAt && { created_at: device.addedAt }),
            ...(device.lastSeenAt && { last_seen_at: device.lastSeenAt }),
          }
        : { device_id: id, name: device.name };
    });
    return json(200, { devices });
  } catch {
    return current()
      ? json(503, { error: "The Cowork device directory is unavailable." })
      : json(409, { error: "The account activation changed." });
  }
}
