import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Camera,
  CircleDot,
  Copy,
  House,
  Lock,
  MousePointer2,
  Volume1,
  Volume2,
  Pencil,
  SquareFilled,
  SquareTerminal,
  RotateCw,
} from "../ui/glyphs";
import { formatText, t } from "../i18n";
import type { SimulatorKind } from "../../shared/simulators";
import { useTooltip } from "../ui/Tooltip";
import { controlKeys } from "./simulator-controls";

/**
 * One control of the bar: a 26px icon button with its tooltip (and the
 * shortcut, where the screen takes it). It never takes the focus from the
 * screen, so typing and the shortcuts go on working after a click (the
 * original's control bar does the same).
 */
function BarButton({
  label,
  shortcut,
  pressed,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string[];
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
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
        className={`icon-button sim-icon-button ${danger ? "sim-danger" : ""}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
      {tooltip}
    </>
  );
}

/** "00:07" in red with a dot while a recording runs. */
export function RecordingTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const text = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <span
      role="timer"
      aria-label="Recording time"
      className="sim-rec-timer"
      data-no-translate
    >
      <span className="sim-rec-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * The control bar under the screen: the recording time while one runs; Back
 * (Android), Home, Recents (Android) and Lock; a divider; Save screenshot and
 * Record video (iOS) or Stop recording; a divider; Show logs or Hide logs.
 *
 * Annotate opens the annotation editor with a screenshot, where a composer can
 * take the result: on Android before Save screenshot, on iOS after the second
 * divider (the original's order).
 *
 * Rotate is iOS-only; Back and Recents are Android-only. Lock and volume use
 * the unframed pane.
 */
export function ControlBar({
  kind,
  disabled,
  recordingStartedAt,
  logsOpen,
  canRecord,
  busy,
  bare = false,
  onButton,
  onScreenshot,
  onToggleRecording,
  onToggleLogs,
  onAnnotate,
  inspecting = false,
  onInspect,
  hinge,
  onRotate,
}: {
  kind: SimulatorKind;
  onRotate?: () => void;
  /** The device is being switched: every control waits. */
  disabled: boolean;
  recordingStartedAt: number | null;
  logsOpen: boolean;
  canRecord: boolean;
  /** A capture is being saved (the buttons ignore clicks until it is). */
  busy: boolean;
  /** Only the device's buttons (no captures or logs to offer). */
  bare?: boolean;
  onButton: (
    name: "HOME" | "BACK" | "RECENTS" | "LOCK" | "VOLUME_UP" | "VOLUME_DOWN",
  ) => void;
  onScreenshot: () => void;
  onToggleRecording: () => void;
  onToggleLogs: () => void;
  /** Annotate, when a composer can take the annotated screenshot. */
  onAnnotate?: () => void;
  /** Inspect is on (the button reads Close inspector). */
  inspecting?: boolean;
  /** Inspect or Close inspector, where the elements can be read. */
  onInspect?: () => void;
  /** A foldable's hinge: percent open, moved and committed. */
  hinge?: {
    percent: number;
    onChange: (percent: number) => void;
    onCommit: (percent: number) => void;
  };
}) {
  const annotate = onAnnotate && (
    <BarButton
      label="Annotate"
      disabled={disabled}
      onClick={() => !busy && onAnnotate()}
    >
      <Pencil size={18} />
    </BarButton>
  );
  const recording = recordingStartedAt !== null;
  return (
    <div className={`sim-controls${hinge ? " sim-controls-hinge" : ""}`}>
      <div className="sim-pill" role="toolbar" aria-label="Device controls">
        {recordingStartedAt !== null && (
          <RecordingTimer startedAt={recordingStartedAt} />
        )}
        {kind === "android" && (
          <BarButton
            label="Back"
            shortcut={controlKeys.back}
            disabled={disabled}
            onClick={() => onButton("BACK")}
          >
            <ArrowLeft size={18} />
          </BarButton>
        )}
        <BarButton
          label="Home"
          shortcut={controlKeys.home}
          disabled={disabled}
          onClick={() => onButton("HOME")}
        >
          <House size={18} />
        </BarButton>
        {kind === "android" && (
          <BarButton
            label="Recents"
            shortcut={controlKeys.recents}
            disabled={disabled}
            onClick={() => onButton("RECENTS")}
          >
            <Copy size={18} />
          </BarButton>
        )}
        {kind === "ios" && onRotate && (
          <BarButton
            label="Rotate right"
            shortcut={controlKeys.rotate}
            disabled={disabled}
            onClick={onRotate}
          >
            <RotateCw size={18} />
          </BarButton>
        )}
        <BarButton
          label="Lock"
          shortcut={controlKeys.lock}
          disabled={disabled}
          onClick={() => onButton("LOCK")}
        >
          <Lock size={18} />
        </BarButton>
        {kind === "android" && (
          <>
            <BarButton
              label="Volume up"
              shortcut={controlKeys.volumeUp}
              disabled={disabled}
              onClick={() => onButton("VOLUME_UP")}
            >
              <Volume2 size={18} />
            </BarButton>
            <BarButton
              label="Volume down"
              shortcut={controlKeys.volumeDown}
              disabled={disabled}
              onClick={() => onButton("VOLUME_DOWN")}
            >
              <Volume1 size={18} />
            </BarButton>
          </>
        )}
        {hinge && (
          <div
            className="sim-device-pose"
            role="group"
            aria-label={t("Device pose")}
          >
            <div className="sim-hinge-panel">
              <input
                type="range"
                className="sim-hinge"
                min={0}
                max={100}
                step={1}
                value={hinge.percent}
                disabled={disabled}
                aria-label={t("Hinge angle")}
                title={t("Hinge angle")}
                aria-valuetext={formatText(
                  "{percent}% open, {degrees} degrees",
                  {
                    percent: hinge.percent,
                    degrees: Math.round((hinge.percent / 100) * 180),
                  },
                )}
                onChange={(event) => hinge.onChange(Number(event.target.value))}
                onPointerUp={(event) =>
                  hinge.onCommit(Number(event.currentTarget.value))
                }
                onKeyUp={(event) =>
                  hinge.onCommit(Number(event.currentTarget.value))
                }
              />
              <span className="sim-hinge-value" aria-hidden="true">
                {formatText("{percent}%", { percent: hinge.percent })}
              </span>
            </div>
            {([0, 50, 100] as const).map((percent, index) => (
              <BarButton
                key={percent}
                label={["Closed", "Half open", "Open"][index]}
                pressed={hinge.percent === percent}
                disabled={disabled}
                onClick={() => {
                  hinge.onChange(percent);
                  hinge.onCommit(percent);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  width={20}
                  height={20}
                >
                  {index === 0 ? (
                    <>
                      <path
                        d="M6.75 5H14.95A2.3 2.3 0 0 1 17.25 7.3V16.7A2.3 2.3 0 0 1 14.95 19H6.75Z"
                        fill="currentColor"
                        fillOpacity={0.2}
                        stroke="currentColor"
                        strokeWidth={1.5}
                        strokeLinejoin="round"
                      />
                      <circle cx="14.75" cy="7.4" r="0.8" fill="currentColor" />
                      <path
                        d="M10.25 16.75h3.5"
                        stroke="currentColor"
                        strokeWidth={1.25}
                        strokeLinecap="round"
                      />
                    </>
                  ) : index === 1 ? (
                    <path
                      d="M3.75 6.95Q3.75 4.7 5.97 5.05L12 6L18.03 5.05Q20.25 4.7 20.25 6.95L20.25 17.05Q20.25 19.3 18.03 18.95L12 18L5.97 18.95Q3.75 19.3 3.75 17.05Z"
                      fill="currentColor"
                      fillOpacity={0.2}
                      stroke="currentColor"
                      strokeWidth={1.5}
                      strokeLinejoin="round"
                    />
                  ) : (
                    <>
                      <rect
                        x="3.25"
                        y="5"
                        width="17.5"
                        height="14"
                        rx="2"
                        fill="currentColor"
                        fillOpacity={0.2}
                        stroke="currentColor"
                        strokeWidth={1.5}
                      />
                      <path
                        d="M10 16.75h4"
                        stroke="currentColor"
                        strokeWidth={1.25}
                        strokeLinecap="round"
                      />
                    </>
                  )}
                </svg>
              </BarButton>
            ))}
          </div>
        )}
        {!bare && (
          <>
            <span className="sim-pill-divider" aria-hidden="true" />
            {onInspect && (
              <BarButton
                label={inspecting ? "Close inspector" : "Inspect"}
                pressed={inspecting}
                disabled={disabled}
                onClick={onInspect}
              >
                <MousePointer2 size={18} />
              </BarButton>
            )}
            {kind === "android" && annotate}
            <BarButton
              label="Save screenshot"
              shortcut={controlKeys.screenshot}
              disabled={disabled}
              onClick={() => !busy && onScreenshot()}
            >
              <Camera size={18} />
            </BarButton>
            {canRecord &&
              (recording ? (
                <BarButton
                  label="Stop recording"
                  danger
                  disabled={disabled}
                  onClick={() => !busy && onToggleRecording()}
                >
                  <SquareFilled size={14} />
                </BarButton>
              ) : (
                <BarButton
                  label="Record video"
                  disabled={disabled}
                  onClick={() => !busy && onToggleRecording()}
                >
                  <CircleDot size={18} />
                </BarButton>
              ))}
            <span className="sim-pill-divider" aria-hidden="true" />
            {kind === "ios" && annotate}
            <BarButton
              label={logsOpen ? "Hide logs" : "Show logs"}
              pressed={logsOpen}
              disabled={disabled}
              onClick={onToggleLogs}
            >
              <SquareTerminal size={18} />
            </BarButton>
          </>
        )}
      </div>
    </div>
  );
}
