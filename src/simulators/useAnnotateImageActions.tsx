import { useCallback, useLayoutEffect, useEffect } from "react";
import {
  drawMark,
  isEmptyMark,
  drawSelection,
  removeMark,
  replaceMark,
  addMark,
  isSelectable,
  revealProgress,
  revealDuration,
  textSize,
  moveThreshold,
  moveMark,
  gestureThreshold,
  redo,
  undo,
} from "./annotate-sketch";
import type {
  SketchHistory,
  Mark,
  Point,
  EditorTool,
  TextMark,
  RedactStyle,
  HitOptions,
  MeasureText,
  Box,
} from "./annotate-sketch";
import type { Typing, Drag } from "./AnnotateImage";
import type {
  PointerEvent as ReactPointerEvent,
  MouseEvent as ReactMouseEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  handleAt,
  markAt,
  clampMove,
  resizeText,
  dragHandle,
  textTargetAt,
  constrainPoint,
  targetRedaction,
} from "./annotate-hit";
import { strokeWidth } from "./annotate-geometry";
import {
  dragChanged,
  pngBytes,
  penCursor,
  redactCursor,
} from "./AnnotateImage";
import { annotateImageView } from "./AnnotateImageView";
import type { SimulatorAnnotateCapture } from "../../shared/simulators";

/** What useAnnotateImageActions needs from AnnotateImage.tsx. */
export interface UseAnnotateImageActionsKit {
  canRedo: boolean;
  canUndo: boolean;
  canvas: React.RefObject<HTMLCanvasElement | null>;
  capture: SimulatorAnnotateCapture;
  color: string;
  concealed: boolean;
  confirming: boolean;
  detecting: React.RefObject<boolean>;
  draftPointer: React.RefObject<number | null>;
  draftRef: React.RefObject<Mark | null>;
  dragRef: React.RefObject<Drag | null>;
  field: React.RefObject<HTMLTextAreaElement | null>;
  gestureRef: React.RefObject<boolean>;
  hasMarks: boolean;
  historyRef: React.RefObject<SketchHistory>;
  hitOptions: (
    event: React.PointerEvent<Element> | React.MouseEvent<Element, MouseEvent>,
  ) => HitOptions;
  image: React.RefObject<HTMLImageElement | null>;
  measure: () => MeasureText;
  onAdd: (png: Uint8Array<ArrayBufferLike>) => Promise<void>;
  onClose: () => void;
  onError: (text: string) => void;
  overTarget: boolean;
  redactStyle: RedactStyle;
  revealFrame: React.RefObject<number>;
  revealRef: React.RefObject<{ mark: Mark; progress: number } | null>;
  root: React.RefObject<HTMLDivElement | null>;
  saving: boolean;
  scale: () => number;
  selectCursor: string;
  selectOnEdit: React.RefObject<boolean>;
  selected: Mark | null;
  selectedRef: React.RefObject<Mark | null>;
  setColor: React.Dispatch<React.SetStateAction<string>>;
  setConcealed: React.Dispatch<React.SetStateAction<boolean>>;
  setConfirming: React.Dispatch<React.SetStateAction<boolean>>;
  setHistory: React.Dispatch<React.SetStateAction<SketchHistory>>;
  setOverTarget: React.Dispatch<React.SetStateAction<boolean>>;
  setRedactStyle: React.Dispatch<React.SetStateAction<RedactStyle>>;
  setSaving: React.Dispatch<React.SetStateAction<boolean>>;
  setSelectCursor: React.Dispatch<React.SetStateAction<string>>;
  setSelected: React.Dispatch<React.SetStateAction<Mark | null>>;
  setTargets: React.Dispatch<React.SetStateAction<Box[] | null>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  setTool: React.Dispatch<React.SetStateAction<EditorTool>>;
  setTyping: React.Dispatch<React.SetStateAction<Typing | null>>;
  targets: Box[] | null;
  text: string;
  textRef: React.RefObject<string>;
  tool: EditorTool;
  typing: Typing | null;
  typingRef: React.RefObject<Typing | null>;
}

