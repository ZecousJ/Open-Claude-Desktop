/**
 * The panels beside the conversation open and close on a spring: a panel that
 * appears slides in from the right while the conversation column narrows with
 * it; one that leaves slides back out while the column widens with it. The
 * panels stay direct children of `.chat-layout` (many rules select them with
 * `>`), so this watches that element: an added panel is animated in place, a
 * removed one is put back for its exit and then removed. A panel replaced by
 * one of the same kind (another file in the viewer) is not animated.
 */

/**
 * A critically damped spring (the quickest settle that never passes its
 * end) sampled as a CSS linear() easing.
 */
function springEasing(frequency: number, points = 40) {
  const omega = 2 * Math.PI * frequency;
  const values: string[] = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const x = 1 - Math.exp(-omega * t) * (1 + omega * t);
    values.push(i === points ? "1" : x.toFixed(4));
  }
  return `linear(${values.join(", ")})`;
}

const openEasing = springEasing(1.1);
/** Closing: quicker. */
const closeEasing = springEasing(1.3);
const openMs = 560;
const closeMs = 380;

const reducedMotion = () =>
  document.documentElement.dataset.motion === "reduced" ||
  matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The conversation column and pages, which never animate. */
const isPanel = (node: Node): node is HTMLElement =>
  node instanceof HTMLElement &&
  !node.matches(".chat-main, .artifacts-page, script, style");

const floating = (el: HTMLElement) =>
  ["absolute", "fixed"].includes(getComputedStyle(el).position);
/**
 * On a phone the file viewer and the tool panels are sheets over the lower part
 * of the screen and come up from the bottom on the same spring, the scrim
 * fading in with them (artifact-narrow.css, 95-web.css).
 */
const rises = (el: HTMLElement) =>
  matchMedia("(max-width: 639.98px)").matches &&
  el.matches(".artifact-panel, .app.web .work-panel") &&
  floating(el);

/** The keyframes that bring a panel of this width in (reversed: out). */
function frames(el: HTMLElement, width: number): Keyframe[] {
  if (rises(el)) {
    const below = Math.max(0, innerHeight - el.getBoundingClientRect().top);
    const scrim = getComputedStyle(el).boxShadow;
    const shadow = (end: boolean) =>
      scrim === "none"
        ? {}
        : { boxShadow: end ? scrim : "0 0 0 100vmax rgb(0 0 0 / 0%)" };
    // Opaque throughout: the web's own fade-in is for the side panel.
    return [
      { transform: `translateY(${below}px)`, opacity: 1, ...shadow(false) },
      { transform: "translateY(0)", opacity: 1, ...shadow(true) },
    ];
  }
  return floating(el)
    ? [
        { transform: `translateX(${width}px)`, opacity: 0.4 },
        { transform: "translateX(0)", opacity: 1 },
      ]
    : [
        { marginRight: `${-width}px`, opacity: 0.4 },
        { marginRight: "0px", opacity: 1 },
      ];
}

/**
 * The conversation column and its title bar. Beside a panel the rules give
 * them their new size at once (a margin for a tool card, a width for the
 * file viewer), so they are held at the width they had and moved to the
 * one they have now on the panel's curve.
 */
function column(layout: HTMLElement) {
  return [
    layout.querySelector<HTMLElement>(":scope > .chat-main"),
    layout.parentElement?.querySelector<HTMLElement>(":scope > .chat-header"),
  ].filter((el): el is HTMLElement => Boolean(el));
}
const widthOf = (el: HTMLElement) => el.getBoundingClientRect().width;
const widthsOf = (els: HTMLElement[]) =>
  new Map(els.map((el) => [el, widthOf(el)] as const));
/**
 * The column moves made here. Others on the same elements (the title bar's
 * own fade as a panel opens) are neither a move to turn back from nor
 * stopped.
 */
const columnMoves = new WeakSet<Animation>();
const ours = (a: Animation) => columnMoves.has(a);
/** A column still moving: where its move holds it now. */
function moving(els: HTMLElement[]) {
  return els.some((el) =>
    el.getAnimations().some((a) => ours(a) && a.playState === "running"),
  )
    ? widthsOf(els)
    : undefined;
}
/** The column's sizes under the rules alone: an earlier move is stopped. */
function settled(els: HTMLElement[]) {
  for (const el of els)
    for (const a of el.getAnimations()) if (ours(a)) a.cancel();
  return widthsOf(els);
}
/**
 * A width to hold. In a row (the conversation column) the flex basis is
 * that width too; the title bar sits in a column, where a basis would be
 * its height, so it only gets the width.
 */
function sized(el: HTMLElement, width: number): Keyframe {
  const parent = el.parentElement;
  const row =
    parent !== null &&
    getComputedStyle(parent).flexDirection.startsWith("row") &&
    getComputedStyle(parent).display.includes("flex");
  return {
    ...(row ? { flex: `0 0 ${width}px` } : {}),
    width: `${width}px`,
    minWidth: "0px",
    maxWidth: "none",
  };
}

function move(
  els: HTMLElement[],
  from: Map<Element, number>,
  to: Map<Element, number>,
  options: KeyframeAnimationOptions,
) {
  return els.flatMap((el) => {
    const start = from.get(el);
    const end = to.get(el);
    if (start === undefined || end === undefined || Math.abs(start - end) < 1)
      return [];
    const animation = el.animate([sized(el, start), sized(el, end)], options);
    columnMoves.add(animation);
    return [animation];
  });
}

