import { useState, type FormEvent } from "react";
import { formatText } from "../i18n";
import { BusyLabel } from "./BusyLabel";
import "./sign-in.css";
import { SignInFrame, TextLink } from "./SignInFrame";

/**
 * The emailed reset link opened in a browser that is already signed in,
 * maybe to another account: the new password is set here before the app
 * shows, then the app comes back (a signed-out browser uses the sign-in
 * flow's own reset step).
 */
export function ResetPasswordPage({
  link,
  signedInEmail,
  minLength,
  onDone,
}: {
  link: { email: string; token: string };
  signedInEmail: string;
  minLength: number;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const other =
    signedInEmail.trim().toLowerCase() !== link.email.trim().toLowerCase();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password.length < minLength) {
      setError(`Use at least ${minLength} characters for your password.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await window.desktop.resetPassword(link.email, link.token, password);
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <SignInFrame
      title="Reset your password"
      subtitle={link.email}
      step={done ? "resetDone" : "reset"}
    >
      {done ? (
        <>
          <p className="signin-text">Your password has been updated.</p>
          <button type="button" className="signin-primary" onClick={onDone}>
            Continue to Claudex
          </button>
        </>
      ) : (
        <>
          {other && (
            <p className="signin-text">
              {formatText(
                "You’re signed in as {email}. This sets a new password for the account in the link.",
                { email: signedInEmail },
              )}
            </p>
          )}
          <form onSubmit={submit} noValidate>
            <input
              className="signin-input"
              type="password"
              autoComplete="new-password"
              aria-label="Enter a new password"
              placeholder="Enter a new password"
              maxLength={256}
              required
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
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
            {error && (
              <p className="signin-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="signin-primary"
              type="submit"
              disabled={busy}
              aria-busy={busy || undefined}
            >
              <BusyLabel busy={busy} busyLabel="Please wait…">
                Set new password
              </BusyLabel>
            </button>
          </form>
          <p className="signin-small">
            <TextLink onClick={onDone}>Cancel</TextLink>
          </p>
        </>
      )}
    </SignInFrame>
  );
}
