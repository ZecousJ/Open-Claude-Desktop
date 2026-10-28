import { currentLocale, formatText, t as tt, useT } from "../../i18n";
/**
 * Buying a plan or adding funds (package C5): choose a method (and an
 * amount), then pay with a QR code in the app or on the page the app opened
 * in the system browser. The main process follows the order and sends
 * "billing-order" events; this dialog shows each status as it arrives.
 *
 * In the web app (`inTab`) there is no second browser: the payment page
 * opens in the app's own tab (web plan Q8), so the words say so.
 */
import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type {
  BillingCheckout,
  BillingOrder,
  PaymentMethod,
  PaymentStarted,
  PlanOffer,
} from "../../../shared/billing-api";
import { orderIsOpen } from "../../../shared/billing-api";
import { SettingsModal } from "../controls";
import { Check } from "../../ui/glyphs";
import { CheckoutPage, MethodMark, type SummaryLine } from "./CheckoutPage";
import {
  balanceQuote,
  countdown,
  money,
  planQuote,
  usd,
  validityText,
} from "./quote";

export type Purchase = { plan: PlanOffer } | { funds: true };

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors thrown in the main process.
  return message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

/** The QR code as an image; the payment link never becomes markup. */
function QrImage({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (live)
          setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => setSrc(undefined));
    return () => {
      live = false;
    };
  }, [text]);
  return (
    <div className="billing-qr" role="img" aria-label={label}>
      {src && <img src={src} alt="" width={184} height={184} />}
    </div>
  );
}

function statusMessage(order: BillingOrder, kind: PaymentStarted["kind"]) {
  switch (order.status) {
    case "PENDING":
      return kind === "qr"
        ? "Waiting for payment…"
        : "Waiting for the payment to go through…";
    case "PAID":
    case "RECHARGING":
      return "Payment received. Adding it to your account…";
    case "COMPLETED":
      return order.kind === "subscription"
        ? "Payment complete. Your plan is ready."
        : "Payment complete. The funds were added to your balance.";
    case "EXPIRED":
      return "This order expired before it was paid.";
    case "CANCELLED":
      return "This order was cancelled.";
    default:
      return "This order wasn't completed.";
  }
}