/**
 * Under a rising sheet the conversation stays on screen as it was (the
 * rules hide it, and size it for a panel beside it, at once) until the
 * sheet covers it, or from the moment the sheet starts down.
 */
function holdColumn(
  els: HTMLElement[],
  widths: Map<Element, number>,
  options: KeyframeAnimationOptions,
) {
  return els.flatMap((el) => {
    const width = widths.get(el);
    if (width === undefined) return [];
    const frame = { ...sized(el, width), visibility: "visible" };
    const animation = el.animate([frame, frame], options);
    columnMoves.add(animation);
    return [animation];
  });
}

/**
 * While a card is off to the right the page around it must not scroll to
 * it: Safari brings a focused panel into view by scrolling the clipped
 * workspace, which then stayed shifted with the column under the sidebar.
 * Clip instead of hide for the move, and put the scroll back after.
 */
const holds = new WeakMap<HTMLElement, { count: number; overflow: string[] }>();
function holdStill(layout: HTMLElement) {
  const els = [layout, layout.parentElement].filter((el): el is HTMLElement =>
    Boolean(el),
  );
  // Overlapping moves (a panel closed while it opens) share one hold.
  const hold = holds.get(layout) ?? {
    count: 0,
    overflow: els.map((el) => el.style.overflow),
  };
  holds.set(layout, hold);
  if (hold.count++ === 0) for (const el of els) el.style.overflow = "clip";
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--hold.count) return;
    holds.delete(layout);
    els.forEach((el, i) => {
      el.style.overflow = hold.overflow[i]!;
      el.scrollLeft = 0;
    });
  };
}

/**
 * The column's sizes as if the panel were not there: its classes (which the
 * rules on its presence select) are taken off and it is out of the flow
 * for the measure, then put back. The node itself never moves, so nothing
 * in it reloads.
 */
function widthsWithout(el: HTMLElement, els: HTMLElement[]) {
  const classes = el.getAttribute("class");
  const display = el.style.display;
  el.removeAttribute("class");
  el.style.display = "none";
  const widths = widthsOf(els);
  if (classes !== null) el.setAttribute("class", classes);
  el.style.display = display;
  return widths;
}

/**
 * An added panel slides in. The column starts from where it is moving, or
 * else from its width without the panel.
 */
function animateIn(layout: HTMLElement, el: HTMLElement) {
  const width = el.getBoundingClientRect().width;
  if (!width) return;
  const els = column(layout);
  const now = moving(els);
  const after = settled(els);
  const before = now ?? widthsWithout(el, els);
  const release = holdStill(layout);
  const options = { duration: openMs, easing: openEasing };
  const animation = el.animate(frames(el, width), options);
  if (rises(el)) holdColumn(els, before, options);
  else move(els, before, after, options);
  animation.onfinish = animation.oncancel = release;
}

/**
 * A removed panel is put back to slide out, inert, and then removed. Both
 * ends of the column's move are measured here: without the panel, then
 * with it back (or from where it is moving).
 */
function animateOut(layout: HTMLElement, el: HTMLElement, next: Node | null) {
  // A sheet dragged down has already left (ui/sheet-drag.ts).
  if (el.dataset.dismissed) return;
  const els = column(layout);
  const now = moving(els);
  const after = settled(els);
  el.setAttribute("inert", "");
  el.setAttribute("aria-hidden", "true");
  el.style.pointerEvents = "none";
  layout.insertBefore(el, next && next.parentNode === layout ? next : null);
  const width = el.getBoundingClientRect().width;
  if (!width) {
    el.remove();
    return;
  }
  const before = now ?? widthsOf(els);
  const release = holdStill(layout);
  const options = { duration: closeMs, easing: closeEasing };
  const animation = el.animate([...frames(el, width)].reverse(), {
    ...options,
    fill: "forwards",
  });
  // Back in the page the panel's rules hold the old size; the column keeps
  // the new one until the panel is gone.
  const moves = rises(el)
    ? holdColumn(els, after, { ...options, fill: "forwards" })
    : move(els, before, after, { ...options, fill: "forwards" });
  const done = () => {
    el.remove();
    for (const m of moves) m.cancel();
    release();
  };
  animation.onfinish = animation.oncancel = done;
}

/** Watches a `.chat-layout` element; returns the stop function. */
export function springPanels(layout: HTMLElement) {
  const ghosts = new WeakSet<Node>();
  const observer = new MutationObserver((records) => {
    const added: HTMLElement[] = [];
    const removed: { el: HTMLElement; next: Node | null }[] = [];
    for (const record of records) {
      for (const node of record.addedNodes)
        if (isPanel(node) && !ghosts.has(node)) added.push(node);
      for (const node of record.removedNodes)
        if (isPanel(node) && !ghosts.has(node))
          removed.push({ el: node, next: record.nextSibling });
    }
    if (reducedMotion()) return;
    // A panel replaced by one of its kind is a swap, not an open or close.
    const kind = (el: Element) => el.classList[0] ?? el.tagName;
    const swapped = new Set<Element>();
    for (const out of removed) {
      const match = added.find(
        (el) => !swapped.has(el) && kind(el) === kind(out.el),
      );
      if (match) {
        swapped.add(match);
        swapped.add(out.el);
      }
    }
    for (const el of added) if (!swapped.has(el)) animateIn(layout, el);
    for (const out of removed) {
      if (swapped.has(out.el)) continue;
      ghosts.add(out.el);
      animateOut(layout, out.el, out.next);
    }
  });
  observer.observe(layout, { childList: true });
  return () => observer.disconnect();
}
