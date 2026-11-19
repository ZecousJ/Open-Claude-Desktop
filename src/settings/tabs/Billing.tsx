import { useLocale } from "../../i18n";
/**
 * Settings → Billing (package C5). The plan card follows
 * R-设置-Billing-顶部 (a 64px drawing, the plan's name and one line under
 * it); balance, plans, redeem codes and orders use the Settings rows and
 * are provisional (no capture of the original shows them). The person's
 * orders show as the original's Invoices. Sub2API has no saved payment
 * methods or plan cancellation, so none are shown.
 */
import { useEffect, useRef, useState } from "react";
import type {
  BillingCheckout,
  BillingInfo,
  BillingOrder,
  PlanOffer,
} from "../../../shared/billing-api";
import { CheckoutDialog, type Purchase } from "../billing/CheckoutDialog";
import { PlanIcon } from "../billing/PlanIcon";
import { Invoices, type InvoiceOrders } from "../billing/Invoices";
import { SpendLimitBlock } from "../billing/SpendLimit";
import { onRechargeRequest, takeRechargeRequest } from "../billing/recharge";
import {
  money,
  planQuote,
  shortDate,
  usd,
  validityText,
} from "../billing/quote";
import { Button, Row, Section, Value } from "../controls";
import type { TabProps } from "../context";
import { useHost } from "../../host/HostContext";
import "../billing.css";
import { SettingsSkeleton } from "../../ui/Skeleton";

export { searchLabels } from "../billing/search";

/**
 * The plan card (cbbbe68ed: the drawing, the plan's name and its line,
 * and at the right Adjust plan, or Upgrade plan on pay-as-you-go, where
 * the service sells plans: both go to the Plans below).
 */
function PlanCard({
  info,
  onPlans,
}: {
  info: BillingInfo;
  onPlans?: () => void;
}) {
  const subtitle = info.plan
    ? info.planExpiresAt
      ? `Ends ${shortDate(info.planExpiresAt)}`
      : "No end date"
    : "Usage is charged to your balance";
  return (
    <div className="billing-plan" data-setting="Plan">
      <PlanIcon />
      <div className="billing-plan-text">
        <div className="billing-plan-name">
          {info.plan ? `${info.plan} plan` : "Pay as you go"}
        </div>
        <div className="billing-plan-note">{subtitle}</div>
      </div>
      {onPlans && (
        <div className="billing-plan-action">
          <Button size="regular" primary={!info.plan} onClick={onPlans}>
            {info.plan ? "Adjust plan" : "Upgrade plan"}
          </Button>
        </div>
      )}
    </div>
  );
}

function PlanRow({
  plan,
  checkout,
  current,
  onBuy,
}: {
  plan: PlanOffer;
  checkout: BillingCheckout;
  current: boolean;
  onBuy: () => void;
}) {
  const quote = planQuote(plan, checkout.methods[0], checkout);
  const period = validityText(plan);
  return (
    <Row
      label={plan.name}
      description={
        <>
          <span className="billing-price">
            {money(quote.base, quote.currency)}
            {period && ` / ${period}`}
          </span>
          {plan.originalPrice && plan.originalPrice > plan.price ? (
            <s className="billing-price-was">
              {money(
                planQuote(
                  { ...plan, price: plan.originalPrice },
                  checkout.methods[0],
                  checkout,
                ).base,
                quote.currency,
              )}
            </s>
          ) : null}
          {plan.description && (
            <span className="billing-plan-description">{plan.description}</span>
          )}
          {plan.features.length > 0 && (
            <span className="billing-plan-description">
              {plan.features.join(" · ")}
            </span>
          )}
        </>
      }
    >
      <Button size="regular" onClick={onBuy}>
        {current ? "Extend" : "Subscribe"}
      </Button>
    </Row>
  );
}

