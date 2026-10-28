/**
 * The account step after sign-up, after the original's "Let’s create your
 * account": the name Claudex calls the person, their birthday with the age
 * gate, and their acceptance of the Claudex Terms of Service. The service keeps
 * them (GET/PUT /api/v1/claudex/account-profile,
 * backend/backend/internal/claudex/profile); an account whose accepted terms
 * are not the current ones sees the step before the app.
 *
 * The desktop asks from the main process with the session's token, the web app
 * from the page; both read the answer with `accountProfileFrom`.
 */
import { bridgeMethods } from "./bridge-methods";
import type { ActionVerificationResult } from "./action-verification";

/**
 * Where the Terms of Service are read: the site's legal page
 * (backend/docs/legal/terms.*.md), beside the administrator's privacy policy
 * under /legal/.
 */
export const termsPath = "/legal/terms";
/** Its Acceptable Use section. */
export const acceptableUseAnchor = "acceptable-use";
/** The service's route, under the site root. */
export const accountProfilePath = "/api/v1/claudex/account-profile";
/** The original's minimum age when the service names none. */
export const defaultMinimumAge = 18;

export interface SignUpProfile {
  /** What Claudex calls the person; prefilled from the account's name. */
  displayName: string;
  /** YYYY-MM-DD, or "" before the step. */
  birthdate: string;
  /** The terms version the account accepted, "" for none. */
  termsVersion: string;
  /** When it accepted them (ms since the epoch). */
  termsAcceptedAt: number | null;
  /** The service's current terms version. */
  currentTermsVersion: string;
  minimumAge: number;
  /** Name, birthday and the current terms are on record: no step. */
  complete: boolean;
  /** The Terms of Service page, absolute (the service's /legal/terms). */
  termsUrl: string;
}

export interface SignUpProfileInput {
  name: string;
  /** YYYY-MM-DD. */
  birthdate: string;
  /** The version shown, accepted with the checkbox. */
  termsVersion: string;
}

export interface AccountProfileAPI {
  sendActionVerification(): Promise<ActionVerificationResult>;
  confirmActionVerification(code: string): Promise<ActionVerificationResult>;
  /** Null for an account without a Claudex service (or one too old to keep it). */
  signUpProfile(): Promise<SignUpProfile | null>;
  /** Saves the step; the service checks the name, the age and the version. */
  saveSignUpProfile(input: SignUpProfileInput): Promise<SignUpProfile>;
}

export const accountProfileMethods = bridgeMethods<AccountProfileAPI>({
  sendActionVerification: true,
  confirmActionVerification: true,
  signUpProfile: true,
  saveSignUpProfile: true,
});

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.trim().slice(0, limit) : "";
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const version = /^[A-Za-z0-9._-]{1,32}$/;

/** The service's answer (`{display_name, birthdate, …}`), checked. */
export function accountProfileFrom(
  value: unknown,
  termsUrl: string,
): SignUpProfile {
  const v = (
    value && typeof value === "object" && !Array.isArray(value) ? value : {}
  ) as Record<string, unknown>;
  const birthdate = text(v.birthdate, 10);
  const accepted = text(v.terms_version, 32);
  const current = text(v.current_terms_version, 32);
  const at =
    typeof v.terms_accepted_at === "string"
      ? Date.parse(v.terms_accepted_at)
      : NaN;
  const age = v.minimum_age;
  return {
    displayName: text(v.display_name, 100),
    birthdate: isoDate.test(birthdate) ? birthdate : "",
    termsVersion: version.test(accepted) ? accepted : "",
    termsAcceptedAt: Number.isFinite(at) ? at : null,
    currentTermsVersion: version.test(current) ? current : "",
    minimumAge:
      typeof age === "number" && Number.isInteger(age) && age > 0 && age < 100
        ? age
        : defaultMinimumAge,
    complete: v.complete === true,
    termsUrl,
  };
}

/** The original's earliest birthday. */
export const earliestBirthdate = "1900-01-01";

/** Today as YYYY-MM-DD in the person's own time zone. */
export function isoToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * A birthday the field can hold: a real YYYY-MM-DD date from 1900-01-01 to
 * today.
 */
export function validBirthdate(value: string, today = isoToday()): boolean {
  if (!isoDate.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  )
    return false;
  return value >= earliestBirthdate && value <= today;
}

/** Whole years from the birthday to today (both YYYY-MM-DD). */
export function ageOn(birthdate: string, today = isoToday()): number {
  const [by, bm, bd] = birthdate.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** The PUT body the service reads. */
export function accountProfileBody(input: SignUpProfileInput) {
  return {
    display_name: input.name.trim(),
    birthdate: input.birthdate,
    accept_terms_version: input.termsVersion,
  };
}
