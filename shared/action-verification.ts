export const actionVerificationPath = "/api/v1/claudex/action-verification";
export const actionVerificationMarker = "CLAUDEX_ACTION_VERIFICATION:";
export type ActionVerificationResult = {
  retry_after_seconds?: number;
  expires_in_seconds?: number;
  status?: string;
  masked_email?: string;
};

export function actionVerificationError(
  error: unknown,
): { code: string; actionLabel: string; seconds: number } | undefined {
  if (!error || typeof error !== "object") return;
  let value = error as {
    code?: string;
    metadata?: Record<string, unknown>;
    details?: Record<string, unknown>;
    message?: string;
  };
  const message = value.message ?? "";
  const offset = message.indexOf(actionVerificationMarker);
  if (offset >= 0) {
    try {
      value = JSON.parse(
        message.slice(offset + actionVerificationMarker.length),
      );
    } catch {
      return;
    }
  }
  if (typeof value.code !== "string") return;
  const metadata = value.metadata ?? value.details ?? {};
  return {
    code: value.code,
    actionLabel:
      typeof metadata.action_label === "string" ? metadata.action_label : "",
    seconds: Math.max(0, Number(metadata.retry_after_seconds) || 0),
  };
}
