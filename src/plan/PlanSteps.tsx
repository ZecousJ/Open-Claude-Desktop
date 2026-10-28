import { useEffect, useRef, useState } from "react";
import { ChevronUp } from "../ui/glyphs";
import { Collapsible } from "../ui/Collapsible";
import { PlanStatusIcon, type PlanStep } from "./PlanPanel";
import { onPlanReveal, takePlanReveal } from "./plan-reveal";
import { formatText, t } from "../i18n";

/** Done steps at the top that stay in view when the earlier ones fold. */
export const KEPT_DONE_STEPS = 2;

/**
 * How many steps fold under "N earlier steps": the run of finished steps at the
 * top of the list, less the last two of them.
 */
export function foldedStepCount(plan: PlanStep[]) {
  let done = 0;
  while (done < plan.length && plan[done].status === "completed") done += 1;
  return Math.max(0, done - KEPT_DONE_STEPS);
}

/** The step the list points at: the running one, else the first open one, else the last. */
export function currentStepIndex(plan: PlanStep[]) {
  const running = plan.findIndex((step) => step.status === "inProgress");
  if (running >= 0) return running;
  const open = plan.findIndex((step) => step.status !== "completed");
  return open >= 0 ? open : plan.length - 1;
}

/**
 * The task list as a progress rail: a 2px rail joins each step's glyph to the
 * next, brighter along the part already walked. A step that arrives rises in
 * (220ms) while the rail grows down to it (220ms); a step that starts running
 * pops its glyph in from 40% (180ms). While a running task's list has no step
 * started yet a light runs down the rail. Finished steps at the top fold away
 * under "N earlier steps", keeping the last two in view.
 */
export function PlanSteps({
  conversationId,
  plan,
  live,
}: {
  conversationId: string;
  plan: PlanStep[];
  /** The conversation's task is still running. */
  live: boolean;
}) {
  // The list as last drawn: what is new since then enters.
  const seen = useRef<PlanStep[] | null>(null);
  const before = seen.current;
  useEffect(() => {
    seen.current = plan;
  });
  const folded = foldedStepCount(plan);
  const [showEarlier, setShowEarlier] = useState(false);
  if (!folded && showEarlier) setShowEarlier(false);
  // "Updated tasks ›" points at the current step (plan-reveal.ts).
  const [reveal, setReveal] = useState(() =>
    takePlanReveal(conversationId) ? 1 : 0,
  );
  useEffect(
    () => onPlanReveal(conversationId, () => setReveal((value) => value + 1)),
    [conversationId],
  );
  const current = currentStepIndex(plan);
  const allDone = plan.every((step) => step.status === "completed");
  const walkedTo = allDone
    ? plan.length - 1
    : plan.reduce(
        (last, step, index) => (step.status !== "pending" ? index : last),
        -1,
      );
  const building = live && plan.every((step) => step.status === "pending");
  const row = (step: PlanStep, index: number) => (
    <PlanStepRow
      key={`${index}:${step.step}`}
      step={step}
      last={index === plan.length - 1}
      walked={index < walkedTo}
      drawn={before !== null}
      enter={before !== null && index >= before.length}
      knobEnter={
        before !== null &&
        step.status === "inProgress" &&
        before[index]?.status !== "inProgress"
      }
      reveal={index === current ? reveal : 0}
    />
  );
  return (
    <div className="plan-progress" data-building={building || undefined}>
      {folded > 0 && (
        <>
          <button
            type="button"
            className="plan-fold"
            aria-expanded={showEarlier}
            aria-controls={`plan-earlier-${conversationId}`}
            onClick={() => setShowEarlier((value) => !value)}
          >
            <span className="plan-fold-rail" aria-hidden="true">
              {Array.from({ length: Math.min(folded, 3) }, (_, index) => (
                <i key={index} />
              ))}
            </span>
            <span className="plan-fold-label">
              {showEarlier
                ? t("Hide earlier steps")
                : formatText(
                    folded === 1
                      ? "{count} earlier step"
                      : "{count} earlier steps",
                    { count: folded },
                  )}
              <ChevronUp size={12} strokeWidth={2} aria-hidden="true" />
            </span>
          </button>
          <Collapsible
            open={showEarlier}
            className="plan-earlier"
            id={`plan-earlier-${conversationId}`}
          >
            <ol className="plan-steps">
              {plan.slice(0, folded).map((step, index) => row(step, index))}
            </ol>
          </Collapsible>
        </>
      )}
      <ol className="plan-steps" start={folded + 1}>
        {plan.slice(folded).map((step, index) => row(step, folded + index))}
      </ol>
    </div>
  );
}

function PlanStepRow({
  step,
  last,
  walked,
  drawn,
  enter,
  knobEnter,
  reveal,
}: {
  step: PlanStep;
  last: boolean;
  walked: boolean;
  /** The list was on screen before this render. */
  drawn: boolean;
  enter: boolean;
  knobEnter: boolean;
  /** Bumped to light the row up and scroll it into view; 0 for none. */
  reveal: number;
}) {
  // Only the render that brought the step in animates it.
  const [entered] = useState(enter);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (reveal) ref.current?.scrollIntoView({ block: "nearest" });
  }, [reveal]);
  return (
    <li ref={ref} data-status={step.status} data-enter={entered || undefined}>
      {reveal > 0 && (
        <span key={reveal} className="plan-step-reveal" aria-hidden="true" />
      )}
      <PlanKnob key={step.status} status={step.status} enter={knobEnter} />
      <span className="plan-step-text">{step.step}</span>
      {!last && <PlanRail walked={walked} grow={drawn} />}
    </li>
  );
}

/** The step's glyph; keyed by status, so a step that starts running pops in. */
function PlanKnob({ status, enter }: { status: string; enter: boolean }) {
  const [entered] = useState(enter);
  return (
    <span className="plan-knob" data-enter={entered || undefined}>
      <PlanStatusIcon status={status} />
    </span>
  );
}

/** The rail down to the next step; it grows when it arrives after the list did. */
function PlanRail({ walked, grow }: { walked: boolean; grow: boolean }) {
  const [grows] = useState(grow);
  return (
    <span
      className="plan-rail"
      data-walked={walked || undefined}
      data-grow={grows || undefined}
      aria-hidden="true"
    />
  );
}
