import {
  serviceStatusQuery,
  serviceStatusResponseFrom,
  serviceStatusPath,
  type ServiceStatus,
} from "../../shared/service-status-api";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";

export function registerServiceStatusHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  handle(
    "serviceStatus",
    async (raw: unknown): Promise<ServiceStatus | null> => {
      const query = serviceStatusQuery.optional().parse(raw);
      const remote = ctx.remote;
      if (!remote?.ready) return null;
      const { backend, session } = remote;
      const activation = ctx.accountActivationIdentity;
      const current = () =>
        !ctx.accountRetiring &&
        ctx.accountActivationIdentity === activation &&
        ctx.remote === remote &&
        remote.ready &&
        remote.session === session;
      assertAccountOperationCurrent(current);
      const body = await session.authorized(
        (token) =>
          requestJson(
            fetch,
            `${backend.accounts.baseUrl}/api/v1${serviceStatusPath(query)}`,
            { token, responseChars: 24 * 1024 * 1024 },
          ),
        current,
      );
      assertAccountOperationCurrent(current);
      return serviceStatusResponseFrom(body);
    },
  );
}
