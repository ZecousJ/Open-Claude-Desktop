import { useState, type FormEvent } from "react";
import { t } from "../i18n";
import { BusyLabel } from "./BusyLabel";
import { SignInFrame } from "./SignInFrame";

/**
 * A desktop build without a default service asks which Claudex service to
 * sign in to; the address is kept once a service answers there.
 */
export function ServiceAddressCard({ onChosen }: { onChosen: () => void }) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = address.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      await window.desktop.setServiceAddress(
        /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`,
      );
      onChosen();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message.replace(
              /^Error invoking remote method '[^']+': (Error: )?/,
              "",
            )
          : String(reason),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <SignInFrame
      title={t("Connect to a Claudex service")}
      subtitle={t("Enter the address of the service you sign in to.")}
    >
      <form onSubmit={(event) => void submit(event)} noValidate>
        <input
          className="signin-input"
          type="url"
          inputMode="url"
          autoFocus
          autoComplete="url"
          spellCheck={false}
          maxLength={2000}
          aria-label={t("Service address")}
          placeholder="https://claudex.example.com"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
        />
        {error && (
          <p className="signin-error" role="alert">
            {t(error)}
          </p>
        )}
        <button
          className="signin-primary"
          type="submit"
          disabled={busy || !address.trim()}
          aria-busy={busy || undefined}
        >
          <BusyLabel busy={busy} busyLabel="Please wait…">
            {t("Continue")}
          </BusyLabel>
        </button>
      </form>
    </SignInFrame>
  );
}
