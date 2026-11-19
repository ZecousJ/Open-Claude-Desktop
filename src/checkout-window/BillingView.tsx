/**
 * The top-up window's Billing view (owner, 2026-10-31: Settings › Billing
 * of the official interface opens Claudex's own Billing page): the classic
 * Settings › Billing tab (balance, add funds, redeem codes, orders as
 * invoices, spend limit) on the app's settings styles.
 */
import { useState } from "react";
import type { TabProps } from "../settings/context";
import { BillingTab } from "../settings/tabs/Billing";
import "../styles.css";
import "../settings/settings.css";
import "../settings/billing/checkout-page.slot";
import "./billing-view.css";

function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    "",
  );
}

export default function BillingView({ email }: { email: string }) {
  const [error, setError] = useState("");
  // The tab reads only these two of the settings dialog's props.
  const props = { email, onError: (reason: unknown) => setError(errorText(reason)) } as unknown as TabProps;
  return (
    <div className="billing-window">
      <main className="settings-page billing-window-page">
        <h1 className="billing-window-title">Billing</h1>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <BillingTab {...props} />
      </main>
    </div>
  );
}
