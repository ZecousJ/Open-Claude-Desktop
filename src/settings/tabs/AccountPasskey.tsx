import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../../ui/Controls";
import { showToast } from "../../ui/toast-store";
import { t } from "../../i18n";
import { Button, Row, Section } from "../controls";

/**
 * Settings → Account → Passkey. Claudex's passkeys sign the account in instead
 * of its password, so the row says that; the service asks for the password
 * before it makes one, then the browser's own passkey prompt follows. Only
 * where the service and this browser offer passkeys (the web).
 */
export function AccountPasskey() {
  const [count, setCount] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const load = () =>
    void window.desktop
      .accountPasskeys?.()
      .then((value) => setCount(value ? value.count : null))
      .catch(() => setCount(null));
  useEffect(load, []);
  if (count === null) return null;
  return (
    <Section joinsAbove>
      <Row
        label="Passkey"
        description={
          count
            ? "On · you can sign in with a passkey instead of your password. Set one up here too if this device doesn’t have yours."
            : "Off · set one up to sign in with a passkey instead of your password."
        }
      >
        <Button onClick={() => setAsking(true)}>Set up passkey</Button>
      </Row>
      {asking && (
        <PasskeyDialog
          onClose={() => setAsking(false)}
          onDone={() => {
            setAsking(false);
            showToast(t("Passkey set up"));
            load();
          }}
        />
      )}
    </Section>
  );
}

function PasskeyDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setProblem("");
    try {
      await window.desktop.setUpPasskey(password);
      onDone();
    } catch (error) {
      const name = (error as { name?: string })?.name;
      setProblem(
        name === "InvalidStateError"
          ? t("You already have a passkey set up.")
          : name === "NotAllowedError" || name === "AbortError"
            ? t("Couldn’t set up a passkey.")
            : (error as Error)?.message || t("Couldn’t set up a passkey."),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Set up a passkey" onClose={onClose} pending={busy}>
      <form className="account-passkey-form" onSubmit={submit}>
        <p>{t("Enter your password to continue.")}</p>
        <input
          className="settings-input"
          type="password"
          aria-label={t("Password")}
          placeholder={t("Password")}
          autoComplete="current-password"
          autoFocus
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
        {problem && (
          <p className="account-passkey-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="button-row">
          <button type="button" onClick={onClose} disabled={busy}>
            {t("Cancel")}
          </button>
          <button
            type="submit"
            className="primary"
            disabled={!password || busy}
          >
            {t("Continue")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
