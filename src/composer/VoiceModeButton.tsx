import { useContext, useEffect, useRef } from "react";
import { MicrophoneChevron } from "./voice/CoworkVoiceControls";
import { useTooltip } from "../ui/Tooltip";
import { AppContext } from "../app/AppContext";
import { canSpeak } from "../voice/speech";
import { useVoiceMode, type VoicePhase } from "../voice/useVoiceMode";
import type { SpeechEngine } from "../voice/useSpeechEngine";
import { setVoiceSurface } from "../voice/voice-surface";
import { useT } from "../i18n";
import { dismissToast, showToast } from "../ui/toast-store";
import { hasEscapeLayer } from "../ui/useDismiss";
import { useHost } from "../host/HostContext";

/**
 * The original's voice controls next to the microphone: Chat's voice-mode split
 * button and the ⌄ voice options after the microphone in Cowork and the Code
 * footer. Claudex has no spoken conversation service, so voice mode is made of
 * parts it has: dictation to listen, and the window's own speech synthesis to
 * read the reply (nothing extra is sent anywhere). The waveform starts and ends
 * it; while it runs it is lit and a note above it says what it is doing. It is
 * greyed, with the reason, where dictation is off or the window cannot speak.
 * The ⌄ opens the microphone menu.
 */
export const voiceModeUnavailable =
  "Voice mode needs dictation and a window that can read aloud.";
const phaseText: Record<VoicePhase, string> = {
  off: "Use voice mode",
  starting: "Connecting...",
  reconnecting: "Reconnecting...",
  // The live voice bar's three states: "Listening...", "Processing...", "Claude
  // is speaking..." (Claudex here).
  listening: "Listening...",
  thinking: "Processing...",
  speaking: "Claudex is speaking...",
};

