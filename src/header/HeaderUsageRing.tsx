import { useEffect, useRef, useState } from "react";
import { useApp } from "../app/AppContext";
import { formatText, t, useT } from "../i18n";
import { useDismiss } from "../ui/useDismiss";
import { WithTooltip } from "../ui/Tooltip";
import { PlanRow } from "../composer/ContextPopover";
import {
  ringWindow,
  windowPercent,
  type PlanUsageState,
} from "../composer/usage-meter";
import { UsageRingMotion, UsageRingSvg } from "../composer/UsageRingMotion";
import { openRecharge } from "../settings/billing/recharge";
import "../composer/context-popover.css";
import "./header-usage-ring.css";

const ringSize = 16;
/** Plan usage is read again at most this often while the header shows. */
const refreshMs = 60_000;

/**
 * The chat header's usage ring: a ghost button with a 16px ring in the success
 * colour and "{percent}% used" for the fullest limit; it opens the 360px "Your
 * usage limits · {plan}" panel with each window, and Buy credits, which is
 * Billing's Add funds here. Claudex has no plans to upgrade to, so there is no
 * Upgrade button. Only a Claudex service account with plan limits has it.
 */
export function HeaderUsageRing({ running }: { running: boolean }) {
  useT();
  const app = useApp();
  const remote = Boolean(app.remoteAccount);
  const [plan, setPlan] = useState<PlanUsageState>();
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; right: number }>();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const read = useRef(0);
  useDismiss([button, panel], open, () => setOpen(false));
  // Read on first show, when a reply finishes, and on opening (fresh).
  useEffect(() => {
    if (!remote || running) return;
    if (!open && Date.now() - read.current < refreshMs) return;
    read.current = Date.now();
    let live = true;
    setPlan((value) => value ?? { status: "loading" });
    window.desktop
      .planUsage(open)
      .then((usage) => live && setPlan({ status: "ready", usage }))
      .catch(
        () =>
          live &&
          setPlan((value) =>
            value?.status === "ready" ? value : { status: "error" },
          ),
      );
    return () => {
      live = false;
    };
  }, [remote, running, open]);
  const windows =
    plan?.status === "ready" && plan.usage ? plan.usage.windows : [];
  const fullest = ringWindow(windows);
  if (!remote || !fullest) return null;
  const percent = Math.round(windowPercent(fullest));
  const label = t("View usage limits");
  const used = formatText("{percent}% used", { percent });
  const name = plan?.status === "ready" ? plan.usage?.plan : undefined;
  const toggle = () => {
    const box = button.current?.getBoundingClientRect();
    if (box) setPlace({ top: box.bottom + 4, right: innerWidth - box.right });
    setOpen((value) => !value);
  };
  return (
    <>
      <WithTooltip label={label} disabled={open} placement="below">
        {(tip) => (
          <button
            {...tip}
            ref={button}
            type="button"
            className="header-usage-ring urm-host"
            aria-label={`${label} · ${used}`}
            aria-expanded={open}
            aria-haspopup="dialog"
            data-testid="header-usage-ring"
            onClick={toggle}
          >
            <UsageRingMotion
              size={ringSize}
              percent={percent}
              color="var(--success)"
              ready={plan?.status === "ready"}
              streaming={running}
              windowKey={app.accountId || null}
              resetsAt={fullest.resetsAt}
            >
              <UsageRingSvg
                size={ringSize}
                percent={percent}
                stroke="var(--success)"
                trackStroke="var(--border-strong)"
              />
            </UsageRingMotion>
            <span>{used}</span>
          </button>
        )}
      </WithTooltip>
      {open && place && (
        <div
          ref={panel}
          className="context-popover header-usage-popover"
          role="dialog"
          aria-label={label}
          style={{ top: place.top, right: place.right }}
        >
          <div className="header-usage-body">
            <span className="header-usage-title">
              <span>{t("Your usage limits")}</span>
              {name && (
                <>
                  {" · "}
                  <span data-no-translate>{name}</span>
                </>
              )}
            </span>
            <div className="context-popover-plan">
              {windows.map((window) => (
                <PlanRow key={window.id} window={window} now={Date.now()} />
              ))}
            </div>
            <div className="header-usage-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setOpen(false);
                  openRecharge(() => app.openSettingsTab("billing"));
                }}
              >
                {t("Buy credits")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
