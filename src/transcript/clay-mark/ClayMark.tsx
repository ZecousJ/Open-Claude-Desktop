import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../ui/usePresence";
import type { MarkBody } from "./activity";
import "./clay-mark.css";

type Sheets = typeof import("./sheets");

let loaded: Sheets | undefined;
let loading: Promise<Sheets | undefined> | undefined;
const decoded = new Set<string>();

function decode(url: string) {
  if (typeof Image === "undefined") return Promise.resolve();
  const image = new Image();
  image.src = url;
  return image.decode().catch(() => {});
}

/**
 * The sheets, with "grow" and every body's in, loop and out decoded before
 * the first frame is drawn (the original waits for its sheets the same way,
 * then shows the plain dot until they are in).
 */
function loadSheets() {
  loading ??= import("./sheets")
    .then(async (module) => {
      await Promise.all(
        Object.entries(module.sheetUrls).map(([key, url]) =>
          decode(url).then(() => decoded.add(key)),
        ),
      );
      loaded = module;
      return module;
    })
    .catch(() => {
      loading = undefined;
      return undefined;
    });
  return loading;
}

type Stage =
  | { kind: "grow" }
  | { kind: "in" | "loop" | "out"; body: MarkBody }
  /** The loop's last frames, played to leave it early. */
  | { kind: "tail"; body: MarkBody };

const sheetOf = (stage: Stage) =>
  stage.kind === "grow"
    ? "grow"
    : `${stage.body}.${stage.kind === "tail" ? "loop" : stage.kind}`;

/** What follows a stage that has played out, toward `wanted`. */
function nextStage(stage: Stage, wanted: MarkBody): Stage {
  switch (stage.kind) {
    case "grow":
      return { kind: "in", body: wanted };
    case "in":
      return { kind: "loop", body: stage.body };
    case "loop":
      return stage.body === wanted ? stage : { kind: "out", body: stage.body };
    case "tail":
      return { kind: "out", body: stage.body };
    case "out":
      return { kind: "in", body: wanted };
  }
}

/** A loop leaves early only after it has shown this long. */
const minimumLoopMs = 2000;
/** A loop with more than this left leaves by its tail instead of finishing. */
const longRemainderMs = 1500;
const tailFrames = 20;

/**
 * The working mark (live desktop 2.42304.2, the clay "working mark" of the
 * Code status line): small clay dots that grow from one dot and move by what
 * Claude is doing (thinking, reading, searching, running code, writing,
 * composing a document, waiting on the person). Each body comes in, loops,
 * and when the activity changes goes out at its next seam, by its tail, or
 * at the end of the loop, and the next comes in. Under reduced motion the
 * loop's rest frame stands still.
 */
export function ClayMark({
  body,
  size = 20,
  className,
}: {
  body: MarkBody;
  size?: number;
  className?: string;
}) {
  const [sheets, setSheets] = useState(loaded);
  const [stage, setStage] = useState<Stage>({ kind: "grow" });
  // Bumped to replay a loop that keeps its body.
  const [round, setRound] = useState(0);
  const strip = useRef<HTMLImageElement>(null);
  const animation = useRef<Animation | undefined>(undefined);
  const loopStarted = useRef(0);
  const wanted = useRef(body);
  wanted.current = body;
  const still = prefersReducedMotion();

  useEffect(() => {
    if (sheets) return;
    let alive = true;
    void loadSheets().then((module) => alive && module && setSheets(module));
    return () => {
      alive = false;
    };
  }, [sheets]);

  const key = sheetOf(still ? { kind: "loop", body } : stage);
  const info = sheets?.sheets[key];
  const tail =
    stage.kind === "tail" && info
      ? [Math.max(0, info.frames - tailFrames), info.frames]
      : undefined;

  // Play the stage's frames; when they end, take the next stage.
  useLayoutEffect(() => {
    const element = strip.current;
    if (!sheets || !info || !element || still) return;
    if (typeof element.animate !== "function") return;
    const [from, to] = tail ?? [0, info.frames];
    const count = to - from;
    const frames = Array.from({ length: count }, (_, index) => ({
      transform: `translateY(${-(from + index) * size}px)`,
    }));
    let playing: Animation;
    try {
      playing = element.animate(frames, {
        duration: sheets.frameMs * count,
        easing: count > 1 ? `steps(${count}, jump-none)` : "linear",
        fill: "forwards",
      });
    } catch {
      return;
    }
    animation.current = playing;
    if (stage.kind === "loop") loopStarted.current = performance.now();
    let alive = true;
    playing.finished
      .then(() => {
        if (!alive) return;
        const next = nextStage(stage, wanted.current);
        if (next === stage) setRound((value) => value + 1);
        else setStage(next);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (animation.current === playing) animation.current = undefined;
      playing.cancel();
    };
  }, [sheets, key, stage.kind, round, still, size]);

  // A new activity while a loop plays: leave at the next seam, or by the
  // tail once the loop has shown a while and much of it is left.
  useEffect(() => {
    if (!sheets || !info || still || stage.kind !== "loop") return;
    if (stage.body === body) return;
    const playing = animation.current;
    const at = Number(playing?.currentTime ?? 0);
    const seam = info.seams
      ?.map((frame) => frame * sheets.frameMs)
      .find((time) => time > at + 50);
    if (seam !== undefined) {
      const timer = window.setTimeout(
        () => setStage({ kind: "out", body: stage.body }),
        seam - at,
      );
      return () => window.clearTimeout(timer);
    }
    const shown = performance.now() - loopStarted.current;
    const remaining = info.frames * sheets.frameMs - at;
    if (remaining <= longRemainderMs) return;
    const timer = window.setTimeout(
      () => setStage({ kind: "tail", body: stage.body }),
      Math.max(0, minimumLoopMs - shown),
    );
    return () => window.clearTimeout(timer);
  }, [sheets, stage, body, still]);

  const ready = sheets && info && decoded.has(key);
  const rest = still ? (info?.rest ?? Math.floor((info?.frames ?? 0) / 3)) : 0;
  const start = tail ? tail[0] : rest;
  return (
    <span
      className={className ? `clay-mark ${className}` : "clay-mark"}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {ready ? (
        <img
          key={key}
          ref={strip}
          className="clay-mark-strip"
          src={sheets.sheetUrls[key]}
          alt=""
          draggable={false}
          style={{
            width: size,
            height: size * info.frames,
            transform: `translateY(${-start * size}px)`,
          }}
        />
      ) : (
        <span className="clay-mark-dot" />
      )}
    </span>
  );
}
