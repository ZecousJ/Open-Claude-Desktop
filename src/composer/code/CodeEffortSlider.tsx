import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { CircleHelp } from "../../ui/glyphs";
import { useTooltip } from "../../ui/Tooltip";
import type { CodeEffort } from "../../../shared/types";
import {
  codeEffortIndexAt,
  codeEffortLabels,
  codeEffortLevels,
  codeEffortPull,
} from "../../../shared/code-effort";
import { exponentialEasing } from "../../ui/exponential-easing";
import {
  nearestSupportedEffort,
  stepSupportedEffort,
} from "./code-effort-support";
import { lazyPiece } from "../../ui/lazy-piece";
// The point field is decoration inside the open effort popup.
const CodeEffortField = lazyPiece(
  () => import("./CodeEffortField"),
  "CodeEffortField",
  { silent: true },
);
import { rollLabel, settleLabel, type LabelLayer } from "./code-effort-labels";
import "./code-effort-slider.css";

// The thumb, fill and field glide to a new stop (and follow the rubber band)
// as an exponential approach with τ ≈ 35ms: 0.6 / 0.86 / 0.95 of the way
// after one, two and three 30fps frames (2097af56).
const snapEase = exponentialEasing(180, 35, 16);

// No warning on Max.
const effortHelp = "Higher effort uses more time and tokens";