// Voice master16/master20 geometry.
function VoiceWaveIcon({ small = false }: { small?: boolean }) {
  return (
    <svg
      width={small ? 16 : 20}
      height={small ? 16 : 20}
      viewBox={small ? "0 0 16 16" : "0 0 20 20"}
      fill="none"
      stroke="currentColor"
      strokeWidth={small ? 1 : 1.2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      {small ? (
        <>
          <line x1="2" y1="6.5" x2="2" y2="9.5" />
          <line x1="5" y1="3.5" x2="5" y2="12.5" />
          <line x1="8" y1="5.5" x2="8" y2="10.5" />
          <line x1="11" y1="4.5" x2="11" y2="11.5" />
          <line x1="14" y1="7" x2="14" y2="9" />
        </>
      ) : (
        <>
          <line x1="2.5" y1="8.5" x2="2.5" y2="11.5" />
          <line x1="5.5" y1="6.5" x2="5.5" y2="13.5" />
          <line x1="8.5" y1="3.5" x2="8.5" y2="16.5" />
          <line x1="11.5" y1="6.5" x2="11.5" y2="13.5" />
          <line x1="14.5" y1="4.5" x2="14.5" y2="15.5" />
          <line x1="17.5" y1="8.5" x2="17.5" y2="11.5" />
        </>
      )}
    </svg>
  );
}

/**
 * Chat's waveform starts the available dictation + local read-aloud loop.
 * Where unavailable it keeps its position and explains why. Some callers
 * group the microphone menu with it; others render that menu beside Dictate.
 */
export function VoiceModeButton({
  waveform = true,
  microphoneOptions = true,
  iconSize = microphoneOptions ? 20 : 16,
  reason,
  maxSeconds = null,
  engine = "service",
  onPhase,
  variant,
}: {
  waveform?: boolean;
  microphoneOptions?: boolean;
  iconSize?: 16 | 20;
  reason?: string;
  maxSeconds?: number | null;
  engine?: SpeechEngine;
  onPhase?: (phase: VoicePhase) => void;
  /** Current unified web reply group; new drafts and native keep theirs. */
  variant?: "reply";
}) {
  const app = useContext(AppContext);
  const host = useHost();
  const reply = variant === "reply" && host.kind === "web";
  const t = useT();
  const off = reason ?? (canSpeak() && app ? undefined : voiceModeUnavailable);
  const mode = useVoiceMode(app!, maxSeconds, engine);
  const active = mode.phase !== "off";
  // Available, the button says what it does in a bottom tooltip; unavailable,
  // the reason.
  const { props, tooltip } = useTooltip(
    off ? t(off) : t(active ? "End voice mode" : "Use voice mode"),
    { size: off ? "wrap" : "line" },
  );
  const session = useRef({});
  useEffect(() => {
    const owner = session.current;
    setVoiceSurface(owner, active);
    return () => setVoiceSurface(owner, false);
  }, [active]);
  useEffect(() => {
    onPhase?.(mode.phase);
  }, [mode.phase, onPhase]);
  useEffect(() => () => onPhase?.("off"), [onPhase]);
  // No sound or a muted microphone while listening, as a toast that stays until
  // the sound returns or it is closed for this session.
  const noticeToast = useRef<{ id: number; clearing: boolean }>(undefined);
  useEffect(() => {
    const shown = noticeToast.current;
    if (shown) {
      shown.clearing = true;
      dismissToast(shown.id);
      noticeToast.current = undefined;
    }
    if (!mode.micNotice) return;
    const entry = { id: 0, clearing: false };
    entry.id = showToast(t(micNoticeCopy[mode.micNotice]), {
      timeout: Infinity,
      onDismiss: () => {
        if (!entry.clearing) mode.dismissMicNotice();
      },
    });
    noticeToast.current = entry;
  }, [mode.micNotice]);
  useEffect(
    () => () => {
      const shown = noticeToast.current;
      if (!shown) return;
      shown.clearing = true;
      dismissToast(shown.id);
    },
    [],
  );
  // Escape ends voice mode wherever it is, unless a menu or popover is open
  // over it: that takes the key and voice mode carries on.
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hasEscapeLayer()) mode.stop();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [active, mode.stop]);
  return (
    <div
      className={`voice-mode-button ${waveform ? "" : "chevron-only"} ${microphoneOptions ? "" : "standalone"}${reply ? " reply-voice-mode" : ""}`}
      role={reply ? "group" : undefined}
      aria-label={reply ? t("Use voice mode") : undefined}
    >
      {waveform && (
        <>
          <button
            {...props}
            type="button"
            className={`voice-mode-main ${off ? "unavailable" : ""} ${active ? "active" : ""}`}
            aria-label={t(active ? "End voice mode" : "Use voice mode")}
            aria-pressed={off ? undefined : active}
            aria-disabled={off ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              if (off) return;
              if (mode.phase === "speaking") mode.skip();
              else if (active) mode.stop();
              else void mode.start();
            }}
          >
            <VoiceWaveIcon small={reply || iconSize === 16} />
            {active && <span className="dictation-pulse" />}
            {active && (
              <span
                role="status"
                className="dictation-tooltip voice-mode-status"
                data-open="true"
              >
                {t(phaseText[mode.phase])}
              </span>
            )}
          </button>
          {tooltip}
        </>
      )}
      {reply && waveform && microphoneOptions && (
        <span className="reply-voice-divider" aria-hidden="true" />
      )}
      {microphoneOptions && (
        <MicrophoneChevron
          className="voice-mode-chevron"
          reason={reason}
          menuVariant={reply ? "idle" : undefined}
        />
      )}
    </div>
  );
}

/** The microphone notices' words. */
const micNoticeCopy = {
  muted:
    "Your device or browser has muted your microphone. Unmute it there so Claudex can hear you.",
  silent:
    "Claudex isn’t getting any sound from your microphone. Check that it’s on and that you’ve picked the right one.",
} as const;

/** Cowork and the Code footer: the ⌄ right after the microphone. */
export function VoiceOptionsButton({
  reason,
  menuVariant,
}: {
  reason?: string;
  menuVariant?: "idle" | "legacy";
}) {
  return (
    <MicrophoneChevron
      className="cowork-voice-options"
      reason={reason}
      menuVariant={menuVariant}
    />
  );
}
