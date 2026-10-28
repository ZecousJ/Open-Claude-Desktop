import type {
  Dispatch,
  FormEvent,
  MutableRefObject,
  ReactNode,
  SetStateAction,
} from "react";
import type { LoginMethod } from "./signin-env";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { ArrowLeft, CircleCheck, Copy, Mailbox } from "../ui/glyphs";
import { type EmailLink } from "../../shared/email-link";
import { type BrowserAccount } from "../../shared/sign-in-api";
import { signInExpired } from "../../shared/sign-in-errors";
import type { AuthStatus, PublicAccount } from "../../shared/types";
import { t } from "../i18n";
import {
  createFields,
  initialStep,
  passwordMin,
  privacyNote,
  type AuthField,
  type AuthStep,
  type StatePage,
} from "./signInView";
import { type OfflineWait } from "./whenOnline";
import { web } from "./signin-env";
import { TextLink, StateCard, LastUsed } from "./SignInFrame";
import { AccountChooser } from "./AccountChooser";

export interface SignInValues {
  name: string;
  email: string;
  password: string;
  invitationCode: string;
  promoCode: string;
  code: string;
}

/** What the step cards need from the sign-in flow (SignInPage.tsx). */
export interface SignInKit {
  confirm: string;
  status: AuthStatus;
  accounts: BrowserAccount[];
  adding: { email?: string } | undefined;
  busy: boolean;
  callbackActive: MutableRefObject<boolean>;
  changeEmail: ReactNode;
  choosing: boolean;
  codeAutoFocus: boolean;
  codeCopied: boolean;
  codeIncomplete: boolean;
  email: string;
  error: string;
  expired: boolean;
  fail: (reason: unknown) => void;
  feedback: ReactNode;
  forget: (account: BrowserAccount) => void;
  go: (next: AuthStep) => void;
  google: (code?: string) => void;
  input: (
    field: AuthField | "code",
    options?: {
      placeholder?: string;
      autoFocus?: boolean;
      type?: string;
      autoComplete?: string;
      code?: boolean;
    },
  ) => ReactNode;
  lastMethod: LoginMethod | undefined;
  linkFallback: EmailLink | undefined;
  maskedEmail: string;
  onSignedIn: (account: PublicAccount) => void;
  page: StatePage | undefined;
  passkey: () => void;
  pick: (account: BrowserAccount) => void;
  policy: AuthStatus["remote"];
  primary: (label: string, incomplete?: boolean) => ReactNode;
  resend: (kind: "sign-in" | "register") => void;
  resetLink: { email: string; token: string } | undefined;
  run: (task: () => Promise<void>, wait?: OfflineWait) => Promise<void>;
  sendCode: (kind: "sign-in" | "register") => Promise<unknown>;
  set: (field: keyof SignInValues, value: string) => void;
  setChoosing: Dispatch<SetStateAction<boolean>>;
  setCodeAutoFocus: Dispatch<SetStateAction<boolean>>;
  setCodeCopied: Dispatch<SetStateAction<boolean>>;
  setConfirm: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  setLinkFallback: Dispatch<SetStateAction<EmailLink | undefined>>;
  setSent: Dispatch<SetStateAction<string>>;
  setShowNotice: Dispatch<SetStateAction<boolean>>;
  stateAction: (page: StatePage) => void;
  step: AuthStep;
  submit: (event: FormEvent) => void;
}

/**
 * The sign-in card for the flow's current step (email, password, code,
 * create account, reset): the page frame and its state stay in SignInFlow.
 */
