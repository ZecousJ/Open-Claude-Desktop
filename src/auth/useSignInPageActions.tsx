import { useEffect } from "react";
import type { FormEvent } from "react";
import {
  emailProblem,
  passwordMin,
  initialStep,
  blockedPage,
  frameHeading,
} from "./signInView";
import { rememberLoginMethod } from "./signin-env";
import { offlineWaitOf, offlineNotes } from "./whenOnline";
import type { StatePage, AuthField, AuthStep } from "./signInView";
import { t, formatText } from "../i18n";
import { BusyLabel } from "./BusyLabel";
import { placeholders } from "./SignInPage";
import { AppIcon } from "../ui/app-icon";
import { signInFailed } from "../../shared/sign-in-errors";
import { SignInFallback, TextLink } from "./SignInFrame";
import type { BrowserAccount } from "../../shared/sign-in-api";
import type { EmailLink } from "../../shared/email-link";
import type { OfflineWait } from "./whenOnline";
import type {
  PublicAccount,
  TwoFactorChallenge,
  AuthStatus,
  RemoteSignInPolicy,
} from "../../shared/types";
import type { SignInValues } from "./SignInSteps";

/** What useSignInPageActions needs from SignInPage.tsx. */
export interface UseSignInPageActionsKit {
  adding: { email?: string | undefined } | undefined;
  addingFor: BrowserAccount | undefined;
  busy: boolean;
  confirm: string;
  countdown: number;
  email: string;
  error: string;
  focus: React.RefObject<HTMLInputElement | null>;
  go: (next: AuthStep) => void;
  linkFallback: EmailLink | undefined;
  offline: OfflineWait | undefined;
  onRetry: () => void;
  onSignedIn: (account: PublicAccount) => void;
  policy: RemoteSignInPolicy | undefined;
  resetLink: { email: string; token: string } | undefined;
  run: (
    task: () => Promise<void>,
    wait?: OfflineWait | undefined,
  ) => Promise<void>;
  sendCode: (kind: "sign-in" | "register") => Promise<void>;
  sent: string;
  set: (field: keyof SignInValues, value: string) => void;
  setCodeAutoFocus: React.Dispatch<React.SetStateAction<boolean>>;
  setError: React.Dispatch<React.SetStateAction<string>>;
  setSent: React.Dispatch<React.SetStateAction<string>>;
  setShowNotice: React.Dispatch<React.SetStateAction<boolean>>;
  setState: React.Dispatch<React.SetStateAction<StatePage | undefined>>;
  setStep: React.Dispatch<React.SetStateAction<AuthStep>>;
  setValues: React.Dispatch<React.SetStateAction<SignInValues>>;
  signedIn: (result: PublicAccount | TwoFactorChallenge) => void;
  state: StatePage | undefined;
  status: AuthStatus;
  step: AuthStep;
  values: SignInValues;
}

