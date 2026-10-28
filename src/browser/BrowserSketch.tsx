import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Circle,
  EyeOff,
  Minus,
  MoveUpRight,
  Pencil,
  Redo2,
  Square,
  Type,
  Undo2,
  Trash2,
} from "../ui/glyphs";
import { Modal } from "../ui/Controls";
import { useTooltip } from "../ui/Tooltip";
import {
  addMark,
  clearAll,
  drawMark,
  emptyHistory,
  inkColors,
  redactStyleLabels,
  redactStyles,
  redo,
  sketchTools,
  textFont,
  textSize,
  toolLabels,
  undo,
  type Mark,
  type Point,
  type RedactStyle,
  type SketchHistory,
  type SketchTool,
} from "../simulators/annotate-sketch";
import { strokeWidth } from "../simulators/annotate-geometry";
import { sketchKeyCommand, sketchAttachmentName } from "./browser-sketch-model";
import "../simulators/annotate-image.css";
import "./browser-sketch.css";

/** The page as it was when sketch mode started: a PNG and its pixel size. */
export interface SketchBackdrop {
  dataUrl: string;
  /** The picture's own pixels. */
  width: number;
  height: number;
  /** Device pixels per CSS pixel when it was taken (the page's scale). */
  scale: number;
}

/** What the Browser panel asks of an open sketch. */
export interface SketchHandle {
  hasMarks(): boolean;
  /** Ends sketch mode, asking first when marks would be lost. */
  requestClose(): void;
}

const toolIcons: Record<SketchTool, ReactNode> = {
  pen: <Pencil size={16} />,
  line: <Minus size={16} style={{ transform: "rotate(-45deg)" }} />,
  arrow: <MoveUpRight size={16} />,
  rect: <Square size={16} />,
  ellipse: <Circle size={16} />,
  text: <Type size={16} />,
  redact: <EyeOff size={16} />,
};

/** The swatch of a redaction style: black, or a small grid of greys. */
function styleSwatch(style: RedactStyle) {
  if (style === "solid") return "#000000";
  const cells = style === "mosaic" ? 3 : 7;
  const greys =
    style === "mosaic"
      ? ["#4a4a4a", "#bdbdbd", "#7c7c7c", "#a3a3a3", "#5e5e5e"]
      : ["#1e1e1e", "#e2e2e2", "#6a6a6a", "#b8b8b8", "#3c3c3c", "#8e8e8e"];
  const size = 14 / cells;
  let rects = "";
  for (let i = 0; i < cells * cells; i++)
    rects += `<rect x='${(i % cells) * size}' y='${Math.floor(i / cells) * size}' width='${size}' height='${size}' fill='${greys[(i * 7 + (i >> 2)) % greys.length]}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'>${rects}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0 / cover`;
}

