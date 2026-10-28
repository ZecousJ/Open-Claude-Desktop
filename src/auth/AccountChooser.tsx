import { GoogleSignInButton } from "./GoogleSignInButton";
import { X } from "../ui/glyphs";
import { type BrowserAccount } from "../../shared/sign-in-api";
import { formatText, useT } from "../i18n";
import "./sign-in.css";

/**
 * "Choose an account": a body-size medium heading, a row per account (avatar,
 * name, the email under it when they differ, and an X that removes the account
 * from this device), "Use another account" under them.
 */
export function AccountChooser({
  accounts,
  busy,
  onPick,
  onForget,
  onUseAnother,
  googleClientId,
  onGoogle,
}: {
  accounts: BrowserAccount[];
  busy: boolean;
  onPick: (account: BrowserAccount) => void;
  onForget: (account: BrowserAccount) => void;
  onUseAnother: () => void;
  /** Continue with Google under the accounts, when Google sign-in is on. */
  googleClientId?: string;
  onGoogle: (code?: string) => void;
}) {
  useT(); // the label below follows the language
  return (
    <div className="signin-chooser">
      <h2 className="signin-chooser-title">Choose an account</h2>
      <ul className="signin-chooser-list">
        {accounts.map((account) => {
          const label = account.name || account.email;
          return (
            <li key={account.id} className="signin-chooser-row">
              <span className="signin-chooser-avatar" aria-hidden="true">
                {label.slice(0, 1).toUpperCase()}
              </span>
              <button
                type="button"
                className="signin-chooser-pick"
                disabled={busy}
                onClick={() => onPick(account)}
              >
                <span className="signin-chooser-name" title={label}>
                  {label}
                </span>
                {label !== account.email && (
                  <span className="signin-chooser-email" title={account.email}>
                    {account.email}
                  </span>
                )}
              </button>
              <button
                type="button"
                className="signin-chooser-forget"
                disabled={busy}
                aria-label={formatText("Remove {email} from this device", {
                  email: account.email,
                })}
                onClick={() => onForget(account)}
              >
                <X size={16} aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
      {googleClientId && (
        <GoogleSignInButton
          clientId={googleClientId}
          disabled={busy}
          onDesktop={() => onGoogle()}
          onCode={onGoogle}
        />
      )}
      <button
        type="button"
        className="signin-ghost signin-chooser-another"
        disabled={busy}
        onClick={onUseAnother}
      >
        Use another account
      </button>
    </div>
  );
}
