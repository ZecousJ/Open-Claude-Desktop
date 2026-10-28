import {
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  Circle,
  EyeOff,
  Minus,
  MoveUpRight,
  Pencil,
  Square,
  Type,
} from "../ui/glyphs";
import type { SimulatorAnnotateCapture } from "../../shared/simulators";
import {
  emptyHistory,
  inkColors,
  isEmptyMark,
  textMeasurer,
  type Box,
  type EditorTool,
  type HandleId,
  type HitOptions,
  type Mark,
  type MeasureText,
  type Point,
  type RedactStyle,
  type SketchHistory,
  type SketchTool,
  type TextMark,
} from "./annotate-sketch";
import "./annotate-image.css";
import { useAnnotateImageActions } from "./useAnnotateImageActions";

export const toolIcons: Record<SketchTool, ReactNode> = {
  pen: <Pencil size={16} />,
  line: <Minus size={16} style={{ transform: "rotate(-45deg)" }} />,
  arrow: <MoveUpRight size={16} />,
  rect: <Square size={16} />,
  ellipse: <Circle size={16} />,
  text: <Type size={16} />,
  redact: <EyeOff size={16} />,
};

/*
 * Canvas cursors: Pen shows a filled pencil, dark with a white outline, its tip
 * on the pointer; Redact over a word it can cover shows a struck-out eye, dark
 * over a wide white stroke, centred. Drawn from the icons the toolbar uses
 * (lucide).
 */
const svgCursor = (svg: string, hotspot: string, fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspot}, ${fallback}`;
export const penCursor = svgCursor(
  "<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' fill='#1f1e1d' stroke='#fff' stroke-width='1.67' stroke-linejoin='round' paint-order='stroke'/></svg>",
  "2 22",
  "crosshair",
);
const eyeOffPaths =
  "<path d='M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49'/><path d='M14.084 14.158a3 3 0 0 1-4.242-4.242'/><path d='M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143'/><path d='m2 2 20 20'/>";
export const redactCursor = svgCursor(
  `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='-2 -2 28 28' fill='none' stroke-linecap='round' stroke-linejoin='round'><g stroke='#fff' stroke-width='3.5'>${eyeOffPaths}</g><g stroke='#1f1e1d' stroke-width='1.5'>${eyeOffPaths}</g></svg>`,
  "12 12",
  "crosshair",
);

export const pngBytes = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("The picture couldn’t be made."));
      blob
        .arrayBuffer()
        .then((buffer) => resolve(new Uint8Array(buffer)), reject);
    }, "image/png"),
  );

/** A press on a mark: a move (no handle) or a handle being dragged. */
export interface Drag {
  pointerId: number;
  coarse: boolean;
  handle: HandleId | null;
  /** Where the press took hold: the handle itself, or the pointer. */
  grip: Point;
  start: Point;
  item: Mark;
  current: Mark;
  moved: boolean;
  dx: number;
  dy: number;
}

/** A text label being typed, new or `editing` one already there. */
export interface Typing {
  at: Point;
  shown: Point;
  size: number;
  color: string;
  editing: TextMark | null;
}

/** A drag counts only when it changed something that still has a size. */
export const dragChanged = (drag: Drag) =>
  drag.moved &&
  (drag.dx !== 0 || drag.dy !== 0) &&
  drag.current !== drag.item &&
  !(
    drag.handle !== null &&
    drag.current.kind !== "text" &&
    drag.current.kind !== "pen" &&
    isEmptyMark(drag.current)
  );

/**
 * Annotate: the picture over 62.5% black, at most 40rem wide and the window's
 * height less 4rem, with the marks drawn on it; a floating bar 24px above the
 * bottom with the tools, the ink colours (or, for Redact, the redaction
 * styles), Undo, Redo, Clear all, Close and Add to chat. Closing with marks
 * asks "Discard your annotations?" first. Add to chat flattens the marks into
 * the picture.
 *
 * A finished shape, line, arrow, text or redaction leaves its tool for Select
 * with the new mark chosen; clicking the chosen tool again does the same.
 * Select picks marks up (pen strokes stay put): drag to move, drag a handle to
 * resize or move an end, drag a line's middle handle to bend it, pick an ink or
 * style to change it, Delete removes it, Escape lets it go, and a double-click
 * edits text. With Redact, a click on a word covers it.
 */
export default function AnnotateImage({
  capture,
  onAdd,
  onError,
  onClose,
}: {
  capture: SimulatorAnnotateCapture;
  /**
   * Keeps the annotated PNG as an attachment; rejects (after saying why)
   * when it can't, and the editor stays open.
   */
  onAdd: (png: Uint8Array) => Promise<void>;
  onError: (text: string) => void;
  onClose: () => void;
}) {
  const [tool, setTool] = useState<EditorTool>("pen");
  const [color, setColor] = useState(inkColors[0].value);
  const [redactStyle, setRedactStyle] = useState<RedactStyle>("solid");
  const [history, setHistory] = useState<SketchHistory>(emptyHistory);
  const [selected, setSelected] = useState<Mark | null>(null);
  const [typing, setTyping] = useState<Typing | null>(null);
  const [text, setText] = useState("");
  const [concealed, setConcealed] = useState(false);
  const [selectCursor, setSelectCursor] = useState("default");
  const [overTarget, setOverTarget] = useState(false);
  const [targets, setTargets] = useState<Box[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  /* The pointer handlers read and write these between renders. */
  const historyRef = useRef(history);
  const selectedRef = useRef<Mark | null>(null);
  const typingRef = useRef<Typing | null>(null);
  const textRef = useRef("");
  const draftRef = useRef<Mark | null>(null);
  const draftPointer = useRef<number | null>(null);
  const gestureRef = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const revealRef = useRef<{ mark: Mark; progress: number } | null>(null);
  const revealFrame = useRef(0);
  const measureRef = useRef<MeasureText | null>(null);
  const selectOnEdit = useRef(false);
  const detecting = useRef(false);

  const marks = history.present;
  const hasMarks = marks.length > 0;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  /** The picture's pixels per shown pixel. */
  const scale = () => {
    const shown = canvas.current?.getBoundingClientRect().width;
    return shown ? capture.width / shown : 1;
  };
  const measure = () =>
    (measureRef.current ??= textMeasurer(
      canvas.current?.getContext("2d") ?? null,
    ));
  const hitOptions = (
    event: ReactPointerEvent | ReactMouseEvent,
  ): HitOptions => ({
    scale: scale(),
    coarse: "pointerType" in event && event.pointerType === "touch",
    measure: measure(),
  });
  const { annotateImageViewView } = useAnnotateImageActions({
    canRedo,
    canUndo,
    canvas,
    capture,
    color,
    concealed,
    confirming,
    detecting,
    draftPointer,
    draftRef,
    dragRef,
    field,
    gestureRef,
    hasMarks,
    historyRef,
    hitOptions,
    image,
    measure,
    onAdd,
    onClose,
    onError,
    overTarget,
    redactStyle,
    revealFrame,
    revealRef,
    root,
    saving,
    scale,
    selectCursor,
    selectOnEdit,
    selected,
    selectedRef,
    setColor,
    setConcealed,
    setConfirming,
    setHistory,
    setOverTarget,
    setRedactStyle,
    setSaving,
    setSelectCursor,
    setSelected,
    setTargets,
    setText,
    setTool,
    setTyping,
    targets,
    text,
    textRef,
    tool,
    typing,
    typingRef,
  });
  return annotateImageViewView;
}
