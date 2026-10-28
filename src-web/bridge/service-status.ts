/**
 * The Service status page's data on the web: a plain request to the
 * service with the session's token (shared/service-status-api.ts).
 */
import {
  serviceStatusFrom,
  serviceStatusPath,
  type ServiceStatusAPI,
  type ServiceStatusQuery,
} from "../../shared/service-status-api";
import type { WebTransport } from "../../shared/web-client/transport";

type Method = (...args: any[]) => Promise<unknown>;

export function createServiceStatusMethods(
  transport: Pick<WebTransport, "json">,
): { [K in keyof ServiceStatusAPI]: Method } {
  return {
    serviceStatus: async (query?: ServiceStatusQuery) => {
      const body = (await transport.json(
        `/api/v1${serviceStatusPath(query)}`,
      )) as { data?: unknown } | undefined;
      return serviceStatusFrom(
        body && typeof body === "object" && "data" in body ? body.data : body,
      );
    },
  };
}
