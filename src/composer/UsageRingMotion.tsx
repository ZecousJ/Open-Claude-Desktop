import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { prefersReducedMotion } from "../ui/usePresence";
import "./usage-ring-motion.css";

/**
 * The usage ring's motion, as the original's. Once per reset window the arc
 * draws itself in (later it fades in quietly); crossing into warning (75%),
 * critical (90%) or the limit beats once per window, remembered in
 * localStorage; a reply that starts streaming at 15% or more sends a shimmer
 * round the ring. Nothing moves with reduced motion.
 */
export type RingBand = 0 | 1 | 2 | 3;

export function ringBand(percent: number): RingBand {
  return percent >= 100 ? 3 : percent >= 90 ? 2 : percent >= 75 ? 1 : 0;
}

/** Each beat's length (ms): its last pulse's end, in 50 ms steps. */
export const beatMs: Record<Exclude<RingBand, 0>, number> = {
  1: 2300,
  2: 1450,
  3: 2450,
};
const drawMs = 1200;
const quietMs = 200;
const shimmerMs = 2000;
const cometShare = 0.1;
const storagePrefix = "claudex.usageRingMotion.";

export interface RingLedger {
  resetsAt: number;
  drawn: boolean;
  beats: RingBand[];
}

/** The window's ledger, or a fresh one when the window has reset. */
export function readLedger(
  storage: Pick<Storage, "getItem"> | undefined,
  key: string,
  resetsAt: number,
): RingLedger {
  const fresh = { resetsAt, drawn: false, beats: [] };
  try {
    const value = JSON.parse(storage?.getItem(storagePrefix + key) ?? "null");
    if (!value || typeof value !== "object" || value.resetsAt !== resetsAt)
      return fresh;
    return {
      resetsAt,
      drawn: value.drawn === true,
      beats: Array.isArray(value.beats)
        ? value.beats.filter(
            (band: unknown) => band === 1 || band === 2 || band === 3,
          )
        : [],
    };
  } catch {
    return fresh;
  }
}

function writeLedger(key: string, ledger: RingLedger) {
  try {
    localStorage.setItem(storagePrefix + key, JSON.stringify(ledger));
  } catch {
    // Private windows: the motion just repeats next time.
  }
}

/** Every band up to `band` counts as beaten, as the original keeps them. */
function beaten(ledger: RingLedger, band: RingBand): RingLedger {
  return {
    ...ledger,
    beats: ([1, 2, 3] as const).filter(
      (value) => ledger.beats.includes(value) || value <= band,
    ),
  };
}

const storage = () => {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
};

interface Motion {
  entrance: "draw" | "quiet" | null;
  beat: RingBand | null;
  queued: RingBand | null;
  shimmer: number | null;
}

