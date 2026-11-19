import {
  serviceStatusPath,
  serviceStatusResponseFrom,
  type ServiceStatusAPI,
} from "../../shared/service-status-api";
import type { WebTransport } from "../../shared/web-client/transport";

export function createServiceStatusMethods(
  transport: Pick<WebTransport, "json">,
): ServiceStatusAPI {
  return {
    serviceStatus: async (query) => {
      const body = await transport.json(`/api/v1${serviceStatusPath(query)}`);
      return serviceStatusResponseFrom(body);
    },
  };
}