function ToolButton({
  label,
  pressed,
  disabled,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  shortcut?: string[];
  onClick: () => void;
  children: ReactNode;
}) {
  const { props, tooltip } = useTooltip(label, {
    shortcut,
    placement: "above",
  });
  return (
    <>
      <button
        {...props}
        type="button"
        className={`icon-button annotate-tool ${pressed ? "active" : ""}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
      {tooltip}
    </>
  );
}

function Swatch({
  label,
  fill,
  active,
  square,
  onPick,
}: {
  label: string;
  fill: string;
  active: boolean;
  square: boolean;
  onPick: () => void;
}) {
  const { props, tooltip } = useTooltip(label, { placement: "above" });
  return (
    <>
      <button
        {...props}
        type="button"
        className={`annotate-swatch ${square ? "square" : ""}`}
        aria-label={label}
        aria-pressed={active}
        onClick={onPick}
      >
        <span
          aria-hidden="true"
          className={`annotate-swatch-fill ${active ? "active" : ""} ${fill === "#FFFFFF" ? "light" : ""}`}
          style={{ background: fill }}
        />
      </button>
      {tooltip}
    </>
  );
}

const pngBytes = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("The picture couldn’t be made."));
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png"),
  );

/**
 * Sketch mode on the Browser's page: the page stands still as the picture taken
 * when it started, at its own size from the top, with the marks drawn over it
 * and, in a strip under it, the sketch bar 10px above the bottom: the tools,
 * the inks (or the redaction styles), Undo ⌘Z, Redo ⇧⌘Z, Clear all, Close and
 * Add to chat. Add to chat flattens the marks into the picture and attaches it
 * ("preview-annotation.png", or the plain "preview-screenshot.png" when nothing
 * was drawn); Esc or Close with marks asks "Discard your annotations?" first.
 */
export function BrowserSketch({
  backdrop,
  handle,
  platform,
  onAttach,
  onError,
  onClose,
}: {
  backdrop: SketchBackdrop;
  /** Filled while the sketch is open, for the panel's ⇧⌘X and Annotate button. */
  handle?: RefObject<SketchHandle | null>;
  /** The snapshot platform ("darwin"): Ctrl+Y also redoes elsewhere. */
  platform?: string;
  /** Keeps the PNG as an attachment; rejects (after saying why) when it can't. */
  onAttach: (png: Uint8Array, name: string) => Promise<void>;
  onError: (text: string) => void;
  onClose: () => void;
}) {
  const [tool, setTool] = useState<SketchTool>("pen");
  const [color, setColor] = useState(inkColors[0].value);
  const [redactStyle, setRedactStyle] = useState<RedactStyle>("solid");
  const [history, setHistory] = useState<SketchHistory>(emptyHistory);
  const [draft, setDraft] = useState<Mark | null>(null);
  const [typing, setTyping] = useState<{ at: Point; shown: Point } | null>(
    null,
  );
  const [text, setText] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const root = useRef<HTMLDivElement>(null);

  const marks = history.present;
  const hasMarks = marks.length > 0;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;
  const shown = {
    width: backdrop.width / backdrop.scale,
    height: backdrop.height / backdrop.scale,
  };

  /** The picture's pixels per shown pixel. */
  const ratio = () => {
    const width = canvas.current?.getBoundingClientRect().width;
    return width ? backdrop.width / width : backdrop.scale;
  };

  useLayoutEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, backdrop.width, backdrop.height);
    const scale = ratio();
    for (const mark of marks) drawMark(ctx, mark, scale);
    if (draft) drawMark(ctx, draft, scale);
  });

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const requestClose = useCallback(() => {
    if (hasMarks) setConfirming(true);
    else onClose();
  }, [hasMarks, onClose]);

  const latest = useRef({ hasMarks, requestClose });
  latest.current = { hasMarks, requestClose };
  useEffect(() => {
    if (!handle) return;
    handle.current = {
      hasMarks: () => latest.current.hasMarks,
      requestClose: () => latest.current.requestClose(),
    };
    return () => {
      handle.current = null;
    };
  }, [handle]);

  // Esc with the focus nowhere in particular (the page's body) ends the
  // sketch too, as the original's document listener does.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      const target = event.target as Node | null;
      if (target !== document.body && target !== document.documentElement)
        return;
      if (document.querySelector('[role="alertdialog"],[aria-modal="true"]'))
        return;
      event.preventDefault();
      if (!event.repeat) latest.current.requestClose();
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  const point = (event: ReactPointerEvent): Point => {
    const area = canvas.current!.getBoundingClientRect();
    const scale = backdrop.width / area.width;
    return {
      x: (event.clientX - area.left) * scale,
      y: (event.clientY - area.top) * scale,
    };
  };

  const commitText = () => {
    if (typing && text.trim())
      setHistory((current) =>
        addMark(current, {
          kind: "text",
          color,
          size: textSize * ratio(),
          at: typing.at,
          text: text.trimEnd(),
        }),
      );
    setTyping(null);
    setText("");
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const at = point(event);
    if (tool === "text") {
      if (typing) return commitText();
      const area = canvas.current!.getBoundingClientRect();
      setTyping({
        at,
        shown: { x: event.clientX - area.left, y: event.clientY - area.top },
      });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = strokeWidth * ratio();
    setDraft(
      tool === "pen"
        ? { kind: "pen", color, width, points: [at] }
        : tool === "redact"
          ? { kind: "redact", style: redactStyle, from: at, to: at }
          : { kind: tool, color, width, from: at, to: at },
    );
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!draft) return;
    const at = point(event);
    setDraft(
      draft.kind === "pen"
        ? { ...draft, points: [...draft.points, at] }
        : draft.kind === "text"
          ? draft
          : { ...draft, to: at },
    );
  };
  const onPointerUp = () => {
    if (!draft) return;
    const done = draft;
    setDraft(null);
    setHistory((current) => addMark(current, done));
  };

  const add = async () => {
    if (saving) return;
    setSaving(true);
    let png: Uint8Array;
    try {
      const flat = document.createElement("canvas");
      flat.width = backdrop.width;
      flat.height = backdrop.height;
      const ctx = flat.getContext("2d");
      const picture = image.current;
      if (!ctx || !picture) throw new Error("No canvas.");
      if (!picture.complete) await picture.decode();
      ctx.drawImage(picture, 0, 0, backdrop.width, backdrop.height);
      const scale = ratio();
      for (const mark of marks) drawMark(ctx, mark, scale);
      png = await pngBytes(flat);
    } catch {
      setSaving(false);
      onError("Couldn’t save your annotations. Try again.");
      return;
    }
    try {
      await onAttach(png, sketchAttachmentName(hasMarks));
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (confirming || typing) return;
    const command = sketchKeyCommand(event, platform);
    if (!command) return;
    event.preventDefault();
    event.stopPropagation();
    if (command === "undo") setHistory(undo);
    else if (command === "redo") setHistory(redo);
    // No mark can be selected here, so Esc ends the sketch and ⌫ does nothing.
    else if (command === "deselect" && !event.repeat) requestClose();
  };

  const redacting = tool === "redact";
  return (
    <div
      ref={root}
      className="browser-sketch"
      role="dialog"
      aria-label="Annotate page in Browser"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="browser-sketch-page">
        <div className="browser-sketch-stage" style={shown}>
          <img
            ref={image}
            src={backdrop.dataUrl}
            alt=""
            draggable={false}
            className="browser-sketch-picture"
          />
          <canvas
            ref={canvas}
            width={backdrop.width}
            height={backdrop.height}
            className={`annotate-canvas ${tool === "text" ? "text" : ""}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {typing && (
            <textarea
              autoFocus
              className="annotate-text-field"
              aria-label={toolLabels.text}
              value={text}
              rows={Math.max(1, text.split("\n").length)}
              style={{
                left: typing.shown.x,
                top: typing.shown.y,
                color,
                font: `${textSize}px ${textFont}`,
              }}
              onChange={(event) => setText(event.target.value)}
              onBlur={commitText}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Escape") {
                  setTyping(null);
                  setText("");
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commitText();
                }
              }}
            />
          )}
        </div>
      </div>
      <div className="browser-sketch-strip">
        <div className="annotate-bar">
          <div
            role="group"
            aria-label="Annotation tool"
            className="annotate-group"
          >
            {sketchTools.map((each) => (
              <ToolButton
                key={each}
                label={toolLabels[each]}
                pressed={tool === each}
                onClick={() => {
                  if (typing) commitText();
                  setTool(each);
                }}
              >
                {toolIcons[each]}
              </ToolButton>
            ))}
          </div>
          <span className="annotate-divider" aria-hidden="true" />
          <div
            role="group"
            aria-label={redacting ? "Redaction style" : "Ink color"}
            className="annotate-group annotate-swatches"
          >
            {redacting
              ? redactStyles.map((style) => (
                  <Swatch
                    key={style}
                    label={redactStyleLabels[style]}
                    fill={styleSwatch(style)}
                    active={style === redactStyle}
                    square
                    onPick={() => setRedactStyle(style)}
                  />
                ))
              : inkColors.map((ink) => (
                  <Swatch
                    key={ink.value}
                    label={ink.label}
                    fill={ink.value}
                    active={ink.value === color}
                    square={false}
                    onPick={() => setColor(ink.value)}
                  />
                ))}
          </div>
          <span className="annotate-divider" aria-hidden="true" />
          <div className="annotate-group">
            <ToolButton
              label={canUndo ? "Undo" : "Nothing to undo yet"}
              shortcut={["mod", "Z"]}
              disabled={!canUndo}
              onClick={() => setHistory(undo)}
            >
              <Undo2 size={16} />
            </ToolButton>
            <ToolButton
              label={canRedo ? "Redo" : "Nothing to redo yet"}
              shortcut={["shift", "mod", "Z"]}
              disabled={!canRedo}
              onClick={() => setHistory(redo)}
            >
              <Redo2 size={16} />
            </ToolButton>
            <ToolButton
              label={hasMarks ? "Clear all" : "Nothing to clear yet"}
              disabled={!hasMarks}
              onClick={() => setHistory(clearAll)}
            >
              <Trash2 size={16} />
            </ToolButton>
          </div>
          <button
            type="button"
            className="annotate-close"
            onClick={requestClose}
          >
            Close
          </button>
          <button
            type="button"
            className="primary annotate-add"
            disabled={saving}
            onClick={() => void add()}
          >
            Add to chat
          </button>
        </div>
      </div>
      {confirming && (
        <Modal
          title="Discard your annotations?"
          variant="confirm"
          confirmFocus="cancel"
          onClose={() => setConfirming(false)}
        >
          <p className="confirm-body">
            You have unsaved marks on this image. Discarding removes them.
          </p>
          <div className="button-row">
            <button className="secondary" onClick={() => setConfirming(false)}>
              Keep editing
            </button>
            <button className="primary danger-button" onClick={onClose}>
              Discard
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
