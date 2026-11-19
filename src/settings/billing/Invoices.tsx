import { useEffect, useState } from "react";
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

export type InvoiceOrders =
  | { kind: "loading" | "failed"; page: number; data?: BillingOrderPage }
  | { kind: "ready"; data: BillingOrderPage };

export function Invoices({
  orders,
  plans,
  onPay,
  onCancel,
  onPage,
}: {
  orders: InvoiceOrders;
  plans: readonly PlanOffer[];
  onPay: (order: BillingOrder) => void;
  onCancel: (order: BillingOrder) => void;
  onPage: (page: number) => void;
}) {
  const [detailOrderId, setDetailOrderId] = useState<number>();
  const data = orders.data;
  return (
    <Section title="Invoices">
      <span className="billing-anchor" data-setting="Invoices" />
      {orders.kind === "loading" && !data && <p role="status">Loading…</p>}
      {data && data.items.length === 0 && orders.kind === "ready" && (
        <p className="billing-invoices-empty">
          We have not sent you an invoice yet.
        </p>
      )}
      {data && data.items.length > 0 && (
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
              {data.items.map((order) => (
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
                    {order.status === "PENDING" && (
                      <>
                        <button type="button" onClick={() => onPay(order)}>
                          Pay
                        </button>
                        {" · "}
                        <button type="button" onClick={() => onCancel(order)}>
                          Cancel
                        </button>
                        {" · "}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setDetailOrderId(order.id)}
                    >
                      View details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.page < data.pages && orders.kind !== "failed" && (
        <div className="billing-invoices-more">
          <button
            type="button"
            className="settings-button"
            disabled={orders.kind === "loading"}
            onClick={() => onPage(data.page + 1)}
          >
            Load more
          </button>
        </div>
      )}
      {orders.kind === "failed" && (
        <div className="settings-load-error">
          <p role="alert">Unable to load data. Try again later.</p>
          <button
            type="button"
            className="settings-button"
            onClick={() => onPage(orders.page)}
          >
            Try again
          </button>
        </div>
      )}
      {detailOrderId !== undefined && (
        <InvoiceDetail
          key={detailOrderId}
          orderId={detailOrderId}
          plans={plans}
          onClose={() => setDetailOrderId(undefined)}
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

function hasInvoice(order: BillingOrder) {
  return (
    order.paidAt !== null ||
    ["PAID", "RECHARGING", "COMPLETED", "REFUNDED"].includes(order.status)
  );
}

export function invoiceLines(order: BillingOrder, plans: readonly PlanOffer[]) {
  return [
    [t(hasInvoice(order) ? "Invoice number" : "Order number"), `#${order.id}`],
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
  const cell = (value: string) => {
    const text = /^\s*[=+@-]|^[\t\r\n]/.test(value) ? `'${value}` : value;
    return `"${text.replace(/"/g, '""')}"`;
  };
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
</style></head><body><h1>Claudex</h1><p>${escape(t(hasInvoice(order) ? "Invoice" : "Order"))} #${order.id}</p><table>${rows}</table></body></html>`;
}

type OrderDetail =
  { kind: "loading" | "failed" } | { kind: "ready"; order: BillingOrder };

function InvoiceDetail({
  orderId,
  plans,
  onClose,
}: {
  orderId: number;
  plans: readonly PlanOffer[];
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetail>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [save, setSave] = useState<"idle" | "saving" | "failed">("idle");
  useEffect(() => {
    let active = true;
    void window.desktop.billingOrder(orderId).then(
      (order) => {
        if (active) setDetail({ kind: "ready", order });
      },
      () => {
        if (active) setDetail({ kind: "failed" });
      },
    );
    return () => {
      active = false;
    };
  }, [orderId, attempt]);

  const order = detail.kind === "ready" ? detail.order : undefined;
  const paid = order && hasInvoice(order);
  const download = async (order: BillingOrder) => {
    setSave("saving");
    try {
      const csv = invoiceCsv(order, plans);
      if (window.checkoutWindow)
        await window.checkoutWindow.saveInvoiceCsv(order.id, csv);
      else await window.desktop.saveArtifact(`invoice-${order.id}.csv`, csv);
      setSave("idle");
    } catch {
      setSave("failed");
    }
  };
  return createPortal(
    <Modal
      title={order && !paid ? "Order detail" : "Invoice detail"}
      wide
      className="billing-invoice-detail"
      onClose={onClose}
    >
      {detail.kind === "loading" && <p role="status">Loading…</p>}
      {detail.kind === "failed" && (
        <div className="settings-load-error">
          <p role="alert">Unable to load data. Try again later.</p>
          <button
            type="button"
            className="settings-button"
            onClick={() => {
              setDetail({ kind: "loading" });
              setAttempt((count) => count + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {order && (
        <iframe
          title={t(paid ? "Invoice detail document" : "Order detail document")}
          sandbox=""
          srcDoc={invoiceDocument(order, plans)}
        />
      )}
      {save === "failed" && (
        <p className="error-text" role="alert">
          Unable to save invoice.
        </p>
      )}
      {order && paid && (
        <div className="button-row">
          <button
            type="button"
            className="secondary"
            disabled={save === "saving"}
            onClick={() => void download(order)}
          >
            Download CSV
          </button>
        </div>
      )}
    </Modal>,
    document.body,
  );
}