export function signInCard(kit: SignInKit): ReactNode {
  const {
    status,
    confirm,
    accounts,
    adding,
    busy,
    callbackActive,
    changeEmail,
    choosing,
    codeAutoFocus,
    codeCopied,
    codeIncomplete,
    email,
    error,
    expired,
    fail,
    feedback,
    forget,
    go,
    google,
    input,
    lastMethod,
    linkFallback,
    maskedEmail,
    onSignedIn,
    page,
    passkey,
    pick,
    policy,
    primary,
    resend,
    resetLink,
    run,
    sendCode,
    set,
    setChoosing,
    setCodeAutoFocus,
    setCodeCopied,
    setConfirm,
    setError,
    setLinkFallback,
    setSent,
    setShowNotice,
    stateAction,
    step,
    submit,
  } = kit;
  let card: ReactNode;
  if (linkFallback)
    card = (
      <div className="signin-link-fallback">
        <div className="signin-link-code" dir="ltr">
          {linkFallback.code}
        </div>
        <button
          className="signin-primary"
          type="button"
          onClick={() => {
            void window.desktop
              .copyText(linkFallback.code)
              .then(() => setCodeCopied(true), fail);
          }}
        >
          {codeCopied ? <CircleCheck size={20} /> : <Copy size={20} />}
          {t("Copy code")}
        </button>
        <TextLink
          onClick={() => {
            callbackActive.current = false;
            setLinkFallback(undefined);
            if (status.account) {
              onSignedIn(status.account);
              return;
            }
            if (web) history.replaceState(null, "", "/login");
            go("email");
          }}
        >
          {t("Sign in here instead")}
        </TextLink>
        {feedback}
      </div>
    );
  else if (status.account)
    card = (
      <button
        className="signin-primary"
        onClick={() => onSignedIn(status.account!)}
      >
        {t("Continue")}
      </button>
    );
  else if (page)
    card = (
      <StateCard
        page={page}
        error={error}
        busy={busy}
        onAction={() => stateAction(page)}
      />
    );
  else if (expired)
    card = (
      <div className="signin-state">
        <p className="signin-error" role="alert">
          {signInExpired}
        </p>
        <button
          type="button"
          className="signin-primary"
          onClick={() =>
            go(initialStep({ ...status, twoFactorPending: false }))
          }
        >
          Start again
        </button>
      </div>
    );
  else if (step === "email" && choosing)
    card = (
      <>
        <AccountChooser
          accounts={accounts}
          busy={busy}
          onPick={pick}
          onForget={forget}
          googleClientId={policy?.googleClientId}
          onGoogle={google}
          onUseAnother={() => {
            setShowNotice(false);
            setChoosing(false);
            set("email", "");
          }}
        />
        {feedback}
      </>
    );
  else if (step === "email") {
    const note = privacyNote(policy);
    card = (
      <>
        {/* Back to the chooser. */}
        {accounts.length > 0 && !adding && (
          <button
            type="button"
            className="signin-ghost signin-all-accounts"
            disabled={busy}
            onClick={() => {
              setError("");
              setChoosing(true);
            }}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            All accounts
          </button>
        )}
        {policy?.googleClientId && (
          <LastUsed method="google" last={lastMethod}>
            <GoogleSignInButton
              clientId={policy.googleClientId}
              disabled={busy}
              onDesktop={() => google()}
              onCode={google}
            />
          </LastUsed>
        )}
        {policy?.passkey && (
          <LastUsed method="passkey" last={lastMethod}>
            <button
              type="button"
              className="signin-secondary signin-wide"
              disabled={busy}
              onClick={passkey}
            >
              Continue with passkey
            </button>
          </LastUsed>
        )}
        {(policy?.passkey || policy?.googleClientId) && (
          <div className="signin-or">OR</div>
        )}
        <form onSubmit={submit} noValidate>
          {input("email", { autoFocus: true, autoComplete: "email" })}
          {feedback}
          <LastUsed method="email" last={lastMethod}>
            {primary("Continue with email")}
          </LastUsed>
        </form>
        {note && (
          <p className="signin-small">
            By continuing, you acknowledge {note.service}&rsquo;s{" "}
            <a href={note.url} target="_blank" rel="noopener noreferrer">
              Privacy Policy
            </a>
            .
          </p>
        )}
        {policy?.registrationEnabled && (
          <p className="signin-small">
            Don&rsquo;t have an account?{" "}
            <TextLink onClick={() => go("create")}>Sign up</TextLink>
          </p>
        )}
      </>
    );
  } else if (step === "password")
    card = (
      <>
        <p className="signin-text">
          Enter the password for
          <br />
          <strong>{email}</strong>
        </p>
        <p className="signin-text">{changeEmail}</p>
        <form onSubmit={submit} noValidate>
          {input("password", {
            autoFocus: true,
            type: "password",
            autoComplete: "current-password",
          })}
          {feedback}
          {primary("Continue")}
        </form>
        {(policy?.passwordReset || policy?.emailCodeLogin) && (
          <p className="signin-small signin-links">
            {policy.passwordReset && (
              <TextLink onClick={() => go("forgot")}>Forgot password?</TextLink>
            )}
            {policy.emailCodeLogin && (
              <TextLink
                onClick={() =>
                  void run(async () => {
                    await sendCode("sign-in");
                    go("emailSent");
                  }, "send")
                }
              >
                Email me a sign-in code
              </TextLink>
            )}
          </p>
        )}
      </>
    );
  else if (step === "emailSent") {
    card = (
      <div className="signin-mailbox-form">
        <div className="signin-mailbox">
          <Mailbox
            className="signin-mailbox-icon"
            size={32}
            aria-hidden="true"
          />
          <div>
            <p>{t("To continue, click the link sent to")}</p>
            <p className="signin-mailbox-email" dir="ltr">
              {email}
            </p>
          </div>
        </div>
        <div className="signin-mailbox-links">
          <TextLink
            onClick={() => {
              setCodeAutoFocus(true);
              go("code");
            }}
            disabled={busy}
          >
            Enter verification code
          </TextLink>
          <TextLink onClick={() => go("email")} disabled={busy}>
            {t("Resend email")}
          </TextLink>
          <TextLink onClick={() => go("email")} disabled={busy}>
            {t("Use a different email")}
          </TextLink>
        </div>
        {feedback}
      </div>
    );
  } else if (step === "code" || step === "createVerify") {
    const kind = step === "code" ? "sign-in" : "register";
    card = (
      <>
        <p className="signin-text">
          {step === "code"
            ? t("To continue, click the link sent to")
            : t("To continue, enter the code sent to")}
          <br />
          <strong>{email}</strong>
        </p>
        <p className="signin-text">
          Not seeing the email in your inbox?{" "}
          <span className="signin-nowrap">
            <TextLink
              onClick={() => (step === "code" ? go("email") : resend(kind))}
              disabled={busy}
            >
              Try sending again
            </TextLink>
            .
          </span>
          <br />
          {step === "code" ? (
            changeEmail
          ) : (
            <>
              Wrong email?{" "}
              <TextLink onClick={() => go("create")}>
                Change email address
              </TextLink>
            </>
          )}
        </p>
        <p className="signin-text signin-gap">
          The code expires in 10 minutes.
          {step === "code" && (
            <>
              {" "}
              You can also{" "}
              <TextLink onClick={() => go("password")}>
                use your password
              </TextLink>
              .
            </>
          )}
        </p>
        {step === "code" && (
          <p className="signin-text signin-link-hint">
            If the link shows a verification code instead of signing you in,
            enter it here.
          </p>
        )}
        <form onSubmit={submit} noValidate>
          {input("code", {
            autoFocus: step === "code" ? codeAutoFocus : true,
            code: true,
            autoComplete: "one-time-code",
          })}
          {feedback}
          {/* The original's login code submits with "Verify email address". */}
          {primary("Verify email address", codeIncomplete)}
        </form>
      </>
    );
  } else if (step === "twoFactor")
    card = (
      <>
        {/* The original's second-factor heading. */}
        <p className="signin-mfa-heading">Confirm it’s you</p>
        <p className="signin-text">
          Enter the 6-digit code from your authenticator app
          {maskedEmail ? (
            <>
              {" "}
              for
              <br />
              <strong>{maskedEmail}</strong>
            </>
          ) : (
            "."
          )}
        </p>
        <p className="signin-text">
          Wrong account?{" "}
          <TextLink onClick={() => go("email")}>
            Use a different account
          </TextLink>
        </p>
        <form onSubmit={submit} noValidate>
          {input("code", {
            autoFocus: true,
            code: true,
            placeholder: "Enter authentication code",
            autoComplete: "one-time-code",
          })}
          {feedback}
          {primary("Continue", codeIncomplete)}
        </form>
      </>
    );
  else if (step === "create") {
    const fields = createFields(status);
    card = (
      <>
        <p className="signin-text">
          {policy
            ? `Create your ${policy.siteName.trim() || "Claudex"} account.`
            : "Create a Claudex account on this computer."}
        </p>
        <form onSubmit={submit} noValidate>
          {fields.map((field, index) =>
            input(field, {
              autoFocus: index === 0,
              ...(field === "password"
                ? {
                    type: "password",
                    placeholder: `Create a password (${passwordMin(status)}+ characters)`,
                    autoComplete: "new-password",
                  }
                : field === "email"
                  ? { autoComplete: "email" }
                  : field === "name"
                    ? { autoComplete: "name" }
                    : {}),
            }),
          )}
          {policy && policy.emailDomains.length > 0 && (
            <p className="signin-small signin-hint">
              Use an address at {policy.emailDomains.join(", ")}.
            </p>
          )}
          {feedback}
          {primary(policy?.emailVerification ? "Continue" : "Create account")}
        </form>
        <p className="signin-small">
          Already have an account?{" "}
          <TextLink onClick={() => go(policy ? "email" : "login")}>
            Sign in
          </TextLink>
        </p>
      </>
    );
  } else if (step === "reset")
    card = (
      <>
        <p className="signin-text">
          Choose a new password for
          <br />
          <strong>{resetLink?.email ?? email}</strong>
        </p>
        <form onSubmit={submit} noValidate>
          {input("password", {
            autoFocus: true,
            type: "password",
            autoComplete: "new-password",
            placeholder: "Enter a new password",
          })}
          <input
            className="signin-input"
            type="password"
            autoComplete="new-password"
            aria-label="Enter the new password again"
            placeholder="Enter the new password again"
            maxLength={256}
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {feedback}
          {primary("Set new password")}
        </form>
        <p className="signin-small signin-links">
          <TextLink onClick={() => go("forgot")}>Send a new link</TextLink>
          <TextLink onClick={() => go("email")}>Back to sign in</TextLink>
        </p>
      </>
    );
  else if (step === "resetDone")
    card = (
      <>
        <p className="signin-text">
          Your password has been updated. Sign in with your new password.
        </p>
        <button
          type="button"
          className="signin-primary"
          onClick={() => go(policy ? "password" : "login")}
        >
          Sign in
        </button>
      </>
    );
  else if (step === "forgot")
    card = (
      <>
        <p className="signin-text">
          Enter your account&rsquo;s email and we&rsquo;ll send you a link to
          reset your password.
        </p>
        <form onSubmit={submit} noValidate>
          {input("email", { autoFocus: true, autoComplete: "email" })}
          {feedback}
          {primary("Send reset link")}
        </form>
        <p className="signin-small">
          <TextLink onClick={() => go("password")}>Back to sign in</TextLink>
        </p>
      </>
    );
  else if (step === "forgotSent")
    card = (
      <>
        <p className="signin-text">
          If an account exists for
          <br />
          <strong>{email}</strong>
          <br />
          we sent a link to reset your password.
        </p>
        <p className="signin-text">
          Not seeing the email in your inbox?{" "}
          <span className="signin-nowrap">
            <TextLink
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.desktop.requestPasswordReset(email);
                  setSent(`We sent another link to ${email}.`);
                })
              }
            >
              Try sending again
            </TextLink>
            .
          </span>
        </p>
        {feedback}
        <button
          type="button"
          className="signin-primary"
          onClick={() => go("password")}
        >
          Back to sign in
        </button>
      </>
    );
  else
    card = (
      <>
        <form onSubmit={submit} noValidate>
          {input("email", { autoFocus: true, autoComplete: "email" })}
          {input("password", {
            type: "password",
            autoComplete: "current-password",
          })}
          {feedback}
          {primary("Sign in")}
        </form>
        <p className="signin-small">
          <TextLink onClick={() => go("create")}>
            Create another local account
          </TextLink>
        </p>
      </>
    );

  return card;
}
