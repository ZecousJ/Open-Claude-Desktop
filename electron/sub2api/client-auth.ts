import {
  emailCodeRoutes,
  googleLoginRoute,
  parseSignInOptions,
  signInOptionsRoute,
  type SignInOptions,
} from "../../shared/sign-in-api";
import { Sub2ApiError } from "./http";
import { object } from "./client-support";
import { count } from "./client-support";
import { user } from "./client-support";
import { loginAnswer } from "./client-support";
import { tokens } from "./client-support";
import type { Sub2ApiClient } from "./client";
import type { TokenPair, LoginResponse } from "./client";

export async function login(
  this: Sub2ApiClient,
  email: string,
  password: string,
): Promise<LoginResponse> {
  return loginAnswer(
    await this.call("/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  );
}

/** What the sign-in page may offer; nothing on a service without the extension. */
export async function signInOptions(
  this: Sub2ApiClient,
): Promise<SignInOptions> {
  try {
    return parseSignInOptions(await this.call(signInOptionsRoute));
  } catch (error) {
    if (error instanceof Sub2ApiError && error.status === 404)
      return { emailCodeLogin: false };
    throw error;
  }
}

export async function forgotPassword(this: Sub2ApiClient, email: string) {
  await this.call("/auth/forgot-password", {
    method: "POST",
    body: { email },
  });
}

export async function resetPassword(
  this: Sub2ApiClient,
  email: string,
  token: string,
  newPassword: string,
) {
  await this.call("/auth/reset-password", {
    method: "POST",
    body: { email, token, new_password: newPassword },
  });
}

export async function sendSignInCode(
  this: Sub2ApiClient,
  email: string,
  request?: import("../../shared/email-link").EmailLinkRequest,
) {
  const data = object(
    await this.call(emailCodeRoutes.send, {
      method: "POST",
      body: { email, ...request },
    }),
  );
  return {
    countdown: Math.max(0, Math.min(count(data.countdown) || 60, 3600)),
  };
}

export async function loginWithCode(
  this: Sub2ApiClient,
  email: string,
  code: string,
  request?: import("../../shared/email-link").EmailLinkRequest,
): Promise<LoginResponse> {
  return loginAnswer(
    await this.call(emailCodeRoutes.login, {
      method: "POST",
      body: { email, code, ...request, ...(request ? { link: true } : {}) },
    }),
  );
}

/** The desktop Google sign-in's code, exchanged by the service (LOGIN-GOOGLE). */
export async function loginWithGoogle(
  this: Sub2ApiClient,
  authorization: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
): Promise<LoginResponse> {
  return loginAnswer(
    await this.call(googleLoginRoute, {
      method: "POST",
      body: {
        code: authorization.code,
        code_verifier: authorization.codeVerifier,
        redirect_uri: authorization.redirectUri,
      },
    }),
  );
}

export async function loginTwoFactor(
  this: Sub2ApiClient,
  tempToken: string,
  code: string,
): Promise<LoginResponse> {
  const data = object(
    await this.call("/auth/login/2fa", {
      method: "POST",
      body: { temp_token: tempToken, totp_code: code },
    }),
  );
  return { kind: "tokens", tokens: tokens(data), user: user(data.user) };
}

export async function register(
  this: Sub2ApiClient,
  input: {
    email: string;
    password: string;
    verifyCode?: string;
    invitationCode?: string;
    promoCode?: string;
  },
): Promise<LoginResponse> {
  const data = object(
    await this.call("/auth/register", {
      method: "POST",
      body: {
        email: input.email,
        password: input.password,
        ...(input.verifyCode ? { verify_code: input.verifyCode } : {}),
        ...(input.invitationCode
          ? { invitation_code: input.invitationCode }
          : {}),
        ...(input.promoCode ? { promo_code: input.promoCode } : {}),
      },
    }),
  );
  return { kind: "tokens", tokens: tokens(data), user: user(data.user) };
}

export async function sendVerifyCode(this: Sub2ApiClient, email: string) {
  const data = object(
    await this.call("/auth/send-verify-code", {
      method: "POST",
      body: { email },
    }),
  );
  return { countdown: Math.max(0, Math.min(count(data.countdown), 3600)) };
}

export async function refresh(
  this: Sub2ApiClient,
  refreshToken: string,
): Promise<TokenPair> {
  return tokens(
    await this.call("/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
    }),
  );
}

export async function logout(this: Sub2ApiClient, refreshToken: string) {
  await this.call("/auth/logout", {
    method: "POST",
    body: { refresh_token: refreshToken },
  });
}

export async function revokeAllSessions(
  this: Sub2ApiClient,
  accessToken: string,
) {
  await this.call("/auth/revoke-all-sessions", {
    method: "POST",
    token: accessToken,
    body: {},
  });
}

export async function deleteAccount(
  this: Sub2ApiClient,
  accessToken: string,
): Promise<void> {
  await this.call("/claudex/account", {
    method: "DELETE",
    token: accessToken,
  });
}
