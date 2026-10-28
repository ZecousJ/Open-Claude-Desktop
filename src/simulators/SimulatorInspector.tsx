import { useEffect, useRef, useState, type RefObject } from "react";
import {
  ChevronUp,
  Copy,
  MousePointer2,
  Check,
  ChevronDown,
  Plus,
  X,
} from "../ui/glyphs";
import type { SimulatorElement } from "../../shared/simulators";
import { formatText, t } from "../i18n";

/** The elements under a point of the screen (fractions), front first. */
export function elementsAt(
  elements: readonly SimulatorElement[],
  x: number,
  y: number,
) {
  return elements
    .map((element, index) => ({ element, index }))
    .filter(
      ({ element: { frame } }) =>
        x >= frame.x &&
        x <= frame.x + frame.width &&
        y >= frame.y &&
        y <= frame.y + frame.height,
    )
    .sort(
      (a, b) =>
        a.element.frame.width * a.element.frame.height -
          b.element.frame.width * b.element.frame.height ||
        b.element.depth - a.element.depth ||
        b.index - a.index,
    )
    .map(({ element }) => element);
}

/** An element's name for its card and the chat ("Sign in", else its type). */
export function elementTitle(element: SimulatorElement) {
  return element.label ?? element.identifier ?? element.type;
}

/** The text an element adds to the message (with the person's note). */
export function elementChatText(element: SimulatorElement, note: string) {
  const name = element.label ? `"${element.label}" ` : "";
  const id = element.identifier ? `, id ${element.identifier}` : "";
  const value = element.value ? `, value "${element.value}"` : "";
  const head = `Simulator element: ${name}(${element.type}${id}${value})`;
  return note.trim() ? `${head}\n${note.trim()}` : head;
}

/**
 * Inspect: over the screen, the element under the pointer is outlined; a click
 * selects the frontmost one there, and the comment card opens beside it: the
 * Cursor glyph, the element's name in semibold and its type, Select the element
 * in front / behind, Close; a two-line field "Tell Claude what to change" and
 * Add to chat. Enter adds, Escape closes.
 */
/** What the layer, its card and the side panel share. */
export interface InspectorSelection {
  /** The elements under the clicked point, front first (or the one chosen in the tree). */
  stack: SimulatorElement[];
  index: number;
}

export function useInspectorState() {
  const [hovered, setHovered] = useState<SimulatorElement>();
  const [selection, setSelection] = useState<InspectorSelection>({
    stack: [],
    index: 0,
  });
  return { hovered, setHovered, selection, setSelection };
}
export type InspectorState = ReturnType<typeof useInspectorState>;

