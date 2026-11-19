import { version } from "../../package.json";
import {
  createProductFeedbackSubmitter,
  productFeedbackAcceptedSchema,
  productFeedbackPath,
  productFeedbackRefusal,
  type ProductFeedbackDelivery,
  type ProductFeedbackRequest,
} from "../../shared/product-feedback";
import { apiError, apiValue, readJson } from "../../shared/web-client/errors";
import { WebTransport } from "../../shared/web-client/transport";
import type { WebEnv } from "../../shared/web-client/env";
import type { WebAuth } from "./auth";

export function createWebProductFeedback(
  env: Pick<WebEnv, "fetch" | "timers">,
  auth: Pick<WebAuth, "activationIdentity" | "accessToken" | "refresh" | "expire">,
  tabId: string,
) {
  let owner: typeof auth.activationIdentity;
  let submit: ReturnType<typeof createProductFeedbackSubmitter> | undefined;
  return (text: string) => {
    const opening = auth.activationIdentity;
    if (!opening) return Promise.resolve({ failureReason: "auth_error", statusCode: 409 });
    if (opening !== owner || !submit) {
      const send = async (request: ProductFeedbackRequest): Promise<ProductFeedbackDelivery> => {
        let dispatched = false;
        let status: number | undefined;
        const transport = new WebTransport({ timers: env.timers, fetch: async (...args) => {
          dispatched = true;
          status = undefined;
          const response = await env.fetch(...args);
          status = response.status;
          return response;
        } }, auth, tabId);
        const check = transport.captureActivation();
        let response: Response;
        try {
          response = await transport.fetch(productFeedbackPath, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(18_000),
          }, check);
        } catch {
          check();
          return dispatched && status !== 401
            ? { kind: "unknown" }
            : { kind: "refused", failureReason: "auth_error", statusCode: 401 };
        }
        const body = await readJson(response);
        check();
        if (response.ok) {
          const accepted = productFeedbackAcceptedSchema.safeParse(apiValue(response.status, body));
          return accepted.success ? { kind: "sent", feedbackId: accepted.data.feedback_id } : { kind: "unknown" };
        }
        return productFeedbackRefusal(response.status, apiError(response.status, body).code ?? "");
      };
      submit = createProductFeedbackSubmitter({ appVersion: version, uuid: () => crypto.randomUUID(), current: () => auth.activationIdentity === opening, send });
      owner = opening;
    }
    return submit(text);
  };
}
