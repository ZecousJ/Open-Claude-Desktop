import { createPortal } from "react-dom";
import {
  textSize,
  textFont,
  sketchTools,
  toolLabels,
  redactStyles,
  redactStyleLabels,
  inkColors,
  undo,
  redo,
  clearAll,
} from "./annotate-sketch";
import type {
  Mark,
  SketchHistory,
  EditorTool,
  RedactStyle,
} from "./annotate-sketch";
import { toolIcons } from "./AnnotateImage";
import { ToolButton, Swatch, styleSwatch } from "./AnnotateControls";
import { Undo2, Redo2, Trash2 } from "../ui/glyphs";
import { Modal } from "../ui/Controls";
import type { SimulatorAnnotateCapture } from "../../shared/simulators";
import type { Drag, Typing } from "./AnnotateImage";

/** What annotateImageView needs from AnnotateImage.tsx. */
export interface AnnotateImageViewKit {
  add: () => Promise<void>;
  apply: (next: SketchHistory) => void;
  canRedo: boolean;
  canUndo: boolean;
  canvas: React.RefObject<HTMLCanvasElement | null>;
  canvasCursor: string;
  capture: SimulatorAnnotateCapture;
  changeTool: (next: EditorTool) => void;
  color: string;
  commitText: () => Mark | null;
  concealed: boolean;
  confirming: boolean;
  dragRef: React.RefObject<Drag | null>;
  field: React.RefObject<HTMLTextAreaElement | null>;
  hasMarks: boolean;
  historyRef: React.RefObject<SketchHistory>;
  historyStep: (step: (history: SketchHistory) => SketchHistory) => void;
  image: React.RefObject<HTMLImageElement | null>;
  onClose: () => void;
  onDoubleClick: (
    event: React.MouseEvent<HTMLCanvasElement, MouseEvent>,
  ) => void;
  onKeyDown: (event: React.KeyboardEvent<Element>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  openTyping: (next: Typing | null, value?: string) => void;
  pickColor: (next: string) => void;
  pickStyle: (next: RedactStyle) => void;
  ratio: number;
  redactStyle: RedactStyle;
  redacting: boolean;
  requestClose: () => void;
  revealRef: React.RefObject<{ mark: Mark; progress: number } | null>;
  root: React.RefObject<HTMLDivElement | null>;
  saving: boolean;
  select: (mark: Mark | null) => void;
  setConfirming: React.Dispatch<React.SetStateAction<boolean>>;
  setText: React.Dispatch<React.SetStateAction<string>>;
  text: string;
  textRef: React.RefObject<string>;
  tool: EditorTool;
  toolDone: (mark: Mark | null) => void;
  typing: Typing | null;
  typingRef: React.RefObject<Typing | null>;
}

export function annotateImageView(kit: AnnotateImageViewKit) {
  const {
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
  } = kit;
  const annotateImageViewView = createPortal(
    <div
      ref={root}
      className="annotate-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Annotate image"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div className="annotate-stage">
        <img
          ref={image}
          src={capture.dataUrl}
          alt={capture.name}
          draggable={false}
          className="annotate-picture"
        />
        <canvas
          ref={canvas}
          role="application"
          aria-label="Sketch canvas"
          width={capture.width}
          height={capture.height}
          className="annotate-canvas"
          style={{ cursor: canvasCursor }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onLostPointerCapture={onPointerCancel}
          onDoubleClick={onDoubleClick}
        />
        {typing && (
          <textarea
            ref={field}
            autoFocus
            className="annotate-text-field"
            aria-label="Text label"
            value={text}
            rows={Math.max(1, text.split("\n").length)}
            style={{
              left: typing.shown.x,
              top: typing.shown.y,
              minWidth: `min(40px, calc(100% - ${typing.shown.x}px))`,
              maxWidth: `calc(100% - ${typing.shown.x}px)`,
              maxHeight: `max(1.2em, calc(100% - ${typing.shown.y}px))`,
              color: typing.color,
              font: `${typing.size / ratio || textSize}px/1.2 ${textFont}`,
            }}
            onChange={(event) => {
              textRef.current = event.target.value;
              setText(event.target.value);
            }}
            onBlur={() => commitText()}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.nativeEvent.isComposing) return;
              let done: Mark | null;
              if (event.key === "Escape") {
                event.preventDefault();
                done = typingRef.current?.editing ?? null;
                openTyping(null);
              } else if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey)
              ) {
                event.preventDefault();
                done = commitText();
              } else return;
              root.current?.focus({ preventScroll: true });
              toolDone(done);
            }}
          />
        )}
      </div>
      <div className="annotate-bar-row">
        <div
          className={`annotate-bar ${concealed ? "concealed" : ""}`}
          inert={concealed || undefined}
        >
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
                onClick={() => changeTool(tool === each ? "select" : each)}
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
                    onPick={() => pickStyle(style)}
                  />
                ))
              : inkColors.map((ink) => (
                  <Swatch
                    key={ink.value}
                    label={ink.label}
                    fill={ink.value}
                    active={ink.value === color}
                    square={false}
                    onPick={() => pickColor(ink.value)}
                  />
                ))}
          </div>
          <span className="annotate-divider" aria-hidden="true" />
          <div className="annotate-group">
            <ToolButton
              label={canUndo ? "Undo" : "Nothing to undo yet"}
              shortcut={["mod", "Z"]}
              disabled={!canUndo}
              onClick={() => historyStep(undo)}
            >
              <Undo2 size={16} />
            </ToolButton>
            <ToolButton
              label={canRedo ? "Redo" : "Nothing to redo yet"}
              shortcut={["shift", "mod", "Z"]}
              disabled={!canRedo}
              onClick={() => historyStep(redo)}
            >
              <Redo2 size={16} />
            </ToolButton>
            <ToolButton
              label={hasMarks ? "Clear all" : "Nothing to clear yet"}
              disabled={!hasMarks}
              onClick={() => {
                commitText();
                dragRef.current = null;
                revealRef.current = null;
                select(null);
                apply(clearAll(historyRef.current));
              }}
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
            disabled={!hasMarks || saving}
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
    </div>,
    document.body,
  );
  return annotateImageViewView;
}
