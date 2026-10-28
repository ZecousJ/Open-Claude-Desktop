import type { RetryCause } from "../../shared/turn-errors";

/** What a retried failure is called in the status line (English keys). */
export const retryCauses: Record<RetryCause, string> = {
  authentication_failed: "Authentication failed",
  rate_limit: "Rate limit reached",
  overloaded: "Server is busy",
};
