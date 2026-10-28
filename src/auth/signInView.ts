/**
 * What the sign-in page shows: pure functions of the account status, so each
 * step and refusal can be tested without a window. SignInPage.tsx renders them.
 *
 * A Sub2API service signs in like claude.ai: the email first, then the password
 * (or a code sent by email, when the administrator offers it), then the
 * authenticator code when the account has 2FA. Local accounts (a desktop
 * without a service) keep one email-and-password card.
 */
import { surface, type HostSurface } from "../../shared/host";
import type { StartMode } from "./startMode";
export type { StartMode } from "./startMode";
import type { AccountState } from "../../shared/sign-in-states";
import { signInErrorMessages } from "../../shared/sign-in-errors";
import type { AuthStatus, RemoteSignInPolicy } from "../../shared/types";

export type AuthStep =
  /** Service: the email address. */
  | "email"
  /** Service: the password for that address. */
  | "password"
  /** Service: the code sent by email (email-code sign-in). */
  | "code"
  | "emailSent"
  /** The authenticator code after the password or email code. */
  | "twoFactor"
  /** A new account (service or local). */
  | "create"
  /** Service: the registration code sent by email. */
  | "createVerify"
  /** Service: ask for the password reset link. */
  | "forgot"
  /** Service: the reset link was sent. */
  | "forgotSent"
  /** Service: a new password from the emailed link (`/reset-password`). */
  | "reset"
  /** Service: the new password is set. */
  | "resetDone"
  /** Local accounts: email and password on one card. */
  | "login";

export type AuthField =
  "name" | "email" | "password" | "invitationCode" | "promoCode";

/** The large serif heading and its subtitle (ref-login-email). */
export const hero = {
  title: "Question what’s next",
  subtitle: "Your thinking partner for big ambitions",
} as const;

/**
 * The desktop's signed-out pages: a short serif heading above the card in place
 * of the web page's hero, and a welcome screen before it.
 */
export const desktopHeading = "Sign In";

/** The welcome screen's words; `{platform}` is Mac, Windows or Linux. */
export const welcome = {
  title: "Claudex for {platform}",
  tagline: "The fastest way to talk with Claudex",
  action: "Get started",
} as const;

/** The platform the welcome screen names (the original says Windows when unsure). */
export function welcomePlatform(
  platform: "darwin" | "win32" | "linux" | undefined,
): "Mac" | "Windows" | "Linux" {
  return platform === "darwin"
    ? "Mac"
    : platform === "linux"
      ? "Linux"
      : "Windows";
}

/**
 * Whether the desktop's sign-in page opens on the welcome screen. The
 * original shows it each time its sign-in page opens on the desktop; here
 * a pending 2FA step or a service that refuses sign-in skips it.
 */
export function opensOnWelcome(
  status: AuthStatus,
  host: HostSurface = surface,
): boolean {
  if (host === "web" || status.twoFactorPending) return false;
  return !blockedPage(status, "desktop");
}

/**
 * The heading and subtitle above the card: the web page's hero (or the
 * state page's own), and on the desktop "Sign In" (or the state page's
 * title, with its subtitle below in muted text).
 */
export function frameHeading(
  page: Pick<StatePage, "title" | "subtitle"> | undefined,
  host: HostSurface = surface,
): { title: string; subtitle: string } {
  if (page) return { title: page.title, subtitle: page.subtitle };
  return host === "web" ? { ...hero } : { title: desktopHeading, subtitle: "" };
}

/**
 * The step the page starts on: the 2FA step while one is pending, creating
 * an account when there is none yet (local) or when the web app was opened
 * at `/register` and the service takes registrations, else the email step
 * (local accounts: the sign-in card).
 */
export function initialStep(status: AuthStatus, wanted?: StartMode): AuthStep {
  if (status.twoFactorPending) return "twoFactor";
  if (wanted === "create" && status.remote?.registrationEnabled)
    return "create";
  if (wanted === "reset" && status.remote) return "reset";
  if (wanted === "forgot" && status.remote?.passwordReset) return "forgot";
  if (status.remote) return "email";
  return status.hasAccounts ? "login" : "create";
}

/** Shortest password Sub2API accepts (`binding:"min=6"`); local accounts ask 12. */
export const passwordMin = (status: AuthStatus) => (status.remote ? 6 : 12);

