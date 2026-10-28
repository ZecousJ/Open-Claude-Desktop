import { useEffect, useState } from "react";
import {
  type ClipboardDirection,
  type SimulatorAppearance,
  type SimulatorCapture,
  type SimulatorKind,
  type SimulatorLogBatch,
  type SimulatorElement,
} from "../../shared/simulators";
import { formatText } from "../i18n";
import { type MenuEntry } from "../ui/Menu";
import { type CaptureActions } from "./CaptureThumbnail";
import { FrameClock, frameTickMs } from "./simulator-controls";

/**
 * The device menu's foot: after the devices, a separator, Detach and "Shut down
 * {name}".
 */
export function deviceMenuFooter({
  kind,
  name,
  disabled,
  onDetach,
  onShutdown,
}: {
  kind: SimulatorKind;
  name: string;
  disabled: boolean;
  onDetach: () => void;
  onShutdown: () => void;
}): MenuEntry[] {
  return [
    { separator: true },
    {
      label: kind === "android" ? "Detach emulator" : "Detach simulator",
      disabled,
      onSelect: onDetach,
    },
    {
      label: formatText("Shut down {name}", { name }),
      disabled,
      onSelect: onShutdown,
    },
  ];
}

/**
 * What the control bar, the Edit and Device menus and the log drawer ask of
 * the pane (`SimulatorPanel` builds it over the main process's calls).
 * Without it the device has only its touch input, buttons and zoom.
 */
export interface DeviceTools {
  saveScreenshot(): Promise<SimulatorCapture>;
  startRecording(): Promise<void>;
  stopRecording(): Promise<SimulatorCapture>;
  captures: CaptureActions;
  /**
   * "Screenshot saved to {filePath}" with Add to chat, for a capture the
   * pane can't show in its corner.
   */
  savedNotice(capture: SimulatorCapture): void;
  appearance(set?: SimulatorAppearance): Promise<SimulatorAppearance | null>;
  /** Show on-screen keyboard (Android); null when it can't be read. */
  softwareKeyboard(show?: boolean): Promise<boolean | null>;
  /** Slow animations; null when it can't be read. */
  slowAnimations?(on?: boolean): Promise<boolean | null>;
  /** A foldable's hinge angle in degrees; null without a hinge. */
  hinge?(degrees?: number): Promise<number | null>;
  clipboard(direction: ClipboardDirection): Promise<number>;
  readLogs(since: number): Promise<SimulatorLogBatch>;
  stopLogs(): void;
  /** A failure, as a notice above the screen. */
  report(message: string): void;
  /**
   * Annotate: a screenshot in the annotation editor, whose result joins the
   * message being written; absent where no composer can take it.
   */
  annotate?: () => void;
  /** Inspect: the screen's elements (frames in fractions of the screen). */
  inspect?: () => Promise<SimulatorElement[]>;
  /** An inspected element and the person's note join the message being written. */
  addElementToChat?: (element: SimulatorElement, note: string) => Promise<void>;
  /** "Show in Finder" or "Show in File Explorer". */
  revealLabel: string;
}

/** "FPS: idle" or "FPS: {fps}" beside the zoom buttons. */
export function FrameRate({ clock }: { clock: FrameClock }) {
  const [value, setValue] = useState<number | "idle" | null>(null);
  useEffect(() => {
    const timer = setInterval(
      () => setValue(clock.read(performance.now())),
      frameTickMs,
    );
    return () => clearInterval(timer);
  }, [clock]);
  if (value === null) return null;
  return (
    <span className="sim-fps" aria-label={formatText("Frame rate")}>
      {value === "idle"
        ? "FPS: idle"
        : formatText("FPS: {fps}", { fps: Math.round(value) })}
    </span>
  );
}
