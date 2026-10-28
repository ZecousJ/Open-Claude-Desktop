/**
 * The account step after sign-up as pure functions (src/auth/ProfileStep.tsx
 * draws it, src/auth/ProfileStepGate.tsx decides when it shows), after the
 * original's combined "Let’s create your account" form.
 */
import {
  ageOn,
  isoToday,
  validBirthdate,
  type SignUpProfile,
} from "../../shared/account-profile-api";

export type ProfileField = "name" | "birthday" | "terms";

/** The original's sentence under each field. */
export const profileErrors = {
  name: "Enter your name to continue",
  invalidDate: "Enter a valid date",
  underage: "You cannot create an account",
  terms: "Agree to the terms to continue",
} as const;

export interface ProfileForm {
  name: string;
  birthdate: string;
  agreed: boolean;
}

/**
 * Whether the birthday is asked: once one is on record the service keeps
 * it, so a person accepting new terms is not asked again.
 */
export const asksBirthday = (profile: SignUpProfile) => !profile.birthdate;

/**
 * Accepting new terms rather than creating the account: the person has
 * accepted an earlier version.
 */
export const updatingTerms = (profile: SignUpProfile) =>
  Boolean(profile.termsVersion) &&
  profile.termsVersion !== profile.currentTermsVersion;

/**
 * Every field that stops the form, with its sentence, checked all at once
 * on submit as the original does (name, then birthday, then terms).
 */
export function profileFormErrors(
  form: ProfileForm,
  profile: SignUpProfile,
  today = isoToday(),
): Map<ProfileField, string> {
  const errors = new Map<ProfileField, string>();
  if (!form.name.trim()) errors.set("name", profileErrors.name);
  if (asksBirthday(profile)) {
    if (!validBirthdate(form.birthdate, today))
      errors.set("birthday", profileErrors.invalidDate);
    else if (ageOn(form.birthdate, today) < profile.minimumAge)
      errors.set("birthday", profileErrors.underage);
  }
  if (!form.agreed) errors.set("terms", profileErrors.terms);
  return errors;
}

/** The service's reasons that belong to a field (backend profile.go). */
export function fieldOfReason(code: unknown): ProfileField | undefined {
  switch (code) {
    case "CLAUDEX_PROFILE_NAME":
      return "name";
    case "CLAUDEX_PROFILE_BIRTHDATE":
    case "CLAUDEX_PROFILE_UNDERAGE":
      return "birthday";
    case "CLAUDEX_PROFILE_TERMS":
      return "terms";
    default:
      return undefined;
  }
}

/** Where this device remembers that an account finished the step. */
export const profileDoneKey = (accountId: string) =>
  `claudex.profile-done.${accountId}`;

/**
 * The terms version this device saw the account accept, so the app opens
 * at once next time while the service is asked again in the background.
 */
export function rememberedTerms(
  storage: Pick<Storage, "getItem"> | undefined,
  accountId: string,
): string {
  try {
    return storage?.getItem(profileDoneKey(accountId)) ?? "";
  } catch {
    return "";
  }
}

export function rememberTerms(
  storage: Pick<Storage, "setItem"> | undefined,
  accountId: string,
  version: string,
) {
  try {
    storage?.setItem(profileDoneKey(accountId), version);
  } catch {
    /* Without storage the service is asked before the app each time. */
  }
}

/**
 * A sentence with links: the translated template cut at its `{holes}`,
 * each hole replaced by `fill(name)`.
 */
export function splitTemplate<T>(
  template: string,
  fill: (name: string) => T,
): (string | T)[] {
  const out: (string | T)[] = [];
  let last = 0;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    if (match.index! > last) out.push(template.slice(last, match.index));
    out.push(fill(match[1]));
    last = match.index! + match[0].length;
  }
  if (last < template.length) out.push(template.slice(last));
  return out;
}
