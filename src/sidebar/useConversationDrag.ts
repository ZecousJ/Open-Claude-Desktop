import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import type {
  DropPosition,
  SidebarSection,
} from "../../shared/conversation-order";
import {
  dragIntent,
  dragShifts,
  groupDrop,
  landingOffset,
  sameIntent,
  slotTarget,
  type DragIntent,
  type DragLayout,
  type GroupZone,
} from "./dragPlacement";

export interface ConversationDrop {
  section: SidebarSection;
  targetId?: string;
  position: DropPosition;
}

/** The row's copy that follows the pointer, as the drag started. */
export interface DragGhostSource {
  clone: HTMLElement;
  width: number;
  height: number;
  /** Where the pointer holds the copy, from its top left. */
  dx: number;
  dy: number;
  /** The row's own corner radius (the live pill's --df-radius-pill). */
  radius: string;
}

/** The drag as the list renders it: it changes only when its intent does. */
export interface ConversationDrag extends DragIntent {
  id: string;
  ghost: DragGhostSource;
}

/** What a release asks for. */
export type ConversationDropAction =
  | { kind: "pin" | "reorder"; target: ConversationDrop }
  | { kind: "unpin" }
  /** Into a custom group, or out of its group with a null id. */
  | { kind: "group"; groupId: string | null; label: string };

type DragStart = {
  id: string;
  x: number;
  y: number;
  pointerId: number;
  row: HTMLElement;
  captureTarget: HTMLElement;
};

type Measured = {
  layout: DragLayout<HTMLElement>;
  pane: HTMLElement;
  scrollTop: number;
  right: number;
  /** Every element a shift may have moved. */
  moved: HTMLElement[];
  /** The custom groups' parts of the list, and the one the row is in. */
  zones: GroupZone[];
  srcZone: number;
};

/**
 * The row's copy for the pointer: the row's own markup, inert and stripped of
 * what identifies it.
 */
function cloneRow(row: HTMLElement) {
  const clone = row.cloneNode(true) as HTMLElement;
  for (const element of [clone, ...clone.querySelectorAll<HTMLElement>("*")]) {
    element.removeAttribute("id");
    element.removeAttribute("data-conversation-id");
    element.removeAttribute("data-roving-row");
    element.removeAttribute("data-roving-item");
    element.removeAttribute("data-drag-shift");
  }
  clone.removeAttribute("style");
  clone.setAttribute("inert", "");
  return clone;
}

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), Math.max(low, high));

/**
 * Pointer-captured sidebar drag, independent of the OS clipboard and HTML drag
 * image, as in the original: the rows are measured when the drag starts, the
 * others slide by transforms while the dragged row's place stays laid out and
 * empty, and the copy follows the pointer frame by frame without rendering the
 * list. A release into Pinned shows the row in its new place at once and keeps
 * the list standing so until the reordered list arrives; the caller says when
 * with `release`.
 */