export function BillingTab({
  onError,
  email,
}: Pick<TabProps, "onError" | "email">) {
  // The web app opens payment pages in its own tab (web plan Q8): there is
  // no system browser to hand them to.
  const inTab = useHost().kind === "web";
  useLocale();
  const [info, setInfo] = useState<BillingInfo | null>();
  const [checkout, setCheckout] = useState<BillingCheckout | null>(null);
  const [orders, setOrders] = useState<InvoiceOrders>({
    kind: "loading",
    page: 1,
  });
  const orderRequest = useRef(0);
  const [purchase, setPurchase] = useState<Purchase>();
  // The open checkout dialog reloads the page itself when its order settles.
  const purchaseOpen = useRef(false);
  purchaseOpen.current = !!purchase;
  // What the service sells once read (undefined until then).
  const checkoutRef = useRef<BillingCheckout | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [redeemNote, setRedeemNote] = useState<{
    text: string;
    error: boolean;
  }>();

  const loadOrders = async (page = 1) => {
    const request = ++orderRequest.current;
    setOrders((current) => ({ kind: "loading", page, data: current.data }));
    try {
      const next = await window.desktop.billingOrders(page);
      if (request !== orderRequest.current) return;
      setOrders((current) => ({
        kind: "ready",
        data:
          page > 1 && current.data
            ? { ...next, items: [...current.data.items, ...next.items] }
            : next,
      }));
    } catch {
      if (request === orderRequest.current)
        setOrders((current) => ({ kind: "failed", page, data: current.data }));
    }
  };
  const updateOrder = (
    id: number,
    update: (item: BillingOrder) => BillingOrder,
  ) =>
    setOrders((current) => {
      if (!current.data) return current;
      return {
        ...current,
        data: {
          ...current.data,
          items: current.data.items.map((item) =>
            item.id === id ? update(item) : item,
          ),
        },
      };
    });
  const load = async () => {
    const value = await window.desktop.billingInfo();
    setInfo(value);
    if (!value) {
      checkoutRef.current = null;
      takeRechargeRequest();
      return;
    }
    const orderRead = loadOrders();
    const offer = await window.desktop.billingCheckout().catch((error) => {
      onError(error);
      return null;
    });
    setCheckout(offer);
    checkoutRef.current = offer;
    // Opened from the recharge entry (account menu, low-balance notice):
    // straight into Add funds when the service takes payments.
    if (takeRechargeRequest() && offer?.balance) setPurchase({ funds: true });
    await orderRead;
  };
  // The account's billing did not load: say so with Try again (the
  // original's "Unable to load data. Try again later." line, live claude.ai
  // bundle, 2026-10-12) rather than the page for a service without billing.
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const firstLoad = () =>
    load()
      .then(() => setLoadFailed(false))
      .catch((error) => {
        console.error("Billing did not load:", error);
        setLoadFailed(true);
      });
  useEffect(() => {
    void firstLoad();
  }, []);
  // A recharge asked for while this page is already open and loaded.
  useEffect(
    () =>
      onRechargeRequest(() => {
        if (checkoutRef.current === undefined) return;
        takeRechargeRequest();
        if (checkoutRef.current?.balance) setPurchase({ funds: true });
      }),
    [],
  );
  // Orders placed elsewhere in this session change status in the list too.
  useEffect(
    () =>
      window.desktop.onEvent((event) => {
        if (event.type !== "billing-order") return;
        // Paid after the checkout dialog was closed: show the new plan and balance.
        if (event.status === "COMPLETED" && !purchaseOpen.current)
          void load().catch(onError);
        updateOrder(event.orderId, (item) => ({
          ...item,
          status: event.status,
        }));
      }),
    [],
  );

  if (info === undefined && loadFailed)
    return (
      <Section title="Billing">
        <div className="settings-load-error">
          <p>Unable to load data. Try again later.</p>
          <Button
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              void firstLoad().finally(() => setRetrying(false));
            }}
          >
            Try again
          </Button>
        </div>
      </Section>
    );
  if (info === undefined) return <SettingsSkeleton />;
  if (!info)
    return (
      <Section
        title="Billing"
        note="Your account and model access are managed by your Claudex service. There is nothing to pay for in this app."
      />
    );

  const redeem = async () => {
    setRedeeming(true);
    setRedeemNote(undefined);
    try {
      const result = await window.desktop.redeemCode(code);
      setRedeemNote({ text: result.message, error: false });
      setCode("");
      if (result.billing) setInfo(result.billing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRedeemNote({
        text: message.replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          "",
        ),
        error: true,
      });
    } finally {
      setRedeeming(false);
    }
  };
  const plans = checkout?.plans ?? [];
  const currentGroups = new Set(
    info.subscriptions
      .filter((item) => item.status === "active")
      .map((item) => item.plan),
  );

  return (
    <div className="billing-page">
      <PlanCard
        info={info}
        onPlans={
          checkout && plans.length > 0
            ? () =>
                document
                  .querySelector('.billing-page [data-setting="Plans"]')
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
            : undefined
        }
      />
      <Section title="Balance">
        <span className="billing-anchor" data-setting="Balance" />
        <Row
          label={usd(info.balance)}
          description={
            info.plan
              ? "Usage outside your plan is charged to your balance."
              : "Usage is charged to your balance"
          }
        >
          {checkout?.balance && (
            <Button size="regular" onClick={() => setPurchase({ funds: true })}>
              Add funds
            </Button>
          )}
        </Row>
        <SpendLimitBlock onError={onError} />
      </Section>
      {checkout && plans.length > 0 && (
        <Section title="Plans">
          <span className="billing-anchor" data-setting="Plans" />
          {plans.map((plan) => (
            <PlanRow
              key={plan.id}
              plan={plan}
              checkout={checkout}
              current={currentGroups.has(plan.groupName)}
              onBuy={() => setPurchase({ plan })}
            />
          ))}
        </Section>
      )}
      {info.redeem !== false && (
        <Section title="Redeem code">
          <span className="billing-anchor" data-setting="Redeem code" />
          <form
            className="billing-redeem"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.trim() && !redeeming) void redeem();
            }}
          >
            <input
              className="settings-input"
              aria-label="Redeem code"
              placeholder="Enter a code"
              value={code}
              spellCheck={false}
              onChange={(event) => setCode(event.target.value)}
            />
            <button
              type="submit"
              className="settings-button regular"
              disabled={!code.trim() || redeeming}
            >
              Redeem
            </button>
          </form>
          {redeemNote && (
            <p
              className={`billing-redeem-note ${redeemNote.error ? "error-text" : ""}`}
              role={redeemNote.error ? "alert" : "status"}
            >
              {redeemNote.text}
            </p>
          )}
        </Section>
      )}
      <Invoices
        orders={orders}
        plans={plans}
        onPage={(page) => void loadOrders(page)}
        onPay={(order) =>
          void window.desktop.reopenPayment(order.id).catch(onError)
        }
        onCancel={(order) =>
          void window.desktop
            .cancelOrder(order.id)
            .then((next) => updateOrder(next.id, () => next))
            .catch(onError)
        }
      />
      {purchase && checkout && (
        <CheckoutDialog
          checkout={checkout}
          purchase={purchase}
          inTab={inTab}
          email={email}
          onClose={() => setPurchase(undefined)}
          onSettled={() => void load().catch(onError)}
        />
      )}
    </div>
  );
}
