import { Suspense, useId, useRef, useState, type RefObject } from "react";
import { useReplyTooltipClamp } from "../../ui/useReplyTooltipClamp";
import { Mic } from "../../ui/glyphs";
import { Spinner } from "../../ui/Spinner";
import { createPortal } from "react-dom";
import { surface } from "../../../shared/host";
import { AppIcon } from "../../ui/app-icon";
import { lazyPiece } from "../../ui/lazy-piece";
import { type MicrophoneReason } from "../../voice/microphone-guidance";
import { t } from "../../i18n";
import { dismissToast } from "../../ui/toast-store";
import { microphoneContextKey } from "../../voice/microphone-context";
import { useDictationButtonState } from "./useDictationButtonState";

/**
 * The web draws the original's Microphone glyph (its icon font, 20px), solid
 * while it connects or records.
 */
const micGlyph = (filled = false) =>
  surface === "web" ? (
    <AppIcon name={filled ? "MicrophoneFilled" : "Microphone"} />
  ) : (
    <Mic size={16} strokeWidth={1.4} />
  );
import type { SpeechEngine } from "../../voice/useSpeechEngine";

/** Loaded with the first recording. */
const DictationBar = lazyPiece(
  () => import("../../voice/DictationBar"),
  "DictationBar",
  { silent: true },
);
const MicrophoneGuidance = lazyPiece(
  () => import("../../voice/MicrophoneGuidance"),
  "MicrophoneGuidance",
);
const CommentMicrophone = lazyPiece(
  () => import("../../voice/CommentMicrophone"),
  "CommentMicrophone",
);
const MicrophoneMenu = lazyPiece(
  () => import("../MicrophoneMenu"),
  "MicrophoneMenu",
);

export type DictationPhase = "idle" | "requesting" | "recording" | "finishing";
type Phase = DictationPhase;
type Props = {
  /** What transcribes: Claudex's service (default) or the browser's own recognition. */
  engine?: SpeechEngine;
  /** Longest recording; the service's limit, or the default when it names none. */
  maxSeconds: number | null;
  contextKey: string;
  /** The transcript so far, while recording (partial text included). */
  onLive: (spoken: string) => void;
  /** The whole transcript once the recording stopped. */
  onTranscript: (spoken: string) => void;
  /** Escape: the recording and what it transcribed are dropped. */
  onCancel: () => void;
  onError: (error: unknown) => void;
  /** The recording's phase as it changes: the composer's placeholder follows it. */
  onPhase?: (phase: DictationPhase) => void;
  /**
   * Settings → System → Dictation shortcut: starts or stops dictation while
   * this composer has the keyboard; "" for none.
   */
  shortcut?: string;
  platform?: string;
  comment?: boolean;
  canStart?: boolean;
  field?: RefObject<HTMLElement | null>;
  onSubmit?: (spoken: string) => void;
  recordingTarget?: RefObject<HTMLDivElement | null>;
  guidanceAnchor?: RefObject<HTMLElement | null>;
  autoStart?: boolean;
  /** Code home keeps even its hidden hint within the scroll client box. */
  containTooltip?: boolean;
  /**
   * Right-click (Shift+F10) opens the microphone menu and the hint says so,
   * where no ⌄ follows the microphone; with a ⌄ only that opens it.
   */
  contextMenu?: boolean;
};
// Claude keeps a shown tooltip for ~200ms after the pointer leaves (claude-chat-voice-hover-001, claude-cowork-mic-hover-001).
export const tooltipHoldMs = 190;
/** A pointer press held this long records only while it is held. */
export const pushToTalkMs = 500;

/**
 * The composer's microphone (package C6): streams 16 kHz PCM to the
 * service through the main process and shows the transcript as it arrives.
 */
