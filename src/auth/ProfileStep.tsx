import { useState, type FormEvent, type ReactNode } from "react";
import {
  acceptableUseAnchor,
  isoToday,
  earliestBirthdate,
  type SignUpProfile,
} from "../../shared/account-profile-api";
import { formatText, useT } from "../i18n";
import { BusyLabel } from "./BusyLabel";
import { InfoIcon } from "../ui/icons";
import { useTooltip } from "../ui/Tooltip";
import { SignInFrame } from "./SignInFrame";
import {
  asksBirthday,
  fieldOfReason,
  profileFormErrors,
  splitTemplate,
  updatingTerms,
  type ProfileField,
} from "./profile-step-form";
import "./profile-step.css";

/**
 * The account step after sign-up, after the original's combined form: "Let’s
 * create your account" over "So Claudex knows what to call you.", the name
 * ("What is your name?", focused, prefilled from the account), the birthday
 * ("When is your birthday?" with its "We’ll use this to verify your account"
 * tip), the terms checkbox, and Create account. Every field is checked on
 * submit and each shows its own sentence, cleared as it is edited. Below the
 * card: the signed-in address and "Use a different email", which signs out.
 *
 * Differences: the birthday is the browser's date field (the original's is its
 * own segmented field without a calendar); there is no privacy or marketing
 * checkbox (the original shows them only in some regions, and Claudex sends no
 * marketing); an account accepting new terms keeps its birthday and reads
 * "Updates to the Terms of Service" with Continue.
 */
export function ProfileStep({
  profile,
  email,
  onDone,
  onUseDifferentEmail,
}: {
  profile: SignUpProfile;
  email: string;
  onDone: (profile: SignUpProfile) => void | Promise<void>;
  onUseDifferentEmail: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(profile.displayName);
  const [birthdate, setBirthdate] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [errors, setErrors] = useState<Map<ProfileField, string>>(new Map());
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const birthday = asksBirthday(profile);
  const updating = updatingTerms(profile);
  const tip = useTooltip(t("We’ll use this to verify your account"), {
    placement: "above",
    size: "wrap",
  });
  const clear = (field: ProfileField) =>
    setErrors((current) => {
      if (!current.has(field)) return current;
      const next = new Map(current);
      next.delete(field);
      return next;
    });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const found = profileFormErrors({ name, birthdate, agreed }, profile);
    setErrors(found);
    setFailure("");
    if (found.size) return;
    setBusy(true);
    try {
      await onDone(
        await window.desktop.saveSignUpProfile({
          name: name.trim(),
          birthdate: birthday ? birthdate : profile.birthdate,
          termsVersion: profile.currentTermsVersion,
        }),
      );
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      const field = fieldOfReason((reason as { code?: unknown })?.code);
      if (field) setErrors(new Map([[field, message]]));
      else setFailure(message);
      setBusy(false);
    }
  }
  const error = (field: ProfileField) =>
    errors.has(field) && (
      <p className="profile-field-error" role="alert">
        {t(errors.get(field)!)}
      </p>
    );
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {t(label)}
    </a>
  );
  const agreement: ReactNode[] = splitTemplate(
    t("I agree to the {terms} and {aup}."),
    (hole) =>
      hole === "terms"
        ? link(profile.termsUrl, "Terms of Service")
        : link(
            `${profile.termsUrl}#${acceptableUseAnchor}`,
            "Acceptable Use Policy",
          ),
  ).map((part, index) =>
    typeof part === "string" ? <span key={index}>{part}</span> : part,
  );
  return (
    <SignInFrame
      title={
        updating
          ? t("Updates to the Terms of Service")
          : t("Let’s create your account")
      }
      subtitle={t("So Claudex knows what to call you.")}
      below={
        <div className="signin-small profile-footer">
          <div>{formatText(t("Email verified as {email}"), { email })}</div>
          <button
            type="button"
            className="signin-link"
            onClick={onUseDifferentEmail}
          >
            {t("Use a different email")}
          </button>
        </div>
      }
    >
      <form className="profile-form" onSubmit={submit} noValidate>
        <div className="profile-field">
          <label className="profile-label" htmlFor="profile-name">
            {t("What is your name?")}
          </label>
          <input
            id="profile-name"
            className="signin-input"
            type="text"
            autoFocus
            autoCapitalize="words"
            autoComplete="name"
            maxLength={100}
            aria-invalid={errors.has("name") || undefined}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              clear("name");
            }}
            data-1p-ignore
          />
          {error("name")}
        </div>
        {birthday && (
          <div className="profile-field">
            <span className="profile-label-row">
              <label className="profile-label" htmlFor="profile-birthday">
                {t("When is your birthday?")}
              </label>
              <span
                className="profile-tip"
                tabIndex={0}
                aria-label={t("We’ll use this to verify your account")}
                {...tip.props}
              >
                <InfoIcon size={14} />
              </span>
              {tip.tooltip}
            </span>
            <input
              id="profile-birthday"
              className="signin-input"
              type="date"
              min={earliestBirthdate}
              max={isoToday()}
              aria-label={t("Enter your birthdate")}
              aria-invalid={errors.has("birthday") || undefined}
              value={birthdate}
              onChange={(event) => {
                setBirthdate(event.target.value);
                clear("birthday");
              }}
            />
            {error("birthday")}
          </div>
        )}
        <div className="profile-field">
          <label className="profile-check">
            <input
              type="checkbox"
              className="cx-check-input"
              checked={agreed}
              aria-invalid={errors.has("terms") || undefined}
              onChange={(event) => {
                setAgreed(event.target.checked);
                clear("terms");
              }}
            />
            <span>{agreement}</span>
          </label>
          {error("terms")}
        </div>
        {failure && (
          <p className="signin-error" role="alert">
            {failure}
          </p>
        )}
        <button
          className="signin-primary"
          type="submit"
          disabled={busy}
          aria-busy={busy || undefined}
          data-testid="continue"
        >
          <BusyLabel busy={busy} busyLabel={t("Please wait…")}>
            {updating ? t("Continue") : t("Create account")}
          </BusyLabel>
        </button>
      </form>
    </SignInFrame>
  );
}