/** The inputs of the create step. The registration code has its own step. */
export function createFields(status: AuthStatus): AuthField[] {
  const policy = status.remote;
  if (!policy) return ["name", "email", "password"];
  const fields: AuthField[] = ["email", "password"];
  if (policy.invitationCode) fields.push("invitationCode");
  if (policy.promoCode) fields.push("promoCode");
  return fields;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Why an address cannot be used, or undefined when it can. */
export function emailProblem(
  email: string,
  policy?: RemoteSignInPolicy,
  creating = false,
): string | undefined {
  const value = email.trim();
  // The email field's valueMissing line.
  if (!value) return "Email address is required";
  if (value.length > 254 || !emailPattern.test(value))
    return signInErrorMessages.INVALID_EMAIL;
  const domains = creating ? (policy?.emailDomains ?? []) : [];
  if (
    domains.length &&
    !domains.some((domain) =>
      value.toLowerCase().endsWith(domain.toLowerCase().replace(/^@?/, "@")),
    )
  )
    return `Use an address at ${domains.join(", ")}.`;
  return undefined;
}

/** "By continuing, you acknowledge <service>'s Privacy Policy." */
export function privacyNote(
  policy?: RemoteSignInPolicy,
): { service: string; url: string } | undefined {
  if (!policy?.privacyPolicyUrl) return undefined;
  return {
    service: policy.siteName.trim() || "Claudex",
    url: policy.privacyPolicyUrl,
  };
}

/** A refusal that replaces the form with a page of its own. */
export type StateKind = AccountState | "captcha";

export interface StatePage {
  kind: StateKind;
  title: string;
  subtitle: string;
  /** The service's own sentence, when it says more than the subtitle. */
  detail?: string;
  /** The primary button. */
  action: { label: string; does: "retry" | "restart" | "update" };
}

/**
 * The page for a refusal: too many devices, a disabled account, backend
 * mode, an outdated app, the service down, or a captcha this app cannot
 * show.
 */
export function statePage(
  kind: StateKind,
  detail = "",
  host: HostSurface = surface,
): StatePage {
  const extra = detail.trim().slice(0, 300) || undefined;
  switch (kind) {
    case "device-limit":
      return {
        kind,
        title: "Too many devices",
        subtitle: "Your account is signed in on as many devices as it allows.",
        detail: extra,
        action: { label: "Back to sign in", does: "restart" },
      };
    case "disabled":
      return {
        kind,
        title: "Account disabled",
        subtitle: "This account can't sign in right now.",
        detail:
          extra ?? "Contact your administrator to turn your account back on.",
        action: { label: "Use a different account", does: "restart" },
      };
    case "backend-mode":
      return {
        kind,
        title: "Sign-in is paused",
        subtitle: "Only administrators can sign in to this service right now.",
        detail: "Contact your administrator, or try again later.",
        action: { label: "Try again", does: "retry" },
      };
    case "upgrade-required":
      return {
        kind,
        title: "Update Claudex",
        subtitle: "This version of Claudex is too old for this service.",
        detail:
          host === "web"
            ? "Reload the page to get the latest version, then sign in again."
            : "Install the latest version of Claudex, then sign in again.",
        action:
          host === "web"
            ? { label: "Reload", does: "retry" }
            : { label: "Check for updates", does: "update" },
      };
    case "unavailable":
      return {
        kind,
        title: "Claudex is unavailable",
        subtitle:
          "The service is down for maintenance or can't be reached right now.",
        detail: extra,
        action: { label: "Try again", does: "retry" },
      };
    case "captcha":
      return {
        kind,
        title: "Sign-in needs a captcha",
        subtitle:
          host === "web"
            ? "This service asks for a captcha check that Claudex on the web cannot show yet."
            : "This service asks for a captcha check that Claudex cannot show.",
        detail:
          host === "web"
            ? "Ask your administrator to turn it off."
            : "Ask your administrator to turn it off for desktop sign-in.",
        action: { label: "Try again", does: "retry" },
      };
  }
}

/** The page the service's policy puts in place of the form, if any. */
export function blockedPage(
  status: AuthStatus,
  host: HostSurface = surface,
): StatePage | undefined {
  const policy = status.remote;
  if (!policy) return undefined;
  if (policy.unavailable)
    return statePage("unavailable", policy.unavailable, host);
  if (policy.captchaRequired) return statePage("captcha", "", host);
  return undefined;
}

export {
  sessionEndedLine,
  signedOutNotice,
  type SignedOutNotice,
  type SignedOutReason,
} from "./signedOut";
