/**
 * The sign-in page's calls beyond email and password: the password reset email,
 * signing in with a code sent by email (a Claudex extension, offered only when
 * the administrator turned it on and the service can send email) and passkeys
 * (web only).
 *
 * Also what the desktop main process and the web bridge share: the public
 * sign-in options endpoint. The refusals with a page of their own are in
 * sign-in-states.ts.
 */
import { bridgeMethods } from "./bridge-methods";
import type { AuthStatus, PublicAccount, TwoFactorChallenge } from "./types";
import type { EmailLinkRequest } from "./email-link";

export interface SignInAPI {
  /**
   * Desktop, signed out, with no service chosen: signs in to the service at
   * this address from now on, once it answers as one.
   */
  setServiceAddress(address: string): Promise<AuthStatus>;
  /** Sends the password reset link. */
  requestPasswordReset(email: string): Promise<void>;
  /** Sets a new password with the emailed link's token (Sub2API `reset-password`). */
  resetPassword(email: string, token: string, password: string): Promise<void>;
  /** Sends a code and, with a request proof, its one-time sign-in link (10 minutes). */
  sendSignInCode(
    email: string,
    request?: EmailLinkRequest,
  ): Promise<{ countdown: number }>;
  /** A link supplies the requesting window's proof; manual codes omit it. 2FA still applies. */
  loginWithCode(
    email: string,
    code: string,
    request?: EmailLinkRequest,
  ): Promise<PublicAccount | TwoFactorChallenge>;
  /** Signs in with a passkey (web only; the desktop refuses). */
  loginWithPasskey(): Promise<PublicAccount>;
  /**
   * The signed-in account's passkeys (web): how many it has; null where the
   * service or this browser doesn't offer passkeys.
   */
  accountPasskeys(): Promise<{ count: number } | null>;
  /**
   * Makes a passkey on this device for the signed-in account, which the
   * service asks the account's password for first (web).
   */
  setUpPasskey(password: string): Promise<void>;
  /**
   * Continue with Google (LOGIN-GOOGLE). The web passes the code Google's
   * popup code client gave; the desktop opens Google in the browser itself and
   * takes no argument. 2FA still applies.
   */
  loginWithGoogle(code?: string): Promise<PublicAccount | TwoFactorChallenge>;
  /** Desktop: stops waiting for the browser's Google sign-in (the web has nothing to stop). */
  cancelGoogleSignIn(): Promise<void>;
  /**
   * The accounts used in this browser, or signed in to this computer (the
   * desktop with a Claudex service; an account on this computer only
   * answers none and a limit of one): the account menu's other accounts
   * and the signed-out page's "Choose an account".
   */
  browserAccounts(): Promise<BrowserAccounts>;
  /**
   * Makes another account this browser is signed in to the window's
   * account (its own session; the current one stays signed in). Refused
   * with `signInAgainCode` when that account's session has ended.
   */
  switchAccount(id: string): Promise<PublicAccount>;
  /**
   * Leaves the current account signed in and shows the sign-in page for
   * another one; `email` fills it in (an account to sign in to again).
   */
  addAccount(email?: string): Promise<void>;
  /** Gives up adding an account: the window goes back to its account. */
  cancelAddAccount(): Promise<void>;
  /** "Remove {email} from this device": signs that account out here and forgets it. */
  forgetBrowserAccount(id: string): Promise<void>;
}

/** An account used in this browser (web; several accounts per browser). */
export interface BrowserAccount {
  id: string;
  email: string;
  name: string;
  /** This browser still holds the account's session. */
  signedIn: boolean;
  /** Its session ended without a log out: the menu offers to sign in again. */
  signInAgain?: boolean;
}

export interface BrowserAccounts {
  /** The window's own account, when it is signed in. */
  current?: string;
  /** Most recently used first; the window's own account included. */
  accounts: BrowserAccount[];
  /** How many accounts this browser can be signed in to at once (1: no switching). */
  maxAccounts: number;
  /** The sign-in page is adding an account (the current one stays signed in). */
  adding?: { email?: string };
}

