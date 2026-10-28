import type {
  AuthStatus,
  PublicAccount,
  RegisterExtras,
} from "../../shared/types";
import { webAuthRoutes } from "../../shared/web-protocol";
import { signInExpired } from "../../shared/sign-in-errors";
import { bridgeError } from "../../shared/web-client/errors";
import {
  affiliateKey,
  signedOutMessages,
  record,
  text,
  expiredCode,
} from "./auth-support";
import type { WebAuth } from "./auth";

export async function login(this: WebAuth, email: string, password: string) {
  this.signedOutOnly();
  const { value } = await this.post(webAuthRoutes.login, {
    email: String(email).trim(),
    password: String(password),
  });
  return this.signedIn(value);
}

export async function completeTwoFactor(
  this: WebAuth,
  code: string,
): Promise<PublicAccount> {
  this.signedOutOnly();
  const pending = this.pendingTwoFactor;
  if (!pending) throw bridgeError(signInExpired, expiredCode);
  const { value } = await this.post(webAuthRoutes.twoFactor, {
    ...(pending.tempToken ? { temp_token: pending.tempToken } : {}),
    totp_code: String(code).trim(),
  }).catch((error: unknown) => {
    // The service forgot the step: only starting again helps.
    if ((error as { code?: unknown })?.code === expiredCode)
      this.pendingTwoFactor = undefined;
    throw error;
  });
  const result = await this.signedIn(value);
  if ("twoFactorRequired" in result)
    throw bridgeError("The service asked for another code.");
  return result;
}

export async function cancelTwoFactor(this: WebAuth) {
  const pending = this.pendingTwoFactor;
  this.pendingTwoFactor = undefined;
  if (!pending) return;
  await this.post(webAuthRoutes.cancelTwoFactor, {
    ...(pending.tempToken ? { temp_token: pending.tempToken } : {}),
  }).catch(() => {});
}

export async function sendCode(
  this: WebAuth,
  email: string,
): Promise<{ countdown: number }> {
  this.signedOutOnly();
  const { value } = await this.post(webAuthRoutes.sendCode, {
    email: String(email).trim(),
  });
  const countdown = record(value)?.countdown;
  return {
    countdown: typeof countdown === "number" && countdown >= 0 ? countdown : 60,
  };
}

// The sign-in page's other ways in.

export async function requestPasswordReset(
  this: WebAuth,
  email: string,
): Promise<void> {
  this.signedOutOnly();
  await this.post(webAuthRoutes.forgotPassword, {
    email: String(email).trim(),
  });
}

export async function resetPassword(
  this: WebAuth,
  email: string,
  token: string,
  password: string,
): Promise<void> {
  // No session needed: the link's token is the proof (a signed-in browser
  // may set another account's new password from its link).
  await this.post(webAuthRoutes.resetPassword, {
    email: String(email).trim(),
    token: String(token).trim(),
    new_password: String(password),
  });
}

export async function sendSignInCode(
  this: WebAuth,
  email: string,
  request?: import("../../shared/email-link").EmailLinkRequest,
): Promise<{ countdown: number }> {
  this.signedOutOnly();
  const { value } = await this.post(webAuthRoutes.emailCodeSend, {
    email: String(email).trim(),
    ...request,
  });
  const countdown = record(value)?.countdown;
  return {
    countdown: typeof countdown === "number" && countdown > 0 ? countdown : 60,
  };
}

export async function loginWithCode(
  this: WebAuth,
  email: string,
  code: string,
  request?: import("../../shared/email-link").EmailLinkRequest,
) {
  this.signedOutOnly();
  const { value } = await this.post(webAuthRoutes.emailCodeLogin, {
    email: String(email).trim(),
    code: String(code).trim(),
    ...request,
    ...(request ? { link: true } : {}),
  });
  return this.signedIn(value);
}

/**
 * Continue with Google: the code Google's popup code client gave, which
 * the service exchanges (redirect "postmessage", Google's popup redirect).
 */
export async function loginWithGoogle(this: WebAuth, code?: string) {
  this.signedOutOnly();
  const value0 = typeof code === "string" ? code.trim() : "";
  if (!value0 || value0.length > 2048)
    throw bridgeError("Google didn’t finish signing you in. Try again.");
  const { value } = await this.post(webAuthRoutes.googleLogin, {
    code: value0,
    redirect_uri: "postmessage",
  });
  return this.signedIn(value);
}

export async function loginWithPasskey(this: WebAuth): Promise<PublicAccount> {
  this.signedOutOnly();
  const sign = this.env.passkey;
  if (!sign) throw bridgeError("This browser can't use passkeys.");
  const begin = record((await this.post(webAuthRoutes.passkeyBegin, {})).value);
  const sessionToken = text(begin?.session_token, 2000);
  if (!sessionToken)
    throw bridgeError("The service did not start a passkey sign-in.");
  const credential = await sign(begin?.options);
  const { value } = await this.post(webAuthRoutes.passkeyFinish, {
    session_token: sessionToken,
    credential,
  });
  const result = await this.signedIn(value);
  if ("twoFactorRequired" in result)
    throw bridgeError("The service asked for another code.");
  return result;
}

export async function register(
  this: WebAuth,
  email: string,
  password: string,
  _name: string,
  extras: RegisterExtras = {},
): Promise<PublicAccount> {
  this.signedOutOnly();
  const aff = this.env.sessionValue(affiliateKey);
  const { value } = await this.post(webAuthRoutes.register, {
    email: String(email).trim(),
    password: String(password),
    ...(extras.verifyCode ? { verify_code: extras.verifyCode.trim() } : {}),
    ...(extras.invitationCode
      ? { invitation_code: extras.invitationCode.trim() }
      : {}),
    ...(extras.promoCode ? { promo_code: extras.promoCode.trim() } : {}),
    ...(aff ? { aff_code: aff } : {}),
  });
  const result = await this.signedIn(value);
  if ("twoFactorRequired" in result)
    throw bridgeError("Sign in to finish creating your account.");
  return result;
}

export async function logout(this: WebAuth): Promise<AuthStatus> {
  const account = this.session?.account.id;
  try {
    // Only this account: the browser's others stay signed in.
    await this.post(
      webAuthRoutes.logout,
      account ? { account } : {},
      this.session?.accessToken,
    );
  } catch (error) {
    console.error(
      "The service did not confirm sign-out:",
      error instanceof Error ? error.message : String(error),
    );
  }
  this.set(undefined);
  if (account) this.leftAccount(account);
  this.tell({
    type: "signed-out",
    reason: "revoked",
    message: "You signed out in another tab.",
    account,
  });
  return this.signedOutStatus();
}

export async function revokeAll(this: WebAuth): Promise<AuthStatus> {
  const token = await this.accessToken();
  const account = this.session?.account.id;
  await this.post(webAuthRoutes.revokeAll, {}, token);
  this.set(undefined);
  if (account) this.leftAccount(account);
  this.tell({
    type: "signed-out",
    reason: "revoked",
    message: signedOutMessages.revoked,
    account,
  });
  return this.signedOutStatus();
}