export function useConversationDrag(
  onDrop: (
    sourceId: string,
    action: ConversationDropAction,
    release: () => void,
  ) => void,
) {
  const [drag, setDrag] = useState<ConversationDrag>();
  const dragRef = useRef<ConversationDrag | undefined>(undefined);
  const start = useRef<DragStart | undefined>(undefined);
  const measured = useRef<Measured | undefined>(undefined);
  // The row of a drop waiting for the reordered list, shown in its new place.
  const held = useRef<{ row: HTMLElement } | undefined>(undefined);
  const pointer = useRef({ x: 0, y: 0 });
  const suppressClick = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const scrollFrame = useRef<number | undefined>(undefined);
  const callback = useRef(onDrop);
  callback.current = onDrop;
  const stopScroll = () => {
    if (scrollFrame.current !== undefined)
      cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = undefined;
  };
  // Back to the laid-out list, with no motion: the transition is lifted with
  // the transforms (the original's rows animate only while dragging).
  const restore = (row?: HTMLElement) => {
    const current = measured.current;
    measured.current = undefined;
    scroll.current?.removeAttribute("data-pin-dragging");
    for (const element of current?.moved ?? []) element.style.transform = "";
    for (const element of [row, held.current?.row])
      if (element) {
        element.style.transform = "";
        element.style.visibility = "";
      }
    held.current = undefined;
  };
  const clear = () => {
    stopScroll();
    restore(start.current?.row);
    start.current = undefined;
    dragRef.current = undefined;
    setDrag(undefined);
  };
  const shift = (intent: DragIntent) => {
    const current = measured.current;
    if (!current) return;
    const shifts = dragShifts(current.layout, intent.slot);
    const step = current.layout.rowStep;
    for (const element of current.moved) {
      const by = shifts.get(element);
      element.style.transform = by ? `translateY(${by * step}px)` : "";
    }
  };
  // The intent where the pointer is now; the list renders only a change.
  const retarget = () => {
    const active = dragRef.current,
      current = measured.current;
    if (!active || !current) return;
    const { x, y } = pointer.current;
    const at = y + current.pane.scrollTop - current.scrollTop;
    // Over a custom group a release moves the row into it.
    const group =
      x > current.right
        ? null
        : groupDrop(current.zones, at, {
            zone: current.srcZone,
            pinned: current.layout.srcPinnedIndex >= 0,
          });
    const next: DragIntent =
      group !== undefined
        ? { slot: null, unpin: false, group }
        : dragIntent(current.layout, at, active.slot);
    if (sameIntent(next, active)) return;
    shift(next);
    dragRef.current = { ...active, ...next };
    setDrag(dragRef.current);
  };
  // Measured once the list has rendered for the drag (every pinned row out,
  // the empty section's "Drop here" row in).
  const measure = () => {
    const origin = start.current,
      pane = scroll.current;
    if (!origin || !pane) return;
    const row = origin.row;
    // A row's step is its height and the space before the next row (the
    // live list's --df-row-h plus --df-row-stack-gap), so the opened place
    // is exactly a row's room.
    const style = getComputedStyle(row);
    const rowStep =
      row.getBoundingClientRect().height +
      Math.max(
        parseFloat(style.marginBottom) || 0,
        parseFloat(style.marginTop) || 0,
      );
    const pinnedRows = [
      ...pane.querySelectorAll<HTMLElement>(
        ".pinned-rows > [data-conversation-id]",
      ),
    ];
    const pinned = pinnedRows.map((element) => {
      const rect = element.getBoundingClientRect();
      return { key: element, top: rect.top, mid: rect.top + rect.height / 2 };
    });
    const sectionBottom =
      pane.querySelector(".pinned-section")?.getBoundingClientRect().bottom ??
      pane.getBoundingClientRect().top;
    const listBottom = pinnedRows.length
      ? pinnedRows.at(-1)!.getBoundingClientRect().bottom
      : sectionBottom;
    const below = [...pane.querySelectorAll<HTMLElement>("[data-drag-shift]")]
      .filter((element) => !element.closest(".pinned-rows"))
      .map((element) => ({
        key: element,
        top: element.getBoundingClientRect().top,
      }))
      .filter((item) => item.top >= listBottom - 0.5);
    const paneRect = pane.getBoundingClientRect();
    // The custom groups (ConversationList marks each with data-drop-group,
    // empty for Ungrouped), measured once like the rows.
    const zoneElements = [
      ...pane.querySelectorAll<HTMLElement>("[data-drop-group]"),
    ];
    const zones = zoneElements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.dataset.dropGroup || null,
        label: element.dataset.groupLabel ?? "",
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    measured.current = {
      layout: {
        pinned,
        below,
        srcY: row.getBoundingClientRect().top,
        srcPinnedIndex: pinnedRows.indexOf(row),
        pinnedBottom: pinned.length ? sectionBottom : sectionBottom + rowStep,
        nextSectionTop:
          pane
            .querySelector('[data-drop-section="recent"]')
            ?.getBoundingClientRect().top ?? paneRect.bottom,
        rowStep,
      },
      pane,
      scrollTop: pane.scrollTop,
      right: paneRect.right,
      moved: [...pinned, ...below]
        .map((item) => item.key)
        .filter((element) => element !== row),
      zones,
      srcZone: zoneElements.findIndex((element) => element.contains(row)),
    };
    pane.setAttribute("data-pin-dragging", "");
  };
  const dragId = drag?.id;
  useLayoutEffect(() => {
    if (!dragId || measured.current) return;
    measure();
    retarget();
  }, [dragId]);
  const finish = () => {
    const origin = start.current,
      active = dragRef.current,
      current = measured.current;
    start.current = undefined;
    if (!origin) return;
    if (!active) {
      dragRef.current = undefined;
      return;
    }
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    stopScroll();
    retarget();
    const intent = dragRef.current ?? active;
    dragRef.current = undefined;
    setDrag(undefined);
    let action: ConversationDropAction | undefined;
    if (current && intent.slot !== null) {
      const slot = intent.slot;
      // The row shows in its new place at once, without motion, as the
      // original's optimistic pin does (transientPinKey).
      scroll.current?.removeAttribute("data-pin-dragging");
      const hint = current.pane.querySelector(".pin-hint");
      const offset =
        landingOffset(current.layout, slot) ??
        (hint
          ? hint.getBoundingClientRect().top -
            origin.row.getBoundingClientRect().top
          : 0);
      origin.row.style.transform = `translateY(${offset}px)`;
      origin.row.style.visibility = "";
      const { targetId, position } = slotTarget(current.layout, slot);
      action = {
        kind: current.layout.srcPinnedIndex >= 0 ? "reorder" : "pin",
        target: {
          section: "pinned",
          targetId: targetId?.dataset.conversationId,
          position,
        },
      };
    } else if (current && intent.group) {
      // The row leaves its place; the list shows it in the group at once
      // (a pinned one once the list without its pin arrives).
      scroll.current?.removeAttribute("data-pin-dragging");
      action = {
        kind: "group",
        groupId: intent.group.id,
        label: intent.group.label,
      };
    } else if (intent.unpin) {
      // Its place stays empty until the list without it arrives.
      scroll.current?.removeAttribute("data-pin-dragging");
      action = { kind: "unpin" };
    }
    if (!action) {
      restore(origin.row);
      return;
    }
    const drop = { row: origin.row };
    held.current = drop;
    callback.current(origin.id, action, () => {
      // A newer drag has already put the list back.
      if (held.current === drop) restore();
    });
  };
  const finishRef = useRef(finish),
    clearRef = useRef(clear);
  finishRef.current = finish;
  clearRef.current = clear;
  useEffect(() => {
    const mouseUp = (event: globalThis.MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      finishRef.current();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && start.current) clearRef.current();
    };
    document.addEventListener("mouseup", mouseUp, true);
    document.addEventListener("keydown", escape, true);
    const blur = () => start.current && clearRef.current();
    window.addEventListener("blur", blur);
    return () => {
      document.removeEventListener("mouseup", mouseUp, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const autoScroll = () => {
    scrollFrame.current = undefined;
    const pane = scroll.current;
    if (!dragRef.current || !pane) return;
    const rect = pane.getBoundingClientRect();
    const pointerY = pointer.current.y;
    if (pointerY < rect.top || pointerY > rect.bottom) return;
    const edge = 36;
    const delta =
      pointerY < rect.top + edge
        ? -Math.ceil((rect.top + edge - pointerY) / 3)
        : pointerY > rect.bottom - edge
          ? Math.ceil((pointerY - (rect.bottom - edge)) / 3)
          : 0;
    if (!delta) return;
    const before = pane.scrollTop;
    pane.scrollTop += delta;
    if (pane.scrollTop !== before) {
      retarget();
      scrollFrame.current = requestAnimationFrame(autoScroll);
    }
  };
  const activate = (origin: DragStart) => {
    const row = origin.row;
    const rect = row.getBoundingClientRect();
    // The copy is as tall as the row's own pill, not its step.
    const pad = parseFloat(getComputedStyle(row).paddingTop) || 0;
    const height = rect.height - 2 * pad;
    // A previous drop still standing gives way to this drag.
    restore();
    row.style.visibility = "hidden";
    dragRef.current = {
      id: origin.id,
      slot: null,
      unpin: false,
      group: null,
      ghost: {
        clone: cloneRow(row),
        width: rect.width,
        height,
        dx: clamp(origin.x - rect.left, 4, rect.width - 4),
        dy: clamp(origin.y - rect.top - pad, 2, height - 2),
        radius: getComputedStyle(row).borderRadius,
      },
    };
    setDrag(dragRef.current);
  };
  const pointerDown = (
    event: PointerEvent<HTMLDivElement>,
    row: { id: string },
  ) => {
    // Only a press on the row's own link starts a drag. The row also holds its
    // ⋮ button, its open menu and the rename field; capturing the pointer for a
    // press there sent the click to the row instead, so menu items could not be
    // chosen.
    const link = (event.target as HTMLElement).closest<HTMLElement>(
      ".conversation-link",
    );
    if (event.button !== 0 || !link || !event.currentTarget.contains(link))
      return;
    start.current = {
      id: row.id,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      row: event.currentTarget,
      captureTarget: link,
    };
    // Capture keeps the moves coming when the pointer leaves the row; a
    // pointer the browser does not know (synthetic events) just goes without.
    try {
      link.setPointerCapture(event.pointerId);
    } catch {
      /* uncaptured */
    }
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const origin = start.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (!dragRef.current) {
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < 7)
        return;
      activate(origin);
    }
    event.preventDefault();
    retarget();
    if (scrollFrame.current === undefined)
      scrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current?.pointerId !== event.pointerId) return;
    const captured = start.current.captureTarget;
    pointer.current = { x: event.clientX, y: event.clientY };
    finish();
    if (captured.hasPointerCapture(event.pointerId))
      captured.releasePointerCapture(event.pointerId);
  };
  const pointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current?.pointerId !== event.pointerId) return;
    const captured = start.current.captureTarget;
    clear();
    if (captured.hasPointerCapture(event.pointerId))
      captured.releasePointerCapture(event.pointerId);
  };
  const lostCapture = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current?.pointerId === event.pointerId) finish();
  };
  const click = (event: MouseEvent<HTMLElement>) => {
    if (!suppressClick.current) return false;
    event.preventDefault();
    event.stopPropagation();
    suppressClick.current = false;
    return true;
  };
  return {
    drag,
    pointer,
    scroll,
    pointerDown,
    pointerMove,
    pointerUp,
    pointerCancel,
    lostCapture,
    click,
  };
}
