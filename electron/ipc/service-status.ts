import { z } from "zod";
import {
  serviceStatusFrom,
  serviceStatusMethods,
  serviceStatusPath,
  type ServiceStatus,
} from "../../shared/service-status-api";
import type { AppContext, IpcHandle } from "../app/app-context";
import { requestJson } from "../sub2api/http";

const query = z
  .object({
    end: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}(:\d{2})?)?$/)
      .optional(),
    days: z.number().int().min(1).max(366).optional(),
    hours: z.number().int().min(1).max(720).optional(),
    step: z
      .union([
        z.literal(10),
        z.literal(15),
        z.literal(20),
        z.literal(30),
        z.literal(60),
      ])
      .optional(),
  })
  .strict()
  .optional();

/**
 * The Service status page's data from the service
 * (shared/service-status-api.ts), read with the session's token in the main
 * process. An account without a Claudex session has none.
 */
export function registerServiceStatusHandlers(
  handle: IpcHandle,
  ctx: AppContext,
) {
  handle(
    "serviceStatus",
    async (raw: unknown): Promise<ServiceStatus | null> => {
      const checked = query.parse(raw);
      const backend = ctx.remote?.ready ? ctx.remote.backend : undefined;
      if (!backend) return null;
      const body = await backend.session.authorized((token) =>
        requestJson(
          fetch,
          `${backend.accounts.baseUrl}/api/v1${serviceStatusPath(checked)}`,
          { token },
        ),
      );
      const data =
        body && typeof body === "object" && "data" in body
          ? (body as { data: unknown }).data
          : body;
      return serviceStatusFrom(data);
    },
  );
  // Keeps this list and the bridge's in step.
  void serviceStatusMethods;
}