export function DictationButton({
  engine = "service",
  maxSeconds,
  contextKey,
  onLive,
  onTranscript,
  onCancel,
  onError,
  onPhase,
  shortcut = "",
  platform = "",
  comment = false,
  canStart = true,
  field,
  onSubmit,
  recordingTarget,
  guidanceAnchor,
  autoStart = false,
  containTooltip = false,
  contextMenu = true,
}: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  /** The microphone panel, open with why dictation couldn't start. */
  const [guidance, setGuidance] = useState<MicrophoneReason | false>(false);
  /** Starts that failed in a row ("Dictation couldn’t start" after a few). */
  const failedStarts = useRef(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const failureToast = useRef<number | undefined>(undefined);
  const clearFailure = () => {
    if (failureToast.current !== undefined) dismissToast(failureToast.current);
    failureToast.current = undefined;
  };
  const [errorVisible, setErrorVisible] = useState(false);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const {
    tooltip,
    tooltipVisible,
    tooltipId,
    tooltipTimer,
    setTooltipVisible,
    pointerDown,
    pointerHold,
    click,
    tooltipRef,
    coarse,
    recording,
    stream,
    abandon,
    stop,
  } = useDictationButtonState({
    autoStart,
    button,
    canStart,
    clearFailure,
    comment,
    containTooltip,
    contextKey,
    engine,
    errorTimer,
    failedStarts,
    failureToast,
    field,
    maxSeconds,
    onCancel,
    onLive,
    onPhase,
    onSubmit,
    onTranscript,
    phase,
    platform,
    setErrorVisible,
    setGuidance,
    setMenuOpen,
    setPhase,
    shortcut,
  });
  if (!canStart && phase === "idle" && !guidance) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`mic-button dictation-button u-press ${phase} ${errorVisible ? "dictation-error" : ""} ${comment ? "comment-dictation" : ""}`}
        aria-label={tooltip}
        aria-keyshortcuts={contextMenu ? "Shift+F10" : undefined}
        aria-pressed={comment ? phase === "recording" : undefined}
        aria-busy={phase === "requesting" || phase === "finishing" || undefined}
        aria-haspopup={guidance ? "dialog" : contextMenu ? "menu" : undefined}
        aria-expanded={
          Boolean(guidance) || (contextMenu && menuOpen) || undefined
        }
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        disabled={phase === "requesting" || phase === "finishing"}
        onPointerEnter={() => {
          clearTimeout(tooltipTimer.current);
          tooltipTimer.current = setTimeout(() => setTooltipVisible(true), 330);
        }}
        onPointerLeave={() => {
          clearTimeout(tooltipTimer.current);
          if (tooltipVisible)
            tooltipTimer.current = setTimeout(
              () => setTooltipVisible(false),
              tooltipHoldMs,
            );
        }}
        onFocus={() => {
          clearTimeout(tooltipTimer.current);
          setTooltipVisible(true);
        }}
        onBlur={() => {
          clearTimeout(tooltipTimer.current);
          setTooltipVisible(false);
        }}
        onPointerDown={pointerDown}
        onContextMenu={
          contextMenu
            ? (event) => {
                event.preventDefault();
                setTooltipVisible(false);
                setMenuOpen(true);
              }
            : undefined
        }
        onKeyDown={contextMenu ? microphoneContextKey : undefined}
        onMouseDown={
          comment
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
              }
            : undefined
        }
        onClick={() => {
          // The press already started it.
          if (pointerHold.current) {
            pointerHold.current = false;
            return;
          }
          click();
        }}
      >
        {comment && (phase === "requesting" || phase === "finishing") ? (
          <Spinner inheritColor size={16} className="spin" />
        ) : phase === "finishing" ? (
          <Spinner inheritColor size={16} className="spin" />
        ) : comment ? (
          <Suspense fallback={micGlyph()}>
            <CommentMicrophone recording={phase === "recording"} />
          </Suspense>
        ) : (
          micGlyph(phase === "recording" || phase === "requesting")
        )}
        <span
          ref={tooltipRef}
          id={tooltipId}
          role="tooltip"
          aria-hidden={!tooltipVisible}
          className="dictation-tooltip"
          data-open={tooltipVisible}
        >
          {tooltip}
          {contextMenu && phase === "idle" && !comment && !coarse && (
            <span className="dictation-tooltip-detail">
              {t("Right-click for microphone settings")}
            </span>
          )}
        </span>
      </button>
      {menuOpen && (
        <Suspense fallback={null}>
          <MicrophoneMenu anchor={button} onClose={() => setMenuOpen(false)} />
        </Suspense>
      )}
      {guidance && (
        <Suspense fallback={null}>
          <MicrophoneGuidance
            anchor={guidanceAnchor ?? button}
            platform={platform}
            reason={guidance}
            onClose={() => setGuidance(false)}
          />
        </Suspense>
      )}
      {recording &&
        recordingTarget?.current &&
        createPortal(
          <Suspense fallback={null}>
            <DictationBar
              stream={stream}
              connecting={phase !== "recording"}
              onCancel={() => abandon(true)}
              onDone={() => void stop()}
            />
          </Suspense>,
          recordingTarget.current,
        )}
    </>
  );
}

/**
 * Unavailable microphone: the generic unavailable tooltip, not a
 * provider-specific explanation.
 */
export function UnavailableDictationButton({
  reason: _reason,
  containTooltip = false,
}: {
  reason: string;
  containTooltip?: boolean;
}) {
  const [tooltipVisible, setTooltipVisible] = useState(false),
    tooltipId = useId();
  const tooltipRef = useReplyTooltipClamp(
    tooltipVisible,
    t("Dictation is unavailable"),
    { enabled: containTooltip, desktop: true, whileClosed: true, padding: 5 },
  );
  return (
    <button
      className="mic-button dictation-button unavailable"
      aria-label={t("Dictate")}
      aria-disabled
      aria-describedby={tooltipVisible ? tooltipId : undefined}
      onPointerEnter={() => setTooltipVisible(true)}
      onPointerLeave={() => setTooltipVisible(false)}
      onFocus={() => setTooltipVisible(true)}
      onBlur={() => setTooltipVisible(false)}
      onClick={(event) => event.preventDefault()}
    >
      {micGlyph()}
      <span
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        aria-hidden={!tooltipVisible}
        className="dictation-tooltip"
        data-open={tooltipVisible}
      >
        {t("Dictation is unavailable")}
      </span>
    </button>
  );
}
