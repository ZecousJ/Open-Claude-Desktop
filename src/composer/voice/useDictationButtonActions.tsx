import { useEffect, useRef } from "react";
import { useMicrophonePreferences } from "../../voice/preferences";
import { useMediaQuery } from "../../ui/useMediaQuery";
import { pressMatches } from "../../../shared/accelerator";
import type { PointerEvent } from "react";
import { pushToTalkMs } from "./DictationButton";
import { t } from "../../i18n";
import { dictationLabel } from "../../voice/microphone-guidance";
import { useReplyTooltipClamp } from "../../ui/useReplyTooltipClamp";
import type { DictationPhase } from "./DictationButton";

/** What useDictationButtonActions needs from DictationButton.tsx. */
export interface UseDictationButtonActionsKit {
  autoStart: boolean;
  button: React.RefObject<HTMLButtonElement | null>;
  click: (retry?: boolean) => void;
  clickRef: React.RefObject<(retry?: boolean) => void>;
  comment: boolean;
  containTooltip: boolean;
  phase: DictationPhase;
  phaseRef: React.RefObject<DictationPhase>;
  platform: string;
  released: React.RefObject<boolean>;
  shortcut: string;
  tooltipVisible: boolean;
}

export function useDictationButtonActions(kit: UseDictationButtonActionsKit) {
  const {
    autoStart,
    button,
    click,
    clickRef,
    comment,
    containTooltip,
    phase,
    phaseRef,
    platform,
    released,
    shortcut,
    tooltipVisible,
  } = kit;
  phaseRef.current = phase;
  useEffect(() => {
    if (autoStart) clickRef.current();
  }, [autoStart]);
  const { hold: preferredHold } = useMicrophonePreferences();
  const coarse = useMediaQuery("(pointer: coarse)");
  const hold = !comment && preferredHold;
  const holdRef = useRef(hold);
  holdRef.current = hold;
  useEffect(() => {
    if (!shortcut) return;
    // With "Hold to record" the shortcut records while it is held and stops
    // when its key or a modifier is let go; without it the shortcut starts and
    // stops the recording.
    let held: string | undefined;
    const key = (event: KeyboardEvent) => {
      if (!pressMatches(event, shortcut, platform)) return;
      const composer = button.current?.closest(
        comment ? '[role="dialog"]' : ".composer-wrap",
      );
      if (!composer?.contains(document.activeElement)) return;
      event.preventDefault();
      if (!holdRef.current) return clickRef.current();
      if (event.repeat) return;
      held = event.code;
      released.current = false;
      if (phaseRef.current === "idle") clickRef.current();
    };
    const release = (event: KeyboardEvent) => {
      if (!held) return;
      const modifier = ["Control", "Meta", "Alt", "Shift", "OS"].includes(
        event.key,
      );
      if (event.code !== held && !modifier) return;
      held = undefined;
      if (phaseRef.current === "recording") clickRef.current();
      else if (phaseRef.current === "requesting") released.current = true;
    };
    document.addEventListener("keydown", key);
    document.addEventListener("keyup", release);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("keyup", release);
    };
  }, [shortcut, platform, comment]);
  // "Hold to record" with the pointer (the original's push to talk): the
  // press starts the recording, and a press held 500ms or more stops it on
  // release; a shorter one leaves it recording until the next click.
  const pointerHold = useRef(false);
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (
      event.button !== 0 ||
      event.isPrimary === false ||
      event.pointerType === "touch" ||
      !holdRef.current ||
      phase !== "idle"
    )
      return;
    pointerHold.current = true;
    released.current = false;
    const began = event.timeStamp;
    const id = event.pointerId;
    const up = (end: globalThis.PointerEvent) => {
      if (end.pointerId !== id) return;
      document.removeEventListener("pointerup", up);
      document.removeEventListener("pointercancel", up);
      // The click that follows this release is the press's own; a disabled
      // button gets none, so the mark clears after it either way.
      setTimeout(() => (pointerHold.current = false));
      if (end.type === "pointercancel" || end.timeStamp - began < pushToTalkMs)
        return;
      if (phaseRef.current === "recording") clickRef.current();
      else if (phaseRef.current === "requesting") released.current = true;
    };
    document.addEventListener("pointerup", up);
    document.addEventListener("pointercancel", up);
    click();
  };
  const tooltip = t(dictationLabel(phase, comment, hold, coarse));
  const tooltipRef = useReplyTooltipClamp(tooltipVisible, tooltip, {
    enabled: containTooltip,
    desktop: true,
    whileClosed: true,
    padding: 5,
  });
  const recording = !comment && phase !== "idle";
  return {
    tooltip,
    pointerDown,
    pointerHold,
    tooltipRef,
    coarse,
    recording,
  } as const;
}
