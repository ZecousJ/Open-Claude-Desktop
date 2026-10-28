export type AuthIssue = "auth_error" | "auth_unavailable" | "retrying";

export const authIssueCopy: Record<AuthIssue, string> = {
  auth_error: "Your sign-in expired. Sign in again to continue.",
  auth_unavailable: "Couldn’t verify your sign-in. Try again in a moment.",
  retrying: "Couldn’t verify your sign-in. Retrying now.",
};

export function turnAuthIssue(error?: string): AuthIssue | undefined {
  if (!error) return undefined;
  if (/\bauth_unavailable\b/i.test(error)) return "auth_unavailable";
  if (/\bauth_error\b|\b401\b|unauthori[sz]ed|invalid api key/i.test(error))
    return "auth_error";
  return undefined;
}

export function authIssueOf(error: unknown): AuthIssue | undefined {
  if (!error || typeof error !== "object") return undefined;
  const failure = error as {
    code?: unknown;
    errorCode?: unknown;
    message?: unknown;
    status?: unknown;
  };
  if (failure.status === 401) return "auth_error";
  return turnAuthIssue(
    [failure.code, failure.errorCode, failure.message]
      .filter((value) => typeof value === "string")
      .join(" "),
  );
}
