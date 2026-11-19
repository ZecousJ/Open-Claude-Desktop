/**
 * The move from ZecousAI (shared/zecous-migration-api.ts) on the web: plain
 * requests to the service's endpoints with the session's token.
 */
import {
  confirmOfficialZecousMigration,
  noZecousMigration,
  officialZecousMigrationFrom,
  refreshZecousMigrationReadiness,
  zecousMigrationFrom,
  zecousMigrationPath,
  zecousMigrationRoute,
  type OfficialZecousMigration,
  type ZecousMigrationAPI,
  type ZecousMigrationRoute,
} from "../../shared/zecous-migration-api";
import { apiValue } from "../../shared/web-client/errors";
import type { WebTransport } from "../../shared/web-client/transport";

const confirmation = {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}",
};

/** The value of the service's `{code, data}` answer. */
function data(body: unknown): unknown {
  return body && typeof body === "object" && "data" in body ? body.data : body;
}

export function createZecousMigrationMethods(
  transport: Pick<WebTransport, "json">,
): ZecousMigrationAPI {
  return {
    zecousMigration: async () => {
      try {
        return zecousMigrationFrom(
          data(await transport.json(zecousMigrationPath)),
        );
      } catch {
        return noZecousMigration;
      }
    },
    confirmZecousMigration: async () =>
      zecousMigrationFrom(
        data(
          await transport.json(`${zecousMigrationPath}/confirm`, confirmation),
        ),
      ),
  };
}

export function createOfficialZecousMigration(
  transport: Pick<WebTransport, "json" | "captureActivation">,
  refreshModels: (current: () => void, signal: AbortSignal) => Promise<unknown>,
): OfficialZecousMigration {
  const operation = () => {
    const current = transport.captureActivation();
    const request = async (
      route: ZecousMigrationRoute = zecousMigrationRoute,
    ) => {
      current();
      const body = await transport.json(
        `/api/v1${route}`,
        route === zecousMigrationRoute ? undefined : confirmation,
      );
      current();
      return apiValue(200, body);
    };
    const refresh = async () => {
      current();
      await refreshZecousMigrationReadiness((signal) =>
        refreshModels(current, signal),
      );
      current();
    };
    return { request, refresh };
  };
  return {
    async status(options) {
      const { request, refresh } = operation();
      const status = officialZecousMigrationFrom(await request());
      if (options?.refreshOnDone && status.state === "done") await refresh();
      return status;
    },
    async confirm() {
      const { request, refresh } = operation();
      const result = await confirmOfficialZecousMigration(request);
      await refresh();
      return result;
    },
  };
}
