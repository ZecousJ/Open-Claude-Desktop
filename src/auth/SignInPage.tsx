import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Download } from "../ui/glyphs";
import { parseEmailLink, type EmailLinkRequest } from "../../shared/email-link";
import { type BrowserAccount } from "../../shared/sign-in-api";
import {
  codeMismatch,
  totpCodeMismatch,
  signInExpired,
} from "../../shared/sign-in-errors";
import { accountStateOf } from "../../shared/sign-in-states";
import type { AuthStatus, PublicAccount } from "../../shared/types";
import { findDesktopDownload } from "./desktopDownload";
import {
  frameHeading,
  initialStep,
  opensOnWelcome,
  statePage,
  type AuthField,
  type AuthStep,
  type SignedOutNotice,
  type StartMode,
  type StatePage,
} from "./signInView";
import { runWhenOnline, type OfflineWait } from "./whenOnline";
import "./sign-in.css";
import {
  web,
  pendingEmailLink,
  keepEmailLink,
  message,
  lastLoginMethod,
} from "./signin-env";
import { SignInFrame, Welcome, StateCard } from "./SignInFrame";
import { ServiceAddressCard } from "./ServiceAddressCard";
import { signInCard, type SignInValues } from "./SignInSteps";
import { useSignInPageState } from "./useSignInPageState";

export const placeholders: Record<AuthField, string> = {
  name: "Enter your name",
  email: "Enter your email",
  password: "Enter your password",
  invitationCode: "Enter your invitation code",
  promoCode: "Promo code (optional)",
};

const emptyValues: SignInValues = {
  name: "",
  email: "",
  password: "",
  invitationCode: "",
  promoCode: "",
  code: "",
};
type Values = SignInValues;

/**
 * The signed-out page for local accounts or the operator's Sub2API
 * service. Its steps follow the service's public policy: registration only
 * when it is open, the reset link when password reset is on, email codes
 * when the administrator offers them, the authenticator step when the
 * account asks for one. Refusals with a page of their own (too many
 * devices, a disabled account, …) replace the card's contents.
 */
export default function SignInPage({
  status,
  loadError,
  notice: signedOut,
  startMode,
  resetLink,
  onSignedIn,
  onRetry,
}: {
  /** Undefined while the account status loads. */
  status?: AuthStatus;
  /** Why the status could not be read. */
  loadError?: string;
  /** The step the web address asks for. */
  startMode?: StartMode;
  /** The emailed reset link's email and token (`/reset-password`). */
  resetLink?: { email: string; token: string };
  /** Why the service ended the last session, if it did. */
  notice?: SignedOutNotice;
  onSignedIn: (account: PublicAccount) => void;
  onRetry: () => void;
}) {
  if (!status) {
    const page = loadError ? statePage("unavailable", loadError) : undefined;
    // The desktop names nothing while it loads: the welcome screen may come.
    const heading = page || web ? frameHeading(page) : undefined;
    return (
      <SignInFrame
        title={heading?.title ?? ""}
        subtitle={heading?.subtitle ?? ""}
      >
        {page ? (
          <StateCard page={page} onAction={onRetry} />
        ) : (
          <p className="signin-text signin-loading" role="status">
            Loading…
          </p>
        )}
      </SignInFrame>
    );
  }
  if (status.serviceConfigured === false)
    return <ServiceAddressCard onChosen={onRetry} />;
  return (
    <SignInFlow
      status={status}
      notice={signedOut}
      startMode={startMode}
      resetLink={resetLink}
      onSignedIn={onSignedIn}
      onRetry={onRetry}
    />
  );
}

