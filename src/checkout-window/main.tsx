/**
 * The top-up window's page (checkout.html; shared/checkout-window.ts):
 * Claudex's checkout for adding funds, as Settings → Billing shows it, in a
 * window of its own. It talks only to its preload's `window.desktop`
 * (payment calls) and `window.checkoutWindow`.
 */
import React, { Suspense, lazy, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { BillingCheckout } from "../../shared/billing-api";
import type {
  CheckoutWindowBridge,
  CheckoutWindowInfo,
  CheckoutWindowView,
} from "../../shared/checkout-window";
import { initialLocale, setLocale } from "../i18n";
import { startDomTranslation } from "../i18n/dom";
import { CheckoutDialog } from "../settings/billing/CheckoutDialog";
import "../settings/billing/checkout-page.slot";
import "./checkout-window.css";

declare global {
  interface Window {
    checkoutWindow?: CheckoutWindowBridge;
  }
}

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

// The Billing view brings the app's settings styles; loaded when shown.
const BillingView = lazy(() => import("./BillingView"));

function TopUpCheckout({
  info,
  bridge,
}: {
  info: CheckoutWindowInfo;
  bridge: CheckoutWindowBridge;
}) {
  const [checkout, setCheckout] = useState<BillingCheckout | null>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void window.desktop.billingCheckout().then(
      (offered) => {
        if (active)
          setCheckout(
            offered && {
              ...offered,
              methods: offered.methods.filter((method) =>
                info.methods.includes(method.id),
              ),
            },
          );
      },
      (reason: unknown) => {
        if (active) setError(errorText(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [attempt, info]);
  if (error || checkout === null)
    return (
      <div className="checkout-window-message" role="alert">
        <p>{error || "Adding funds is not available right now."}</p>
        {error && (
          <button
            type="button"
            className="checkout-secondary"
            onClick={() => {
              setError("");
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </button>
        )}
        <button
          type="button"
          className="checkout-secondary"
          onClick={bridge.close}
        >
          Close
        </button>
      </div>
    );
  if (!checkout)
    return (
      <div className="checkout-window-message" role="status">
        Loading…
      </div>
    );
  return (
    <CheckoutDialog
      checkout={checkout}
      purchase={{ funds: true }}
      email={info.email}
      onClose={bridge.close}
      onSettled={() => {}}
    />
  );
}

function CheckoutWindow({ bridge }: { bridge: CheckoutWindowBridge }) {
  const [info, setInfo] = useState<CheckoutWindowInfo>();
  const [view, setView] = useState<CheckoutWindowView>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const unsubscribe = bridge.onView(setView);
    void bridge.info().then(
      (next) => {
        if (!active) return;
        document.documentElement.dataset.theme = next.theme;
        setInfo(next);
        setView((current) => current ?? next.view);
      },
      (reason: unknown) => {
        if (active) setError(errorText(reason));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);
  if (error)
    return (
      <div className="checkout-window-message" role="alert">
        <p>{error}</p>
        <button
          type="button"
          className="checkout-secondary"
          onClick={bridge.close}
        >
          Close
        </button>
      </div>
    );
  if (!info || !view) return null;
  if (view === "billing")
    return (
      <Suspense fallback={null}>
        <BillingView email={info.email} />
      </Suspense>
    );
  return <TopUpCheckout info={info} bridge={bridge} />;
}

async function start() {
  const bridge = window.checkoutWindow;
  if (!bridge) return;
  await setLocale(initialLocale()).catch(() => {});
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <CheckoutWindow bridge={bridge} />
    </React.StrictMode>,
  );
  startDomTranslation();
}
void start();
