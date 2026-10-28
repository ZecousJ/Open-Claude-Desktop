import type { GoogleAuthorization } from "../account/google-sign-in";
import type { PublicAccount, RegisterExtras } from "../../shared/types";
import { type LoginResponse } from "./client";
import { signInExpired } from "../../shared/sign-in-errors";
import { Sub2ApiError } from "./http";
import { RemoteSession } from "./session";
import { remoteAccountId } from "./identity-support";
import { pendingChallengeMs } from "./identity-support";
import { signInError } from "./identity-support";
import { publicAccount } from "./identity-support";
import type { RemoteAccounts } from "./identity";
import type { SignIn } from "./identity";

export async function finish(
  this: RemoteAccounts,
  response: LoginResponse,
  email: string,
): Promise<SignIn> {
  if (response.kind === "twoFactor") {
    this.challenge = {
      tempToken: response.tempToken,
      email,
      expiresAt: this.now() + pendingChallengeMs,
    };
    return { kind: "twoFactor", maskedEmail: response.maskedEmail };
  }
  this.challenge = undefined;
  const user =
    response.user ?? (await this.client.me(response.tokens.accessToken));
  const accountId = this.remember(user);
  const session = new RemoteSession(
    this.client,
    this.file,
    {
      version: 1,
      baseUrl: this.baseUrl,
      accountId,
      userId: user.id,
      email: user.email,
      refreshToken: response.tokens.refreshToken,
    },
    response.tokens,
    this.now,
  );
  return {
    kind: "signedIn",
    session,
    account: publicAccount(accountId, user),
  };
}

export async function login(
  this: RemoteAccounts,
  email: string,
  password: string,
): Promise<SignIn> {
  try {
    return await this.finish(
      await this.client.login(email.trim(), password),
      email.trim(),
    );
  } catch (error) {
    throw signInError(error);
  }
}

export async function completeTwoFactor(
  this: RemoteAccounts,
  code: string,
): Promise<SignIn> {
  const challenge = this.challenge;
  if (!challenge || challenge.expiresAt <= this.now()) {
    this.challenge = undefined;
    throw Error(signInExpired);
  }
  if (!/^\d{6}$/.test(code))
    throw Error("Enter the 6-digit code from your authenticator app.");
  try {
    return await this.finish(
      await this.client.loginTwoFactor(challenge.tempToken, code),
      challenge.email,
    );
  } catch (error) {
    const refusal = signInError(error, true);
    // The service forgot the step: only starting again helps.
    if (refusal.message === signInExpired) this.challenge = undefined;
    throw refusal;
  }
}

export async function requestPasswordReset(
  this: RemoteAccounts,
  email: string,
) {
  try {
    await this.client.forgotPassword(email.trim());
  } catch (error) {
    throw signInError(error);
  }
}

export async function resetPassword(
  this: RemoteAccounts,
  email: string,
  token: string,
  password: string,
) {
  try {
    await this.client.resetPassword(email.trim(), token, password);
  } catch (error) {
    throw signInError(error);
  }
}

export async function sendSignInCode(
  this: RemoteAccounts,
  email: string,
  request?: import("../../shared/email-link").EmailLinkRequest,
) {
  try {
    return await this.client.sendSignInCode(email.trim(), request);
  } catch (error) {
    throw signInError(error);
  }
}

export async function loginWithCode(
  this: RemoteAccounts,
  email: string,
  code: string,
  request?: import("../../shared/email-link").EmailLinkRequest,
): Promise<SignIn> {
  if (!/^\d{6}$/.test(code.trim()))
    throw Error("Enter the 6-digit code from the email.");
  try {
    return await this.finish(
      await this.client.loginWithCode(email.trim(), code.trim(), request),
      email.trim(),
    );
  } catch (error) {
    throw signInError(error);
  }
}

/**
 * Continue with Google (LOGIN-GOOGLE): Google signs the person in in the
 * browser and hands this computer a code (google-sign-in.ts), which the
 * service exchanges for their account.
 */
export async function loginWithGoogle(
  this: RemoteAccounts,
  authorize: (clientId: string) => Promise<GoogleAuthorization>,
): Promise<SignIn> {
  const options = await this.client.signInOptions();
  if (!options.googleDesktopClientId)
    throw Error(
      "Signing in with Google is not available on this Claudex service.",
    );
  const authorization = await authorize(options.googleDesktopClientId);
  try {
    return await this.finish(
      await this.client.loginWithGoogle(authorization),
      "",
    );
  } catch (error) {
    throw signInError(error);
  }
}

export async function sendVerificationCode(
  this: RemoteAccounts,
  email: string,
) {
  try {
    return await this.client.sendVerifyCode(email.trim());
  } catch (error) {
    throw signInError(error);
  }
}

export async function register(
  this: RemoteAccounts,
  email: string,
  password: string,
  extras: RegisterExtras = {},
): Promise<SignIn> {
  const policy = await this.policy();
  if (policy.unavailable) throw Error(policy.unavailable);
  if (!policy.registrationEnabled)
    throw Error("Registration is closed on this Claudex service.");
  if (policy.emailVerification && !extras.verifyCode?.trim())
    throw Error("Enter the verification code sent to your email.");
  if (policy.invitationCode && !extras.invitationCode?.trim())
    throw Error("Enter your invitation code.");
  try {
    return await this.finish(
      await this.client.register({
        email: email.trim(),
        password,
        verifyCode: extras.verifyCode?.trim(),
        invitationCode: extras.invitationCode?.trim(),
        promoCode: policy.promoCode ? extras.promoCode?.trim() : undefined,
      }),
      email.trim(),
    );
  } catch (error) {
    throw signInError(error);
  }
}

/** The saved session for this service, renewed once to prove it is still valid. */
export async function restore(
  this: RemoteAccounts,
): Promise<{ session: RemoteSession; account: PublicAccount } | undefined> {
  const record = this.file.load();
  if (!record) {
    // The app closed while an account was being added: the account the
    // window had stays open (a plain log out opens the sign-in page).
    const adding = this.adding;
    if (!adding) return undefined;
    this.setAdding(undefined);
    try {
      return await this.resume(adding.from);
    } catch {
      return undefined;
    }
  }
  if (record.baseUrl !== this.baseUrl) return undefined;
  // A copy parked before a crash holds a spent token: the open file wins.
  this.parked.remove(record.accountId);
  const session = new RemoteSession(
    this.client,
    this.file,
    record,
    undefined,
    this.now,
  );
  try {
    await session.refresh();
    const user = await session.authorized((token) => this.client.me(token));
    if (remoteAccountId(this.baseUrl, user.id) !== record.accountId) {
      session.end();
      return undefined;
    }
    this.remember(user);
    return { session, account: publicAccount(record.accountId, user) };
  } catch (error) {
    // A refused token ends the saved session; an outage keeps it for next time.
    if (error instanceof Sub2ApiError && error.status === 401) session.end();
    throw signInError(error);
  }
}
