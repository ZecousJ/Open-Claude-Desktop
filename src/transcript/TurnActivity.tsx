import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { turnActivity } from "../../shared/activity";
import type { Turn } from "../../shared/types";
import { SparkMark } from "../ui/SparkMark";
import { ClayMark } from "../ui/ClayMark";
import { CodeEndStar } from "./CodeTurnStatus";
import { formatElapsed } from "../code-tools/code-tool-model";
import { Star } from "../ui/Star";
import { ShimmerText } from "../ui/ShimmerText";
import { t } from "../i18n";

export function ActivityMark({
  phase = "thinking",
}: {
  phase?: "thinking" | "tools";
}) {
  // the status row's three dots, drawn together and apart while the model
  // thinks, turning over while a tool runs.
  return (
    <span className="activity-mark clay" data-phase={phase} aria-hidden="true">
      <ClayMark motion={phase === "tools" ? "tumble" : "breathe"} />
    </span>
  );
}

/** How long a replaced label may take to leave before it is dropped anyway. */
const LABEL_SWAP_MS = 600;

/**
 * Status text that swaps in place. A new label fades in over 250ms while the
 * old one fades out over 150ms in the same spot; the quiet variant (a step's
 * own row) rises 6px into place over 240ms while the old one drops 4px away
 * over 180ms. `afterMark`: the working mark beside the label is leaving, so the
 * new label waits 210ms for it. A running label shimmers (ShimmerText); the
 * first label shows without a swap.
 */
export function ActivityLabel({
  phase,
  children,
  quiet = false,
  afterMark = false,
  className,
  hidden = false,
}: {
  phase?: "thinking" | "tools";
  children: string;
  quiet?: boolean;
  afterMark?: boolean;
  /** Added to the wrapper, which lays the two labels over each other. */
  className?: string;
  /** Shown only: something else says it to a screen reader. */
  hidden?: boolean;
}) {
  const [shown, setShown] = useState({
    text: children,
    phase,
    id: 0,
    swap: undefined as string | undefined,
  });
  const [leaving, setLeaving] = useState<typeof shown>();
  if (shown.text !== children) {
    setLeaving(shown);
    setShown({
      text: children,
      phase,
      id: shown.id + 1,
      swap: quiet ? "enter-quiet" : afterMark ? "enter-after-mark" : "enter",
    });
  } else if (shown.phase !== phase) setShown({ ...shown, phase });
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving(undefined), LABEL_SWAP_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const text = (value: string, shimmer: boolean) =>
    shimmer ? <ShimmerText>{value}</ShimmerText> : value;
  return (
    <span
      className={
        className ? `activity-label-morph ${className}` : "activity-label-morph"
      }
      aria-hidden={hidden || undefined}
    >
      {leaving && (
        <span
          key={`leaving-${leaving.id}`}
          className="activity-label"
          data-swap={quiet ? "leave-quiet" : "leave"}
          data-shimmer={leaving.phase}
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setLeaving(undefined);
          }}
        >
          {text(leaving.text, Boolean(leaving.phase))}
        </span>
      )}
      <span
        key={shown.id}
        className="activity-label"
        data-swap={shown.swap}
        data-shimmer={phase}
      >
        {text(children, Boolean(phase))}
      </span>
    </span>
  );
}

