import { useState } from "react";
import { createPortal } from "react-dom";
import { Info } from "../../ui/glyphs";
import type {
  BillingOrder,
  BillingOrderPage,
  PlanOffer,
} from "../../../shared/billing-api";
import { formatText, t, tc } from "../../i18n";
import { Modal } from "../../ui/Controls";
import { Section } from "../controls";
import { dateTime, money, orderTitle, shortDate, statusLabel } from "./quote";
import "./invoices.css";

/**
 * Settings → Billing → Invoices: the person's orders in the original's invoice
 * table (Date, Total, Status, Actions; Load more under it; "We have not sent
 * you an invoice yet." when there are none). An order still waiting for payment
 * offers Pay (and Cancel, as the service allows); a paid one View details, the
 * invoice detail drawn from the order.
 */
export function Invoices({
  orders,
  plans,
  onPay,
  onCancel,
  onMore,
  loadingMore,
}: {
  orders: BillingOrderPage;
  plans: readonly PlanOffer[];
  onPay: (order: BillingOrder) => void;
  onCancel: (order: BillingOrder) => void;
  onMore: () => void;
  loadingMore: boolean;
}) {
  const [detail, setDetail] = useState<BillingOrder>();
  if (orders.items.length === 0)
    return (
      <Section title="Invoices">
        <span className="billing-anchor" data-setting="Invoices" />
        <p className="billing-invoices-empty">
          We have not sent you an invoice yet.
        </p>
      </Section>
    );
  return (
    <Section title="Invoices">
      <span className="billing-anchor" data-setting="Invoices" />
      <div className="billing-invoices" data-testid="invoice-list">
        <table aria-label={t("Invoices")}>
          <thead>
            <tr>
              <th>Date</th>
              {/* The amount, not a length of time: "billing|Total". */}
              <th>{tc("billing", "Total")}</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {orders.items.map((order) => (
              <tr key={order.id}>
                <td>{shortDate(order.createdAt)}</td>
                <td>
                  <span className="billing-invoice-total">
                    {money(order.payAmount, order.currency)}
                    {order.payAmount > order.amount && (
                      <span
                        className="billing-invoice-info"
                        title={`${formatText("Price: {price}", {
                          price: money(order.amount, order.currency),
                        })}\n${formatText("Fees: {fees}", {
                          fees: money(
                            order.payAmount - order.amount,
                            order.currency,
                          ),
                        })}`}
                      >
                        <Info size={14} aria-hidden />
                      </span>
                    )}
                  </span>
                </td>
                <td>
                  <span
                    className={`billing-invoice-status ${
                      ["EXPIRED", "CANCELLED", "FAILED", "REFUNDED"].includes(
                        order.status,
                      )
                        ? "muted"
                        : ""
                    }`}
                  >
                    {statusLabel(order.status)}
                  </span>
                </td>
                <td className="billing-invoice-actions">
                  {order.status === "PENDING" ? (
                    <>
                      <button type="button" onClick={() => onPay(order)}>
                        Pay
                      </button>
                      {" · "}
                      <button type="button" onClick={() => onCancel(order)}>
                        Cancel
                      </button>
                    </>
                  ) : ["PAID", "RECHARGING", "COMPLETED", "REFUNDED"].includes(
                      order.status,
                    ) ? (
                    <button type="button" onClick={() => setDetail(order)}>
                      View details
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {orders.page < orders.pages && (
        <div className="billing-invoices-more">
          <button
            type="button"
            className="settings-button"
            disabled={loadingMore}
            onClick={onMore}
          >
            Load more
          </button>
        </div>
      )}
      {detail && (
        <InvoiceDetail
          order={detail}
          plans={plans}
          onClose={() => setDetail(undefined)}
        />
      )}
    </Section>
  );
}

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );

/** The invoice's lines: what was bought and what was charged. */
export function invoiceLines(order: BillingOrder, plans: readonly PlanOffer[]) {
  return [
    [t("Invoice number"), `#${order.id}`],
    [t("Date"), dateTime(order.createdAt)],
    ...(order.paidAt ? [[t("Paid"), dateTime(order.paidAt)]] : []),
    [t("Item"), t(orderTitle(order, plans))],
    [t("Price"), money(order.amount, order.currency)],
    ...(order.payAmount > order.amount
      ? [[t("Fees"), money(order.payAmount - order.amount, order.currency)]]
      : []),
    [tc("billing", "Total"), money(order.payAmount, order.currency)],
    [t("Payment method"), order.method],
    [t("Status"), t(statusLabel(order.status))],
  ];
}

/** The invoice as a CSV file (the original's Download CSV). */
export function invoiceCsv(order: BillingOrder, plans: readonly PlanOffer[]) {
  const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return invoiceLines(order, plans)
    .map((line) => line.map(cell).join(","))
    .join("\r\n");
}

function invoiceDocument(order: BillingOrder, plans: readonly PlanOffer[]) {
  const rows = invoiceLines(order, plans)
    .map(
      ([label, value]) =>
        `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:32px;font:14px/20px -apple-system,"Segoe UI",sans-serif;color:#141413;background:#fff}
h1{margin:0 0 4px;font-size:20px;line-height:28px}p{margin:0 0 24px;color:#5e5d59}
table{width:100%;border-collapse:collapse}th,td{padding:10px 0;border-bottom:1px solid #e8e6dc;text-align:left;vertical-align:top}
th{width:40%;font-weight:500;color:#5e5d59}
</style></head><body><h1>Claudex</h1><p>${escape(t("Invoice"))} #${order.id}</p><table>${rows}</table></body></html>`;
}

/**
 * "Invoice detail" (cbbbe68ed dc): the invoice document in a sandboxed
 * frame 70vh tall, and Download CSV under it. Claudex's service keeps no
 * PDF of its orders, so there is no Download PDF.
 */
function InvoiceDetail({
  order,
  plans,
  onClose,
}: {
  order: BillingOrder;
  plans: readonly PlanOffer[];
  onClose: () => void;
}) {
  const [error, setError] = useState<string>();
  return createPortal(
    <Modal
      title="Invoice detail"
      wide
      className="billing-invoice-detail"
      onClose={onClose}
    >
      <iframe
        title={t("Invoice detail document")}
        sandbox=""
        srcDoc={invoiceDocument(order, plans)}
      />
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="secondary"
          onClick={() =>
            void window.desktop
              .saveArtifact(`invoice-${order.id}.csv`, invoiceCsv(order, plans))
              .catch((reason) =>
                setError(
                  reason instanceof Error ? reason.message : String(reason),
                ),
              )
          }
        >
          Download CSV
        </button>
      </div>
    </Modal>,
    document.body,
  );
}
