/** Explicit, text-only product feedback. No email recipient or diagnostics in client payloads. */
import { z } from "zod";
export const productFeedbackPath = "/api/v1/claudex/product-feedback";
export const productFeedbackRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(4096),
    app_version: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9.+_-]+$/),
    request_id: z.string().uuid(),
  })
  .strict();
/** sent means accepted by the service SMTP transport, not inbox delivery. */
export const productFeedbackAcceptedSchema = z
  .object({ status: z.literal("sent"), feedback_id: z.string().uuid() })
  .strict();

const optionalText = z.string().max(512).optional();
const formSchema = z
  .object({
    reportType: z.string().min(1).max(128),
    details: z.string().max(4096),
    urgency: z.string().max(128),
    reportTypeOther: optionalText,
    productArea: optionalText,
    areaOther: optionalText,
    impact: optionalText,
    frequency: optionalText,
    regression: optionalText,
    satisfaction: z.number().finite().optional(),
    sessionId: optionalText,
    includeLogs: z.boolean().optional(),
    includeTranscript: z.boolean().optional(),
    source: optionalText,
    model: optionalText,
  })
  .strict();

const refusalSchema = z.object({
  failureReason: z.string(),
  statusCode: z.number(),
});
export const productFeedbackDeliverySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("sent"), feedbackId: z.string().uuid() }),
  refusalSchema.extend({ kind: z.literal("refused") }).strict(),
  z.strictObject({ kind: z.literal("unknown") }),
]);
export type ProductFeedbackRequest = z.infer<
  typeof productFeedbackRequestSchema
>;
export type ProductFeedbackDelivery = z.infer<
  typeof productFeedbackDeliverySchema
>;
export type ProductFeedbackRefusal = z.infer<typeof refusalSchema>;
export type ProductFeedbackAnswer =
  | { feedbackId: string; includedTranscript: false }
  | ProductFeedbackRefusal
  | (ProductFeedbackRefusal & {
      claudexProductFeedback: true;
      deliveryState: "unknown";
    });

export function productFeedbackRefusal(
  status: number,
  code: string,
): ProductFeedbackDelivery {
  switch (status) {
    case 401:
    case 403:
      return {
        kind: "refused",
        failureReason: "auth_error",
        statusCode: status,
      };
    case 429:
      return {
        kind: "refused",
        failureReason: "rate_limited",
        statusCode: status,
      };
    case 503:
      if (code === "PRODUCT_FEEDBACK_UNAVAILABLE")
        return {
          kind: "refused",
          failureReason: "unavailable",
          statusCode: status,
        };
      break;
    case 409:
      if (code === "PRODUCT_FEEDBACK_CONFLICT")
        return {
          kind: "refused",
          failureReason: "http_error",
          statusCode: status,
        };
      break;
    case 400:
    case 404:
    case 405:
    case 413:
    case 415:
    case 422:
    case 426:
      return {
        kind: "refused",
        failureReason: "http_error",
        statusCode: status,
      };
  }
  return { kind: "unknown" };
}

export function productFeedbackText(
  raw: unknown,
): string | ProductFeedbackRefusal {
  const parsed = formSchema.safeParse(raw);
  if (!parsed.success)
    return { failureReason: "invalid_request", statusCode: 400 };
  const form = parsed.data;
  if (form.includeLogs || form.includeTranscript)
    return { failureReason: "attachments_unavailable", statusCode: 400 };
  if (!form.details.trim())
    return { failureReason: "invalid_request", statusCode: 400 };
  const fields = [
    ["Category", form.reportType],
    ["Other category", form.reportTypeOther],
    ["Product area", form.productArea],
    ["Other area", form.areaOther],
    ["Impact", form.impact],
    ["Frequency", form.frequency],
    ["Regression", form.regression],
    ["Urgency", form.urgency],
    ["Satisfaction", form.satisfaction],
  ] as const;
  const choices = fields.flatMap(([label, value]) =>
    value !== undefined && String(value).trim()
      ? [`${label}: ${String(value).trim()}`]
      : [],
  );
  const text = [form.details.trim(), ...choices].join("\n\n");
  return text.length > 4096
    ? { failureReason: "payload_too_large", statusCode: 413 }
    : text;
}

type Attempt =
  | { kind: "retryable"; requestId: string }
  | {
      kind: "recorded";
      requestId: string;
      answer: Promise<ProductFeedbackAnswer>;
    };

export function createProductFeedbackSubmitter({
  appVersion,
  uuid,
  current,
  send,
}: {
  appVersion: string;
  uuid(): string;
  current(): boolean;
  send(request: ProductFeedbackRequest): Promise<ProductFeedbackDelivery>;
}) {
  const attempts = new Map<string, Attempt>();
  const retired = { failureReason: "auth_error", statusCode: 409 };
  return async (text: string): Promise<ProductFeedbackAnswer> => {
    if (!current()) return retired;
    const key = text.trim();
    const previous = attempts.get(key);
    if (previous?.kind === "recorded") return previous.answer;
    const requestId = previous?.requestId ?? uuid();
    const request = productFeedbackRequestSchema.safeParse({
      text: key,
      app_version: appVersion,
      request_id: requestId,
    });
    if (!request.success)
      return { failureReason: "invalid_request", statusCode: 400 };
    const answer = Promise.resolve().then(
      async (): Promise<ProductFeedbackAnswer> => {
        if (!current()) return retired;
        let delivery: ProductFeedbackDelivery;
        try {
          delivery = await send(request.data);
        } catch {
          delivery = { kind: "unknown" };
        }
        if (!current()) return retired;
        switch (delivery.kind) {
          case "refused":
            attempts.set(key, { kind: "retryable", requestId });
            return {
              failureReason: delivery.failureReason,
              statusCode: delivery.statusCode,
            };
          case "sent":
            return {
              feedbackId: delivery.feedbackId,
              includedTranscript: false,
            };
          case "unknown":
            return {
              claudexProductFeedback: true,
              deliveryState: "unknown",
              failureReason: "unconfirmed",
              statusCode: 409,
            };
        }
      },
    );
    attempts.set(key, { kind: "recorded", requestId, answer });
    return answer;
  };
}