export function ActivityElapsed({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  // Over a minute the reference reads "3m 40s", like Code's status line.
  return seconds >= 5 ? (
    <span className="activity-elapsed" aria-hidden="true">
      {formatElapsed(seconds)}
    </span>
  ) : null;
}

/*
 * Chat and Cowork's thinking verb: one of 16 words, drawn at random, and
 * swapped for a different random one every 8 s while any turn is working. The
 * word is shared by every status row on the page, and resets when the last one
 * stops.
 */
export const THINKING_VERBS = [
  "Thinking",
  "Sifting",
  "Fathoming",
  "Honing",
  "Weighing",
  "Pondering",
  "Contemplating",
  "Cogitating",
  "Picturing",
  "Figuring",
  "Reckoning",
  "Mulling",
  "Triangulating",
  "Crystallizing",
  "Sleuthing",
  "Untangling",
] as const;

/*
 * The words beside the clay mark: the chat word's place in its list, modulo 15,
 * picks one.
 */
export const CLAY_VERBS = [
  "Thinking",
  "Kneading",
  "Shaping",
  "Folding",
  "Rolling",
  "Smoothing",
  "Forming",
  "Molding",
  "Gathering",
  "Turning over",
  "Taking shape",
  "Settling",
  "Pressing",
  "Rounding",
  "Mulling",
] as const;

/** The clay mark's word for the chat word now showing (shared-13 UM "clay"). */
export function clayVerb(verb: string) {
  const index = THINKING_VERBS.indexOf(verb as ThinkingVerb);
  return CLAY_VERBS[Math.max(0, index) % CLAY_VERBS.length];
}

/** How often the verb changes (live: ey = 8000). */
export const THINKING_VERB_MS = 8000;

type ThinkingVerb = (typeof THINKING_VERBS)[number];

function pickVerb(except?: string): ThinkingVerb {
  const pool = except
    ? THINKING_VERBS.filter((verb) => verb !== except)
    : THINKING_VERBS;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * What the 8 s timer does: a different word, unless something holds the
 * verb (shared-13 ny: `holdCount > 0 || ...`).
 */
export function verbAfterTick(
  current: string,
  holds: number,
  pick: (except?: string) => string = pickVerb,
) {
  return holds > 0 ? current : pick(current);
}

let currentVerb = pickVerb();
let verbUsers = 0;
let verbHolds = 0;
let verbTimer: number | undefined;
const verbListeners = new Set<() => void>();

function setVerb(value: ThinkingVerb) {
  currentVerb = value;
  for (const listener of verbListeners) listener();
}

function subscribeVerb(listener: () => void) {
  verbListeners.add(listener);
  return () => void verbListeners.delete(listener);
}

/**
 * Subscribes a status row to the shared verb while `active`; it re-renders
 * whenever the verb changes.
 */
export function useThinkingVerb(active = true): ThinkingVerb {
  const verb = useSyncExternalStore(
    subscribeVerb,
    () => currentVerb,
    () => currentVerb,
  );
  useEffect(() => {
    if (!active) return;
    verbUsers += 1;
    if (verbTimer === undefined)
      verbTimer = window.setInterval(() => {
        const next = verbAfterTick(currentVerb, verbHolds);
        if (next !== currentVerb) setVerb(next as ThinkingVerb);
      }, THINKING_VERB_MS);
    return () => {
      verbUsers = Math.max(0, verbUsers - 1);
      if (verbUsers === 0 && verbTimer !== undefined) {
        window.clearInterval(verbTimer);
        verbTimer = undefined;
        currentVerb = pickVerb();
      }
    };
  }, [active]);
  return verb;
}

/**
 * Keeps the verb from changing while `active` (shared-13 sy: holdAcquire on
 * mount, holdRelease on cleanup). The original holds it while an artifact
 * action's approval card (publish, comment, share) is on screen, so the
 * word beside the card does not change under the reader's eyes.
 */
export function useVerbHold(active: boolean) {
  useEffect(() => {
    if (!active) return;
    verbHolds += 1;
    return () => {
      verbHolds = Math.max(0, verbHolds - 1);
    };
  }, [active]);
}

/** The verb as it stands now; rows call useThinkingVerb to follow its changes. */
export function turnVerb(_turn?: Pick<Turn, "id">): ThinkingVerb {
  return currentVerb;
}

/** Keeps `value` true for `ms` after it turns false (a marker fading out late). */
export function useLinger(value: boolean, ms: number) {
  const [lingering, setLingering] = useState(value);
  useEffect(() => {
    if (value) {
      setLingering(true);
      return;
    }
    const timer = window.setTimeout(() => setLingering(false), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return value || lingering;
}

export function TurnActivity({
  turn,
  awaitingApproval,
  startingUp = false,
}: {
  turn: Turn;
  awaitingApproval: boolean;
  /**
   * A Cowork task says "Waiting for Claudex…" until its first item arrives,
   * with no timer.
   */
  startingUp?: boolean;
}) {
  const phase = turnActivity(turn, awaitingApproval);
  useThinkingVerb(
    phase !== "idle" &&
      phase !== "streaming" &&
      phase !== "tools" &&
      phase !== "approval",
  );
  // Command rows already expose the running operation and its disclosure
  // control; streaming text carries its own trailing mark.
  if (phase === "idle" || phase === "streaming" || phase === "tools")
    return null;
  const starting = startingUp && phase !== "approval" && !turn.items.length;
  const label =
    phase === "approval"
      ? "Needs your input"
      : starting
        ? "Waiting for Claudex…"
        : clayVerb(turnVerb(turn));
  return (
    <>
      <PreToolActivity
        label={label}
        startedAt={starting ? undefined : turn.createdAt}
        shimmer={phase !== "approval"}
        announcement={
          phase !== "approval" && !starting
            ? t("Claudex is thinking")
            : undefined
        }
      />
    </>
  );
}

/** Before any tool output, Chat shows the working dots beside the verb. */
export function PreToolActivity({
  label,
  startedAt,
  shimmer = true,
  announcement,
}: {
  label: string;
  /** Without it no elapsed time shows. */
  startedAt?: number;
  shimmer?: boolean;
  /** What a screen reader hears in place of the changing word. */
  announcement?: string;
}) {
  return (
    <div className="turn-activity pre-tool-activity" role="status">
      <ClayMark />
      {announcement && <span className="sr-only">{announcement}</span>}
      <ActivityLabel
        phase={shimmer ? "thinking" : undefined}
        hidden={!!announcement}
      >
        {label}
      </ActivityLabel>
      {startedAt !== undefined && <ActivityElapsed startedAt={startedAt} />}
    </div>
  );
}

/*
 * Chat's mark under a reply (reply-retry-001, 1.0 px/CSS): while text streams
 * a moving star (26–30px, ~36px under the last line) follows the content;
 * when the reply ends it shrinks for ~100ms and the still end star takes its
 * place. Only the newest reply keeps a mark.
 */
export function ReplyMark({
  streaming,
  done,
}: {
  streaming: boolean;
  done: boolean;
}) {
  const was = useRef(streaming);
  const [ending, setEnding] = useState(false);
  useEffect(() => {
    if (was.current && !streaming && done) {
      setEnding(true);
      const timer = window.setTimeout(() => setEnding(false), 100);
      was.current = streaming;
      return () => window.clearTimeout(timer);
    }
    was.current = streaming;
  }, [streaming, done]);
  if (streaming || ending)
    return (
      <div
        className="response-stream-mark"
        data-ending={ending || undefined}
        aria-hidden="true"
      >
        {ending ? <CodeEndStar /> : <SparkMark />}
      </div>
    );
  return done ? (
    <div className="response-end-mark" aria-hidden="true">
      <Star size={32} />
    </div>
  ) : null;
}
