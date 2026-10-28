import { useEffect, useState } from "react";
import type { SpendLimit } from "../../../shared/billing-api";
import { currentLocale, formatText, t } from "../../i18n";
import { Button, SettingsModal } from "../controls";
import { Spinner } from "../../ui/Spinner";
import "./spend-limit.css";

/**
 * "$20" for whole amounts, "$20.50" otherwise, and the dollar sign in every
 * language. `digits` fixes the decimals, as for this month's spend.
 */
function money(value: number, digits?: number) {
  const places = digits ?? (Number.isInteger(value) ? 0 : 2);
  return new Intl.NumberFormat(currentLocale(), {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(value);
}

/** The block's line. */
export function spendLimitLine(limit: SpendLimit) {
  if (limit.limitUsd === null)
    return formatText("{used} this month · No spend limit", {
      used: money(limit.usedUsd, 2),
    });
  return formatText("{used} of {limit} this month", {
    used: money(limit.usedUsd, 2),
    limit: money(limit.limitUsd),
  });
}

/** An amount like 20 or 20.50; null when it can't be read. */
export function parseSpendAmount(text: string): number | null {
  const value = text.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount <= 100_000 ? amount : null;
}

/**
 * Settings → Billing → Monthly spend limit: this month's spend against the
 * person's own cap, and Manage, which opens "Set monthly spend limit".
 * Claudex has no saved payment method, so the original's Auto-reload is
 * not offered.
 */
export function SpendLimitBlock({
  onError,
}: {
  onError: (error: unknown) => void;
}) {
  const [limit, setLimit] = useState<SpendLimit | null>();
  const [managing, setManaging] = useState(false);
  useEffect(() => {
    let active = true;
    void window.desktop
      .spendLimit()
      .then((value) => active && setLimit(value))
      .catch(() => active && setLimit(null));
    return () => {
      active = false;
    };
  }, []);
  if (!limit) return null;
  return (
    <div className="spend-limit" data-setting="Monthly spend limit">
      <div className="spend-limit-text">
        <h4>{t("Monthly spend limit")}</h4>
        <p className="spend-limit-line">{spendLimitLine(limit)}</p>
        <p className="spend-limit-note">
          {t(
            limit.limitUsd === null
              ? "Usage is charged to your balance."
              : "Usage is charged to your balance, up to this cap each month.",
          )}
        </p>
      </div>
      <button
        type="button"
        className="spend-limit-manage"
        onClick={() => setManaging(true)}
      >
        {t("Manage")}
      </button>
      {managing && (
        <SpendLimitDialog
          current={limit.limitUsd}
          onClose={() => setManaging(false)}
          onSaved={(next) => {
            setLimit(next);
            setManaging(false);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

/** "Set monthly spend limit". */
function SpendLimitDialog({
  current,
  onClose,
  onSaved,
  onError,
}: {
  current: number | null;
  onClose: () => void;
  onSaved: (limit: SpendLimit) => void;
  onError: (error: unknown) => void;
}) {
  const [text, setText] = useState(
    String(current ?? 2000).replace(/\.0+$/, ""),
  );
  const [busy, setBusy] = useState<"limit" | "unlimited">();
  const amount = parseSpendAmount(text);
  const error = !text.trim()
    ? t("Enter an amount")
    : amount === null
      ? t("Enter an amount like 20 or 20.50")
      : undefined;
  const save = async (value: number | null, kind: "limit" | "unlimited") => {
    setBusy(kind);
    try {
      onSaved(await window.desktop.setSpendLimit(value));
    } catch (reason) {
      onError(reason);
      setBusy(undefined);
    }
  };
  return (
    <SettingsModal title="Set monthly spend limit" onClose={onClose}>
      <div className="spend-limit-form">
        <p>
          {t(
            "You can set a maximum amount you can spend on Claudex usage per month.",
          )}
        </p>
        <div>
          <input
            type="text"
            inputMode="decimal"
            className="spend-limit-input"
            aria-label={t("Monthly spend limit")}
            aria-invalid={error ? true : undefined}
            aria-describedby="spend-limit-help"
            value={text}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <p
            id="spend-limit-help"
            className={`spend-limit-help ${error || amount === 0 ? "danger" : ""}`}
          >
            {error ??
              t(
                amount === 0
                  ? "Setting a limit to $0 effectively disables additional spend"
                  : "This spend limit goes into effect immediately",
              )}
          </p>
        </div>
        <div className="button-row">
          <Button
            disabled={Boolean(busy)}
            onClick={() => void save(null, "unlimited")}
          >
            {busy === "unlimited" && <Spinner inheritColor size="sm" />}
            {t("Set to unlimited")}
          </Button>
          <Button
            primary
            disabled={Boolean(busy) || amount === null}
            onClick={() => amount !== null && void save(amount, "limit")}
          >
            {busy === "limit" && <Spinner inheritColor size="sm" />}
            {t("Set spend limit")}
          </Button>
        </div>
      </div>
    </SettingsModal>
  );
}
