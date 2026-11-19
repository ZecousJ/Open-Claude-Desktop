import { z } from "zod";
import { isWebTabId } from "./web-protocol";

export const officialRemoteCodeGate = "3540182858";
export const officialRemoteCodeTransportGates = {
  "68367710": { defaultValue: false },
  "3809766863": { defaultValue: true },
  "2774291247": { defaultValue: true },
};
export const remoteCodeInventoryPath = "/v1/code/sessions";
export const remoteCodeArchivedInventoryPath =
  remoteCodeInventoryPath + "?statuses=archived";
export const remoteCodeHeartbeatPath =
  remoteCodeInventoryPath + "/heartbeat_check";

export type RemoteCodeEnvironment = {
  environment_id: string;
  name: string;
  kind: "bridge";
  state: "active";
  bridge_info: {
    machine_name: string;
    directory?: string;
    online: boolean;
    max_sessions: number;
    active_sessions: number;
  };
};

export const remoteCodeSessionKey = (id: string) =>
  id.replaceAll("-", "").toLowerCase();
export function remoteCodeSessionId(key: string) {
  const match =
    /^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/.exec(
      key,
    );
  return match && match.slice(1).join("-");
}

export const remoteCodeSession = z.looseObject({
  id: z.string().regex(/^session_[a-f0-9]{32}$/),
  updated_at: z.string().optional(),
  last_event_at: z.string(),
  status: z.enum(["active", "paused", "archived", "failed"]),
  tags: z.array(z.string()),
});

export function remoteCodeEnvironmentId(device: string, directory?: string) {
  return (
    "env_bridge_" +
    device +
    (directory ? "." + encodeURIComponent(directory) : "")
  );
}

export function remoteCodeEnvironmentTarget(input: unknown) {
  const match =
    typeof input === "string"
      ? /^env_bridge_([A-Za-z0-9_-]{8,64})(?:\.(.+))?$/.exec(input)
      : null;
  if (!match) return;
  const [, device, encoded] = match;
  try {
    return { device, directory: encoded && decodeURIComponent(encoded) };
  } catch {
    return;
  }
}

export function remoteCodeLinkTarget(url: URL) {
  const match =
    /^\/(?:code|claude-code-desktop|epitaxy)\/(?:session|cse)_([a-f0-9]{32})\/?$/.exec(
      url.pathname,
    );
  const device = url.searchParams.get("device");
  return match && isWebTabId(device) ? { key: match[1], device } : undefined;
}

export const remoteCodeInventory = z.strictObject({
  directories: z.array(z.string()),
  capacity: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  sessions: remoteCodeSession.array(),
});

export const remoteCodeInventoryPage = remoteCodeInventory.extend({
  next_cursor: remoteCodeSession.shape.id.nullable(),
});

export const remoteCodeRequest = z.strictObject({
  method: z.enum(["GET", "POST", "PUT", "DELETE"]),
  path: z.string().max(2000),
  body: z.unknown().optional(),
});
export type RemoteCodeRequest = z.infer<typeof remoteCodeRequest>;
