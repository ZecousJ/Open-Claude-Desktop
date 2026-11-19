import { useEffect, useRef, useState } from "react";
import { X } from "../ui/glyphs";
import type { ZecousMigration } from "../../shared/zecous-migration-api";
import { formatText, useT } from "../i18n";
import { useDialogOverlay } from "../ui/dialog-stack";
import "./zecous-migration.css";

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * The one-time move from ZecousAI (owner, 2026-10-03), drawn after claude.ai's
 * gift dialog (owner's capture): a gift at the top left, a close button at
 * the top right, a serif title, the text, numbered points in rings, a
 * hairline, and one button at the bottom right. Closing changes nothing (it
 * shows again next time); "Confirm move" moves the account.
 */
export default function ZecousMigrationDialog({
  migration,
  onClose,
  onConfirm,
}: {
  migration: ZecousMigration;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmButton = useRef<HTMLButtonElement>(null);
  const overlay = useDialogOverlay();
  useEffect(() => {
    confirmButton.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [busy, onClose]);
  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message
          ? reason.message
          : t("The move didn't go through. Try again."),
      );
      setBusy(false);
    }
  };
  const points = [
    t(
      "If you had any ZecousAI subscription on September 4, or started one after September 4, the subscription time you had left from September 4 on is turned into balance in proportion to its length and added to your Claudex balance.",
    ),
    t(
      "If you had a ZecousAI balance on September 4, that day's balance is turned into balance and added to your Claudex balance (requests from September 4 on are not charged).",
    ),
    t(
      "Your ZecousAI balance may look smaller in Claudex. Claudex tops up at a new rate of ¥1 to $1, and its model rates are much lower than ZecousAI's previous 1:1, so what you can use does not change.",
    ),
  ];
  return (
    <div {...overlay} className="zecous-migration-overlay">
      <div
        className="zecous-migration"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zecous-migration-title"
      >
        <GiftIcon />
        <button
          type="button"
          className="zecous-migration-close"
          aria-label={t("Close")}
          disabled={busy}
          onClick={onClose}
        >
          <X size={18} strokeWidth={1.5} />
        </button>
        <h2 id="zecous-migration-title">
          {t("ZecousAI users have all moved to the new Claudex")}
        </h2>
        <p className="zecous-migration-text">
          {t(
            "Claudex is the fully upgraded ZecousAI platform, built to give you fuller and steadier service. Since September 4, OpenAI has been degrading and rate-limiting its models, and availability has dropped, so for ZecousAI users we have decided:",
          )}
        </p>
        <ol className="zecous-migration-points">
          {points.map((point, index) => (
            <li key={index}>
              <span className="zecous-migration-number" aria-hidden="true">
                {index + 1}
              </span>
              <span>{point}</span>
            </li>
          ))}
        </ol>
        <p className="zecous-migration-amount">
          {formatText(
            "Moving adds {amount} to your Claudex balance ({balance} from your balance, {subscription} from your subscriptions).",
            {
              amount: usd(migration.amountUsd),
              balance: usd(migration.balanceUsd),
              subscription: usd(migration.subscriptionUsd),
            },
          )}
        </p>
        <p className="zecous-migration-note">
          {t(
            "Once you confirm, your ZecousAI subscription and balance are cleared and moved to Claudex. If you use the API, switch your request address and create new keys in the API tab at the top left.",
          )}
        </p>
        {error && (
          <p className="zecous-migration-error" role="alert">
            {error}
          </p>
        )}
        <div className="zecous-migration-actions">
          <button
            ref={confirmButton}
            type="button"
            className="zecous-migration-confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? t("Moving…") : t("Confirm move")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The capture's hand-drawn gift: a box in four panes, two of them shaded, under a bow. */
function GiftIcon() {
  return (
    <svg
      className="zecous-migration-gift"
      width="46"
      height="56"
      viewBox="0 0 46 56"
      fill="none"
      aria-hidden="true"
    >
      <rect x="2" y="15" width="21" height="19" className="shade" />
      <rect x="23" y="34" width="21" height="19" className="shade" />
      <path
        d="M2 15h42v38H2zM23 15v38M2 34h42"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M23 15c-3-6-9-10-12-7-2.5 2.6 1 6.2 12 7zm0 0c3-6 9-10 12-7 2.5 2.6-1 6.2-12 7z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