function SignInFlow({
  status,
  notice: signedOut,
  startMode,
  resetLink,
  onSignedIn,
  onRetry,
}: {
  status: AuthStatus;
  notice?: SignedOutNotice;
  startMode?: StartMode;
  resetLink?: { email: string; token: string };
  onSignedIn: (account: PublicAccount) => void;
  onRetry: () => void;
}) {
  const policy = status.remote;
  const [callbackLink] = useState(() =>
    typeof location === "undefined"
      ? undefined
      : parseEmailLink(
          web
            ? location.href
            : (new URLSearchParams(location.search).get("email-link") ?? ""),
        ),
  );
  const [pendingLink] = useState(() =>
    !status.account &&
    !status.twoFactorPending &&
    policy?.emailCodeLogin &&
    !resetLink &&
    !startMode
      ? pendingEmailLink()
      : undefined,
  );
  const [step, setStep] = useState<AuthStep>(() =>
    pendingLink ? "code" : initialStep(status, startMode),
  );
  const [values, setValues] = useState<Values>(() =>
    resetLink
      ? { ...emptyValues, email: resetLink.email }
      : // An account to sign in to again (the account menu) comes filled in.
        {
          ...emptyValues,
          email:
            callbackLink?.email ??
            pendingLink?.email ??
            status.browserAccounts?.adding?.email ??
            "",
        },
  );
  // The new password's second entry (the reset step).
  const [confirm, setConfirm] = useState("");
  const [maskedEmail, setMaskedEmail] = useState("");
  // The method this computer signed in with last ("Last used").
  const [lastMethod] = useState(lastLoginMethod);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState("");
  const [countdown, setCountdown] = useState(0);
  const linkRequest = useRef<EmailLinkRequest | undefined>(
    pendingLink
      ? {
          request_id: pendingLink.request_id,
          request_secret: pendingLink.request_secret,
          desktop: false,
        }
      : undefined,
  );
  const linkBusy = useRef(false);
  const callbackHandled = useRef(false);
  const callbackActive = useRef(true);
  const [linkFallback, setLinkFallback] = useState(callbackLink);
  const [codeAutoFocus, setCodeAutoFocus] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [download, setDownload] = useState<string>();
  // A refusal with a page of its own.
  const [state, setState] = useState<StatePage>();
  // "Your session ended…" above the card until the next try.
  const [showNotice, setShowNotice] = useState(Boolean(signedOut));
  // The desktop opens on its welcome screen.
  const [welcoming, setWelcoming] = useState(
    () => !pendingLink && opensOnWelcome(status),
  );
  // The pending verification step ran out: only "Start again" is offered.
  const [expired, setExpired] = useState(false);
  // The request waiting for the connection, and which wait it is.
  const [offline, setOffline] = useState<OfflineWait>();
  // The web's accounts of this browser (several accounts per browser).
  const browser = status.browserAccounts;
  const adding = browser?.adding;
  const [accounts, setAccounts] = useState<BrowserAccount[]>(() =>
    (browser?.accounts ?? []).filter(
      (account) => account.id !== browser?.current,
    ),
  );
  // "Choose an account" opens first on the plain sign-in page, as the
  // original's does when it remembers accounts (never while adding one or
  // on a /register or reset address).
  const [choosing, setChoosing] = useState(
    () =>
      accounts.length > 0 &&
      !adding &&
      !resetLink &&
      !pendingLink &&
      initialStep(status, startMode) === "email" &&
      !opensOnWelcome(status),
  );
  const addingFor = browser?.accounts.find(
    (account) => account.id === browser.current,
  );
  const focus = useRef<HTMLInputElement>(null);

  // The web offers the desktop app when the administrator published one.
  useEffect(() => {
    if (!web) return;
    let live = true;
    void findDesktopDownload().then((url) => live && setDownload(url));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);
  useEffect(() => {
    focus.current?.focus();
  }, [step, state, welcoming, choosing]);

  const set = (field: keyof Values, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));
  const email = values.email.trim();

  function go(next: AuthStep) {
    if (next === "email") {
      linkRequest.current = undefined;
      keepEmailLink();
    }
    if (step === "twoFactor" && next !== "twoFactor")
      void window.desktop.cancelTwoFactor?.();
    setStep(next);
    setExpired(false);
    setError("");
    setSent("");
    setValues((current) => ({ ...current, password: "", code: "" }));
    setConfirm("");
  }
  /** A refusal: its own page, or a line under the form. */
  function fail(reason: unknown) {
    const kind = accountStateOf(reason);
    if (kind) {
      setState(statePage(kind, message(reason)));
      return;
    }
    const text = message(reason);
    if (text === signInExpired) setExpired(true);
    // A code that didn't match is cleared for the next try, as the original does.
    if (text === codeMismatch || text === totpCodeMismatch)
      setValues((current) => ({ ...current, code: "" }));
    setError(text);
  }
  /**
   * Runs a request of the form. With `wait`, an offline browser holds it until
   * the connection returns and the form says so.
   */
  async function run(task: () => Promise<void>, wait?: OfflineWait) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (wait)
        await runWhenOnline(task, (paused) =>
          setOffline(paused ? wait : undefined),
        );
      else await task();
    } catch (reason) {
      fail(reason);
    } finally {
      setOffline(undefined);
      setBusy(false);
    }
  }
  const {
    page,
    changeEmail,
    codeIncomplete,
    feedback,
    forget,
    google,
    input,
    passkey,
    pick,
    primary,
    resend,
    sendCode,
    stateAction,
    submit,
    title,
    subtitle,
    backToAccount,
  } = useSignInPageState({
    accounts,
    adding,
    addingFor,
    busy,
    callbackActive,
    callbackHandled,
    callbackLink,
    confirm,
    countdown,
    email,
    error,
    fail,
    focus,
    go,
    linkBusy,
    linkFallback,
    linkRequest,
    offline,
    onRetry,
    onSignedIn,
    policy,
    resetLink,
    run,
    sent,
    set,
    setAccounts,
    setBusy,
    setChoosing,
    setCodeAutoFocus,
    setCountdown,
    setError,
    setLinkFallback,
    setMaskedEmail,
    setSent,
    setShowNotice,
    setState,
    setStep,
    setValues,
    setWelcoming,
    state,
    status,
    step,
    values,
  });

  if (welcoming && !page && !linkFallback)
    return <Welcome onNext={() => setWelcoming(false)} />;

  const card = signInCard({
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
  });

  return (
    <SignInFrame
      title={title}
      subtitle={subtitle}
      step={page ? "state" : choosing && step === "email" ? "choose" : step}
      lead={
        showNotice &&
        signedOut &&
        !page && (
          <p className="signin-ended" role="status">
            {signedOut.title}
          </p>
        )
      }
      below={
        adding && !page ? (
          // The add-account page's footer: back to the account that stayed
          // signed in (a ghost button with an arrow).
          <button
            type="button"
            className="signin-ghost signin-back"
            disabled={busy}
            onClick={backToAccount}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            Back
          </button>
        ) : (
          download && (
            <a
              className="signin-secondary signin-download"
              href={download}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Download size={16} aria-hidden="true" />
              Download desktop app
            </a>
          )
        )
      }
    >
      {card}
    </SignInFrame>
  );
}
