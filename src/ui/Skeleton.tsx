import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * Loading placeholders measured on the original (skeleton.css, loaded with
 * the shared styles in styles.css): one block, and the shapes of the pages
 * that load their data.
 */
export function Skeleton({
  width,
  height,
  round,
  className = "",
}: {
  /** px, or a CSS length such as "60%"; the whole row when left out. */
  width?: number | string;
  height: number;
  round?: boolean;
  className?: string;
}) {
  const style: CSSProperties = {
    height,
    ...(width !== undefined ? { width } : {}),
  };
  return (
    <span
      className={`sk${round ? " round" : ""}${className ? ` ${className}` : ""}`}
      style={style}
      aria-hidden="true"
    />
  );
}

/**
 * A group of placeholders (skeleton.css): it waits --placeholder-reveal-delay,
 * fades in, and moves as `motion` says (a wave unless told otherwise). A wave
 * group numbers its blocks in order; a page's own .sk-item takes
 * `skeletonIndex(i)` as its style. The region is announced as loading; the
 * blocks themselves are hidden.
 */
export function SkeletonGroup({
  className = "",
  motion = "wave",
  hold = true,
  label = "Loading",
  as: Tag = "div",
  children,
}: {
  className?: string;
  motion?: "sweep" | "breathe" | "wave";
  /** False shows the placeholders at once, without the wait. */
  hold?: boolean;
  label?: string;
  as?: "div" | "ul";
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const group = ref.current;
    if (motion !== "wave" || !group) return;
    // The blocks take their place in the wave as they come, 22 to a cycle
    // (2s / 90ms); one that already has an index keeps it.
    const number = () => {
      let next = 0;
      for (const block of group.querySelectorAll<HTMLElement>(".sk")) {
        if (block.closest(".sk-item")) continue;
        if (block.style.getPropertyValue("--sk-i") === "")
          block.style.setProperty("--sk-i", String(next % 22));
        next += 1;
      }
    };
    number();
    // Blocks that arrive later join the wave (tests render without observers).
    if (typeof MutationObserver === "undefined") return;
    const watch = new MutationObserver(number);
    watch.observe(group, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [motion]);
  return (
    <Tag
      ref={ref as never}
      className={`sk-group${className ? ` ${className}` : ""}`}
      data-motion={motion}
      data-hold={hold ? undefined : "none"}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      {children}
    </Tag>
  );
}

/** A wave group item's place in the wave (its breath starts 90ms later). */
export function skeletonIndex(index: number): CSSProperties {
  return { "--sk-i": index } as CSSProperties;
}

function Busy({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  return <SkeletonGroup className={className}>{children}</SkeletonGroup>;
}

/** What Settings → Usage shows while it loads, the original's placeholders. */
export function UsageSkeleton() {
  return (
    <Busy className="sk-page">
      <div className="sk-head">
        <Skeleton width={180} height={24} />
        <Skeleton width={300} height={20} />
      </div>
      <Skeleton height={12} />
      <Skeleton height={12} />
      <Skeleton height={12} />
      <div className="sk-row">
        <div className="sk-head">
          <Skeleton width={100} height={28} />
          <Skeleton width={140} height={20} />
        </div>
        <Skeleton width={112} height={40} />
      </div>
      <Skeleton height={8} round />
      <Skeleton width={280} height={20} />
    </Busy>
  );
}

/** A Settings page's data loading (the original's Billing). */
export function SettingsSkeleton() {
  return (
    <Busy className="sk-settings">
      <Skeleton height={28} />
      <Skeleton height={56} />
      <Skeleton height={56} />
      <Skeleton height={56} />
      <Skeleton height={120} />
    </Busy>
  );
}

/** A page of cards loading (the original's Scheduled tasks and Projects). */
export function CardsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <Busy className="sk-cards">
      {Array.from({ length: count }, (_, i) => (
        <div className="sk-card" key={i}>
          <Skeleton height={16} />
          <Skeleton height={12} />
          <Skeleton width="85%" height={12} />
          <Skeleton width={100} height={10} className="sk-foot" />
        </div>
      ))}
    </Busy>
  );
}

/** A list with two columns loading (the original's Customize → Connectors). */
export function TableSkeleton({ rows = 2 }: { rows?: number }) {
  const names = [128, 160, 144, 112];
  return (
    <Busy className="sk-table">
      <Skeleton width={64} height={13} className="sk-head" />
      <Skeleton width={32} height={13} className="sk-head" />
      <Skeleton width={32} height={13} className="sk-head" />
      {Array.from({ length: rows }, (_, i) => [
        <div className="sk-name" key={`n${i}`}>
          <Skeleton width={24} height={24} />
          <Skeleton width={names[i % names.length]} height={14} />
        </div>,
        <Skeleton key={`a${i}`} width={32} height={14} />,
        <Skeleton key={`b${i}`} width={64} height={14} />,
      ])}
    </Busy>
  );
}