/** The error code of a switch to an account whose session has ended. */
export const signInAgainCode = "CLAUDEX_WEB_SIGN_IN_AGAIN";

/**
 * A switch refused because the account's session ended: the web bridge
 * sets `code`, the desktop's IPC carries only the message, which is the
 * code itself.
 */
export function needsSignInAgain(error: unknown) {
  const value = error as { code?: unknown; message?: unknown } | undefined;
  return value?.code === signInAgainCode || value?.message === signInAgainCode;
}

/**
 * How many accounts the desktop app holds signed in at once, as the web's
 * browser does (`max_accounts`, the service's CLAUDEX_WEB_ACCOUNT_LIMIT).
 */
export const desktopMaxAccounts = 5;

/** None: an account on this computer only (no Claudex service) cannot switch. */
export const noBrowserAccounts: BrowserAccounts = {
  accounts: [],
  maxAccounts: 1,
};

/** The accounts this browser is signed in to, its own included. */
export function signedInAccounts(list: BrowserAccounts) {
  return list.accounts.filter((account) => account.signedIn);
}

/** "Add account" is off once the browser holds as many accounts as it can. */
export function atAccountCap(list: BrowserAccounts) {
  return signedInAccounts(list).length >= list.maxAccounts;
}

export const signInMethods = bridgeMethods<SignInAPI>({
  setServiceAddress: true,
  requestPasswordReset: true,
  resetPassword: true,
  sendSignInCode: true,
  loginWithCode: true,
  loginWithPasskey: true,
  accountPasskeys: true,
  setUpPasskey: true,
  loginWithGoogle: true,
  cancelGoogleSignIn: true,
  browserAccounts: true,
  switchAccount: true,
  addAccount: true,
  cancelAddAccount: true,
  forgetBrowserAccount: true,
});

/** Public, under `/api/v1`: what the sign-in page may offer (Claudex extension). */
export const signInOptionsRoute = "/claudex/sign-in/options";
/** Desktop email-code sign-in, under `/api/v1` (the web app uses webAuthRoutes). */
export const emailCodeRoutes = {
  send: "/claudex/auth/email-code/send",
  login: "/claudex/auth/email-code/login",
} as const;
/** Desktop Google sign-in, under `/api/v1` (the web app uses webAuthRoutes). */
export const googleLoginRoute = "/claudex/auth/google/login";

export interface SignInOptions {
  emailCodeLogin: boolean;
  /** The web Google button's client id, when Google sign-in is on. */
  googleClientId?: string;
  /** The desktop's Google client id, when the desktop may sign in with Google. */
  googleDesktopClientId?: string;
  /** An https URL or a path on the service ("/legal/privacy"). */
  privacyPolicyUrl?: string;
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};

/** The data of `GET /api/v1/claudex/sign-in/options`; anything else offers nothing. */
export function parseSignInOptions(value: unknown): SignInOptions {
  const data = record(value);
  const url =
    typeof data.privacy_policy_url === "string"
      ? data.privacy_policy_url.trim()
      : "";
  const clientId = (value: unknown) =>
    typeof value === "string" &&
    /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/.test(value)
      ? value
      : undefined;
  const web = clientId(data.google_client_id);
  const desktop = clientId(data.google_desktop_client_id);
  return {
    emailCodeLogin: data.email_code_login === true,
    ...(web ? { googleClientId: web } : {}),
    ...(desktop ? { googleDesktopClientId: desktop } : {}),
    ...(url.length <= 2000 && /^(https:\/\/[^\s]+|\/(?!\/)[^\s]*)$/i.test(url)
      ? { privacyPolicyUrl: url }
      : {}),
  };
}

/**
 * The privacy policy link: the administrator's, else the first sign-in
 * agreement document Sub2API publishes (`/legal/<id>`), else none.
 */
export function privacyPolicyUrl(
  options: SignInOptions,
  settings: unknown,
): string | undefined {
  if (options.privacyPolicyUrl) return options.privacyPolicyUrl;
  const documents = record(settings).login_agreement_documents;
  if (!Array.isArray(documents)) return undefined;
  const id = record(documents[0]).id;
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id)
    ? `/legal/${id}`
    : undefined;
}
