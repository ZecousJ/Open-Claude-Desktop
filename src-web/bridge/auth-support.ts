import type { PublicAccount, RemoteSignInPolicy } from "../../shared/types";
import { privacyPolicyUrl, type SignInOptions } from "../../shared/sign-in-api";
import {
  mfaSignInFailed,
  signInErrorMessage,
  signInFailed,
} from "../../shared/sign-in-errors";
import {
  bridgeError,
  type BridgeError,
  messages,
  statusOf,
} from "../../shared/web-client/errors";
import type { SignedOutReason, Json } from "./auth";

export const authChannel = "claudex-web-auth";

export const refreshLock = "claudex-web-refresh";

/** The `aff` code of a `/register?aff=` link, kept for this tab's session. */
export const affiliateKey = "claudex-web-aff";

/** sessionStorage: the account this tab shows (kept across reloads). */
export const tabAccountKey = "claudex-web-account";

/** sessionStorage: this tab is adding an account (`{email?}`). */
export const addingKey = "claudex-web-adding";

/** localStorage: the account used last, or `loggedOut` after a log out. */
export const lastAccountKey = "claudex-web-last-account";

/** localStorage: the accounts used in this browser (no tokens). */
export const rememberedKey = "claudex-web-accounts";

/** The last account logged out: a new tab opens on the sign-in page. */
export const loggedOut = "-";

/** How many accounts the chooser remembers. */
export const rememberLimit = 10;

/** Refresh this long before the access token expires. */
export const refreshAheadMs = 5 * 60_000;

/** A token with less life than this is refreshed before a call. */
export const minimumLifeMs = 30_000;

export const signedOutMessages: Record<SignedOutReason, string> = {
  revoked: "You signed out on all devices.",
  "device-revoked": "This browser was signed out.",
  "session-expired": messages.sessionExpired,
  "password-changed": "Your password was changed. Sign in again.",
};

export const record = (value: unknown): Json | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : undefined;

export const text = (value: unknown, max = 500) =>
  typeof value === "string" ? value.slice(0, max) : "";

/**
 * The account in an auth answer: the web session's `account`, or Sub2API's
 * `user` (`{id, email, username}`).
 */
export function accountFrom(value: unknown): PublicAccount | undefined {
  const json = record(value);
  const account = record(json?.account);
  if (account && typeof account.id === "string" && account.id) {
    return {
      id: account.id,
      email: text(account.email, 254),
      name: text(account.name, 200) || text(account.email, 254),
      ...(typeof account.plan === "string" && account.plan
        ? { plan: text(account.plan, 100) }
        : {}),
      remote: true,
    };
  }
  const user = record(json?.user) ?? (json && "email" in json ? json : null);
  if (!user) return undefined;
  const id = user.id;
  if (!(typeof id === "number" && Number.isSafeInteger(id) && id > 0))
    return undefined;
  const email = text(user.email, 254);
  return {
    id: String(id),
    email,
    name: text(user.username, 200) || email.split("@")[0] || email,
    remote: true,
  };
}

/**
 * What the sign-in screen may offer, from `GET /api/v1/settings/public`
 * and the Claudex sign-in options (`GET /api/v1/claudex/sign-in/options`).
 */
export function signInPolicy(
  settings: unknown,
  options: SignInOptions = { emailCodeLogin: false },
  passkeysWork = false,
): RemoteSignInPolicy {
  const data = record(settings) ?? {};
  const list = Array.isArray(data.registration_email_suffix_whitelist)
    ? data.registration_email_suffix_whitelist
    : [];
  const backendMode = data.backend_mode_enabled === true;
  const privacy = privacyPolicyUrl(options, data);
  return {
    siteName: text(data.site_name, 100),
    passwordReset: data.password_reset_enabled === true && !backendMode,
    emailCodeLogin: options.emailCodeLogin && !backendMode,
    passkey: passkeysWork && data.passkey_enabled === true,
    ...(options.googleClientId && !backendMode
      ? { googleClientId: options.googleClientId }
      : {}),
    backendMode,
    ...(privacy ? { privacyPolicyUrl: privacy } : {}),
    // Backend mode keeps everyone but administrators out.
    registrationEnabled:
      data.registration_enabled === true && data.backend_mode_enabled !== true,
    emailVerification: data.email_verify_enabled === true,
    invitationCode: data.invitation_code_enabled === true,
    promoCode: data.promo_code_enabled === true,
    captchaRequired:
      data.turnstile_enabled === true ||
      data.tencent_captcha_enabled === true ||
      data.aliyun_captcha_enabled === true,
    emailDomains: list
      .filter((item): item is string => typeof item === "string")
      .slice(0, 50),
  };
}

/**
 * A sign-in refusal in the words the sign-in page shows (shared with the
 * desktop, shared/sign-in-errors.ts), its code and status kept for the
 * pages a refusal leads to.
 */
export function friendly(
  error: BridgeError,
  fallback = false,
  twoFactor = false,
): BridgeError {
  const message =
    signInErrorMessage(error.code, error.status, error.message, twoFactor) ??
    (fallback ? (twoFactor ? mfaSignInFailed : signInFailed) : undefined);
  if (!message) return error;
  const next = bridgeError(message, error.code, error.details);
  if (error.status)
    Object.defineProperty(next, "status", { value: error.status });
  return next;
}

/** The service's code for a 2FA step it no longer knows (expired). */
export const expiredCode = "CLAUDEX_2FA_SESSION_EXPIRED";

/**
 * A refresh refusal that means there is no session to restore: 401 (no,
 * expired or revoked cookie), 403 (the web version is off for this account,
 * a failed CSRF check) or 400 (a malformed cookie).
 */
export function isSignedOutError(error: unknown) {
  const status = statusOf(error);
  return status === 400 || status === 401 || status === 403;
}