export function UsageRingMotion({
  children,
  size,
  percent,
  color,
  ready,
  streaming,
  windowKey,
  resetsAt,
}: {
  children?: ReactNode;
  size: number;
  percent: number;
  color: string;
  /** The usage has been read (a guess never draws or beats). */
  ready: boolean;
  streaming: boolean;
  /** The account the window belongs to. */
  windowKey: string | null;
  resetsAt: number | null;
}) {
  const band = ringBand(percent);
  const key = windowKey === null ? null : `${windowKey}:${resetsAt}`;
  const [seen, setSeen] = useState<{
    key: string | null;
    band: RingBand | null;
  }>({ key, band: null });
  const [motion, setMotion] = useState<Motion>({
    entrance: null,
    beat: null,
    queued: null,
    shimmer: null,
  });
  const [wasStreaming, setWasStreaming] = useState(streaming);
  const still = prefersReducedMotion();

  const known = seen.key === key ? seen.band : null;
  const current = ready ? band : known;
  if (known !== current || seen.key !== key) {
    setSeen({ key, band: current });
    if (
      !still &&
      ready &&
      current !== null &&
      windowKey !== null &&
      resetsAt !== null
    ) {
      const ledger = readLedger(storage(), windowKey, resetsAt);
      if (known === null) {
        const queued =
          current !== 0 && !ledger.beats.includes(current) ? current : null;
        setMotion((value) => ({
          ...value,
          entrance: ledger.drawn ? "quiet" : "draw",
          beat: null,
          queued,
        }));
        writeLedger(
          windowKey,
          queued === null
            ? { ...ledger, drawn: true }
            : beaten({ ...ledger, drawn: true }, queued),
        );
      } else if (
        current !== 0 &&
        current > known &&
        !ledger.beats.includes(current)
      ) {
        setMotion((value) =>
          value.entrance === null
            ? { ...value, beat: current, queued: null }
            : {
                ...value,
                queued: Math.max(value.queued ?? 0, current) as RingBand,
              },
        );
        writeLedger(windowKey, beaten(ledger, current));
      }
    }
  }
  if (streaming !== wasStreaming) {
    setWasStreaming(streaming);
    if (streaming && !still && ready && percent >= 15)
      setMotion((value) => ({ ...value, shimmer: (value.shimmer ?? 0) + 1 }));
  }

  useEffect(() => {
    if (motion.entrance === null) return;
    const timer = setTimeout(
      () =>
        setMotion((value) => ({
          ...value,
          entrance: null,
          beat: value.queued ?? value.beat,
          queued: null,
        })),
      motion.entrance === "draw" ? drawMs : quietMs,
    );
    return () => clearTimeout(timer);
  }, [motion.entrance]);
  useEffect(() => {
    if (motion.beat === null || motion.beat === 0) return;
    const timer = setTimeout(
      () => setMotion((value) => ({ ...value, beat: null })),
      beatMs[motion.beat],
    );
    return () => clearTimeout(timer);
  }, [motion.beat]);
  useEffect(() => {
    if (motion.shimmer === null) return;
    const timer = setTimeout(
      () => setMotion((value) => ({ ...value, shimmer: null })),
      shimmerMs,
    );
    return () => clearTimeout(timer);
  }, [motion.shimmer]);

  const radius = (size - 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, percent));
  const comet = circumference * cometShare;
  const travel = Math.max(0, clamped * 3.6 - cometShare * 360);
  const active = still ? { entrance: null, beat: null, shimmer: null } : motion;
  return (
    <span
      className="urm"
      style={
        {
          "--urm-size": `${size}px`,
          "--urm-color": color,
          "--urm-travel": `${travel}deg`,
          "--ring-c": circumference,
        } as CSSProperties
      }
      data-entrance={active.entrance ?? undefined}
      data-beat={active.beat || undefined}
      data-shimmer={active.shimmer === null ? undefined : ""}
      aria-hidden="true"
    >
      <span className="urm__hover">
        <span className="urm__beat">
          <span className="urm__glow" />
          <span className="urm__beat-glow" />
          <span className="urm__hover-glow" />
          <span className="urm__breath">
            {children}
            {active.shimmer !== null && clamped >= 15 && (
              <svg
                className="urm__comet"
                width={size}
                height={size}
                viewBox={`0 0 ${size} ${size}`}
                key={active.shimmer}
              >
                <circle
                  cx={size / 2}
                  cy={size / 2}
                  r={radius}
                  fill="none"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeDasharray={`${comet} ${circumference}`}
                />
              </svg>
            )}
          </span>
        </span>
      </span>
    </span>
  );
}

/** The ring itself (shared-8: the track, then a round-capped arc from twelve o'clock). */
export function UsageRingSvg({
  size,
  percent,
  stroke,
  trackStroke,
}: {
  size: number;
  percent: number;
  stroke: string;
  trackStroke: string;
}) {
  const radius = (size - 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset =
    circumference * (1 - Math.max(0, Math.min(100, percent)) / 100);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="usage-ring-svg"
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={2}
        stroke={trackStroke}
        data-ring-track=""
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={2}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        stroke={stroke}
        data-ring-arc=""
      />
    </svg>
  );
}