export function CodeEffortSlider({
  value,
  onChange,
  openRequest = 0,
  supported = codeEffortLevels,
}: {
  value: CodeEffort;
  onChange: (next: CodeEffort) => void;
  openRequest?: number;
  /**
   * Levels the model takes (`codeEffortsFor`); the others are dimmed, a drag
   * onto one settles on the closest level the model takes, and the keys
   * skip it.
   */
  supported?: readonly CodeEffort[];
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<CodeEffort>(value);
  const [dragging, setDragging] = useState(false);
  const [pull, setPull] = useState(0);
  const [labels, setLabels] = useState<LabelLayer[]>([
    { id: 0, level: value, phase: "steady", direction: "up" },
  ]);
  const previewRef = useRef<CodeEffort>(value);
  const labelId = useRef(0);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const focusTrack = useRef(false);
  const draggingRef = useRef(false);
  useEffect(() => {
    if (!draggingRef.current) {
      previewRef.current = value;
      setPreview(value);
    }
  }, [value]);
  useEffect(() => {
    if (openRequest > 0) {
      focusTrack.current = true;
      setOpen(true);
    }
  }, [openRequest]);
  // /effort opens the panel with the slider ready for the arrow keys; the
  // capture shows no focus ring on the track or the button.
  useEffect(() => {
    if (!open || !focusTrack.current) return;
    focusTrack.current = false;
    track.current?.focus({ focusVisible: false } as FocusOptions);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: globalThis.PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  // Closing mid-drag (Escape while pressed) cancels the drag, so the panel
  // does not reopen with a pressed thumb that follows a released pointer.
  useEffect(() => {
    if (open || !draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    setPull(0);
    previewRef.current = value;
    setPreview(value);
  }, [open]);
  // The label rolls on every level change while open, not on opening.
  const wasOpen = useRef(false);
  useEffect(() => {
    const animate = open && wasOpen.current;
    wasOpen.current = open;
    const id = ++labelId.current;
    setLabels((current) => rollLabel(current, preview, id, animate));
  }, [preview, open]);
  const index = codeEffortLevels.indexOf(preview);
  const setLevel = (next: CodeEffort) => {
    previewRef.current = next;
    setPreview(next);
  };
  const fromPointer = (clientX: number) => {
    const rect = track.current!.getBoundingClientRect();
    const current = codeEffortLevels.indexOf(previewRef.current);
    const next = nearestSupportedEffort(
      codeEffortIndexAt(clientX, rect.left, rect.width, current),
      supported,
    );
    const center = rect.left + 8 + ((rect.width - 16) * next) / 5;
    if (draggingRef.current) setPull(codeEffortPull(clientX - center, next));
    return codeEffortLevels[next];
  };
  const endDrag = () => {
    draggingRef.current = false;
    setDragging(false);
    setPull(0);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus();
    draggingRef.current = true;
    setDragging(true);
    setLevel(fromPointer(event.clientX));
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) setLevel(fromPointer(event.clientX));
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    const next = fromPointer(event.clientX);
    endDrag();
    setLevel(next);
    onChange(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const pointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    endDrag();
    previewRef.current = value;
    setPreview(value);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    const next =
      event.key === "Home"
        ? nearestSupportedEffort(0, supported)
        : event.key === "End"
          ? nearestSupportedEffort(5, supported)
          : event.key === "ArrowRight" || event.key === "ArrowUp"
            ? stepSupportedEffort(index, 1, supported)
            : event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? stepSupportedEffort(index, -1, supported)
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const level = codeEffortLevels[next];
    setLevel(level);
    onChange(level);
  };
  const ultra = preview === "ultra";
  // The trigger's tooltip names ⌘⇧E (openEffortMenu); the help icon opens a
  // tooltip with the level it is on and what effort does.
  const triggerTip = useTooltip("Effort", {
    shortcut: ["mod", "shift", "E"],
    placement: "above",
    disabled: open,
  });
  const helpTip = useTooltip(codeEffortLabels[preview], {
    detail: effortHelp,
    placement: "above",
    gap: 8,
  });
  const stop = `calc(8px + (100% - 16px) * ${index / 5} + ${pull.toFixed(2)}px)`;
  return (
    <div className="popover-anchor code-effort-anchor" ref={anchor}>
      <button
        ref={trigger}
        {...triggerTip.props}
        className="effort-button code-effort-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Effort: ${codeEffortLabels[value]}`}
        onClick={() => {
          previewRef.current = value;
          setPreview(value);
          setOpen((current) => !current);
        }}
      >
        {codeEffortLabels[value]}
      </button>
      {triggerTip.tooltip}
      {open && (
        <div className="code-effort-panel" role="dialog" aria-label="Effort">
          <div className="code-effort-heading">
            <span>Effort</span>
            <span className="code-effort-value" aria-live="polite">
              {labels.map((layer) => (
                <strong
                  key={layer.id}
                  className={layer.level === "ultra" ? "ultra" : ""}
                  data-phase={layer.phase}
                  data-direction={layer.direction}
                  aria-hidden={layer.phase === "out" || undefined}
                  onAnimationEnd={() =>
                    setLabels((current) => settleLabel(current, layer.id))
                  }
                >
                  {codeEffortLabels[layer.level]}
                </strong>
              ))}
            </span>
            <button
              {...helpTip.props}
              className="code-effort-help"
              aria-label="About effort"
            >
              <CircleHelp size={13} />
            </button>
            {helpTip.tooltip}
          </div>
          <div className="code-effort-ends">
            <span>Faster</span>
            <span>Smarter</span>
          </div>
          <div
            ref={track}
            className="code-effort-track"
            data-ultra={ultra}
            data-dragging={dragging}
            style={{ "--code-effort-snap-ease": snapEase } as CSSProperties}
            role="slider"
            tabIndex={0}
            aria-label="Effort"
            aria-valuemin={0}
            aria-valuemax={5}
            aria-valuenow={index}
            aria-valuetext={codeEffortLabels[preview]}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerCancel}
            onKeyDown={keyDown}
          >
            <span className="code-effort-clip">
              <span
                className="code-effort-fill"
                data-ultra={ultra}
                style={{ width: stop }}
              />
              <Suspense fallback={null}>
                <CodeEffortField active={ultra} width={stop} />
              </Suspense>
              {codeEffortLevels.map((level, i) => (
                <i
                  key={level}
                  className="code-effort-dot"
                  data-filled={i <= index}
                  data-unsupported={!supported.includes(level) || undefined}
                  style={{ left: `calc(12px + (100% - 24px) * ${i / 5})` }}
                />
              ))}
            </span>
            <span className="code-effort-thumb" style={{ left: stop }} />
          </div>
        </div>
      )}
    </div>
  );
}
