import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft } from "../../ui/glyphs";
import { formatText, useT } from "../../i18n";
import { Star } from "../../ui/Star";

/** One line of the order summary. */
export interface SummaryLine {
  label: string;
  value: string;
}

/**
 * The checkout as a page of its own, laid out like Stripe Checkout: the order
 * on the left (who is paid, the amount due, its lines), the form on the right;
 * one column on a phone. Escape and the back arrow leave it; focus starts on
 * the right.
 */
export function CheckoutPage({
  merchant,
  amount,
  lines,
  total,
  onClose,
  children,
}: {
  merchant: string;
  /** The amount due, formatted. */
  amount: string;
  lines: SummaryLine[];
  /** The total line, formatted; omitted until there is an amount. */
  total?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const form = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    form.current
      ?.querySelector<HTMLElement>("input, button:not([disabled])")
      ?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", key);
    return () => {
      removeEventListener("keydown", key);
      previous?.focus?.();
    };
  }, []);
  return createPortal(
    <div
      className="checkout-page"
      role="dialog"
      aria-modal="true"
      aria-label={formatText("Pay {name}", { name: merchant })}
    >
      <section className="checkout-summary">
        <div className="checkout-column">
          <div className="checkout-merchant">
            <button
              type="button"
              className="checkout-back"
              aria-label={t("Back")}
              onClick={onClose}
            >
              <ArrowLeft size={16} strokeWidth={1.75} />
            </button>
            <span className="checkout-logo" aria-hidden="true">
              <Star size={18} />
            </span>
            <span className="checkout-merchant-name" data-no-translate>
              {merchant}
            </span>
          </div>
          <p className="checkout-pay-label">
            {formatText("Pay {name}", { name: merchant })}
          </p>
          <p className="checkout-amount" data-no-translate>
            {amount}
          </p>
          <dl className="checkout-lines">
            {lines.map((line) => (
              <div key={line.label} className="checkout-line">
                <dt>{line.label}</dt>
                <dd data-no-translate>{line.value}</dd>
              </div>
            ))}
            {total !== undefined && (
              <div className="checkout-line checkout-total">
                <dt>{t("Total due")}</dt>
                <dd data-no-translate>{total}</dd>
              </div>
            )}
          </dl>
        </div>
      </section>
      <section className="checkout-form">
        <div className="checkout-column" ref={form}>
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** The marks of the methods a Chinese checkout offers, in their own colours. */
export function MethodMark({ id }: { id: string }) {
  if (id === "wxpay")
    return (
      <svg
        className="checkout-method-mark"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <path
          fill="#1aad19"
          d="M7.6 3C4 3 1 5.4 1 8.4c0 1.7 1 3.3 2.6 4.3l-.6 1.9 2.3-1.2c.7.2 1.5.3 2.3.3h.5a4.9 4.9 0 0 1-.2-1.4c0-2.9 2.8-5.2 6.3-5.2h.5C14.1 4.6 11.2 3 7.6 3Zm-2.2 2.8a.8.8 0 1 1 0 1.7.8.8 0 0 1 0-1.7Zm4.4 0a.8.8 0 1 1 0 1.7.8.8 0 0 1 0-1.7Zm4.4 2.4c-3 0-5.4 2-5.4 4.4 0 2.5 2.4 4.4 5.4 4.4.6 0 1.2-.1 1.8-.3l1.8 1-.5-1.6c1.4-.8 2.3-2.1 2.3-3.5 0-2.4-2.4-4.4-5.4-4.4Zm-1.8 2.2a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Zm3.6 0a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"
        />
      </svg>
    );
  if (id === "alipay")
    return (
      <svg
        className="checkout-method-mark"
        width="20"
        height="20"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <rect width="20" height="20" rx="4.5" fill="#1677ff" />
        <path
          fill="#fff"
          d="M5 6.2h10v1.2H10.7v1.3h3.6v1.2h-1.1a9.6 9.6 0 0 1-1.7 3.2c1.2.5 2.4 1 3.5 1.6l-.7 1.2c-1.2-.7-2.5-1.3-3.8-1.8A7 7 0 0 1 5.3 15l-.4-1.3a6 6 0 0 0 4.4-1.4c-.9-.3-1.8-.6-2.6-.8l.5-1.1c1 .3 2 .6 3 1 .5-.6.9-1.3 1.2-2.1H5.6V8.7h3.8V7.4H5Z"
        />
      </svg>
    );
  return null;
}
