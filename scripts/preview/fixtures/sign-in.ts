/**
 * The signed-out pages. `signIn=<flags>` signs the fixture out against a
 * service ("Acme AI") offering what the comma-separated flags name: `codes`
 * (email-code sign-in), `reset` (password reset), `open` (registration with an
 * email code), `passkey`, `privacy` (a privacy policy link), `2fa` (the
 * password asks for an authenticator code). `signInRefuse=<state>` makes the
 * password step fail with that page: device-limit, disabled, backend-mode,
 * upgrade-required, unavailable. `signInBlocked=captcha|down` blocks the whole
 * page. On the desktop the page opens on its welcome screen; "Get started"
 * shows the card.
 */
import { codeMismatch } from "../../../shared/sign-in-errors";
import { signInMessages } from "../../../shared/sign-in-states";
import type {
  AuthStatus,
  PublicAccount,
  RemoteSignInPolicy,
} from "../../../shared/types";
import type { FixtureDomain } from "./index";

const refusals: Record<string, string> = {
  "device-limit":
    "You're signed in to Claudex on 5 devices, the most your account allows. Sign out on one of them, then sign in again.",
  disabled: signInMessages.disabled,
  "backend-mode": signInMessages.backendMode,
  "upgrade-required": signInMessages.upgradeRequired,
  unavailable: signInMessages.unavailable,
};

export const signInFixture: FixtureDomain = {
  params: {
    signIn:
      "codes,reset,open,passkey,privacy,2fa: a signed-out service offering these",
    signInRefuse:
      "device-limit | disabled | backend-mode | upgrade-required | unavailable",
    signInBlocked: "captcha | down: the service blocks the page",
  },
  bridge: ({ params }) => {
    const flags = params.get("signIn");
    if (flags === null) return {};
    const on = new Set(flags.split(","));
    const blocked = params.get("signInBlocked");
    const policy: RemoteSignInPolicy = {
      siteName: "Acme AI",
      registrationEnabled: on.has("open"),
      emailVerification: on.has("open"),
      invitationCode: false,
      promoCode: false,
      captchaRequired: blocked === "captcha",
      emailDomains: [],
      passwordReset: on.has("reset"),
      emailCodeLogin: on.has("codes"),
      passkey: on.has("passkey"),
      ...(on.has("privacy")
        ? { privacyPolicyUrl: "https://example.invalid/privacy" }
        : {}),
      ...(blocked === "down"
        ? { unavailable: "The Claudex service is unreachable." }
        : {}),
    };
    const account: PublicAccount = {
      id: "fixture-account",
      email: "fixture@example.invalid",
      name: "Ada",
      remote: true,
    };
    const status: AuthStatus = { hasAccounts: true, remote: policy };
    const refuse = params.get("signInRefuse");
    return {
      authStatus: async () => status,
      loginAccount: async () => {
        if (refuse && refusals[refuse]) throw Error(refusals[refuse]);
        if (on.has("2fa"))
          return { twoFactorRequired: true, maskedEmail: "z***@example.com" };
        return account;
      },
      sendSignInCode: async () => ({ countdown: 60 }),
      loginWithCode: async (_email, code) => {
        if (code !== "123456") throw Error(codeMismatch);
        return account;
      },
      requestPasswordReset: async () => {},
      resetPassword: async () => {},
      loginWithPasskey: async () => account,
    };
  },
};
