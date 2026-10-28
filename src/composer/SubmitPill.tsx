import {
  cloneElement,
  useEffect,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { prefersReducedMotion, usePresence } from "../ui/usePresence";

// Geometry and spring: 32px circle, 68px capsule, 500/30/0.7.
export function SubmitPill({
  reply = false,
  ...props
}: {
  reply?: boolean;
  running: boolean;
  hasContent: boolean;
  stop: ReactElement<{ children?: ReactNode }>;
  send: ReactNode;
}) {
  // Reply PrimaryAction has ghost controls, not the home capsule.
  if (reply)
    return (
      <span className="composer-reply-submit">
        {props.running && props.stop}
        {(!props.running || props.hasContent) && props.send}
      </span>
    );
  return <HomeSubmitPill {...props} />;
}

function HomeSubmitPill({
  running,
  hasContent,
  stop,
  send,
}: {
  running: boolean;
  hasContent: boolean;
  stop: ReactElement<{ children?: ReactNode }>;
  send: ReactNode;
}) {
  const grouped = running && hasContent;
  const stopPresence = usePresence(running, 120);
  const sendPresence = usePresence(!running || hasContent, 120);
  const stadium = usePresence(grouped, 200);
  const circle = usePresence(running && !grouped, 150);
  const element = useRef<HTMLSpanElement>(null);
  const initial = useRef(true);
  useEffect(() => {
    initial.current = false;
  }, []);
  const position = useRef(grouped ? 68 : 32);
  const velocity = useRef(0);
  useEffect(() => {
    const target = grouped ? 68 : 32;
    const node = element.current;
    if (!node) return;
    if (prefersReducedMotion()) {
      position.current = target;
      velocity.current = 0;
      node.style.width = `${target}px`;
      node.style.gap = `${grouped ? 4 : 0}px`;
      return;
    }
    let frame = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, 0.032);
      previous = now;
      const steps = Math.max(1, Math.ceil(elapsed / 0.004));
      const dt = elapsed / steps;
      for (let index = 0; index < steps; index++) {
        velocity.current +=
          ((500 * (target - position.current) - 30 * velocity.current) / 0.7) *
          dt;
        position.current += velocity.current * dt;
      }
      node.style.width = `${position.current}px`;
      node.style.gap = `${(position.current - 32) / 9}px`;
      if (
        Math.abs(position.current - target) > 0.01 ||
        Math.abs(velocity.current) > 0.01
      )
        frame = requestAnimationFrame(step);
      else {
        position.current = target;
        velocity.current = 0;
        node.style.width = `${target}px`;
        node.style.gap = `${grouped ? 4 : 0}px`;
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [grouped]);
  return (
    <span
      ref={element}
      className="composer-submit-pill"
      data-grouped={grouped || undefined}
      style={{ width: position.current, gap: grouped ? 4 : 0 }}
    >
      {stadium.mounted && (
        <svg
          className="composer-capsule-ring"
          data-state={stadium.state}
          data-enter={!initial.current || undefined}
          width="68"
          height="32"
          viewBox="0 0 68 32"
          aria-hidden="true"
        >
          <path
            d="M 16 0.75 H 52 A 15.25 15.25 0 0 1 52 31.25 H 16 A 15.25 15.25 0 0 1 16 0.75 Z"
            pathLength="20"
          />
        </svg>
      )}
      {stopPresence.mounted && (
        <PillControl open={running} initial={initial.current}>
          {cloneElement(
            stop,
            {},
            <>
              {circle.mounted && (
                <svg
                  className="composer-capsule-ring composer-circle-ring"
                  data-state={circle.state}
                  data-enter
                  width="32"
                  height="32"
                  viewBox="0 0 32 32"
                  aria-hidden="true"
                >
                  <circle cx="16" cy="16" r="15.25" pathLength="12" />
                </svg>
              )}
              {stop.props.children}
            </>,
          )}
        </PillControl>
      )}
      {sendPresence.mounted && (
        <PillControl
          open={!running || hasContent}
          initial={initial.current}
          send
        >
          {send}
        </PillControl>
      )}
    </span>
  );
}

function PillControl({
  open,
  initial,
  send,
  children,
}: {
  open: boolean;
  initial: boolean;
  send?: boolean;
  children: ReactNode;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const entered = useRef(initial);
  useEffect(() => {
    const node = element.current;
    if (!open) entered.current = false;
    if (!node || !open || entered.current || prefersReducedMotion()) return;
    entered.current = true;
    let frame = 0;
    let position = 0;
    let velocity = 0;
    let previous = performance.now();
    const step = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, 0.032);
      previous = now;
      const steps = Math.max(1, Math.ceil(elapsed / 0.004));
      for (let index = 0; index < steps; index++) {
        const dt = elapsed / steps;
        velocity += ((500 * (1 - position) - 30 * velocity) / 0.7) * dt;
        position += velocity * dt;
      }
      node.style.opacity = `${position}`;
      node.style.transform = `scale(${0.6 + 0.4 * position})`;
      if (Math.abs(position - 1) > 0.001 || Math.abs(velocity) > 0.001)
        frame = requestAnimationFrame(step);
      else {
        node.style.removeProperty("opacity");
        node.style.removeProperty("transform");
      }
    };
    node.style.opacity = "0";
    node.style.transform = "scale(0.6)";
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      node.style.removeProperty("opacity");
      node.style.removeProperty("transform");
      entered.current = false;
    };
  }, [open]);
  return (
    <span
      ref={element}
      className={`composer-pill-control${send ? " composer-pill-send" : ""}`}
      data-state={open ? "open" : "closed"}
      inert={!open || undefined}
    >
      {children}
    </span>
  );
}