export function InspectorLayer({
  elements,
  surface,
  frame,
  state,
  onAddToChat,
  onClose,
}: {
  elements: readonly SimulatorElement[];
  surface: RefObject<HTMLImageElement | null>;
  frame: RefObject<HTMLDivElement | null>;
  state: InspectorState;
  onAddToChat: (element: SimulatorElement, note: string) => Promise<void>;
  onClose: () => void;
}) {
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const { hovered, setHovered, selection, setSelection } = state;
  const { stack, index } = selection;
  const setStack = (next: SimulatorElement[]) =>
    setSelection({ stack: next, index: 0 });
  const setIndex = (next: number) => setSelection({ stack, index: next });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const selected = stack[index];

  // The layer lies exactly over the picture, wherever zoom and scroll put
  // it (a passive effect: the frame around this layer gets its ref last).
  useEffect(() => {
    const image = surface.current;
    const outer = frame.current;
    if (!image || !outer) return;
    const measure = () => {
      const a = image.getBoundingClientRect();
      const b = outer.getBoundingClientRect();
      setBox({
        left: a.left - b.left,
        top: a.top - b.top,
        width: a.width,
        height: a.height,
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(image);
    observer.observe(outer);
    const stage = image.parentElement;
    stage?.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      stage?.removeEventListener("scroll", measure);
    };
  }, [surface, frame]);

  useEffect(() => {
    if (selected) field.current?.focus({ preventScroll: true });
  }, [selected?.path]);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (selected) setStack([]);
      else onClose();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selected, onClose]);

  if (!box) return null;
  const at = (event: { clientX: number; clientY: number }) => {
    const rect = frame.current!.getBoundingClientRect();
    return elementsAt(
      elements,
      (event.clientX - rect.left - box.left) / box.width,
      (event.clientY - rect.top - box.top) / box.height,
    );
  };
  const outline = (element: SimulatorElement, kind: "hover" | "selected") => (
    <span
      key={`${kind}-${element.path}`}
      className={`sim-inspect-box ${kind}`}
      style={{
        left: `${element.frame.x * 100}%`,
        top: `${element.frame.y * 100}%`,
        width: `${element.frame.width * 100}%`,
        height: `${element.frame.height * 100}%`,
      }}
    />
  );
  // The card sits to the element's left when there is room, else its right.
  const cardWidth = 288;
  const card =
    selected &&
    (() => {
      const left = box.left + selected.frame.x * box.width;
      const right = left + selected.frame.width * box.width;
      const top = box.top + selected.frame.y * box.height;
      const outerWidth = frame.current?.clientWidth ?? 0;
      const outerHeight = frame.current?.clientHeight ?? 0;
      const bottom = top + selected.frame.height * box.height;
      const clampY = (y: number) => Math.max(0, Math.min(y, outerHeight - 140));
      if (left - 8 - cardWidth >= 0)
        return { x: left - 8 - cardWidth, y: clampY(top) };
      if (right + 8 + cardWidth <= outerWidth)
        return { x: right + 8, y: clampY(top) };
      // No room beside it: under the element, or over it near the bottom.
      const x = Math.max(0, Math.min(left, outerWidth - cardWidth));
      return {
        x,
        y: bottom + 8 + 140 <= outerHeight ? bottom + 8 : clampY(top - 8 - 140),
      };
    })();
  const add = () => {
    if (!selected || busy) return;
    setBusy(true);
    void onAddToChat(selected, note)
      .then(() => {
        setNote("");
        setStack([]);
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  const title = selected ? elementTitle(selected) : "";
  return (
    <>
      <div
        className="sim-inspect-layer"
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        }}
        onPointerMove={(event) => setHovered(at(event)[0])}
        onPointerLeave={() => setHovered(undefined)}
        onClick={(event) => setStack(at(event))}
      >
        {hovered &&
          hovered.path !== selected?.path &&
          outline(hovered, "hover")}
        {hovered && hovered.path !== selected?.path && (
          <span
            className="sim-inspect-chip"
            style={{
              left: `${hovered.frame.x * 100}%`,
              top: `${hovered.frame.y * 100}%`,
            }}
          >
            {hovered.label
              ? `${hovered.type} "${hovered.label}"`
              : hovered.type}
          </span>
        )}
        {selected && outline(selected, "selected")}
      </div>
      {selected && card && (
        <div
          className="sim-inspect-card"
          role="group"
          aria-label={formatText("Selected element: {title}", { title })}
          style={{ left: card.x, top: card.y, width: cardWidth }}
        >
          <div className="sim-inspect-card-head">
            <span className="sim-inspect-card-title">
              <MousePointer2 size={16} aria-hidden="true" />
              {selected.label || selected.identifier ? (
                <>
                  <strong>{title}</strong>
                  <span>{selected.type}</span>
                </>
              ) : (
                <span>{selected.type || t("Element")}</span>
              )}
            </span>
            <span className="sim-inspect-card-actions">
              <button
                type="button"
                className="sim-inspect-icon"
                aria-label={t("Select the element in front")}
                title={t("Select the element in front")}
                disabled={index === 0}
                onClick={() => setIndex(index - 1)}
              >
                <ChevronUp size={12} />
              </button>
              <button
                type="button"
                className="sim-inspect-icon"
                aria-label={t("Select the element behind")}
                title={t("Select the element behind")}
                disabled={index >= stack.length - 1}
                onClick={() => setIndex(index + 1)}
              >
                <ChevronDown size={12} />
              </button>
              <button
                type="button"
                className="sim-inspect-icon"
                aria-label={t("Close")}
                title={t("Close")}
                onClick={() => setStack([])}
              >
                <X size={12} />
              </button>
            </span>
          </div>
          <textarea
            ref={field}
            rows={2}
            value={note}
            aria-label={t("Your note for Claudex about this element")}
            placeholder={t("Tell Claudex what to change")}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                add();
              }
            }}
          />
          <div className="sim-inspect-card-foot">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={add}
            >
              <Plus size={12} aria-hidden="true" />
              {t("Add to chat")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** An element's properties as rows (the Properties section). */
export function elementProperties(element: SimulatorElement) {
  const rows: [string, string][] = [["Type", element.type]];
  if (element.label) rows.push(["Label", element.label]);
  if (element.value) rows.push(["Value", element.value]);
  if (element.identifier) rows.push(["Identifier", element.identifier]);
  const bounds = element.bounds;
  if (bounds)
    rows.push([
      "Frame",
      `${Math.round(bounds.x)}, ${Math.round(bounds.y)}, ${Math.round(bounds.width)} × ${Math.round(bounds.height)}`,
    ]);
  if (element.enabled !== undefined)
    rows.push(["Enabled", element.enabled ? "Yes" : "No"]);
  return rows;
}

/** Copy info: the properties as lines. */
export function elementInfoText(element: SimulatorElement) {
  return elementProperties(element)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

/**
 * The Inspect panel beside the screen: "Inspect" and Close inspector at the
 * top; "Reading the screen…", the reason it couldn't be read, or "No accessible
 * elements on screen."; the accessibility tree (a row per element, indented by
 * depth, the hovered and selected ones marked); and, for the selected element,
 * the Properties section with Copy info.
 */
export function InspectorPanel({
  elements,
  loading,
  error,
  state,
  onClose,
  onCopy,
}: {
  elements: readonly SimulatorElement[];
  loading: boolean;
  error?: string;
  state: InspectorState;
  onClose: () => void;
  onCopy: (text: string) => void;
}) {
  const { hovered, setHovered, selection, setSelection } = state;
  const selected = selection.stack[selection.index];
  const [copied, setCopied] = useState(false);
  const [nameCopied, setNameCopied] = useState(false);
  useEffect(() => {
    setCopied(false);
    setNameCopied(false);
  }, [selected?.path]);
  const minDepth = Math.min(...elements.map((element) => element.depth), 0);
  return (
    <aside className="sim-inspect-panel" aria-label={t("Inspect")}>
      <div className="sim-inspect-panel-head">
        <span>{t("Inspect")}</span>
        <button
          type="button"
          className="sim-inspect-icon"
          aria-label={t("Close inspector")}
          title={t("Close inspector")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {error && (
        <p className="sim-inspect-panel-error" role="alert">
          {error}
        </p>
      )}
      {loading && !elements.length ? (
        <p className="sim-inspect-panel-note" role="status">
          {t("Reading the screen…")}
        </p>
      ) : !elements.length ? (
        !error && (
          <p className="sim-inspect-panel-note">
            {t("No accessible elements on screen.")}
          </p>
        )
      ) : (
        <div
          className="sim-inspect-tree"
          role="tree"
          aria-label={t("Accessibility tree")}
        >
          {elements.map((element) => (
            <div
              key={element.path}
              role="treeitem"
              aria-selected={selected?.path === element.path}
              data-hovered={hovered?.path === element.path || undefined}
              className="sim-inspect-row"
              style={{
                paddingInlineStart: 8 + (element.depth - minDepth) * 12,
              }}
              onPointerEnter={() => setHovered(element)}
              onPointerLeave={() => setHovered(undefined)}
              onClick={() => setSelection({ stack: [element], index: 0 })}
            >
              <span className="sim-inspect-row-type">{element.type}</span>
              {element.label && (
                <span className="sim-inspect-row-name">"{element.label}"</span>
              )}
            </div>
          ))}
        </div>
      )}
      {selected && (
        <section
          className="sim-inspect-properties"
          aria-label={t("Properties")}
        >
          <div className="sim-inspect-properties-head">
            <span>{t("Properties")}</span>
            <button
              type="button"
              className="sim-inspect-text-button"
              onClick={() => {
                onCopy(elementInfoText(selected));
                setCopied(true);
              }}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
              {copied ? t("Copied") : t("Copy info")}
            </button>
          </div>
          <div className="sim-inspect-properties-head">
            <span>{elementTitle(selected)}</span>
            <button
              type="button"
              className="sim-inspect-icon"
              aria-label={nameCopied ? t("Copied") : t("Copy name")}
              title={nameCopied ? t("Copied") : t("Copy name")}
              onClick={() => {
                onCopy(elementTitle(selected));
                setNameCopied(true);
              }}
            >
              {nameCopied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <dl>
            {elementProperties(selected).map(([name, value]) => (
              <div key={name}>
                <dt>{t(name)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </aside>
  );
}
