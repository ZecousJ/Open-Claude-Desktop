import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { t, formatText, useT } from "../i18n";
import { SettingsModal } from "../settings/controls";
import { splitTemplate } from "./profile-step-form";
import { ReasonTooltip } from "../ui/Tooltip";
import { Spinner } from "../ui/Spinner";
import { BusyLabel } from "./BusyLabel";
import { actionVerificationError } from "../../shared/action-verification";
import { actionVerificationStore } from "./action-verification-store";
import "./action-verification.css";

export const verificationDescription =
  "To protect your account, confirm it’s really you before you {actionLabel}. Enter the {codeLength}-digit code we sent to {maskedEmail}.";
export const verificationResend =
  "Didn’t get it? Check your spam folder, or {resend}.";
type Phase =
  | "ready"
  | "starting"
  | "enter_code"
  | "confirmed"
  | "locked"
  | "expired"
  | "send_failed"
  | "rate_limited"
  | "unavailable"
  | "no_email";

export function ActionVerificationDialog() {
  useT();
  const active = useSyncExternalStore(
    actionVerificationStore.subscribe,
    actionVerificationStore.snapshot,
    actionVerificationStore.snapshot,
  );
  const [phase, setPhase] = useState<Phase>("ready");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const pending = useRef(false);
  const [resendAt, setResendAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [maskedEmail, setMaskedEmail] = useState(t("your email address"));
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (phase === "enter_code" && expiresAt && now >= expiresAt)
      setPhase("expired");
  }, [expiresAt, now, phase]);
  if (!active) return null;
  // The minutes the code has left, rounded up (live bundle, 2026-10-16,
  // Math.max(1, Math.ceil((expiresAt - now) / 6e4))).
  const minutesLeft = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  const seconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const close = () => actionVerificationStore.close();
  const isCurrent = () =>
    actionVerificationStore.snapshot()?.key === active.key;
  const failed = (value: unknown, sending: boolean) => {
    const detail = actionVerificationError(value);
    switch (detail?.code) {
      case "challenge_locked":
        setPhase("locked");
        break;
      case "challenge_expired":
        setPhase("expired");
        break;
      case "no_email_address":
        setPhase("no_email");
        break;
      case "challenge_rate_limited":
        setResendAt(Date.now() + detail.seconds * 1000);
        setPhase(
          detail.seconds > 60
            ? "rate_limited"
            : sending
              ? "send_failed"
              : "enter_code",
        );
        break;
      case "code_not_sent":
        setPhase("send_failed");
        break;
      case "invalid_code":
        setCode("");
        setError(t("That code didn’t match."));
        break;
      default:
        setPhase("unavailable");
    }
  };
  const send = async () => {
    if (pending.current || seconds > 0) return;
    const resending = phase === "enter_code";
    setResending(resending);
    pending.current = true;
    setBusy(true);
    if (!resending) setPhase("starting");
    setError("");
    try {
      const result = await window.desktop.sendActionVerification();
      if (!isCurrent()) return;
      setNow(Date.now());
      setResendAt(Date.now() + (result.retry_after_seconds ?? 60) * 1000);
      setExpiresAt(Date.now() + (result.expires_in_seconds ?? 600) * 1000);
      setMaskedEmail(result.masked_email || t("your email address"));
      setCode("");
      setPhase("enter_code");
    } catch (value) {
      if (isCurrent()) failed(value, true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (code.length !== 6 || pending.current) return;
    pending.current = true;
    setResending(false);
    setBusy(true);
    setError("");
    try {
      await window.desktop.confirmActionVerification(code);
      if (isCurrent()) setPhase("confirmed");
    } catch (value) {
      if (isCurrent()) failed(value, false);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const closeButton = (
    <button className="secondary" onClick={close}>
      {t("Close")}
    </button>
  );
  const cancelButton = (
    <button type="button" className="secondary" onClick={close}>
      {t("Cancel")}
    </button>
  );
  let body;
  if (phase === "enter_code") {
    const description = formatText(verificationDescription, {
      actionLabel: t(active.actionLabel),
      codeLength: 6,
      maskedEmail,
    });
    const resendButton =
      seconds > 0 ? (
        <span>{formatText("send a new code in {seconds}s", { seconds })}</span>
      ) : (
        <button type="button" disabled={busy} onClick={() => void send()}>
          {t("send a new code")}
        </button>
      );
    body = (
      <form
        className="action-verification-form"
        onSubmit={(event) => void confirm(event)}
        noValidate
      >
        <p className="action-verification-copy">
          {description.split(maskedEmail).map((part, index, parts) => (
            <span key={index}>
              {part}
              {index < parts.length - 1 && <strong>{maskedEmail}</strong>}
            </span>
          ))}
        </p>
        <div className="action-verification-field">
          <label htmlFor="action-verification-code">
            {t("Confirmation code")}
          </label>
          <input
            id="action-verification-code"
            className="action-verification-code"
            value={code}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
              setError("");
            }}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            spellCheck={false}
            autoFocus
            data-1p-ignore="true"
            placeholder="••••••"
            aria-invalid={Boolean(error)}
            aria-describedby="action-verification-hint"
          />
          <p id="action-verification-hint" className="action-verification-help">
            {expiresAt
              ? minutesLeft === 1
                ? t("The code expires in 1 minute.")
                : formatText("The code expires in {minutes} minutes.", {
                    minutes: minutesLeft,
                  })
              : t("The code expires a few minutes after it was sent.")}
          </p>
          {error && (
            <p role="alert" className="action-verification-error">
              {error}
            </p>
          )}
        </div>
        <p className="action-verification-help">
          {splitTemplate(t(verificationResend), () => (
            <span key="resend" aria-live="polite">
              {resendButton}
            </span>
          ))}
        </p>
        <div className="button-row">
          {cancelButton}
          <ReasonTooltip
            reason={
              code.length !== 6
                ? formatText("Enter the {codeLength}-digit code", {
                    codeLength: 6,
                  })
                : undefined
            }
          >
            {(props) => (
              <span {...props}>
                <button
                  className="primary"
                  type="submit"
                  disabled={code.length !== 6 || busy}
                  aria-busy={busy || undefined}
                >
                  <BusyLabel
                    busy={busy}
                    busyLabel={
                      resending
                        ? t("Sending a new code")
                        : t("Checking the code")
                    }
                  >
                    {t("Continue")}
                  </BusyLabel>
                </button>
              </span>
            )}
          </ReasonTooltip>
        </div>
      </form>
    );
  } else if (phase === "confirmed") {
    body = (
      <>
        <p className="action-verification-copy">
          {t("Confirmed. Press the button again to finish.")}
        </p>
        <div className="button-row">
          <button className="primary" autoFocus onClick={close}>
            {t("Close")}
          </button>
        </div>
      </>
    );
  } else if (phase === "starting") {
    body = (
      <>
        <p
          role="status"
          className="action-verification-copy action-verification-sending"
        >
          <Spinner size="sm" />
          {t("Sending a confirmation code to your email…")}
        </p>
        <div className="button-row">{cancelButton}</div>
      </>
    );
  } else if (phase === "ready") {
    body = (
      <>
        <p className="action-verification-copy">
          {t("To protect your account, we’ll send a code to your email.")}
        </p>
        <div className="button-row">
          {cancelButton}
          <button className="primary" onClick={() => void send()}>
            {t("Send code")}
          </button>
        </div>
      </>
    );
  } else if (phase === "send_failed") {
    body = (
      <>
        <p role="alert" className="action-verification-copy">
          {seconds > 0
            ? t(
                "Another code can’t be sent yet. You can send one when the timer runs out.",
              )
            : t("Couldn’t send the email. Try again in a moment.")}
        </p>
        <div className="button-row">
          {closeButton}
          <button
            className="primary"
            disabled={seconds > 0 || busy}
            onClick={() => void send()}
          >
            {seconds > 0
              ? formatText("Send code in {seconds}s", { seconds })
              : t("Send code")}
          </button>
        </div>
      </>
    );
  } else if (phase === "unavailable") {
    body = (
      <>
        <p role="alert" className="action-verification-copy">
          {t("Confirmation isn’t available right now. Try again in a moment.")}
        </p>
        <div className="button-row">
          {closeButton}
          <button className="primary" onClick={() => setPhase("ready")}>
            {t("Try again")}
          </button>
        </div>
      </>
    );
  } else {
    const message =
      phase === "rate_limited"
        ? "Several codes were sent to this account recently, so another can’t be sent yet. Close this and try again later."
        : phase === "no_email"
          ? "We can’t send a code because this account has no email address. Contact Support."
          : phase === "locked"
            ? "Too many attempts"
            : "This code expired. Close this and try again to get a new one.";
    body = (
      <>
        {phase === "expired" && (
          <p className="action-verification-heading">
            {t("Start again to continue")}
          </p>
        )}
        <p role="alert" className="action-verification-copy">
          {t(message)}
        </p>
        <div className="button-row">{closeButton}</div>
      </>
    );
  }
  return (
    <SettingsModal
      title={t("Confirm it’s you")}
      className="action-verification-dialog"
      onClose={close}
    >
      {body}
    </SettingsModal>
  );
}
