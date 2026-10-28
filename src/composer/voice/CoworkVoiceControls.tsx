import type { VoiceInputChoice } from "../voice-input-preference";
import { Suspense, useRef, useState, type ReactNode } from "react";
import { AppIcon } from "../../ui/app-icon";
import { useTooltip } from "../../ui/Tooltip";
import { useT } from "../../i18n";
import { lazyPiece } from "../../ui/lazy-piece";

const MicrophoneMenu = lazyPiece(
  () => import("../MicrophoneMenu"),
  "MicrophoneMenu",
);

/**
 * Keep this small trigger in the toolbar's eager module. Opening microphone
 * options loads the device menu; displaying its caret does not load voice
 * mode's recording, recognition and reply-speaking implementation.
 */
export function MicrophoneChevron({
  className,
  reason,
  menuVariant,
  voiceInput,
  label = "Microphone",
}: {
  className: string;
  reason?: string;
  menuVariant?: "idle" | "legacy";
  voiceInput?: VoiceInputChoice;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const t = useT();
  const { props, tooltip } = useTooltip(reason ? t(reason) : "", {
    size: "wrap",
    disabled: !reason,
  });
  return (
    <>
      <button
        {...(reason ? props : {})}
        ref={button}
        type="button"
        className={`${className} ${reason ? "unavailable" : ""} ${open ? "open" : ""}`}
        aria-label={t(label)}
        aria-haspopup={reason ? undefined : "menu"}
        aria-expanded={reason ? undefined : open}
        aria-disabled={reason ? "true" : undefined}
        onClick={() => !reason && setOpen((value) => !value)}
      >
        <AppIcon name="CaretDown" size={menuVariant === "idle" ? 12 : 13} />
      </button>
      {reason && tooltip}
      {open && (
        <Suspense fallback={null}>
          <MicrophoneMenu
            anchor={button}
            voiceInput={voiceInput}
            variant={menuVariant}
            onClose={() => {
              setOpen(false);
              button.current?.focus();
            }}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * The microphone's place in the Chat and Cowork toolbars and the Code footer.
 * With `options`, the original's ⌄ follows it (Cowork, Code): the microphone
 * menu (see VoiceModeButton).
 */
export function CoworkVoiceControls({
  microphone,
  options = false,
  optionsReason,
  menuVariant,
  className = "",
  label = "Cowork voice controls",
}: {
  microphone: ReactNode;
  options?: boolean;
  /** Why the ⌄ microphone menu can't open, when it can't. */
  optionsReason?: string;
  menuVariant?: "idle" | "legacy";
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={`cowork-voice-controls ${options ? "with-options" : ""} ${className}`.trim()}
      role="group"
      aria-label={label}
    >
      {microphone}
      {options && (
        <MicrophoneChevron
          className="cowork-voice-options"
          reason={optionsReason}
          menuVariant={menuVariant}
        />
      )}
    </div>
  );
}