export function useAnnotateImageActions(kit: UseAnnotateImageActionsKit) {
  const {
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
  } = kit;
  const paint = useCallback(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, capture.width, capture.height);
    const ratio = scale();
    const drag = dragRef.current;
    const reveal = revealRef.current;
    const editing = typingRef.current?.editing;
    for (const mark of historyRef.current.present) {
      if (mark === editing) continue;
      drawMark(
        ctx,
        drag?.item === mark ? drag.current : mark,
        ratio,
        reveal?.mark === mark ? reveal.progress : 1,
      );
    }
    const draft = draftRef.current;
    if (draft && (draft.kind === "pen" || !isEmptyMark(draft)))
      drawMark(ctx, draft, ratio);
    const chosen = selectedRef.current;
    if (chosen)
      drawSelection(
        ctx,
        drag?.item === chosen ? drag.current : chosen,
        ratio,
        measure(),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capture.width, capture.height]);

  useLayoutEffect(paint);

  useEffect(() => {
    root.current?.focus();
    return () => cancelAnimationFrame(revealFrame.current);
  }, []);

  /* Redact looks for the words on the picture the first time it is chosen. */
  useEffect(() => {
    if (tool !== "redact" || targets || detecting.current) return;
    detecting.current = true;
    let live = true;
    void import("./annotate-text-targets")
      .then(({ detectTextTargets }) => detectTextTargets(capture.dataUrl))
      .catch(() => null)
      .then((found) => {
        if (live) setTargets(found ?? []);
      });
    return () => {
      live = false;
      detecting.current = false;
    };
  }, [tool, targets, capture.dataUrl]);

  useLayoutEffect(() => {
    if (typing?.editing && selectOnEdit.current) {
      selectOnEdit.current = false;
      field.current?.select();
    }
  }, [typing]);

  const apply = (next: SketchHistory) => {
    historyRef.current = next;
    setHistory(next);
  };

  const select = (mark: Mark | null) => {
    selectedRef.current = mark;
    setSelected(mark);
    if (mark?.kind === "redact") setRedactStyle(mark.style);
  };

  const openTyping = (next: Typing | null, value = "") => {
    typingRef.current = next;
    setTyping(next);
    textRef.current = value;
    setText(value);
  };

  const requestClose = useCallback(() => {
    if (historyRef.current.present.length) setConfirming(true);
    else onClose();
  }, [onClose]);

  const point = (event: ReactPointerEvent | ReactMouseEvent): Point => {
    const area = canvas.current!.getBoundingClientRect();
    const ratio = capture.width / area.width;
    return {
      x: (event.clientX - area.left) * ratio,
      y: (event.clientY - area.top) * ratio,
    };
  };

  /** Keeps what is typed; returns the label it made or changed. */
  const commitText = (): Mark | null => {
    const open = typingRef.current;
    if (!open) return null;
    const value = textRef.current.trimEnd();
    openTyping(null);
    const current = historyRef.current;
    if (open.editing) {
      const old = open.editing;
      if (!current.present.includes(old)) return null;
      if (!value) {
        apply(removeMark(current, old));
        return null;
      }
      if (value !== old.text.trimEnd()) {
        const next: Mark = { ...old, text: value };
        apply(replaceMark(current, old, next));
        return next;
      }
      paint();
      return old;
    }
    if (!value) return null;
    const mark: Mark = {
      kind: "text",
      color: open.color,
      size: open.size,
      at: open.at,
      text: value,
    };
    apply(addMark(current, mark));
    return mark;
  };

  const cancelDrag = () => {
    if (!dragRef.current) return false;
    dragRef.current = null;
    setConcealed(false);
    setSelectCursor("grab");
    paint();
    return true;
  };

  const changeTool = (next: EditorTool) => {
    if (next !== "text") commitText();
    if (next !== "select") {
      dragRef.current = null;
      select(null);
      setConcealed(false);
      setSelectCursor("default");
    }
    setOverTarget(false);
    setTool(next);
  };

  /** A finished shape leaves its tool for Select, the mark chosen. */
  const toolDone = (mark: Mark | null) => {
    changeTool("select");
    if (mark && isSelectable(mark)) select(mark);
  };

  const editText = (mark: TextMark) => {
    dragRef.current = null;
    select(null);
    const ratio = scale();
    selectOnEdit.current = true;
    openTyping(
      {
        at: mark.at,
        shown: { x: mark.at.x / ratio, y: mark.at.y / ratio },
        size: mark.size,
        color: mark.color,
        editing: mark,
      },
      mark.text,
    );
  };

  const reveal = (mark: Mark) => {
    cancelAnimationFrame(revealFrame.current);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const state = { mark, progress: 0 };
    revealRef.current = state;
    const started = performance.now();
    const step = (now: number) => {
      if (revealRef.current !== state) return;
      state.progress = revealProgress(now - started);
      if (now - started >= revealDuration) revealRef.current = null;
      else revealFrame.current = requestAnimationFrame(step);
      paint();
    };
    revealFrame.current = requestAnimationFrame(step);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const at = point(event);
    const options = hitOptions(event);
    if (tool === "select") {
      commitText();
      const held = dragRef.current;
      if (held) {
        if (event.pointerId !== held.pointerId) return;
        dragRef.current = null;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      const current = selectedRef.current;
      const handle = current ? handleAt(current, at, options) : null;
      const item =
        handle && current
          ? current
          : markAt(historyRef.current.present, at, options);
      select(item);
      if (item) {
        dragRef.current = {
          pointerId: event.pointerId,
          coarse: !!options.coarse,
          handle: handle?.id ?? null,
          grip: handle ? { x: handle.x, y: handle.y } : at,
          start: at,
          item,
          current: item,
          moved: false,
          dx: 0,
          dy: 0,
        };
        setSelectCursor(handle ? handle.cursor : "grabbing");
      }
      paint();
      return;
    }
    if (tool === "text") {
      event.preventDefault();
      const label = markAt(historyRef.current.present, at, {
        ...options,
        textOnly: true,
      });
      if (label?.kind === "text") {
        commitText();
        editText(label);
        return;
      }
      if (typingRef.current) {
        const done = commitText();
        root.current?.focus({ preventScroll: true });
        toolDone(done);
        return;
      }
      const area = canvas.current!.getBoundingClientRect();
      openTyping({
        at,
        shown: { x: event.clientX - area.left, y: event.clientY - area.top },
        size: textSize * options.scale,
        color,
        editing: null,
      });
      return;
    }
    if (draftRef.current && event.pointerId !== draftPointer.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    draftPointer.current = event.pointerId;
    const width = strokeWidth * options.scale;
    draftRef.current =
      tool === "pen"
        ? { kind: "pen", color, width, points: [at] }
        : tool === "redact"
          ? { kind: "redact", style: redactStyle, from: at, to: at }
          : { kind: tool, color, width, from: at, to: at };
    paint();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const ratio = scale();
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      const at = point(event);
      const dx = at.x - drag.start.x;
      const dy = at.y - drag.start.y;
      if (
        !drag.moved &&
        Math.hypot(dx, dy) < moveThreshold(drag.coarse) * ratio
      )
        return;
      if (!drag.moved) setConcealed(true);
      drag.moved = true;
      drag.dx = dx;
      drag.dy = dy;
      const grip = { x: drag.grip.x + dx, y: drag.grip.y + dy };
      if (drag.handle === null) {
        const fitted = clampMove(
          drag.item,
          dx,
          dy,
          { width: capture.width, height: capture.height },
          measure(),
        );
        drag.dx = fitted.dx;
        drag.dy = fitted.dy;
        drag.current = moveMark(drag.item, fitted.dx, fitted.dy);
      } else
        drag.current =
          drag.item.kind === "text"
            ? resizeText(drag.item, drag.handle, grip, measure(), ratio)
            : dragHandle(drag.item, drag.handle, grip, {
                shift: event.shiftKey,
                scale: ratio,
              });
      paint();
      return;
    }
    if (tool === "select") {
      const at = point(event);
      const options = hitOptions(event);
      const current = selectedRef.current;
      const handle = current ? handleAt(current, at, options) : null;
      setSelectCursor(
        handle
          ? handle.cursor
          : markAt(historyRef.current.present, at, options)
            ? "grab"
            : "default",
      );
      return;
    }
    const draft = draftRef.current;
    if (tool === "redact" && !draft)
      setOverTarget(!!targets && !!textTargetAt(targets, point(event)));
    if (!draft || event.pointerId !== draftPointer.current) return;
    const at = point(event);
    const reach = gestureThreshold(event.pointerType === "touch") * ratio;
    if (draft.kind === "pen") {
      draft.points.push(at);
      if (
        !gestureRef.current &&
        Math.hypot(at.x - draft.points[0].x, at.y - draft.points[0].y) >= reach
      ) {
        gestureRef.current = true;
        setConcealed(true);
      }
    } else if (draft.kind !== "text") {
      const to = constrainPoint(draft.kind, draft.from, at, event.shiftKey);
      draftRef.current = { ...draft, to };
      if (
        !gestureRef.current &&
        Math.hypot(to.x - draft.from.x, to.y - draft.from.y) >= reach
      ) {
        gestureRef.current = true;
        setConcealed(true);
      }
    }
    paint();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      dragRef.current = null;
      setConcealed(false);
      if (drag.handle === null) setSelectCursor("grab");
      if (dragChanged(drag)) {
        apply(replaceMark(historyRef.current, drag.item, drag.current));
        select(drag.current);
      }
      paint();
      return;
    }
    const draft = draftRef.current;
    if (!draft || event.pointerId !== draftPointer.current) return;
    const ratio = scale();
    const coarse = event.pointerType === "touch";
    const travelled =
      gestureRef.current ||
      (draft.kind !== "pen" &&
        draft.kind !== "text" &&
        Math.hypot(draft.to.x - draft.from.x, draft.to.y - draft.from.y) >=
          gestureThreshold(coarse) * ratio);
    gestureRef.current = false;
    setConcealed(false);
    draftRef.current = null;
    draftPointer.current = null;
    if (
      draft.kind === "redact" &&
      !travelled &&
      event.type === "pointerup" &&
      targets
    ) {
      const target = textTargetAt(targets, draft.from);
      if (target) {
        setOverTarget(false);
        const mark = targetRedaction(target, draft.style, ratio);
        apply(addMark(historyRef.current, mark));
        reveal(mark);
        toolDone(mark);
        return;
      }
    }
    if (draft.kind !== "pen" && isEmptyMark(draft)) {
      paint();
      return;
    }
    apply(addMark(historyRef.current, draft));
    if (draft.kind !== "pen") toolDone(draft);
  };

  /** A lost pointer drops a move; a drawing in progress is kept. */
  const onPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) {
      if (event.pointerId === drag.pointerId) {
        dragRef.current = null;
        setConcealed(false);
        setSelectCursor("default");
        paint();
      }
      return;
    }
    onPointerUp(event);
  };

  const onDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (tool !== "select" || typingRef.current) return;
    const label = markAt(historyRef.current.present, point(event), {
      ...hitOptions(event),
      textOnly: true,
    });
    if (label?.kind !== "text") return;
    event.preventDefault();
    editText(label);
  };

  const historyStep = (step: (history: SketchHistory) => SketchHistory) => {
    if (dragRef.current || draftRef.current) return;
    commitText();
    select(null);
    apply(step(historyRef.current));
  };

  const pickColor = (next: string) => {
    setColor(next);
    const chosen = selectedRef.current;
    if (!chosen || dragRef.current || chosen.kind === "redact") return;
    if (chosen.color === next) return;
    const recolored = { ...chosen, color: next } as Mark;
    apply(replaceMark(historyRef.current, chosen, recolored));
    select(recolored);
  };

  const pickStyle = (next: RedactStyle) => {
    setRedactStyle(next);
    const chosen = selectedRef.current;
    if (chosen?.kind !== "redact" || dragRef.current || chosen.style === next)
      return;
    const restyled: Mark = { ...chosen, style: next };
    apply(replaceMark(historyRef.current, chosen, restyled));
    select(restyled);
  };

  const add = async () => {
    if (saving || !hasMarks) return;
    commitText();
    setSaving(true);
    let png: Uint8Array;
    try {
      const flat = document.createElement("canvas");
      flat.width = capture.width;
      flat.height = capture.height;
      const ctx = flat.getContext("2d");
      const picture = image.current;
      if (!ctx || !picture) throw new Error("No canvas.");
      if (!picture.complete) await picture.decode();
      ctx.drawImage(picture, 0, 0, capture.width, capture.height);
      const ratio = scale();
      for (const mark of historyRef.current.present) drawMark(ctx, mark, ratio);
      png = await pngBytes(flat);
    } catch {
      setSaving(false);
      onError("Couldn’t save your annotations. Try again.");
      return;
    }
    try {
      await onAdd(png);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (confirming || typingRef.current) return;
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (cancelDrag()) return;
      if (selectedRef.current) {
        select(null);
        setSelectCursor("default");
        return;
      }
      if (!event.repeat) requestClose();
    } else if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !mod &&
      selectedRef.current &&
      !dragRef.current
    ) {
      event.preventDefault();
      event.stopPropagation();
      apply(removeMark(historyRef.current, selectedRef.current));
      select(null);
      setSelectCursor("default");
    } else if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      historyStep(event.shiftKey ? redo : undo);
    }
  };

  const redacting =
    tool === "redact" || (tool === "select" && selected?.kind === "redact");
  const canvasCursor =
    tool === "select"
      ? selectCursor
      : tool === "pen"
        ? penCursor
        : tool === "redact" && overTarget
          ? redactCursor
          : tool === "text"
            ? "text"
            : "crosshair";
  const ratio = typing ? scale() : 1;
  const annotateImageViewView = annotateImageView({
    add,
    apply,
    canRedo,
    canUndo,
    canvas,
    canvasCursor,
    capture,
    changeTool,
    color,
    commitText,
    concealed,
    confirming,
    dragRef,
    field,
    hasMarks,
    historyRef,
    historyStep,
    image,
    onClose,
    onDoubleClick,
    onKeyDown,
    onPointerCancel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    openTyping,
    pickColor,
    pickStyle,
    ratio,
    redactStyle,
    redacting,
    requestClose,
    revealRef,
    root,
    saving,
    select,
    setConfirming,
    setText,
    text,
    textRef,
    tool,
    toolDone,
    typing,
    typingRef,
  });
  return { annotateImageViewView } as const;
}
