/** Separate from opt-in diagnostics and session ratings; only an explicit form submission. */
import type { AppContext, IpcHandle } from "../app/app-context";
import { profileReadLease } from "../account/profile-read-lease";
import { requestJson, Sub2ApiError } from "../sub2api/http";
import {
  productFeedbackPath,
  productFeedbackRequestSchema,
  productFeedbackAcceptedSchema,
  productFeedbackRefusal,
  type ProductFeedbackDelivery,
} from "../../shared/product-feedback";
export function registerProductFeedbackHandlers(
  handle: IpcHandle,
  ctx: AppContext,
  transport: typeof fetch = fetch,
) {
  const capture = profileReadLease(ctx);
  handle(
    "submitProductFeedback",
    async (raw: unknown): Promise<ProductFeedbackDelivery> => {
      const input = productFeedbackRequestSchema.parse(raw),
        lease = capture();
      const retired = {
        kind: "refused",
        failureReason: "auth_error",
        statusCode: 409,
      } as const;
      const check = () => {
        if (!lease.current()) throw Error("The feedback account changed.");
      };
      if (!lease.current()) return retired;
      // The public version is main-process owned, never supplied by the renderer.
      if (input.app_version !== ctx.appVersion)
        return {
          kind: "refused",
          failureReason: "invalid_request",
          statusCode: 400,
        };
      const backend = lease.host?.ready ? lease.host.backend : undefined;
      const unavailable = {
        kind: "refused",
        failureReason: "unavailable",
        statusCode: 503,
      } as const;
      if (!backend) return unavailable;
      let dispatched = false;
      let responseStatus: number | undefined;
      const trackedTransport: typeof fetch = async (...args) => {
        check();
        dispatched = true;
        responseStatus = undefined;
        const response = await transport(...args);
        responseStatus = response.status;
        return response;
      };
      try {
        const response = await backend.session.authorized((token) => {
          check();
          return requestJson(
            trackedTransport,
            `${backend.accounts.baseUrl}${productFeedbackPath}`,
            { method: "POST", token, body: input },
          );
        }, lease.current);
        if (!lease.current()) return retired;
        const accepted = productFeedbackAcceptedSchema.safeParse(response);
        return accepted.success
          ? { kind: "sent", feedbackId: accepted.data.feedback_id }
          : { kind: "unknown" };
      } catch (error) {
        if (!lease.current()) return retired;
        if (responseStatus !== undefined)
          return productFeedbackRefusal(
            responseStatus,
            error instanceof Sub2ApiError && error.status === responseStatus
              ? error.code
              : "",
          );
        if (dispatched) return { kind: "unknown" };
        return error instanceof Sub2ApiError &&
          (error.status === 401 || error.status === 403)
          ? productFeedbackRefusal(error.status, error.code)
          : unavailable;
      }
    },
  );
}