export function useSignInPageActions(kit: UseSignInPageActionsKit) {
  const {
    adding,
    addingFor,
    busy,
    confirm,
    countdown,
    email,
    error,
    focus,
    go,
    linkFallback,
    offline,
    onRetry,
    onSignedIn,
    policy,
    resetLink,
    run,
    sendCode,
    sent,
    set,
    setCodeAutoFocus,
    setError,
    setSent,
    setShowNotice,
    setState,
    setStep,
    setValues,
    signedIn,
    state,
    status,
    step,
    values,
  } = kit;
  useEffect(() => {
    if (step !== "emailSent") return;
    // .
    const timer = setTimeout(() => {
      setCodeAutoFocus(false);
      go("code");
    }, 5000);
    return () => clearTimeout(timer);
  }, [step]);
  function resend(kind: "sign-in" | "register") {
    if (countdown > 0) {
      setSent(`You can send another code in ${countdown}s.`);
      return;
    }
    void run(async () => {
      await sendCode(kind);
      setSent(`We sent a new code to ${email}.`);
    }, "send");
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setShowNotice(false);
    const problem =
      step === "email" ||
      step === "forgot" ||
      step === "create" ||
      step === "login"
        ? emailProblem(values.email, policy, step === "create")
        : undefined;
    if (problem) {
      setError(problem);
      return;
    }
    void run(
      async () => {
        switch (step) {
          case "email":
            if (policy?.emailCodeLogin) {
              await sendCode("sign-in");
              go("emailSent");
            } else go("password");
            return;
          case "password":
          case "login": {
            const result = await window.desktop.loginAccount(
              email,
              values.password,
            );
            rememberLoginMethod("email");
            signedIn(result);
            return;
          }
          case "code": {
            const result = await window.desktop.loginWithCode(
              email,
              values.code,
            );
            rememberLoginMethod("email");
            signedIn(result);
            return;
          }
          case "twoFactor":
            onSignedIn(await window.desktop.completeTwoFactor(values.code));
            return;
          case "create":
            if (values.password.length < passwordMin(status)) {
              setError(
                `Use at least ${passwordMin(status)} characters for your password.`,
              );
              return;
            }
            if (policy?.emailVerification) {
              await sendCode("register");
              setStep("createVerify");
              setValues((current) => ({ ...current, code: "" }));
              return;
            }
            onSignedIn(await register());
            return;
          case "createVerify":
            onSignedIn(await register(values.code));
            return;
          case "forgot":
            await window.desktop.requestPasswordReset(email);
            go("forgotSent");
            return;
          case "reset":
            if (values.password.length < passwordMin(status)) {
              setError(
                `Use at least ${passwordMin(status)} characters for your password.`,
              );
              return;
            }
            if (values.password !== confirm) {
              setError("The two passwords don't match.");
              return;
            }
            await window.desktop.resetPassword(
              resetLink?.email ?? email,
              resetLink?.token ?? "",
              values.password,
            );
            // The link is spent: the address goes back to the sign-in page.
            if (location.pathname !== "/login")
              history.replaceState(history.state, "", "/login");
            go("resetDone");
            return;
        }
      },
      offlineWaitOf(step, Boolean(policy?.emailCodeLogin)),
    );
  }
  function register(verifyCode?: string) {
    return window.desktop.registerAccount(
      email,
      values.password,
      values.name,
      policy
        ? {
            verifyCode: verifyCode?.trim() || undefined,
            invitationCode: values.invitationCode.trim() || undefined,
            promoCode: values.promoCode.trim() || undefined,
          }
        : undefined,
    );
  }
  /** Continue with Google: the web popup's code, or the desktop's browser sign-in. */
  function google(code?: string) {
    setShowNotice(false);
    void run(async () => {
      const result = await window.desktop.loginWithGoogle(code);
      rememberLoginMethod("google");
      signedIn(result);
    });
  }
  function passkey() {
    setShowNotice(false);
    void run(async () => {
      const account = await window.desktop.loginWithPasskey();
      rememberLoginMethod("passkey");
      onSignedIn(account);
    });
  }
  function stateAction(page: StatePage) {
    setError("");
    if (page.action.does === "update") {
      // A staged update installs on relaunch; otherwise the check starts
      // the download and the page offers the same button again.
      void run(async () => {
        const update = await window.desktop.checkForAppUpdate?.();
        if (update?.phase === "ready") await window.desktop.relaunchToUpdate();
        else {
          throw Error(
            update?.phase === "downloading" || update?.phase === "checking"
              ? "Downloading the update. Try again in a moment."
              : (update?.error ??
                  "No update is available yet. Contact your administrator."),
          );
        }
      });
      return;
    }
    setState(undefined);
    if (page.action.does === "retry") {
      onRetry();
      return;
    }
    go(initialStep({ ...status, twoFactorPending: false }));
  }

  const blocked = blockedPage(status);
  const page = state ?? blocked;
  const heading = frameHeading(page);
  // Adding an account (the account menu): its own heading, naming the account
  // that stays signed in.
  const { title, subtitle } = linkFallback
    ? {
        title: t("Use verification code to continue"),
        subtitle: t(
          "Enter this verification code where you first tried to sign in",
        ),
      }
    : adding && !page
      ? {
          title: "Add another account",
          subtitle: addingFor
            ? formatText("You’re still signed in as {email}.", {
                email: addingFor.email,
              })
            : "",
        }
      : heading;

  const input = (
    field: AuthField | "code",
    options: {
      placeholder?: string;
      autoFocus?: boolean;
      type?: string;
      autoComplete?: string;
      code?: boolean;
    } = {},
  ) => (
    <input
      key={field}
      ref={options.autoFocus ? focus : undefined}
      className={`signin-input${options.code ? " signin-code-input" : ""}`}
      aria-label={
        options.placeholder ??
        (field === "code" ? "Verification code" : placeholders[field])
      }
      placeholder={
        options.placeholder ??
        (field === "code" ? "Enter verification code" : placeholders[field])
      }
      type={options.type ?? (field === "email" ? "email" : "text")}
      inputMode={options.code ? "numeric" : undefined}
      autoComplete={options.autoComplete ?? "off"}
      maxLength={
        options.code
          ? 6
          : field === "email"
            ? 254
            : field === "name"
              ? 100
              : 256
      }
      required={field !== "promoCode"}
      value={values[field]}
      onChange={(event) =>
        set(
          field,
          options.code
            ? event.target.value.replace(/\D/g, "")
            : event.target.value,
        )
      }
    />
  );
  const feedback = (
    <>
      {offline && !error && (
        <p className="signin-warning" role="status">
          <AppIcon
            name="Warning"
            size={15}
            strokeWidth={1.7}
            aria-hidden="true"
          />
          <span>{offlineNotes[offline]}</span>
        </p>
      )}
      {sent && !error && !offline && (
        <p className="signin-sent" role="status">
          {sent}
        </p>
      )}
      {error && (
        <p className="signin-error" role="alert">
          {error === signInFailed ? <SignInFallback /> : error}
        </p>
      )}
    </>
  );
  const primary = (label: string, incomplete = false) => (
    <button
      className="signin-primary"
      type="submit"
      disabled={busy || incomplete}
      aria-busy={busy || undefined}
    >
      <BusyLabel busy={busy} busyLabel="Please wait…">
        {label}
      </BusyLabel>
    </button>
  );
  const changeEmail = (
    <>
      Wrong email?{" "}
      <TextLink onClick={() => go("email")}>Change email address</TextLink>
    </>
  );

  // A code step's button waits for all six digits, as the original's does.
  const codeIncomplete = !/^\d{6}$/.test(values.code);
  return {
    page,
    changeEmail,
    codeIncomplete,
    feedback,
    google,
    input,
    passkey,
    primary,
    resend,
    stateAction,
    submit,
    title,
    subtitle,
  } as const;
}
