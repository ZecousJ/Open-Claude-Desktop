import {
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useTooltip } from "../ui/Tooltip";
import { useEscapeLayer } from "../ui/useDismiss";
import { AppContext } from "../app/AppContext";
import { contextUsageLabel, type ContextUsage } from "./context-usage";
import { postUsageReport } from "../usage-report/usage-report-store";
import {
  planRingLabel,
  planRingName,
  resetIn,
  ringWindow,
  usageSeverity,
  windowPercent,
  type PlanUsageState,
} from "./usage-meter";
import type { SpendState } from "./ContextPopover";
import { lazyPiece } from "../ui/lazy-piece";
import { useHost } from "../host/HostContext";
import { t } from "../i18n";

const ContextPopover = lazyPiece(
  () => import("./ContextPopover"),
  "ContextPopover",
);

/**
 * The Code footer's context ring. Without a known window it shows the track
 * only, and the tooltip gives the token count. Pressing it opens the usage
 * popover (ContextPopover): the context window and Compact session in a
 * session, and for an account on the Claudex service the balance, the spend of
 * today and the last 7 days and the group's limits, read when it opens. Before
 * there is a session the ring follows the group's fullest limit (amber from
 * 75%, red from 90%), as the live ring with no session follows the plan;
 * without limits it stays the empty ring. With a session, the popover's "See
 * detailed breakdown" closes it and posts the usage report in the transcript,
 * as the live one does.
 */
export function ContextRing({
  usage,
  onCompact,
  compactReason,
}: {
  usage: ContextUsage;
  /** Compacts the open session; left out when there is none. */
  onCompact?: () => void;
  /** Why compacting is not available now. */
  compactReason?: string;
}) {
  const app = useContext(AppContext);
  // Current web new-session ring: 24px hit target around a 14px/2px SVG.
  // Native and opened-session rings retain their captured 12px geometry.
  const diameter = useHost().kind === "web" && usage.draft ? 14 : 12;
  const center = diameter / 2;
  const radius = center - 1;
  const circumference = 2 * Math.PI * radius;
  const remote = Boolean(app?.remoteAccount);
  // The session the report is posted in: the open Code conversation.
  const session =
    !usage.draft && app?.active?.mode === "code" ? app.active : undefined;
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<PlanUsageState>();
  // Read each time the popover opens, and once at first for a composer with
  // no session, whose ring shows it. A failed read keeps what an earlier one
  // returned.
  const draft = Boolean(usage.draft);
  const read = useRef(false);
  useEffect(() => {
    if (!remote || (!open && (!draft || read.current))) return;
    read.current = true;
    let live = true;
    setPlan((value) => value ?? { status: "loading" });
    window.desktop
      .planUsage(false)
      .then((value) => {
        if (live) setPlan({ status: "ready", usage: value });
      })
      .catch(() => {
        if (live)
          setPlan((value) =>
            value?.status === "ready" ? value : { status: "error" },
          );
      });
    return () => {
      live = false;
    };
  }, [remote, open, draft]);
  // What was spent today and over the last 7 days, read each time the
  // popover opens (the service's billed cost by product, summed).
  const [spend, setSpend] = useState<SpendState>();
  useEffect(() => {
    if (!remote || !open) return;
    let live = true;
    window.desktop
      .usageProducts("7")
      .then((value) => {
        if (!live) return;
        if (!value) return setSpend({ status: "error" });
        const sum = (costs: Partial<Record<string, number>>) =>
          Object.values(costs).reduce<number>((a, b) => a + (b ?? 0), 0);
        const today = new Date().toISOString().slice(0, 10);
        const day = value.days.find((entry) => entry.day === today);
        setSpend({
          status: "ready",
          todayUsd: day ? sum(day.costUsd) : 0,
          weekUsd: sum(value.totals),
        });
      })
      .catch(() => {
        if (live)
          setSpend((current) =>
            current?.status === "ready" ? current : { status: "error" },
          );
      });
    return () => {
      live = false;
    };
  }, [remote, open]);
  const planWindow =
    usage.draft && plan?.status === "ready" && plan.usage
      ? ringWindow(plan.usage.windows)
      : undefined;
  const planPercent = planWindow ? windowPercent(planWindow) : 0;
  const planLabel = planWindow ? planRingLabel(planWindow) : undefined;
  const planReset = planWindow
    ? resetIn(planWindow.resetsAt, Date.now())
    : null;
  // Before a session there is no context to name: the plan's label, else "Usage
  // limits" / "Usage".
  const label =
    planLabel ??
    (usage.draft
      ? t(remote ? "Usage limits" : "Usage")
      : contextUsageLabel(usage));
  // A draft without a Claudex account has nothing for the popover to hold.
  const hasPanel = !usage.draft || remote;
  const { props, tooltip } = useTooltip(label, {
    placement: "above",
    disabled: open,
    detail: planReset ?? undefined,
  });
  const anchor = useRef<HTMLSpanElement>(null);
  // /autocompact opens the popover (the original's context-popover action).
  useEffect(() => {
    const show = () => {
      if (hasPanel) setOpen(true);
    };
    window.addEventListener("claudex:context-popover", show);
    return () => window.removeEventListener("claudex:context-popover", show);
  }, [hasPanel]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // Escape closes the popover alone: voice mode and a dialog under it stay.
  useEscapeLayer(open, () => setOpen(false));
  const fraction = planWindow ? planPercent / 100 : usage.fraction;
  const arc = fraction ? fraction * circumference : 0;
  const keyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (hasPanel) setOpen((value) => !value);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <span className="popover-anchor context-ring-anchor" ref={anchor}>
      <span
        className="context-ring"
        role="button"
        aria-label={planLabel ? planRingName(planLabel, planReset) : label}
        aria-haspopup={hasPanel ? "dialog" : undefined}
        aria-expanded={hasPanel ? open : undefined}
        tabIndex={0}
        {...props}
        onClick={() => {
          if (hasPanel) setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          props.onKeyDown(event);
          keyDown(event);
        }}
      >
        <svg
          width={diameter}
          height={diameter}
          viewBox={`0 0 ${diameter} ${diameter}`}
          aria-hidden="true"
        >
          <circle
            className="context-ring-track"
            cx={center}
            cy={center}
            r={radius}
            strokeWidth={2}
          />
          {arc > 0 && (
            <circle
              className={
                planWindow
                  ? `context-ring-arc ${usageSeverity(planPercent)}`
                  : "context-ring-arc"
              }
              cx={center}
              cy={center}
              r={radius}
              strokeWidth={2}
              strokeDasharray={`${arc} ${circumference}`}
              transform={`rotate(-90 ${center} ${center})`}
            />
          )}
        </svg>
      </span>
      {tooltip}
      {open && hasPanel && (
        <Suspense fallback={null}>
          <ContextPopover
            usage={usage}
            onCompact={
              onCompact
                ? () => {
                    setOpen(false);
                    onCompact();
                  }
                : undefined
            }
            compactReason={compactReason}
            plan={remote ? (plan ?? { status: "loading" }) : undefined}
            onUsageSettings={
              remote && app
                ? () => {
                    setOpen(false);
                    app.openSettingsTab("usage");
                  }
                : undefined
            }
            onShowUsageReport={
              session
                ? () => {
                    setOpen(false);
                    postUsageReport(session);
                  }
                : undefined
            }
            spend={remote ? (spend ?? { status: "loading" }) : undefined}
          />
        </Suspense>
      )}
    </span>
  );
}
