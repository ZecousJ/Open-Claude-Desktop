import { useState } from "react";
import { AppIcon } from "../../ui/app-icon";
import { t } from "../../i18n";
import { routineFirePath } from "../../../shared/routine-triggers";
import { RoutineApiTokenDialog } from "./RoutineApiTokenDialog";

/**
 * A saved task's API trigger: the fire address with Active or Inactive and its
 * copy button; the token's last characters (or "Generate a token to activate
 * API access.") with Generate token or Regenerate and, while there is one,
 * Delete token; then the example request, folded, with its copy button. A new
 * token is shown once ("Token generated").
 */
export function RoutineApiAccess({
  triggerId,
  hint,
  onHint,
}: {
  triggerId: string;
  hint?: string;
  /** The token's hint changed (made, or the token deleted). */
  onHint: (hint: string | undefined) => void;
}) {
  const [busy, setBusy] = useState<"generate" | "delete">();
  const [error, setError] = useState<string>();
  const [token, setToken] = useState<string>();
  const [example, setExample] = useState(false);
  const [copied, setCopied] = useState<"url" | "curl">();
  const url = `${location.origin}${routineFirePath(triggerId)}`;
  const curl = [
    `curl -X POST ${url} \\`,
    '  -H "Authorization: Bearer $TOKEN" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"text": "optional extra turn appended to the session"}'`,
  ].join("\n");
  const act = async (action: "generate" | "delete") => {
    setBusy(action);
    setError(undefined);
    try {
      const answer = await window.desktop.routineApiToken(triggerId, action);
      if (action === "generate" && answer.token) setToken(answer.token);
      onHint(action === "generate" ? answer.hint : undefined);
    } catch {
      setError(t("Failed to update API token. You can try again."));
    } finally {
      setBusy(undefined);
    }
  };
  const copy = (what: "url" | "curl") =>
    void window.desktop
      .copyText(what === "url" ? url : curl)
      .then(() => setCopied(what));
  return (
    <div className="routine-api-access">
      <div className="routine-api-head">
        <span>{t("Fire URL")}</span>
        <span className={hint ? "routine-api-active" : undefined}>
          {hint ? t("Active") : t("Inactive")}
        </span>
      </div>
      <div className="routine-api-url">
        <input
          dir="ltr"
          readOnly
          value={url}
          aria-label={t("Fire URL")}
          data-no-translate
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="routine-api-icon"
          aria-label={copied === "url" ? t("Copied") : t("Copy")}
          title={copied === "url" ? t("Copied") : t("Copy")}
          onClick={() => copy("url")}
        >
          <AppIcon name={copied === "url" ? "Check" : "Copy"} size={16} />
        </button>
      </div>
      <span className="routine-api-label">{t("Token")}</span>
      <div className="routine-api-token">
        {hint ? (
          <code dir="ltr" data-no-translate>
            {hint}
          </code>
        ) : (
          <span>{t("Generate a token to activate API access.")}</span>
        )}
        <button
          type="button"
          className="secondary"
          disabled={Boolean(busy)}
          aria-busy={busy === "generate" || undefined}
          onClick={() => void act("generate")}
        >
          {hint ? t("Regenerate") : t("Generate token")}
        </button>
        {hint && (
          <button
            type="button"
            className="routine-api-icon"
            aria-label={t("Delete token")}
            title={t("Delete token")}
            disabled={Boolean(busy)}
            aria-busy={busy === "delete" || undefined}
            onClick={() => void act("delete")}
          >
            <AppIcon name="Trash" size={16} />
          </button>
        )}
      </div>
      {hint && (
        <span className="routine-api-note">
          {t(
            "Regenerating invalidates the previous token. Delete to deactivate API access.",
          )}
        </span>
      )}
      {error && (
        <p className="task-error" role="alert">
          {error}
        </p>
      )}
      <div className="routine-api-head">
        <button
          type="button"
          className="routine-api-example"
          aria-expanded={example}
          onClick={() => setExample(!example)}
        >
          <AppIcon
            name="CaretRight"
            size={16}
            style={{ transform: example ? "rotate(90deg)" : undefined }}
          />
          {t("Example request")}
        </button>
        <button
          type="button"
          className="routine-api-icon"
          aria-label={copied === "curl" ? t("Copied") : t("Copy curl")}
          title={copied === "curl" ? t("Copied") : t("Copy curl")}
          onClick={() => copy("curl")}
        >
          <AppIcon name={copied === "curl" ? "Check" : "Copy"} size={16} />
        </button>
      </div>
      {example && (
        <pre dir="ltr" data-no-translate>
          {curl}
        </pre>
      )}
      {token && (
        <RoutineApiTokenDialog
          token={token}
          title="Token generated"
          notice="Copy this token now — it won’t be shown again. Use it as the Bearer credential."
          onClose={() => setToken(undefined)}
        />
      )}
    </div>
  );
}
