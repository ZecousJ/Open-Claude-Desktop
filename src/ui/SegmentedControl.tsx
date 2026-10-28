import {
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTooltip } from "./Tooltip";
import type { TooltipPlacement } from "./tooltip-position";
import { prefersReducedMotion } from "./usePresence";

export type Segment<T> = {
  value: T;
  label: string;
  /** An icon-only segment: the label becomes its name and its tooltip. */
  icon?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
};

/** The thumb's place inside the control, in px from its padding edge. */
type Place = { left: number; width: number };

/** Reads a CSS duration custom property ("200ms", ".2s") as milliseconds. */
function durationMs(value: string, fallback: number) {
  const number = parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return value.trim().endsWith("ms") ? number : number * 1000;
}

/**
 * The keyframes that carry the thumb from where it was to where it is
 * (FLIP): it starts drawn over the old segment, as a scaled copy of its
 * new width, and settles at the new one.
 */
export function thumbFrames(from: Place, to: Place) {
  return [
    {
      transform: `translateX(${from.left}px) scaleX(${to.width ? from.width / to.width : 1})`,
    },
    { transform: `translateX(${to.left}px) scaleX(1)` },
  ];
}

/**
 * A segmented control (a radio group drawn as joined buttons), after the
 * original's SegmentedControl: the chosen segment sits on a thumb with an inner
 * ring and a 0 1px 2px shadow, and a new choice slides and stretches the thumb
 * across (translateX + scaleX over --motion-base on --ease-snap). Arrows, Home
 * and End move the choice, as in any radio group. Consumers style it through
 * their own class and the --segmented-* properties (segmented-control.css).
 */
export function SegmentedControl<T extends string | boolean>({
  label,
  labelledBy,
  value,
  segments,
  onChange,
  className = "",
  disabled = false,
  tooltipPlacement = "below",
}: {
  label?: string;
  /** The id of a visible label, in place of `label`. */
  labelledBy?: string;
  value: T;
  segments: Segment<T>[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
  tooltipPlacement?: TooltipPlacement;
}) {
  const root = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const placed = useRef<Place>(undefined);
  const chosen = segments.findIndex((segment) => segment.value === value);

  // Puts the thumb under the chosen segment, sliding it there when it moved
  // because the choice changed.
  useLayoutEffect(() => {
    const box = root.current;
    const bar = thumb.current;
    if (!box || !bar) return;
    const place = (animate: boolean) => {
      const button = box.querySelector<HTMLElement>(
        'button[aria-checked="true"]',
      );
      if (!button) {
        bar.style.visibility = "hidden";
        placed.current = undefined;
        return;
      }
      const next = { left: button.offsetLeft, width: button.offsetWidth };
      const before = placed.current;
      placed.current = next;
      // The stylesheet hides the thumb until it is placed; clearing the
      // inline value would fall back to that and hide it for good.
      bar.style.visibility = "visible";
      bar.style.width = `${next.width}px`;
      bar.style.transform = `translateX(${next.left}px)`;
      if (
        !animate ||
        !before ||
        (before.left === next.left && before.width === next.width) ||
        typeof bar.animate !== "function" ||
        prefersReducedMotion()
      )
        return;
      const style = getComputedStyle(bar);
      bar.animate(thumbFrames(before, next), {
        duration: durationMs(style.getPropertyValue("--motion-base"), 200),
        easing:
          style.getPropertyValue("--ease-snap").trim() ||
          "cubic-bezier(.32, .72, 0, 1)",
      });
    };
    place(true);
    // A layout change (fonts, width) moves it without the slide.
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => place(false));
    watch.observe(box);
    return () => watch.disconnect();
  }, [chosen, segments.length]);

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabled = segments
      .map((segment, index) => ({ segment, index }))
      .filter(({ segment }) => !segment.disabled);
    if (!enabled.length || disabled) return;
    const at = enabled.findIndex(({ index }) => index === chosen);
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    const target =
      event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled.at(-1)
          : forward
            ? enabled[(at + 1) % enabled.length]
            : back
              ? enabled[(at - 1 + enabled.length) % enabled.length]
              : undefined;
    if (!target) return;
    event.preventDefault();
    if (target.segment.value !== value) onChange(target.segment.value);
    root.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [target.index]?.focus();
  };

  return (
    <div
      ref={root}
      className={`segmented ${className}`}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      onKeyDown={move}
    >
      <span ref={thumb} className="segmented-thumb" aria-hidden="true" />
      {segments.map((segment, index) => (
        <SegmentButton
          key={String(segment.value)}
          segment={segment}
          checked={index === chosen}
          // The chosen segment takes Tab; with none chosen, the first does.
          focusable={index === chosen || (chosen < 0 && index === 0)}
          disabled={disabled || Boolean(segment.disabled)}
          tooltipPlacement={tooltipPlacement}
          onSelect={() => segment.value !== value && onChange(segment.value)}
        />
      ))}
    </div>
  );
}

/** One segment; an icon-only one names itself in a tooltip. */
function SegmentButton<T>({
  segment,
  checked,
  focusable,
  disabled,
  tooltipPlacement,
  onSelect,
}: {
  segment: Segment<T>;
  checked: boolean;
  focusable: boolean;
  disabled: boolean;
  tooltipPlacement: TooltipPlacement;
  onSelect: () => void;
}) {
  const { props, tooltip } = useTooltip(segment.label, {
    placement: tooltipPlacement,
    disabled: !segment.icon || disabled,
  });
  return (
    <>
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={segment.icon ? segment.label : undefined}
        className={segment.icon ? "icon" : undefined}
        tabIndex={focusable ? 0 : -1}
        disabled={disabled}
        title={disabled ? segment.disabledReason : undefined}
        onClick={onSelect}
        {...(segment.icon ? props : {})}
      >
        {segment.icon ?? segment.label}
      </button>
      {segment.icon && tooltip}
    </>
  );
}