export function CheckoutDialog({
  checkout,
  purchase,
  inTab = false,
  onClose,
  onSettled,
  email,
}: {
  checkout: BillingCheckout;
  purchase: Purchase;
  /** Payment pages open in this tab (the web app), not the system browser. */
  inTab?: boolean;
  onClose: () => void;
  /** The order moved on (paid, cancelled…): Billing reads the plan and orders again. */
  onSettled: () => void;
  /** The account's address, shown under Contact as on Stripe Checkout. */
  email?: string;
}) {
  const t = useT();
  const plan = "plan" in purchase ? purchase.plan : undefined;
  const [methodId, setMethodId] = useState(checkout.methods[0]?.id ?? "");
  const method =
    checkout.methods.find((item) => item.id === methodId) ??
    checkout.methods[0];
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [started, setStarted] = useState<PaymentStarted>();
  const [order, setOrder] = useState<BillingOrder>();
  const [now, setNow] = useState(Date.now());

  const quote = useMemo(() => {
    if (!method) return undefined;
    return plan
      ? { ...planQuote(plan, method, checkout), credit: undefined }
      : balanceQuote(Number(amount), method, checkout);
  }, [plan, method, amount, checkout]);

  // Status events for this order; each change is read back for the amounts.
  useEffect(() => {
    if (!started) return;
    const id = started.order.id;
    return window.desktop.onEvent((event) => {
      if (event.type !== "billing-order" || event.orderId !== id) return;
      void window.desktop
        .billingOrder(id)
        .then(setOrder)
        .catch(() =>
          setOrder(
            (current) => current && { ...current, status: event.status },
          ),
        );
      if (event.status !== "PENDING") onSettled();
    });
  }, [started]);
  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [started]);

  const title = plan
    ? formatText("Subscribe to {x}", { x: plan.name })
    : "Add funds";
  if (!method)
    return (
      <SettingsModal title={title} onClose={onClose}>
        <p className="confirm-body">
          No payment method can be used from this app.
        </p>
      </SettingsModal>
    );

  const pay = async () => {
    if (!quote || quote.problem) return;
    setBusy(true);
    setError("");
    try {
      // A phone cannot scan its own screen: the service then opens the
      // payment page (WeChat H5) instead of returning a QR code.
      const mobile = matchMedia(
        "(max-width: 767.98px) and (pointer: coarse)",
      ).matches;
      const result = await window.desktop.startPayment(
        plan
          ? { method: method.id, planId: plan.id, mobile }
          : { method: method.id, amount: quote.base, mobile },
      );
      setStarted(result);
      setOrder(result.order);
      setNow(Date.now());
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const cancelOrder = async () => {
    if (!order) return;
    setBusy(true);
    try {
      setOrder(await window.desktop.cancelOrder(order.id));
      onSettled();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };

  const credit =
    !plan && quote && quote.credit !== undefined ? quote.credit : undefined;
  const merchant = "Claudex";
  const methodName = (item: PaymentMethod) => t(item.label);

  if (started && order) {
    const open = orderIsOpen(order.status);
    const expired =
      order.status === "PENDING" && !!order.expiresAt && now >= order.expiresAt;
    const currency = order.currency || method.currency;
    const charged = money(order.payAmount, currency);
    const done = order.status === "COMPLETED";
    return (
      <CheckoutPage
        merchant={merchant}
        amount={charged}
        lines={summaryLines(plan, credit, money(order.amount, currency))}
        total={charged}
        onClose={onClose}
      >
        <div className="checkout-pay" aria-live="polite">
          {done && (
            <span className="checkout-done-mark" aria-hidden="true">
              <Check size={22} strokeWidth={2.25} />
            </span>
          )}
          {started.kind === "qr" && order.status === "PENDING" && !expired && (
            <>
              <h2 className="checkout-pay-title">
                <span data-no-translate>
                  {formatText("Scan with {method} to pay {amount}", {
                    method: methodName(method),
                    amount: charged,
                  })}
                </span>
              </h2>
              <div className="checkout-qr-card">
                <QrImage
                  text={started.qrCode}
                  label={formatText("QR code to pay {amount} with {method}", {
                    amount: charged,
                    method: methodName(method),
                  })}
                />
              </div>
            </>
          )}
          {started.kind === "browser" &&
            order.status === "PENDING" &&
            !expired &&
            (inTab ? (
              <>
                <h2 className="checkout-pay-title">
                  Opening the payment page…
                </h2>
                <p className="checkout-pay-note">
                  <span data-no-translate>
                    {formatText(
                      "Pay {amount} there. Your plan and balance update when the payment goes through.",
                      { amount: charged },
                    )}
                  </span>
                </p>
              </>
            ) : (
              <>
                <h2 className="checkout-pay-title">
                  Finish paying in your browser
                </h2>
                <p className="checkout-pay-note">
                  <span data-no-translate>
                    {formatText(
                      "The payment page for {amount} opened in your browser. This window updates when the payment goes through.",
                      { amount: charged },
                    )}
                  </span>
                </p>
              </>
            ))}
          <p
            className={`checkout-pay-status ${open && !expired ? "" : "settled"}`}
          >
            {expired
              ? "This order expired before it was paid."
              : statusMessage(order, started.kind)}
          </p>
          {order.status === "PENDING" && !expired && (
            <p className="checkout-pay-note">
              {countdown(order.expiresAt, now)}
            </p>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="checkout-actions">
            {order.status === "PENDING" && !expired ? (
              <>
                {started.kind === "browser" && (
                  <button
                    type="button"
                    className="checkout-submit"
                    onClick={() =>
                      void window.desktop
                        .reopenPayment(order.id)
                        .catch((reason) => setError(errorText(reason)))
                    }
                  >
                    {inTab ? "Go to payment page" : "Open again"}
                  </button>
                )}
                <button
                  type="button"
                  className="checkout-secondary"
                  disabled={busy}
                  onClick={() => void cancelOrder()}
                >
                  Cancel order
                </button>
              </>
            ) : (
              <button
                type="button"
                className="checkout-submit"
                onClick={onClose}
              >
                {open ? "Close" : "Done"}
              </button>
            )}
          </div>
        </div>
      </CheckoutPage>
    );
  }

  const due = quote && !quote.problem ? quote.total : 0;
  return (
    <CheckoutPage
      merchant={merchant}
      amount={money(due, method.currency)}
      lines={summaryLines(
        plan,
        credit,
        money(quote && !quote.problem ? quote.base : 0, method.currency),
        quote && quote.fee > 0
          ? {
              label: formatText("Fee ({percent}%)", {
                percent: checkout.feeRate.toLocaleString(currentLocale()),
              }),
              value: money(quote.fee, quote.currency),
            }
          : undefined,
      )}
      total={money(due, method.currency)}
      onClose={onClose}
    >
      <form
        className="checkout-fields"
        onSubmit={(event) => {
          event.preventDefault();
          void pay();
        }}
      >
        {plan ? (
          <div className="checkout-group">
            <h3>{plan.name}</h3>
            <p className="checkout-pay-note">
              {[plan.description, validityText(plan)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        ) : (
          <label className="checkout-group">
            <h3>{t("Amount to add")}</h3>
            <span className="checkout-input checkout-money-input">
              <span aria-hidden="true">{currencySymbol(method.currency)}</span>
              <input
                inputMode="decimal"
                value={amount}
                placeholder="0.00"
                aria-label={formatText("Amount ({currency})", {
                  currency: method.currency,
                })}
                onChange={(event) =>
                  setAmount(event.target.value.replace(/[^\d.]/g, ""))
                }
              />
            </span>
          </label>
        )}
        {email && (
          <div className="checkout-group">
            <h3>{t("Contact")}</h3>
            <label className="checkout-field-label" htmlFor="checkout-email">
              {t("Email")}
            </label>
            <input
              id="checkout-email"
              className="checkout-input"
              value={email}
              readOnly
              data-no-translate
            />
          </div>
        )}
        <div className="checkout-group">
          <h3>{t("Payment method")}</h3>
          <div
            className="checkout-methods"
            role="radiogroup"
            aria-label="Payment method"
          >
            {checkout.methods.map((item) => (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={method.id === item.id}
                className="checkout-method"
                onClick={() => setMethodId(item.id)}
              >
                <span className="checkout-radio" aria-hidden="true" />
                <MethodMark id={item.id} />
                <span className="checkout-method-label">
                  {methodName(item)}
                </span>
                {item.route === "browser" && (
                  <span className="checkout-method-note">
                    {inTab ? "Opens a payment page" : "Opens in your browser"}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
        {checkout.helpText && (
          <p className="checkout-pay-note">{checkout.helpText}</p>
        )}
        {(error || ((plan || amount) && quote?.problem)) && (
          <p className="error-text" role="alert">
            {error || quote?.problem}
          </p>
        )}
        <button
          type="submit"
          className="checkout-submit"
          disabled={busy || !!quote?.problem}
        >
          {method.route === "browser"
            ? inTab
              ? "Continue to payment"
              : "Continue in browser"
            : formatText("Continue with {method}", {
                method: methodName(method),
              })}
        </button>
      </form>
    </CheckoutPage>
  );
}

/** The order's lines: what is bought, a fee when there is one, the subtotal. */
function summaryLines(
  plan: PlanOffer | undefined,
  credit: number | undefined,
  subtotal: string,
  fee?: SummaryLine,
): SummaryLine[] {
  const lines: SummaryLine[] = plan
    ? [{ label: plan.name, value: subtotal }]
    : [{ label: tt("Account credit"), value: usd(credit ?? 0) }];
  lines.push({ label: tt("Subtotal"), value: subtotal });
  if (fee) lines.push(fee);
  return lines;
}

/** The sign a currency's amounts start with (¥ for CNY). */
function currencySymbol(currency: string) {
  try {
    return (
      new Intl.NumberFormat(currentLocale(), {
        style: "currency",
        currency: currency || "USD",
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
}
