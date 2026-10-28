/**
 * The sign-in refusals that get a page of their own: their fixed wording,
 * shared by the desktop main process and the window, and how a refusal is
 * recognised: by code where the error carries one (the web bridge), else by
 * that wording (an error crossing Electron's IPC keeps only its message). Not
 * part of the web app's first load.
 */

/** Fixed wording, shared by the main process and the window. */
export const signInMessages = {
  disabled: "This account is disabled. Contact your administrator.",
  backendMode:
    "This service only lets administrators sign in right now. Contact your administrator.",
  upgradeRequired:
    "This version of Claudex is too old for this service. Update Claudex, then sign in again.",
  unavailable: "The Claudex service is unavailable right now. Try again later.",
  deviceLimitStart: "You're signed in to Claudex on ",
} as const;

export type AccountState =
  | "device-limit"
  | "disabled"
  | "backend-mode"
  | "upgrade-required"
  | "unavailable";

const stateCodes: Record<string, AccountState> = {
  CLAUDEX_DEVICE_LIMIT: "device-limit",
  USER_NOT_ACTIVE: "disabled",
  USER_INACTIVE: "disabled",
  USER_DISABLED: "disabled",
  BACKEND_MODE_ADMIN_ONLY: "backend-mode",
  CLAUDEX_UPGRADE_REQUIRED: "upgrade-required",
  CLAUDEX_WEB_AUTH_UNAVAILABLE: "unavailable",
  CLAUDEX_WEB_SESSIONS_UNAVAILABLE: "unavailable",
};

/**
 * The page a failed sign-in call leads to, or undefined when the error
 * belongs next to the form (a wrong password, a bad code).
 */
export function accountStateOf(error: unknown): AccountState | undefined {
  const value = error as
    { message?: unknown; code?: unknown; status?: unknown } | undefined;
  const code = typeof value?.code === "string" ? value.code : "";
  if (stateCodes[code]) return stateCodes[code];
  const status = typeof value?.status === "number" ? value.status : 0;
  if (status === 426) return "upgrade-required";
  if (status === 502 || status === 503 || status === 504) return "unavailable";
  const message = typeof value?.message === "string" ? value.message : "";
  if (message.startsWith(signInMessages.deviceLimitStart))
    return "device-limit";
  if (message === signInMessages.disabled) return "disabled";
  if (
    message === signInMessages.backendMode ||
    message.startsWith("Backend mode is active. Only admin")
  )
    return "backend-mode";
  if (message === signInMessages.upgradeRequired) return "upgrade-required";
  if (message === signInMessages.unavailable) return "unavailable";
  return undefined;
}
