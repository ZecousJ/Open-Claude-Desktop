import {
  parsePendingEmailLink,
  type PendingEmailLink,
} from "../../shared/email-link";
import { surface } from "../../shared/host";

export const web = surface === "web";

const emailLinkStorageKey = "claudex-email-link";

export function pendingEmailLink() {
  if (!web) return;
  try {
    return parsePendingEmailLink(sessionStorage.getItem(emailLinkStorageKey));
  } catch {
    return;
  }
}

export function keepEmailLink(pending?: PendingEmailLink) {
  if (!web) return;
  try {
    if (pending)
      sessionStorage.setItem(emailLinkStorageKey, JSON.stringify(pending));
    else sessionStorage.removeItem(emailLinkStorageKey);
  } catch {}
}

export const mac =
  !web && /Mac/i.test(navigator.platform || navigator.userAgent);

export const message = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

export type LoginMethod = "email" | "passkey" | "google";

const lastMethodKey = "claudex.lastLoginMethod";

/** The method this computer last signed in with, if any. */
export function lastLoginMethod(): LoginMethod | undefined {
  try {
    const value = localStorage.getItem(lastMethodKey);
    return value === "email" || value === "passkey" || value === "google"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export function rememberLoginMethod(method: LoginMethod) {
  try {
    localStorage.setItem(lastMethodKey, method);
  } catch {
    // Not remembered: no "Last used" next time.
  }
}
