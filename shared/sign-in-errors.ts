/**
 * What a sign-in refusal says to the person, by the service's code: Sub2API's
 * own codes (`INVALID_CREDENTIALS`…) and the Claudex extensions'. The desktop
 * main process (electron/sub2api/identity.ts) and the web bridge
 * (src-web/bridge/auth.ts) both use it, so neither shows the service's raw
 * wording ("invalid email or password") or a code. The catalogs translate each
 * sentence. Where the original has the same refusal, its sentence is used.
 */
export const codeMismatch =
  "Incorrect code entered. Check that the code matches what you received in your other browser or device and try again.";
export const totpCodeMismatch =
  "That code didn’t match. Check it and try again.";
export const mfaSignInFailed = "Something went wrong. Try again.";
const tooManyAttempts =
  "Too many attempts. Wait a few minutes before trying again.";
export const tooManyLoginAttempts = "Too many login attempts. Try again later.";
export const codeAlreadyUsed =
  "Code already used. Refresh the page and try again.";
const invalidEmail =
  "Invalid email address. Double-check the email entered and try again.";

/**
 * A pending verification step that ran out. The page then offers only "Start
 * again" (src/auth/SignInPage.tsx).
 */
export const signInExpired =
  "This sign-in expired. Start again to get a new code.";

/** The generic failure sentence, when the service gave nothing better. */
export const signInFailed = "There was an error logging you in. {emailSupport}";

export const signInErrorMessages: Readonly<Record<string, string>> = {
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  PASSWORD_REQUIRED: "Enter your password.",
  INVALID_EMAIL: invalidEmail,
  EMAIL_RESERVED: "This email address can't be used.",
  REGISTRATION_DISABLED: "Registration is closed on this Claudex service.",
  CLAUDEX_EMAIL_CODE_INVALID: codeMismatch,
  CLAUDEX_EMAIL_CODE_DISABLED:
    "Signing in with an email code is turned off on this service.",
  EMAIL_EXISTS: "An account with this email already exists.",
  EMAIL_SUFFIX_NOT_ALLOWED:
    "This email domain cannot register on this Claudex service.",
  EMAIL_VERIFY_REQUIRED: "Enter the verification code sent to your email.",
  VERIFY_CODE_REQUIRED: "Enter the verification code sent to your email.",
  INVALID_VERIFY_CODE: codeMismatch,
  VERIFY_CODE_TOO_FREQUENT: "Wait a moment before asking for another code.",
  VERIFY_CODE_MAX_ATTEMPTS: "Too many wrong codes. Ask for a new one.",
  INVITATION_CODE_REQUIRED: "Enter your invitation code.",
  INVITATION_CODE_INVALID: "That invitation code is invalid or already used.",
  TOTP_INVALID_CODE: totpCodeMismatch,
  CLAUDEX_2FA_SESSION_EXPIRED: signInExpired,
  TOTP_TOO_MANY_ATTEMPTS: tooManyAttempts,
  already_used: codeAlreadyUsed,
  CLAUDEX_EMAIL_CODE_ALREADY_USED: codeAlreadyUsed,
  state_expired: "That took too long. Please try again.",
  apple_login_expired: "That took too long. Please try again.",
  tenant_restriction_violation:
    "Access restricted by network policy. Contact IT Administrator.",
  rate_limit_error: tooManyLoginAttempts,
  INVALID_RESET_TOKEN:
    "This reset link is invalid or has expired. Ask for a new one.",
  PASSWORD_RESET_DISABLED:
    "Password reset isn't available on this service. Contact your administrator.",
  EMAIL_NOT_CONFIGURED: "Claudex can't send email right now. Try again later.",
  // Several accounts per browser (the web): the service's cap.
  CLAUDEX_WEB_ACCOUNT_LIMIT:
    "This browser is signed in to as many accounts as it can hold. Log out of one, then try again.",
};

/** The friendly sentence for a refusal, when its code or status has one. */
export function signInErrorMessage(
  code: string | undefined,
  status?: number,
  message?: string,
  twoFactor = false,
): string | undefined {
  if (message === "already_used") return codeAlreadyUsed;
  if (code && Object.hasOwn(signInErrorMessages, code))
    return signInErrorMessages[code];
  if (status === 429) return twoFactor ? tooManyAttempts : tooManyLoginAttempts;
  return undefined;
}
