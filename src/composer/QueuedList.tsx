import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { formatText, useT } from "../i18n";
import { Menu, type MenuEntry, type MenuPosition } from "../ui/Menu";
import { queuedPreview, type QueuedMessage } from "./queue";
import "./queued-message-bar.css";
import {
  Glyph,
  keepFocus,
  GhostButton,
  SentHint,
  countLabel,
  shiftFor,
  overFor,
} from "./QueuedMessageBar";
import type { QueuedMessageBarProps, Slot, Drag } from "./QueuedMessageBar";

/** One row of the open list. */
function QueuedRow({
  entry,
  sortable,
  drag,
  onCancel,
  onEdit,
  onSteer,
  onHandlePointerDown,
  onHandleKeyDown,
  onHandleBlur,
  rowRef,
}: {
  entry: QueuedMessage;
  sortable: boolean;
  drag?: Drag;
  onCancel?: (id: string) => void;
  onEdit?: (id: string) => void;
  onSteer?: (id: string) => void;
  onHandlePointerDown: (event: ReactPointerEvent, id: string) => void;
  onHandleKeyDown: (event: ReactKeyboardEvent, id: string) => void;
  onHandleBlur: () => void;
  rowRef: (node: HTMLDivElement | null) => void;
}) {
  const t = useT();
  const [menu, setMenu] = useState<MenuPosition>();
  const more = useRef<HTMLButtonElement>(null);
  const sent = entry.state === "steered";
  const busy = Boolean(entry.steering);
  const items: MenuEntry[] = [];
  if (onEdit)
    items.push({
      label: "Edit in composer",
      disabled: busy,
      onSelect: () => onEdit(entry.id),
    });
  if (onSteer)
    items.push({
      label: "Send now",
      disabled: busy,
      onSelect: () => onSteer(entry.id),
    });
  if (onCancel) {
    if (items.length) items.push({ separator: true });
    items.push({
      label: "Remove from queue",
      danger: true,
      disabled: busy,
      onSelect: () => onCancel(entry.id),
    });
  }
  const canSort = sortable && !busy;
  const dragging = drag?.id === entry.id;
  const index = drag?.slots.findIndex((slot) => slot.id === entry.id) ?? -1;
  const shift =
    drag && index >= 0
      ? dragging
        ? drag.keyboard
          ? drag.slots[drag.over].top -
            drag.slots[drag.from].top +
            (drag.over > drag.from
              ? drag.slots[drag.over].height - drag.slots[drag.from].height
              : 0)
          : drag.offset
        : shiftFor(drag, index)
      : 0;
  const controls = canSort || busy ? "two" : items.length ? "one" : undefined;
  const held = dragging || Boolean(menu) || busy;
  return (
    <div
      ref={rowRef}
      role="listitem"
      className="queued-row"
      aria-busy={busy || undefined}
      data-entry={entry.id}
      data-controls={controls}
      data-held={held || undefined}
      data-sent={sent || undefined}
      data-dragging={dragging || undefined}
      data-shifting={(drag && !dragging) || undefined}
      style={shift ? { transform: `translate3d(0, ${shift}px, 0)` } : undefined}
      onContextMenu={
        items.length && !drag
          ? (event) => {
              event.preventDefault();
              setMenu({ left: event.clientX, top: event.clientY });
            }
          : undefined
      }
    >
      <span className="queued-row-text" data-no-translate>
        {queuedPreview(entry, t("[Image]"))}
      </span>
      <span className="queued-row-controls">
        {sent && <SentHint />}
        {busy && (
          <GhostButton
            label="Send now"
            icon={<Glyph name="ArrowReturn" />}
            size="sm"
            busy
            busyLabel="Sending…"
          />
        )}
        {canSort && (
          <button
            type="button"
            className="queued-row-handle"
            aria-label="Reorder queued message"
            aria-pressed={drag?.keyboard && dragging ? true : undefined}
            onPointerDown={(event) => onHandlePointerDown(event, entry.id)}
            onKeyDown={(event) => onHandleKeyDown(event, entry.id)}
            onBlur={onHandleBlur}
          >
            <Glyph name="Reorder" />
          </button>
        )}
        {items.length > 0 && (
          <GhostButton
            label="Queued message actions"
            icon={<Glyph name="DotsVertical" />}
            size="sm"
            className="queued-row-more"
            menu
            expanded={Boolean(menu)}
            buttonRef={more}
            onClick={() => {
              if (menu) return setMenu(undefined);
              const box = more.current!.getBoundingClientRect();
              setMenu({
                right: document.documentElement.clientWidth - box.right,
                top: box.bottom + 4,
              });
            }}
          />
        )}
      </span>
      {menu && (
        <Menu
          label="Queued message actions"
          entries={items}
          position={menu}
          width={160}
          anchors={[more]}
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

/** Two or more: the summary button, or the card with the list. */
export function QueuedList({
  entries,
  onCancel,
  onEdit,
  onSteer,
  onReorder,
  onClearAll,
  initiallyExpanded = false,
}: Omit<QueuedMessageBarProps, "exiting" | "onExited">) {
  const t = useT();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const summary = useRef<HTMLButtonElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  // Focus follows the toggle when it had it.
  const toggleFocused = useRef(false);
  const [drag, setDrag] = useState<Drag>();
  const dragRef = useRef<Drag | undefined>(undefined);
  dragRef.current = drag;
  useLayoutEffect(() => {
    if (!toggleFocused.current) return;
    toggleFocused.current = false;
    (expanded ? collapse : summary).current?.focus();
  }, [expanded]);

  const sortable = (entry: QueuedMessage) =>
    Boolean(onReorder) && entry.state === "queued" && !entry.steering;
  const sortableIds = entries.filter(sortable).map((entry) => entry.id);
  const canReorder = sortableIds.length > 1;

  const measure = (): Slot[] =>
    sortableIds.flatMap((id) => {
      const node = rows.current.get(id);
      if (!node) return [];
      const box = node.getBoundingClientRect();
      return [{ id, top: box.top, height: box.height }];
    });
  const finish = (commit: boolean) => {
    const current = dragRef.current;
    setDrag(undefined);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (!commit || !current || current.over === current.from) return;
    onReorder?.(current.id, current.slots[current.over].id);
  };

  const onHandlePointerDown = (event: ReactPointerEvent, id: string) => {
    if (event.button !== 0 || !canReorder) return;
    const handle = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let started = false;
    let slots: Slot[] = [];
    let from = -1;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const travel = moveEvent.clientY - startY;
      if (!started) {
        // A press only becomes a drag past 5px.
        if (Math.abs(travel) < 5) return;
        started = true;
        slots = measure();
        from = slots.findIndex((slot) => slot.id === id);
        if (from < 0) return stop();
        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
      }
      // The dragged row stays within the list's visible box.
      const box = list.current?.getBoundingClientRect();
      const slot = slots[from];
      const offset = box
        ? Math.min(
            Math.max(travel, box.top - slot.top),
            box.bottom - (slot.top + slot.height),
          )
        : travel;
      setDrag({
        id,
        slots,
        from,
        over: overFor(slots, from, offset),
        offset,
        keyboard: false,
      });
    };
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      stop();
      if (started) finish(true);
    };
    const cancel = () => {
      stop();
      if (started) finish(false);
    };
    const escape = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape" || !started) return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    };
    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", escape, true);
      try {
        handle.releasePointerCapture(pointerId);
      } catch {
        /* already released */
      }
    }
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* not capturable */
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", escape, true);
  };

  // From the keyboard: Space or Enter picks the row up, ↑ and ↓ move it,
  // Space or Enter drops it there and Escape puts it back.
  const onHandleKeyDown = (event: ReactKeyboardEvent, id: string) => {
    if (!canReorder) return;
    const current = dragRef.current;
    if (!current) {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      const slots = measure();
      const from = slots.findIndex((slot) => slot.id === id);
      if (from >= 0)
        setDrag({ id, slots, from, over: from, offset: 0, keyboard: true });
      return;
    }
    if (current.id !== id || !current.keyboard) return;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const step = event.key === "ArrowUp" ? -1 : 1;
      const over = Math.min(
        current.slots.length - 1,
        Math.max(0, current.over + step),
      );
      setDrag({ ...current, over });
    } else if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };
  const onHandleBlur = () => {
    if (dragRef.current?.keyboard) finish(false);
  };
  useEffect(
    () => () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    },
    [],
  );

  const count = entries.length;
  if (!expanded)
    return (
      <button
        ref={summary}
        type="button"
        className="queued-bar-band queued-bar-summary"
        aria-expanded={false}
        onClick={(event) => {
          toggleFocused.current =
            event.currentTarget.ownerDocument.activeElement ===
            event.currentTarget;
          setExpanded(true);
        }}
      >
        <span className="queued-bar-count">{countLabel(count)}</span>
        <span className="queued-bar-preview" data-no-translate>
          {formatText("Next: {preview}", {
            preview: queuedPreview(entries[0], t("[Image]")),
          })}
        </span>
        <span className="queued-bar-caret" aria-hidden="true">
          <Glyph name="CaretDown" />
        </span>
      </button>
    );

  const unlocked = entries.filter(
    (entry) => entry.state === "queued" && !entry.steering,
  );
  return (
    <div className="queued-bar-card">
      <div className="queued-bar-header">
        <span className="queued-bar-count">{countLabel(count)}</span>
        <GhostButton
          label="Collapse queued messages"
          icon={<Glyph name="CaretUp" />}
          className="queued-bar-collapse"
          buttonRef={collapse}
          expanded
          onClick={(event) => {
            toggleFocused.current =
              event.currentTarget.ownerDocument.activeElement ===
              event.currentTarget;
            setExpanded(false);
          }}
        />
      </div>
      <div
        ref={list}
        role="list"
        aria-label="Queued messages"
        className="queued-bar-list"
        data-sorting={drag ? "" : undefined}
      >
        {entries.map((entry, index) => {
          const locked = entry.state !== "queued";
          return (
            <Fragment key={entry.id}>
              {index > 0 && (
                <div
                  role="presentation"
                  aria-hidden="true"
                  className="queued-bar-divider"
                />
              )}
              <QueuedRow
                entry={entry}
                sortable={canReorder && sortable(entry)}
                drag={drag}
                onCancel={locked ? undefined : onCancel}
                onEdit={locked ? undefined : onEdit}
                onSteer={locked ? undefined : onSteer}
                onHandlePointerDown={onHandlePointerDown}
                onHandleKeyDown={onHandleKeyDown}
                onHandleBlur={onHandleBlur}
                rowRef={(node) => {
                  if (node) rows.current.set(entry.id, node);
                  else rows.current.delete(entry.id);
                }}
              />
            </Fragment>
          );
        })}
      </div>
      {onCancel && unlocked.length > 0 && (
        <div className="queued-bar-footer">
          <button
            type="button"
            className="queued-bar-clear"
            onMouseDown={keepFocus}
            onClick={() => {
              if (onClearAll) onClearAll();
              else for (const entry of unlocked) onCancel(entry.id);
            }}
          >
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
