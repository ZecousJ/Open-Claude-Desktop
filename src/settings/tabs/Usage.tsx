import {
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { RotateCw, ChevronDown } from "../../ui/glyphs";
import type { PlanUsage, PlanUsageWindow } from "../../../shared/types";
import type { BillingCheckout } from "../../../shared/billing-api";
import type { TabProps } from "../context";
import { Button, Section } from "../controls";
import { CheckoutDialog } from "../billing/CheckoutDialog";
import { useHost } from "../../host/HostContext";
import {
  atLimit,
  money,
  pace,
  resetText,
  rowLabel,
  rowNote,
  rowSeverity,
  spendText,
  updatedText,
} from "../planUsageFormat";
import "../usage.css";
import { UsageSkeleton } from "../../ui/Skeleton";
import { currentLocale, formatText, t, useT } from "../../i18n";
import { lazyPiece } from "../../ui/lazy-piece";
import { AppContext } from "../../app/AppContext";

// The activity dashboard and its styles load with this page, not the first screen.
const ProductUsage = lazyPiece(
  () => import("../usage-products/ProductUsage"),
  "ProductUsage",
);
const UsageActivity = lazyPiece(
  () => import("../usage-activity/UsageActivity"),
);
const CodeUsageSettings = lazyPiece(
  () => import("../../code-home/CodeUsageSettings"),
);

function LimitRow({
  window,
  now,
  name,
  note,
}: {
  window: PlanUsageWindow;
  now: number;
  /** The label drawn in place of the row's name (the week fold's toggle). */
  name?: ReactNode;
  note?: string;
}) {
  useT();
  const percent = Math.round(window.percent);
  const label = rowLabel(window);
  const full = atLimit(window);
  const severity = rowSeverity(window);
  const shown = full ? 100 : Math.min(100, window.percent);
  return (
    <div className="usage-row" title={spendText(window)} data-setting={label}>
      <div className="usage-row-text">
        <div data-no-translate className="usage-row-label">
          {name ?? label}
        </div>
        <p>{note ?? rowNote(window, now)}</p>
      </div>
      <div
        className={`usage-bar${full ? " full" : shown > 0 ? " used" : ""} ${severity}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={full ? 100 : percent}
        aria-valuetext={formatText("{percent}% used, {spend}", {
          percent: (full ? 100 : percent).toLocaleString(currentLocale()),
          spend: spendText(window),
        })}
      >
        <span style={{ width: `${shown}%` }} />
      </div>
      <span
        className={`usage-row-percent${severity === "critical" ? " full" : ""}`}
      >
        {formatText("{percent}% used", {
          percent: (full ? 100 : percent).toLocaleString(currentLocale()),
        })}
      </span>
    </div>
  );
}

const weekSeconds = 7 * 86_400;

/** The rows, with a week's per-model limits folded under "This week". */
function LimitRows({
  windows,
  now,
}: {
  windows: PlanUsageWindow[];
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const week = windows.findIndex(
    (item) => item.kind === "all_models" && item.windowSeconds === weekSeconds,
  );
  const scoped = windows.filter(
    (item) => item.kind === "models" && item.windowSeconds === weekSeconds,
  );
  if (week < 0 || scoped.length === 0)
    return (
      <div className="usage-rows">
        {windows.map((item) => (
          <LimitRow key={item.id} window={item} now={now} />
        ))}
      </div>
    );
  const flat = (from: number, to?: number) =>
    windows
      .slice(from, to)
      .filter((item) => !scoped.includes(item))
      .map((item) => <LimitRow key={item.id} window={item} now={now} />);
  return (
    <div className="usage-rows">
      {flat(0, week)}
      <div
        className="usage-week"
        data-testid="pace-week"
        data-state={open ? "open" : "closed"}
      >
        <LimitRow
          window={windows[week]}
          now={now}
          name={
            <button
              type="button"
              className="usage-week-toggle"
              data-testid="pace-week-toggle"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {rowLabel(windows[week])}
              <ChevronDown size={16} aria-hidden />
            </button>
          }
        />
        {open && (
          <div className="usage-week-scoped" data-testid="pace-week-scoped">
            {scoped.map((item) => (
              <LimitRow
                key={item.id}
                window={item}
                now={now}
                name={item.label}
                note={
                  item.resetsAt === null
                    ? t("Starts with your first message")
                    : resetText(item.resetsAt, now)
                }
              />
            ))}
          </div>
        )}
      </div>
      {flat(week + 1)}
    </div>
  );
}

/** Tests only. */
export const LimitRowsForTests = LimitRows;

/**
 * Settings → Usage: the plan's session, weekly, per-model and other windows
 * from the Claudex service, a summary line worked out from them, the balance
 * for plans paid from it, when it was read and the administrator's Learn more
 * page. The original's Resets, Usage credits, Monthly spend limit and
 * usage-by-product blocks have no Claudex service data behind them and are not
 * shown.
 */
export function UsageTab(props: TabProps) {
  const host = useHost();
  const account = useContext(AppContext)?.accountId ?? props.email ?? "local";
  return (
    <>
      <UsageContent key={account} {...props} />
      {host.kind === "desktop" && host.capabilities.localCode && (
        <Suspense fallback={null}>
          <CodeUsageSettings />
        </Suspense>
      )}
    </>
  );
}

function UsageContent(props: TabProps) {
  useT();
  const { onError, email } = props;
  const inTab = useHost().kind === "web";
  const [usage, setUsage] = useState<PlanUsage | null>();
  // Add funds from here too: the same checkout page as Billing, offered while
  // the service takes payments.
  const [checkout, setCheckout] = useState<BillingCheckout | null>(null);
  const [addingFunds, setAddingFunds] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(Date.now());
  // The first read failed: the original's line in place of the limits, with Try
  // again, not a skeleton forever.
  const [loadFailed, setLoadFailed] = useState(false);
  const live = useRef(false);
  const generation = useRef(0);
  const usageNow = useRef(usage);
  const onErrorNow = useRef(onError);
  usageNow.current = usage;
  onErrorNow.current = onError;
  const load = (fresh: boolean) => {
    if (!live.current) return Promise.resolve();
    const request = ++generation.current;
    const current = () => live.current && request === generation.current;
    setLoading(true);
    return Promise.resolve()
      .then(() => window.desktop.planUsage(fresh))
      .then((value) => {
        if (!current()) return;
        usageNow.current = value;
        setUsage(value);
        setLoadFailed(false);
        setNow(Date.now());
      })
      .catch((error) => {
        if (!current()) return;
        // A refresh that fails keeps what was shown and says so.
        if (usageNow.current === undefined) setLoadFailed(true);
        else onErrorNow.current(error);
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  };
  useEffect(() => {
    void window.desktop
      .billingCheckout()
      .then(setCheckout)
      .catch(() => setCheckout(null));
  }, []);
  useEffect(() => {
    live.current = true;
    void load(false);
    // Keeps the reset times and "Last updated" current.
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    // Read again every 5 minutes and on coming back to the window.
    const poll = setInterval(() => void load(true), 5 * 60_000);
    const focus = () => void load(true);
    window.addEventListener("focus", focus);
    return () => {
      live.current = false;
      generation.current++;
      clearInterval(timer);
      clearInterval(poll);
      window.removeEventListener("focus", focus);
    };
  }, []);
  if (usage === undefined && loadFailed)
    return (
      <Section title="Your usage">
        <div className="settings-load-error">
          <p>Unable to load usage limits. Please try again later.</p>
          <Button disabled={loading} onClick={() => void load(true)}>
            Try again
          </Button>
        </div>
      </Section>
    );
  if (usage === undefined) return <UsageSkeleton />;
  if (!usage)
    return (
      <Section
        title="Your usage"
        note="Your account has no plan on this service."
      />
    );
  const summary = pace(usage.windows, now);
  // At "Heads up" and "Limit hit": Upgrade plan where plans are sold (the
  // Billing page's plans) and Buy more usage where funds can be added.
  const actions =
    summary?.state === "heads_up" || summary?.state === "limit_hit"
      ? [
          checkout?.plans.length ? "upgrade" : null,
          checkout?.balance ? "buy" : null,
        ].filter(Boolean)
      : [];
  const expires =
    usage.expiresAt &&
    new Intl.DateTimeFormat(currentLocale(), {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(usage.expiresAt));
  const balance = usage.balanceUsd ?? null;
  return (
    <section className="usage-page">
      <h2 className="usage-heading" data-setting="Your usage">
        Your usage
        {usage.plan && (usage.windows.length > 0 || balance === null) && (
          <span>
            <span data-no-translate>{usage.plan}</span>
            {expires
              ? ` · ${formatText("Expires {date}", { date: expires })}`
              : ""}
          </span>
        )}
      </h2>
      {summary && (
        <div className="usage-headline">
          <p>{summary.text}</p>
          {actions.length > 0 && (
            <div className="usage-headline-actions">
              {actions.includes("upgrade") && (
                <Button
                  size="regular"
                  primary
                  onClick={() => props.goTo("billing")}
                >
                  Upgrade plan
                </Button>
              )}
              {actions.includes("buy") && (
                <Button size="regular" onClick={() => setAddingFunds(true)}>
                  Buy more usage
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {usage.windows.length > 0 && (
        <LimitRows windows={usage.windows} now={now} />
      )}
      {balance !== null && (
        <div className="usage-balance">
          <div>
            <div className="usage-balance-title">Balance</div>
            <p>Requests are paid from your balance.</p>
          </div>
          <div className="usage-balance-side">
            <span>{money(balance)}</span>
            {checkout && (
              <Button size="regular" onClick={() => setAddingFunds(true)}>
                Add funds
              </Button>
            )}
          </div>
        </div>
      )}
      {addingFunds && checkout && (
        <CheckoutDialog
          checkout={checkout}
          purchase={{ funds: true }}
          inTab={inTab}
          email={email}
          onClose={() => setAddingFunds(false)}
          onSettled={() => void load(true)}
        />
      )}
      {!usage.windows.length && balance === null && (
        <p className="usage-empty">There are no usage limits.</p>
      )}
      <div className="usage-updated" data-setting="Last updated">
        <span>{updatedText(usage.updatedAt, now)}</span>
        <button
          type="button"
          className={`usage-refresh ${loading ? "loading" : ""}`}
          aria-label="Refresh"
          disabled={loading}
          onClick={() => void load(true)}
        >
          <RotateCw size={16} strokeWidth={1.75} />
        </button>
      </div>
      {usage.learnMoreUrl && usage.windows.length > 0 && (
        <button
          type="button"
          className="usage-link"
          data-setting="Learn more about usage limits"
          onClick={() =>
            void window.desktop.openExternal(usage.learnMoreUrl!).catch(onError)
          }
        >
          Learn more about usage limits
        </button>
      )}
      {balance !== null && (
        <button
          type="button"
          className="usage-link usage-billing-link"
          data-setting="See transaction history on the Billing page"
          onClick={() => props.goTo("billing")}
        >
          See transaction history on the Billing page
        </button>
      )}
      <Suspense fallback={null}>
        <ProductUsage />
      </Suspense>
      <Suspense fallback={null}>
        <UsageActivity {...props} />
      </Suspense>
    </section>
  );
}
