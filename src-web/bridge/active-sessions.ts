import {
  activeSessionsFrom,
  parseSessionId,
} from "../../shared/active-sessions";
import {
  parseDeviceList,
  parseDeviceRevoked,
  parseNativeSessionList,
  parseNativeSessionRevoked,
  parseWebSessionList,
  parseWebSessionRevoked,
} from "../../shared/claudex-contract";
import type { SettingsAccountAPI } from "../../shared/settings-api";
import { apiValue, statusOf } from "../../shared/web-client/errors";
import type { WebTransport } from "../../shared/web-client/transport";

const devices = "/api/v1/claudex/devices";
const browsers = "/api/v1/claudex/web/sessions";
const apps = "/api/v1/claudex/native-sessions";

export function createActiveSessionMethods(
  transport: Pick<WebTransport, "json">,
): Pick<SettingsAccountAPI, "activeSessions" | "endActiveSession"> {
  const read = async (path: string, init?: RequestInit) =>
    apiValue(200, await transport.json(path, init));

  return {
    async activeSessions() {
      const [desktop, web, native] = await Promise.all([
        read(devices).then(parseDeviceList),
        read(browsers).then(parseWebSessionList),
        read(apps).then(parseNativeSessionList),
      ]);
      return activeSessionsFrom(desktop, web, native);
    },
    async endActiveSession(id) {
      const session = parseSessionId(id);
      if (!session) throw Error("Unknown session.");
      const routes = {
        desktop: { path: devices, parse: parseDeviceRevoked },
        web: { path: browsers, parse: parseWebSessionRevoked },
        app: { path: apps, parse: parseNativeSessionRevoked },
      };
      const { path, parse } = routes[session.kind];
      try {
        const result = parse(
          await read(`${path}/${session.id}`, { method: "DELETE" }),
        );
        return { ended: result.revoked };
      } catch (error) {
        if (statusOf(error) === 404) return { ended: false };
        throw error;
      }
    },
  };
}
