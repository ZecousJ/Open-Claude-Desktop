import { useId } from "react";
import { ShieldQuestion } from "lucide-react";
import {
  Binoculars,
  CalendarDays,
  FlaskConical,
  GitCommitVertical,
  GitPullRequest,
  Lightbulb,
  ListChecks,
  Mailbox,
  ShieldCheck,
  SquareActivity,
  Sunrise,
  Timer,
} from "../../ui/glyphs";
import type { TemplateIcon } from "./routine-templates";
import "./scheduled.css";

/**
 * The empty Yours tab's stopwatch: a 72px grey dial with a white hand-drawn
 * outline, a crown on top and hands at twelve and two.
 */
export function StopwatchArt() {
  return (
    <svg
      className="routines-stopwatch"
      width="74"
      height="84"
      viewBox="0 0 74 84"
      aria-hidden="true"
    >
      <path
        className="routines-stopwatch-crown"
        d="M28.5 2.2h17.2v7.4h-6.2v5.2h-4.8V9.6h-6.3z"
      />
      <path
        className="routines-stopwatch-dial"
        d="M37.2 13.6c19.3-.4 34.2 14.4 34.5 33.5.3 19.2-15 34.8-34.3 34.9C18 82.1 2.6 66.9 2.3 47.8 2 28.3 17.6 14 37.2 13.6z"
      />
      <path
        className="routines-stopwatch-hand"
        d="M37 47.9V23.4M37.4 48.2 55 38.4"
      />
    </svg>
  );
}

/** The wavy rule between the empty state and the templates below it. */
export function WaveRule() {
  const id = useId();
  return (
    <svg className="routines-wave" height="6" aria-hidden="true">
      <defs>
        <pattern id={id} width="13.5" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 3.2c3.4-2.6 3.4-2.6 6.75 0s3.4 2.6 6.75 0" />
        </pattern>
      </defs>
      <rect width="100%" height="6" fill={`url(#${id})`} />
    </svg>
  );
}

const templateIcons = {
  commit: GitCommitVertical,
  health: SquareActivity,
  issues: ListChecks,
  "pull-request": GitPullRequest,
  dependencies: ShieldQuestion,
  flaky: FlaskConical,
  briefing: Sunrise,
  inbox: Mailbox,
  calendar: CalendarDays,
  review: ListChecks,
  ideas: Lightbulb,
  monitor: Binoculars,
  security: ShieldCheck,
};

/** The 36px tile in front of a routine or template card. */
export function RoutineTile({ icon }: { icon?: TemplateIcon }) {
  const Icon = icon ? templateIcons[icon] : Timer;
  return (
    <span className="routine-tile" aria-hidden="true">
      <Icon size={16} strokeWidth={1.5} />
    </span>
  );
}
